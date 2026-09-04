import { AuthFetch, type WalletInterface } from '@bsv/sdk'
import { epochHistoryDigest, eventDigest, generateRootKey, randomId } from '../domain/crypto'
import { materializeConversation, sortAndDedupeEvents } from '../domain/materialize'
import { validAttachmentSet } from '../domain/attachmentValidation'
import type {
  AttachmentReference,
  AttachmentKeyEnvelope,
  ConversationEpoch,
  ConversationEvent,
  ConversationInvite,
  ConversationKind,
  ConversationSecret,
  ConversationView,
  EditEvent,
  DeleteEvent,
  EpochClosure,
  MembershipEvent,
  MembershipUpdate,
  MessageEvent,
  ReactionEvent,
  EventBase,
  MessageDeliveryState,
  PendingControlDelivery,
} from '../domain/types'
import { GlobalConversationStore, overlayFor } from '../storage/globalConversationStore'
import { ConversationSecretRepository, secretRepositoryFor } from '../storage/privateConversationStore'
import { EncryptedOutbox } from '../storage/outbox'
import { EncryptedInbox } from '../storage/inbox'
import {
  ConversationTransport,
  acknowledgeControl,
  listControlMessages,
  forwardStoredEvent,
  listWorkspaceRoomUpdates,
  messageBoxFor,
  openEpochKey,
  sealEpochKey,
  sendInvite,
  sendMembershipUpdate,
  type PendingInvite,
  type PendingMembershipUpdate,
  type RealtimePeer,
  type TypingPeer,
  type CallMedia,
  type WorkspaceRoomUpdate,
} from '../realtime/messaging'
import { defaultIceServers } from '../realtime/calling'
import { AuthenticatedCallManager, type CallSnapshot, type MeetingRoomSnapshot } from '../realtime/meetingCalling'
import { safeWriteError } from '../storage/kvWriteRecovery'

const defaultPreferences = () => ({ archived: false, favorite: false, muted: false, lastReadAt: 0 })

export class EncryptedOutboxRetryError extends Error {
  constructor(readonly cause: unknown) {
    super('A saved message is awaiting wallet review. It remains encrypted and will retry automatically.')
    this.name = 'EncryptedOutboxRetryError'
  }
}

function uniqueIdentities(identities: string[]): string[] {
  return [...new Set(identities.filter((identity) => /^(02|03)[0-9a-f]{64}$/i.test(identity)))]
}

function sameIdentities(left: string[], right: string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((identity, index) => identity === [...right].sort()[index])
}

const mutationLocks = new Map<string, Promise<void>>()

async function withConversationMutationLock<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return await navigator.locks.request(`convo-v2:mutation:${conversationId}`, operation)
  }
  const previous = mutationLocks.get(conversationId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const current = previous.catch(() => undefined).then(() => gate)
  mutationLocks.set(conversationId, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (mutationLocks.get(conversationId) === current) mutationLocks.delete(conversationId)
  }
}

function currentEpoch(secret: ConversationSecret): ConversationEpoch {
  const epoch = secret.epochs.find((candidate) => candidate.epoch === secret.currentEpoch)
  if (!epoch) throw new Error('Conversation current epoch is missing')
  return epoch
}

function assertTitle(title: string): string {
  const clean = title.trim()
  if (!clean) throw new Error('Conversation title is required')
  if (clean.length > 100) throw new Error('Conversation title is too long')
  return clean
}

function closeEpoch(
  events: ConversationEvent[],
  epoch: ConversationEpoch,
  closedAt: number,
): EpochClosure {
  const eventDigests = Object.fromEntries(sortAndDedupeEvents(events)
    .filter((event) => event.epoch === epoch.epoch && event.createdAt <= closedAt)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((event) => [event.id, eventDigest(event)]))
  return {
    closedAt,
    eventDigests,
    eventCount: Object.keys(eventDigests).length,
    historyDigest: epochHistoryDigest(eventDigests),
  }
}

function matchesCommitment(closure: EpochClosure, update: MembershipUpdate): boolean {
  const commitment = update.previousEpochCommitment
  return closure.closedAt === commitment.closedAt
    && closure.eventCount === commitment.eventCount
    && closure.historyDigest === commitment.historyDigest
}

export class ConversationService {
  readonly secrets: ConversationSecretRepository
  readonly store: GlobalConversationStore
  readonly inbox: EncryptedInbox
  readonly outbox: EncryptedOutbox
  readonly messageBox
  private liveRequest = 0
  private scanPromise: Promise<WorkspaceRoomUpdate[]> | null = null
  private reconciliationCursor = 0
  private transport: ConversationTransport | null = null
  private callManager: AuthenticatedCallManager | null = null
  private transportConversationId: string | null = null
  private readonly forwarding = new Map<string, Promise<number>>()
  private outboxFlushPromise: Promise<void> | null = null
  private readonly relayAuthFetch: AuthFetch
  private liveCallbacks: {
    onEvent: (event: ConversationEvent) => void
    onDelivery: (eventId: string, state: MessageDeliveryState) => void
  } | null = null

  constructor(
    readonly wallet: WalletInterface,
    readonly identityKey: string,
    dependencies: {
      secrets?: ConversationSecretRepository
      store?: GlobalConversationStore
      outbox?: EncryptedOutbox
      messageBox?: ReturnType<typeof messageBoxFor>
    } = {},
  ) {
    this.inbox = new EncryptedInbox(identityKey)
    this.secrets = dependencies.secrets ?? secretRepositoryFor(wallet)
    this.store = dependencies.store ?? new GlobalConversationStore(overlayFor(wallet))
    this.outbox = dependencies.outbox ?? new EncryptedOutbox(identityKey)
    this.messageBox = dependencies.messageBox ?? messageBoxFor(wallet)
    this.relayAuthFetch = new AuthFetch(wallet, undefined, undefined, 'convo.metanet.app')
  }

  async list(): Promise<ConversationSecret[]> {
    return await this.secrets.list()
  }

  async pendingControl(): Promise<{
    invites: PendingInvite[]
    updates: PendingMembershipUpdate[]
  }> {
    try {
      for (let batch = 0; batch < 10; batch += 1) {
        const received = await listControlMessages(this.messageBox, async (invites, updates) => await this.secrets.updateControls(invites, updates))
        if (received.invites.length + received.updates.length < 100) break
      }
    } catch {
      const saved = await this.secrets.pendingControls()
      if (!saved.invites.length && !saved.updates.length) throw new Error('Private invitation sync needs a retry')
    }
    return await this.secrets.pendingControls()
  }

  async discoverWorkspaceRooms(conversations: ConversationSecret[], excludedConversationId?: string): Promise<WorkspaceRoomUpdate[]> {
    if (this.scanPromise) return await this.scanPromise
    this.scanPromise = (async () => {
      const updates = await listWorkspaceRoomUpdates(this.messageBox, this.identityKey, conversations, excludedConversationId,
        async (secret, event) => await this.inbox.receive(secret, event))
      const pending = conversations.filter((secret) => secret.conversationId !== excludedConversationId && this.inbox.events(secret).length > 0)
      // Reclaim confirmed recipient journals without an unbounded overlay fanout.
      for (let i = 0; i < Math.min(3, pending.length); i += 1) {
        const secret = pending[(this.reconciliationCursor + i) % pending.length]
        try {
          const confirmed = await this.store.read(secret, { tailPages: 3 })
          await this.inbox.reconcile(secret, confirmed.events)
        } catch { /* A journal remains encrypted and recoverable during overlay failure. */ }
      }
      if (pending.length) this.reconciliationCursor = (this.reconciliationCursor + 3) % pending.length
      return updates
    })()
    try { return await this.scanPromise } finally { this.scanPromise = null }
  }

  async create(title: string, participants: string[]): Promise<ConversationSecret> {
    const members = uniqueIdentities([this.identityKey, ...participants])
    if (members.length < 2) throw new Error('Choose at least one other participant')
    if (members.length > 100) throw new Error('A conversation supports at most 100 members')
    const now = Date.now()
    const epoch: ConversationEpoch = {
      epoch: 1,
      rootKey: generateRootKey(),
      members,
      admins: [this.identityKey],
      activatedAt: now,
    }
    const kind: ConversationKind = members.length === 2 ? 'direct' : 'group'
    const secret: ConversationSecret = {
      v: 2,
      conversationId: randomId(),
      kind,
      title: title.trim() ? assertTitle(title) : (kind === 'direct' ? 'Direct message' : 'New group'),
      currentEpoch: 1,
      epochs: [epoch],
      createdAt: now,
      updatedAt: now,
      preferences: defaultPreferences(),
    }
    const envelope = await sealEpochKey(this.wallet, secret.conversationId, epoch)
    const invite: ConversationInvite = {
      type: 'convo-v2-invite',
      v: 2,
      conversationId: secret.conversationId,
      title: secret.title,
      kind: secret.kind,
      epoch: 1,
      envelope,
      members,
      admins: epoch.admins,
      createdAt: now,
    }
    const metadataEvent = { ...this.baseEvent(secret), type: 'metadata' as const, title: secret.title }
    secret.pendingControl = members.filter((member) => member !== this.identityKey).map((recipient) => ({
      id: randomId(), recipient, body: invite, prerequisiteEventId: metadataEvent.id,
    }))
    await this.secrets.save(secret)
    await this.persistEvent(secret, metadataEvent, true)
    return await this.deliverPendingControl(secret)
  }

  async acceptInvite(pending: PendingInvite): Promise<ConversationSecret> {
    const { invite } = pending
    if (!invite.members.includes(this.identityKey)
      || !invite.members.includes(pending.sender)
      || !invite.admins.includes(pending.sender)) throw new Error('Invite membership is invalid')
    const existing = await this.secrets.get(invite.conversationId)
    if (existing) {
      const known = existing.epochs.find((epoch) => epoch.epoch === invite.epoch)
      if (!known || !known.admins.includes(pending.sender)) throw new Error('This invitation conflicts with an existing conversation')
      await acknowledgeControl(this.messageBox, pending.messageId)
      await this.secrets.updateControls([], [], pending.messageId)
      return existing
    }
    const rootKey = await openEpochKey(this.wallet, invite.conversationId, invite.epoch, invite.envelope)
    const epoch: ConversationEpoch = {
      epoch: invite.epoch,
      rootKey,
      members: uniqueIdentities(invite.members),
      admins: uniqueIdentities(invite.admins),
      activatedAt: invite.createdAt,
    }
    const secret: ConversationSecret = {
      v: 2,
      conversationId: invite.conversationId,
      kind: invite.kind,
      title: invite.title,
      currentEpoch: invite.epoch,
      epochs: [epoch],
      createdAt: invite.createdAt,
      updatedAt: Date.now(),
      preferences: defaultPreferences(),
    }
    await this.secrets.save(secret)
    await this.store.read(secret, { tailPages: 1 })
    await acknowledgeControl(this.messageBox, pending.messageId)
    await this.secrets.updateControls([], [], pending.messageId)
    return secret
  }

  async declineInvite(pending: PendingInvite): Promise<void> {
    await acknowledgeControl(this.messageBox, pending.messageId)
    await this.secrets.updateControls([], [], pending.messageId)
  }

  async acceptMembershipUpdate(pending: PendingMembershipUpdate): Promise<ConversationSecret> {
    const existing = await this.secrets.get(pending.update.conversationId)
    if (!existing) throw new Error('Membership update does not match a known conversation')
    const previous = currentEpoch(existing)
    const { update } = pending
    const alreadyAccepted = existing.epochs.find((epoch) => epoch.epoch === update.epoch)
    if (alreadyAccepted && existing.epochs.find((epoch) => epoch.epoch === update.epoch - 1)?.admins.includes(pending.sender)
      && sameIdentities(alreadyAccepted.members, update.members) && sameIdentities(alreadyAccepted.admins, update.admins)) {
      await acknowledgeControl(this.messageBox, pending.messageId)
      await this.secrets.updateControls([], [], pending.messageId)
      return existing
    }
    if (!previous.admins.includes(pending.sender)
      || update.epoch !== existing.currentEpoch + 1
      || !update.members.includes(this.identityKey)
      || !update.admins.includes(pending.sender)
      || update.previousEpochCommitment.closedAt !== update.createdAt) throw new Error('Unauthorized membership update')
    await this.flushOutbox()
    const snapshot = await this.store.read(existing, { tailPages: Number.MAX_SAFE_INTEGER })
    if (snapshot.partial) throw new Error('Cannot verify membership while encrypted history is incomplete')
    const closure = closeEpoch(snapshot.events, previous, update.createdAt)
    if (!matchesCommitment(closure, update)) throw new Error('Membership update does not commit the accepted history')
    const rootKey = await openEpochKey(this.wallet, update.conversationId, update.epoch, update.envelope)
    const closedPrevious: ConversationEpoch = { ...previous, closure }
    const epoch: ConversationEpoch = {
      epoch: update.epoch,
      rootKey,
      members: uniqueIdentities(update.members),
      admins: uniqueIdentities(update.admins),
      activatedAt: update.createdAt,
    }
    const secret: ConversationSecret = {
      ...existing,
      kind: existing.kind === 'group' || update.members.length > 2 ? 'group' : 'direct',
      title: update.title,
      currentEpoch: epoch.epoch,
      epochs: [...existing.epochs.map((item) => item.epoch === previous.epoch ? closedPrevious : item), epoch],
      updatedAt: Date.now(),
    }
    await this.secrets.save(secret)
    await this.store.read(secret, { tailPages: 1 })
    await acknowledgeControl(this.messageBox, pending.messageId)
    await this.secrets.updateControls([], [], pending.messageId)
    return secret
  }

  async load(secret: ConversationSecret, tailPages = 3): Promise<ConversationView> {
    const received = this.inbox.events(secret)
    const pending = this.outbox.list().filter((item) => item.conversationId === secret.conversationId)
      .map((item) => this.outbox.decrypt(secret, item))
    let result: Awaited<ReturnType<GlobalConversationStore['read']>>
    try { result = await this.store.read(secret, { tailPages }) }
    catch (error) {
      if (!received.length && !pending.length) throw error
      return { ...materializeConversation(secret, [...received, ...pending], true, 0), historyLoadFailed: true }
    }
    await this.inbox.reconcile(secret, result.events)
    return { ...materializeConversation(secret, [...result.events, ...received, ...pending], result.partial, result.loadedPages),
      hasMoreHistory: result.hasMoreHistory, historyLoadFailed: result.historyLoadFailed }
  }

  async sendMessage(
    secret: ConversationSecret,
    body: string,
    options: { replyTo?: string; attachments?: AttachmentReference[]; attachmentKey?: AttachmentKeyEnvelope } = {},
  ): Promise<MessageEvent> {
    const text = body.trim()
    if (!text && !options.attachments?.length) throw new Error('Message is empty')
    if (text.length > 20_000) throw new Error('Message is too long')
    if ((options.attachments?.length ?? 0) > 20) throw new Error('A message supports at most 20 attachments')
    if (((options.attachments?.length ?? 0) > 0) !== Boolean(options.attachmentKey)) throw new Error('Encrypted attachments require a CurvePoint key')
    if (!validAttachmentSet(options.attachments, options.attachmentKey, secret.conversationId, secret.currentEpoch)) {
      throw new Error('Encrypted attachment metadata is invalid')
    }
    const event: MessageEvent = {
      ...this.baseEvent(secret),
      type: 'message',
      body: text,
      replyTo: options.replyTo,
      attachments: options.attachments,
      attachmentKey: options.attachmentKey,
    }
    await this.persistEvent(secret, event)
    return event
  }

  async editMessage(secret: ConversationSecret, targetId: string, body: string): Promise<EditEvent> {
    const cleanBody = body.trim()
    if (cleanBody.length > 20_000) throw new Error('Message is too long')
    const event: EditEvent = { ...this.baseEvent(secret), type: 'edit', targetId, body: cleanBody }
    await this.persistEvent(secret, event)
    return event
  }

  async deleteMessage(secret: ConversationSecret, targetId: string): Promise<DeleteEvent> {
    const event: DeleteEvent = { ...this.baseEvent(secret), type: 'delete', targetId }
    await this.persistEvent(secret, event)
    return event
  }

  async react(secret: ConversationSecret, targetId: string, emoji: string, removed = false): Promise<ReactionEvent> {
    if (!emoji || emoji.length > 32) throw new Error('Reaction is invalid')
    const event: ReactionEvent = { ...this.baseEvent(secret), type: 'reaction', targetId, emoji, removed }
    await this.persistEvent(secret, event)
    return event
  }

  async changeMembership(
    secret: ConversationSecret,
    membersInput: string[],
    adminsInput: string[],
  ): Promise<ConversationSecret> {
    return await withConversationMutationLock(secret.conversationId, async () => {
      return await this.changeMembershipLocked(secret, membersInput, adminsInput)
    })
  }

  private async changeMembershipLocked(
    callerSecret: ConversationSecret,
    membersInput: string[],
    adminsInput: string[],
  ): Promise<ConversationSecret> {
    let secret = await this.secrets.get(callerSecret.conversationId) ?? callerSecret
    let previous = currentEpoch(secret)
    if (!previous.admins.includes(this.identityKey)) throw new Error('Only an administrator can change membership')
    const members = uniqueIdentities(membersInput)
    const admins = uniqueIdentities(adminsInput)
    if (members.length < 2) throw new Error('A conversation requires at least two members')
    if (members.length > 100) throw new Error('A conversation supports at most 100 members')
    if (!members.includes(this.identityKey) || admins.some((admin) => !members.includes(admin)) || admins.length === 0) {
      throw new Error('Membership must retain the current administrator and at least one administrator')
    }
    await this.flushOutbox()
    secret = await this.secrets.get(secret.conversationId) ?? secret
    if (secret.pendingControl?.length) secret = await this.deliverPendingControl(secret)
    previous = currentEpoch(secret)
    if (sameIdentities(members, previous.members) && sameIdentities(admins, previous.admins)) return secret
    if (secret.pendingControl?.length) {
      throw new Error('The previous encrypted membership update is still syncing. It will retry automatically.')
    }
    if (!previous.admins.includes(this.identityKey)) throw new Error('Only an administrator can change membership')
    const snapshot = await this.store.read(secret, { tailPages: Number.MAX_SAFE_INTEGER })
    if (snapshot.partial) throw new Error('Cannot rotate membership until the complete encrypted history is available')
    const closedAt = Date.now()
    const closure = closeEpoch(snapshot.events, previous, closedAt)
    const closedPrevious: ConversationEpoch = { ...previous, closure }
    const epoch: ConversationEpoch = {
      epoch: secret.currentEpoch + 1,
      rootKey: generateRootKey(),
      members,
      admins,
      activatedAt: closedAt,
    }
    const kind: ConversationKind = secret.kind === 'group' || members.length > 2 ? 'group' : 'direct'
    let updated: ConversationSecret = {
      ...secret,
      kind,
      currentEpoch: epoch.epoch,
      epochs: [...secret.epochs.map((item) => item.epoch === previous.epoch ? closedPrevious : item), epoch],
      updatedAt: Date.now(),
    }
    const envelope = await sealEpochKey(this.wallet, secret.conversationId, epoch)
    const update: MembershipUpdate = {
      type: 'convo-v2-membership',
      v: 2,
      conversationId: secret.conversationId,
      title: secret.title,
      epoch: epoch.epoch,
      envelope,
      members,
      admins,
      createdAt: epoch.activatedAt,
      previousEpochCommitment: {
        closedAt: closure.closedAt,
        eventCount: closure.eventCount,
        historyDigest: closure.historyDigest,
      },
    }
    const membershipEvent: MembershipEvent = {
      ...this.baseEvent(updated),
      type: 'membership',
      members,
      admins,
      previousEpoch: previous.epoch,
    }
    updated = {
      ...updated,
      pendingControl: members.filter((member) => member !== this.identityKey).map((recipient): PendingControlDelivery => ({
        id: randomId(),
        recipient,
        prerequisiteEventId: membershipEvent.id,
        body: previous.members.includes(recipient) ? update : {
          type: 'convo-v2-invite',
          v: 2,
          conversationId: secret.conversationId,
          title: secret.title,
          kind,
          epoch: epoch.epoch,
          envelope,
          members,
          admins,
          createdAt: epoch.activatedAt,
        },
      })),
    }
    await this.secrets.save(updated)
    await this.persistEvent(updated, membershipEvent, true)
    return await this.deliverPendingControl(updated)
  }

  async rename(secret: ConversationSecret, title: string): Promise<ConversationSecret> {
    const cleanTitle = assertTitle(title)
    const epoch = currentEpoch(secret)
    if (!epoch.admins.includes(this.identityKey)) throw new Error('Only an administrator can rename this conversation')
    const updated = { ...secret, title: cleanTitle, updatedAt: Date.now() }
    await this.secrets.save(updated)
    await this.persistEvent(updated, { ...this.baseEvent(updated), type: 'metadata', title: cleanTitle })
    return updated
  }

  async setPreferences(secret: ConversationSecret, patch: Partial<ConversationSecret['preferences']>): Promise<ConversationSecret> {
    const latest = await this.secrets.get(secret.conversationId) ?? secret
    const updated = { ...latest, preferences: { ...latest.preferences, ...patch } }
    await this.secrets.save(updated)
    return updated
  }

  async openLive(secret: ConversationSecret, callbacks: {
    onSync: () => Promise<void>
    onError?: (message: string) => void
    onState: (state: 'connecting' | 'live' | 'fallback') => void
    onEvent: (event: ConversationEvent) => void
    onDelivery: (eventId: string, state: MessageDeliveryState) => void
    onPeersChange?: (peers: RealtimePeer[]) => void
    onTypingChange?: (peers: TypingPeer[]) => void
    onCallChange?: (call: CallSnapshot) => void
    onRoomChange?: (room: MeetingRoomSnapshot | null) => void
  }): Promise<void> {
    const request = ++this.liveRequest
    await this.closeLive(false)
    if (request !== this.liveRequest) return
    this.liveCallbacks = { onEvent: callbacks.onEvent, onDelivery: callbacks.onDelivery }
    this.transport = new ConversationTransport({
      clientFactory: () => messageBoxFor(this.wallet),
      identityKey: this.identityKey,
      conversationId: secret.conversationId,
      epoch: currentEpoch(secret),
      onEvent: async (event) => {
        try { await this.inbox.receive(secret, event) }
        catch (error) { callbacks.onError?.('Incoming messages could not be saved on this device. Check browser storage; messages remain queued for retry.'); throw error }
        callbacks.onEvent(event)
      },
      onSyncRequested: callbacks.onSync,
      onState: callbacks.onState,
      onPeersChange: callbacks.onPeersChange,
      onTypingChange: callbacks.onTypingChange,
      onCallSignal: async (sender, signal) => await this.callManager?.handleSignal(sender, signal),
    })
    this.callManager = new AuthenticatedCallManager({
      wallet: this.wallet,
      identityKey: this.identityKey,
      conversationId: secret.conversationId,
      epoch: currentEpoch(secret),
      sendSignal: async (recipient, signal) => await this.transport?.publishCallSignal(recipient, signal) ?? false,
      onChange: callbacks.onCallChange ?? (() => undefined),
      isGroupConversation: secret.kind === 'group',
      onRoomChange: callbacks.onRoomChange,
      getIceServers: async () => await this.resolveIceServers(),
    })
    this.transportConversationId = secret.conversationId
    await this.transport.start()
    void this.flushOutbox().catch(() => undefined)
  }

  async closeLive(invalidate = true): Promise<void> {
    if (invalidate) this.liveRequest += 1
    const active = this.transport
    const activeCall = this.callManager
    this.callManager = null
    this.transport = null
    this.transportConversationId = null
    this.liveCallbacks = null
    if (activeCall) await activeCall.stop()
    if (active) await active.stop()
  }

  publishTyping(active: boolean): void {
    this.transport?.publishTyping(active)
  }

  async startCall(peerIdentityKeys: string[], media: CallMedia): Promise<void> {
    if (!this.callManager) throw new Error('Open a conversation before starting a call')
    await this.callManager.startCall(peerIdentityKeys, media)
  }

  async acceptCall(): Promise<void> { await this.callManager?.accept() }
  async joinMeetingRoom(): Promise<void> {
    if (!this.callManager) throw new Error('Open a conversation before joining a meeting room')
    await this.callManager.joinRoom()
  }
  discoverMeetingRoom(room: MeetingRoomSnapshot): void { this.callManager?.discoverRoom(room) }
  async closeDiscoveredMeetingRoom(sender: string, callId: string): Promise<void> { await this.callManager?.closeDiscoveredRoom(sender, callId) }
  async declineCall(): Promise<void> { await this.callManager?.decline() }
  async hangupCall(): Promise<void> { await this.callManager?.hangup() }
  dismissCall(): void { this.callManager?.dismiss() }
  toggleCallAudio(): void { this.callManager?.toggleAudio() }
  toggleCallVideo(): void { this.callManager?.toggleVideo() }

  private async resolveIceServers(): Promise<RTCIceServer[]> {
    const configured = import.meta.env.VITE_CONVO_ICE_SERVERS?.trim()
    if (configured) return this.validateIceServers(JSON.parse(configured))
    const configurationUrl = import.meta.env.VITE_CONVO_ICE_CONFIG_URL?.trim()
      || 'https://convo-rtc-credentials-921101068003.us-west1.run.app/ice'
    try {
      const parsedUrl = new URL(configurationUrl)
      if (parsedUrl.protocol !== 'https:') throw new Error('The call relay configuration URL must use HTTPS')
      let timeout: ReturnType<typeof setTimeout> | undefined
      const response = await Promise.race([
        this.relayAuthFetch.fetch(parsedUrl.href),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('The call relay configuration timed out')), 8_000)
        }),
      ]).finally(() => clearTimeout(timeout))
      if (!response.ok) throw new Error(`The call relay rejected ICE configuration (${response.status})`)
      const encoded = await response.text()
      if (encoded.length > 64_000) throw new Error('The call relay configuration is too large')
      const body = JSON.parse(encoded) as { iceServers?: unknown }
      return this.validateIceServers(body.iceServers)
    } catch {
      // Direct peer connectivity remains available if the optional relay is degraded.
      return defaultIceServers()
    }
  }

  private validateIceServers(value: unknown): RTCIceServer[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new Error('Call relay configuration is invalid')
    return value.map((candidate) => {
      if (typeof candidate !== 'object' || candidate === null) throw new Error('Call relay configuration is invalid')
      const server = candidate as { urls?: unknown; username?: unknown; credential?: unknown }
      const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
      if (!Array.isArray(urls) || urls.length === 0 || urls.length > 8
        || !urls.every((url) => typeof url === 'string' && url.length <= 2_048 && /^(stun|stuns|turn|turns):/i.test(url))) {
        throw new Error('Call relay URLs are invalid')
      }
      if ((server.username !== undefined && (typeof server.username !== 'string' || server.username.length > 512))
        || (server.credential !== undefined && (typeof server.credential !== 'string' || server.credential.length > 1_024))) {
        throw new Error('Call relay credentials are invalid')
      }
      return {
        urls: typeof server.urls === 'string' ? server.urls : urls,
        username: server.username as string | undefined,
        credential: server.credential as string | undefined,
      }
    })
  }

  async flushOutbox(): Promise<void> {
    if (this.outboxFlushPromise !== null) {
      await this.outboxFlushPromise
      if (this.outbox.list().some((item) => item.state === 'queued' || item.state === 'writing')) {
        return await this.flushOutbox()
      }
      return
    }
    this.outboxFlushPromise = this.flushOutboxOnce().finally(() => {
      this.outboxFlushPromise = null
    })
    await this.outboxFlushPromise
  }

  private async flushOutboxOnce(): Promise<void> {
    for (const item of this.outbox.list()) {
      const secret = await this.secrets.get(item.conversationId)
      if (!secret) continue
      try {
        const event = this.outbox.decrypt(secret, item)
        if (item.state !== 'confirmed') {
          this.outbox.update(item.id, { state: 'writing', attempts: item.attempts + 1, lastError: undefined })
          await this.store.append(secret, this.identityKey, event)
          this.outbox.update(item.id, { state: 'confirmed' })
          if (this.transportConversationId === secret.conversationId) this.liveCallbacks?.onDelivery(event.id, 'saved')
        }
        const accepted = await this.forwardQueuedEvent(secret, event)
        const expected = Math.max(0, secret.epochs.find((epoch) => epoch.epoch === event.epoch)!.members.length - 1)
        if (accepted === expected) {
          this.outbox.update(item.id, { state: 'notified' })
          this.outbox.remove(item.id)
          if (this.transportConversationId === secret.conversationId) this.liveCallbacks?.onDelivery(event.id, 'saved')
        }
      } catch (error) {
        const durable = this.outbox.list().find((candidate) => candidate.id === item.id)?.state === 'confirmed'
        this.outbox.update(item.id, { state: durable ? 'confirmed' : 'failed', lastError: safeWriteError(error) })
        if (this.transportConversationId === item.conversationId) this.liveCallbacks?.onDelivery(item.id, 'retrying')
        throw new EncryptedOutboxRetryError(error)
      }
    }
  }

  private async forwardQueuedEvent(secret: ConversationSecret, event: ConversationEvent): Promise<number> {
    const existing = this.forwarding.get(event.id)
    if (existing) return await existing
    const operation = withConversationMutationLock(`forward:${this.identityKey}:${event.id}`, async () => {
      const item = this.outbox.list().find((candidate) => candidate.id === event.id)
      const epoch = secret.epochs.find((candidate) => candidate.epoch === event.epoch)!
      if (!item) return Math.max(0, epoch.members.length - 1)
      const accepted = new Set(this.outbox.acceptedRecipients(secret, item))
      const remaining = epoch.members.filter((member) => member !== this.identityKey && !accepted.has(member))
      const onAccepted = (recipient: string) => {
        accepted.add(recipient)
        if (item) this.outbox.recordAccepted(secret, item, [...accepted])
      }
      if (remaining.length) {
        if (this.transport && this.transportConversationId === secret.conversationId && event.epoch === secret.currentEpoch) {
          await this.transport.publishEvent(event, remaining, onAccepted)
        } else await forwardStoredEvent(this.messageBox, secret, event, remaining, onAccepted)
      }
      return accepted.size
    })
    this.forwarding.set(event.id, operation)
    try { return await operation } finally { this.forwarding.delete(event.id) }
  }

  async flushControlOutbox(): Promise<void> {
    for (const secret of await this.secrets.list()) await this.deliverPendingControl(secret)
  }

  private async deliverPendingControl(secret: ConversationSecret): Promise<ConversationSecret> {
    let updated = secret
    for (const delivery of secret.pendingControl ?? []) {
      const prerequisite = delivery.prerequisiteEventId
        ? this.outbox.list().find((item) => item.id === delivery.prerequisiteEventId)
        : undefined
      if (prerequisite && prerequisite.state !== 'confirmed' && prerequisite.state !== 'notified') continue
      try {
        if (delivery.body.type === 'convo-v2-invite') await sendInvite(this.messageBox, delivery.recipient, delivery.body)
        else await sendMembershipUpdate(this.messageBox, delivery.recipient, delivery.body)
        updated = {
          ...updated,
          pendingControl: (updated.pendingControl ?? []).filter((candidate) => candidate.id !== delivery.id),
          updatedAt: Date.now(),
        }
        await this.secrets.save(updated)
      } catch {
        // The exact wallet-private envelope remains queued for the next startup or mutation.
      }
    }
    return updated
  }

  private baseEvent(secret: ConversationSecret): EventBase {
    return {
      v: 2,
      id: randomId(),
      conversationId: secret.conversationId,
      epoch: secret.currentEpoch,
      sender: this.identityKey,
      createdAt: Date.now(),
    }
  }

  private async persistEvent(secret: ConversationSecret, event: ConversationEvent, awaitDurable = false): Promise<void> {
    this.outbox.enqueue(secret, event)
    const activeTransport = this.transport && this.transportConversationId === secret.conversationId
      ? this.transport
      : null
    if (activeTransport) {
      this.liveCallbacks?.onEvent(event)
      this.liveCallbacks?.onDelivery(event.id, 'sending')
      const expected = Math.max(0, currentEpoch(secret).members.length - 1)
      void this.forwardQueuedEvent(secret, event).then((delivered) => {
        if (delivered === expected && this.transportConversationId === secret.conversationId) {
          this.liveCallbacks?.onDelivery(event.id, 'live')
        }
      }).catch(() => undefined)
    }
    const updated = { ...secret, updatedAt: event.createdAt }
    await this.secrets.save(updated).catch(() => undefined)
    if (awaitDurable) await this.flushOutbox()
    else void this.flushOutbox().catch(() => undefined)
  }
}
