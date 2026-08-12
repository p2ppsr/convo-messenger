import { MessageBoxClient } from '@bsv/message-box-client'
import { CurvePoint } from 'curvepoint'
import { Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { decryptJson, encryptJson, liveBoxName, randomId } from '../domain/crypto'
import { MAX_ATTACHMENT_BYTES } from '../services/attachments'
import type {
  ConversationEvent,
  ConversationEpoch,
  ConversationInvite,
  EpochCommitment,
  MembershipUpdate,
} from '../domain/types'

export const MESSAGEBOX_HOST = 'https://messagebox.babbage.systems'
export const INVITES_BOX = 'convo-v2-invites'
const PROTOCOL_ID: WalletProtocol = [2, 'Convo Messenger']

export interface PendingInvite {
  messageId: string
  sender: string
  invite: ConversationInvite
}

export interface PendingMembershipUpdate {
  messageId: string
  sender: string
  update: MembershipUpdate
}

export function messageBoxFor(wallet: WalletInterface): MessageBoxClient {
  return new MessageBoxClient({ walletClient: wallet, host: MESSAGEBOX_HOST, networkPreset: 'mainnet' })
}

export async function sealEpochKey(
  wallet: WalletInterface,
  conversationId: string,
  epoch: ConversationEpoch,
): Promise<string> {
  const curvePoint = new CurvePoint(wallet)
  const { header, encryptedMessage } = await curvePoint.encrypt(
    Utils.toArray(epoch.rootKey, 'base64'),
    PROTOCOL_ID,
    `${conversationId}:${epoch.epoch}`,
    epoch.members,
  )
  return Utils.toBase64([...header, ...encryptedMessage])
}

export async function openEpochKey(
  wallet: WalletInterface,
  conversationId: string,
  epoch: number,
  envelope: string,
): Promise<string> {
  const curvePoint = new CurvePoint(wallet)
  const bytes = await curvePoint.decrypt(
    Utils.toArray(envelope, 'base64'),
    PROTOCOL_ID,
    `${conversationId}:${epoch}`,
  )
  return Utils.toBase64(bytes)
}

export async function sendInvite(
  client: MessageBoxClient,
  recipient: string,
  invite: ConversationInvite,
): Promise<void> {
  await client.sendMessage({ recipient, messageBox: INVITES_BOX, body: invite }, MESSAGEBOX_HOST)
}

export async function sendMembershipUpdate(
  client: MessageBoxClient,
  recipient: string,
  update: MembershipUpdate,
): Promise<void> {
  await client.sendMessage({ recipient, messageBox: INVITES_BOX, body: update }, MESSAGEBOX_HOST)
}

export async function listControlMessages(client: MessageBoxClient): Promise<{
  invites: PendingInvite[]
  updates: PendingMembershipUpdate[]
}> {
  const messages = await client.listMessages({ messageBox: INVITES_BOX, host: MESSAGEBOX_HOST })
  const invites: PendingInvite[] = []
  const updates: PendingMembershipUpdate[] = []
  for (const message of messages) {
    const body = typeof message.body === 'string' ? safeJson(message.body) : message.body
    if (isInvite(body)) invites.push({ messageId: message.messageId, sender: message.sender, invite: body })
    if (isMembershipUpdate(body)) updates.push({ messageId: message.messageId, sender: message.sender, update: body })
  }
  return { invites, updates }
}

export async function acknowledgeControl(client: MessageBoxClient, messageId: string): Promise<void> {
  await client.acknowledgeMessage({ messageIds: [messageId], host: MESSAGEBOX_HOST })
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return null }
}

function validMembership(members: unknown, admins: unknown): members is string[] {
  return Array.isArray(members)
    && members.length >= 2 && members.length <= 100
    && new Set(members).size === members.length
    && members.every((member) => typeof member === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(member))
    && Array.isArray(admins)
    && admins.length > 0
    && new Set(admins).size === admins.length
    && admins.every((admin) => typeof admin === 'string' && members.includes(admin))
}

function isInvite(value: unknown): value is ConversationInvite {
  if (typeof value !== 'object' || value === null) return false
  const invite = value as Partial<ConversationInvite>
  return invite.type === 'convo-v2-invite'
    && invite.v === 2
    && typeof invite.conversationId === 'string' && /^[0-9a-f]{64}$/.test(invite.conversationId)
    && typeof invite.title === 'string' && invite.title.length > 0 && invite.title.length <= 100
    && (invite.kind === 'direct' || invite.kind === 'group')
    && typeof invite.envelope === 'string' && invite.envelope.length > 0 && invite.envelope.length <= 1_000_000
    && typeof invite.epoch === 'number' && Number.isSafeInteger(invite.epoch) && invite.epoch > 0
    && typeof invite.createdAt === 'number' && Number.isFinite(invite.createdAt)
    && validMembership(invite.members, invite.admins)
}

function isMembershipUpdate(value: unknown): value is MembershipUpdate {
  if (typeof value !== 'object' || value === null) return false
  const update = value as Partial<MembershipUpdate>
  return update.type === 'convo-v2-membership'
    && update.v === 2
    && typeof update.conversationId === 'string' && /^[0-9a-f]{64}$/.test(update.conversationId)
    && typeof update.title === 'string' && update.title.length > 0 && update.title.length <= 100
    && typeof update.envelope === 'string' && update.envelope.length > 0 && update.envelope.length <= 1_000_000
    && typeof update.epoch === 'number' && Number.isSafeInteger(update.epoch) && update.epoch > 1
    && typeof update.createdAt === 'number' && Number.isFinite(update.createdAt)
    && validCommitment(update.previousEpochCommitment)
    && update.previousEpochCommitment.closedAt === update.createdAt
    && validMembership(update.members, update.admins)
}

function validCommitment(value: unknown): value is EpochCommitment {
  if (typeof value !== 'object' || value === null) return false
  const commitment = value as { closedAt?: unknown; eventCount?: unknown; historyDigest?: unknown }
  return typeof commitment.closedAt === 'number' && Number.isFinite(commitment.closedAt)
    && typeof commitment.eventCount === 'number' && Number.isSafeInteger(commitment.eventCount) && commitment.eventCount >= 0
    && typeof commitment.historyDigest === 'string' && /^[0-9a-f]{64}$/.test(commitment.historyDigest)
}

const PRESENCE_INTERVAL_MS = 8_000
const PRESENCE_TIMEOUT_MS = 24_000
const RECONCILE_INTERVAL_MS = 12_000
const INBOX_DRAIN_INTERVAL_MS = 30_000
const TYPING_REFRESH_MS = 2_000
const TYPING_TIMEOUT_MS = 5_000
const TYPING_IDLE_MS = 2_500
const SOCKET_RECONNECT_BASE_MS = 1_000
const SOCKET_RECONNECT_MAX_MS = 30_000

export interface RealtimePeer {
  identityKey: string
  lastSeen: number
}

export interface TypingPeer extends RealtimePeer {
  expiresAt: number
}

interface LiveEnvelope {
  type: 'convo-v2-live'
  v: 2
  envelopeId: string
  ciphertext: string
}

interface LivePayload {
  conversationId: string
  epoch: number
  kind: 'event' | 'presence' | 'typing' | 'reconcile'
  sentAt: number
  event?: ConversationEvent
  presence?: 'join' | 'ping' | 'leave'
  typing?: boolean
  expiresAt?: number
}

export interface ConversationTransportOptions {
  clientFactory: () => MessageBoxClient
  identityKey: string
  conversationId: string
  epoch: ConversationEpoch
  onEvent: (event: ConversationEvent) => void | Promise<void>
  onSyncRequested: () => Promise<void>
  onState: (state: 'connecting' | 'live' | 'fallback') => void
  onPeersChange?: (peers: RealtimePeer[]) => void
  onTypingChange?: (peers: TypingPeer[]) => void
}

function isLiveEnvelope(value: unknown): value is LiveEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as Partial<LiveEnvelope>
  return envelope.type === 'convo-v2-live'
    && envelope.v === 2
    && typeof envelope.envelopeId === 'string' && /^[0-9a-f]{64}$/.test(envelope.envelopeId)
    && typeof envelope.ciphertext === 'string' && envelope.ciphertext.length > 0 && envelope.ciphertext.length <= 100_000
}

function isEvent(value: unknown, conversationId: string, epoch: ConversationEpoch, sender: string): value is ConversationEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<ConversationEvent>
  if (event.v !== 2
    || typeof event.id !== 'string' || !/^[0-9a-f]{64}$/.test(event.id)
    || event.conversationId !== conversationId
    || event.epoch !== epoch.epoch
    || event.sender !== sender
    || typeof event.createdAt !== 'number' || !Number.isSafeInteger(event.createdAt)
    || event.createdAt < epoch.activatedAt - 300_000
    || event.createdAt > Date.now() + 300_000) return false
  if (event.type === 'message') {
    return typeof event.body === 'string' && event.body.length <= 20_000
      && (event.replyTo === undefined || (typeof event.replyTo === 'string' && /^[0-9a-f]{64}$/.test(event.replyTo)))
      && (event.attachments === undefined || (Array.isArray(event.attachments) && event.attachments.length <= 20
        && event.attachments.every((attachment) => typeof attachment === 'object' && attachment !== null
          && typeof attachment.id === 'string' && /^[0-9a-f]{64}$/.test(attachment.id)
          && typeof attachment.handle === 'string' && attachment.handle.length > 0 && attachment.handle.length <= 2_048
          && typeof attachment.name === 'string' && attachment.name.length > 0 && attachment.name.length <= 255
          && typeof attachment.mimeType === 'string' && attachment.mimeType.length > 0 && attachment.mimeType.length <= 255
          && Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= MAX_ATTACHMENT_BYTES
          && typeof attachment.digest === 'string' && /^[0-9a-f]{64}$/.test(attachment.digest))))
  }
  if (event.type === 'edit') return typeof event.targetId === 'string' && /^[0-9a-f]{64}$/.test(event.targetId)
    && typeof event.body === 'string' && event.body.length <= 20_000
  if (event.type === 'delete') return typeof event.targetId === 'string' && /^[0-9a-f]{64}$/.test(event.targetId)
  if (event.type === 'reaction') return typeof event.targetId === 'string' && /^[0-9a-f]{64}$/.test(event.targetId)
    && typeof event.emoji === 'string' && event.emoji.length > 0 && event.emoji.length <= 32
  if (event.type === 'metadata') return epoch.admins.includes(sender)
    && (event.title === undefined || (typeof event.title === 'string' && event.title.length > 0 && event.title.length <= 100))
  if (event.type === 'membership') return epoch.admins.includes(sender)
    && event.previousEpoch === epoch.epoch - 1
    && Array.isArray(event.members) && event.members.length === epoch.members.length
    && event.members.every((member, index) => member === epoch.members[index])
    && Array.isArray(event.admins) && event.admins.length === epoch.admins.length
    && event.admins.every((admin, index) => admin === epoch.admins[index])
  return false
}

function isLivePayload(value: unknown, conversationId: string, epoch: ConversationEpoch, sender: string): value is LivePayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Partial<LivePayload>
  if (payload.conversationId !== conversationId
    || payload.epoch !== epoch.epoch
    || typeof payload.sentAt !== 'number' || !Number.isFinite(payload.sentAt)) return false
  if (payload.kind === 'event') return isEvent(payload.event, conversationId, epoch, sender)
  if (payload.kind === 'presence') return payload.presence === 'join' || payload.presence === 'ping' || payload.presence === 'leave'
  if (payload.kind === 'typing') return typeof payload.typing === 'boolean'
    && typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt)
  return payload.kind === 'reconcile'
}

export class ConversationTransport {
  private client: MessageBoxClient | null = null
  private drainTimer: ReturnType<typeof setInterval> | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  private typingPruneTimer: ReturnType<typeof setInterval> | null = null
  private typingIdleTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private outboundTail: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly processed = new Set<string>()
  private readonly processedEvents = new Set<string>()
  private readonly peers = new Map<string, RealtimePeer>()
  private readonly typingPeers = new Map<string, TypingPeer>()
  private localTyping = false
  private lastTypingSentAt = 0
  private readonly visibilityHandler = () => {
    if (document.visibilityState === 'visible') {
      void this.drain()
      void this.options.onSyncRequested()
    }
  }
  private readonly pageHideHandler = () => {
    void this.publishPresence('leave')
    void this.publishTyping(false)
  }

  constructor(private readonly options: ConversationTransportOptions) {}

  private boxFor(recipient: string): string {
    return liveBoxName(this.options.epoch.rootKey, recipient)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connectLiveSocket()
    await this.drain()
    document.addEventListener('visibilitychange', this.visibilityHandler)
    window.addEventListener('pagehide', this.pageHideHandler)
    await this.publishPresence('join')
    this.drainTimer = setInterval(() => { void this.drain() }, INBOX_DRAIN_INTERVAL_MS)
    this.reconcileTimer = setInterval(() => {
      void this.options.onSyncRequested()
    }, RECONCILE_INTERVAL_MS)
    this.presenceTimer = setInterval(() => {
      void this.publishPresence('ping')
      this.prunePeers()
    }, PRESENCE_INTERVAL_MS)
    this.typingPruneTimer = setInterval(() => this.pruneTyping(), 1_000)
  }

  private async connectLiveSocket(): Promise<void> {
    if (this.stopped) return
    this.options.onState('connecting')
    const previous = this.client
    const client = this.options.clientFactory()
    this.client = client
    if (previous && previous !== client) void previous.disconnectWebSocket().catch(() => undefined)
    try {
      await client.listenForLiveMessages({
        messageBox: this.boxFor(this.options.identityKey),
        overrideHost: MESSAGEBOX_HOST,
        onMessage: (message) => { void this.handle(message.messageId, message.sender, message.body) },
      })
      if (this.stopped || this.client !== client) return
      this.reconnectAttempt = 0
      client.testSocket?.on('disconnect', () => {
        if (this.stopped || this.client !== client) return
        this.options.onState('fallback')
        this.scheduleReconnect()
      })
      this.options.onState('live')
      await this.publishPresence('join')
      void this.options.onSyncRequested()
    } catch {
      if (this.stopped || this.client !== client) return
      this.options.onState('fallback')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = Math.min(SOCKET_RECONNECT_BASE_MS * (2 ** this.reconnectAttempt), SOCKET_RECONNECT_MAX_MS)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectLiveSocket()
    }, delay)
  }

  private async handle(messageId: string, sender: string, rawBody: unknown): Promise<void> {
    if (this.stopped || this.processed.has(messageId)) return
    const body = typeof rawBody === 'string' ? safeJson(rawBody) : rawBody
    if (!isLiveEnvelope(body)) {
      await this.acknowledge(messageId)
      return
    }
    let payload: LivePayload
    try {
      payload = decryptJson<LivePayload>(this.options.epoch.rootKey, `live:${body.envelopeId}`, body.ciphertext)
    } catch {
      await this.acknowledge(messageId)
      return
    }
    if (!isLivePayload(payload, this.options.conversationId, this.options.epoch, sender)) {
      await this.acknowledge(messageId)
      return
    }
    this.processed.add(messageId)
    this.trimSet(this.processed)
    if (this.options.epoch.members.includes(sender)) await this.applyPayload(sender, payload)
    await this.acknowledge(messageId)
  }

  private async acknowledge(messageId: string): Promise<void> {
    await this.client?.acknowledgeMessage({ messageIds: [messageId], host: MESSAGEBOX_HOST }).catch(() => undefined)
  }

  private isFresh(sentAt: number): boolean {
    const age = Date.now() - sentAt
    return age >= -300_000 && age < PRESENCE_TIMEOUT_MS
  }

  private async applyPayload(sender: string, payload: LivePayload): Promise<void> {
    if (payload.kind === 'event' && payload.event) {
      if (this.processedEvents.has(payload.event.id)) return
      this.processedEvents.add(payload.event.id)
      this.trimSet(this.processedEvents)
      if (this.isFresh(payload.sentAt)) this.notePeer(sender)
      await this.options.onEvent(payload.event)
      return
    }
    if (payload.kind === 'presence') {
      if (!this.isFresh(payload.sentAt)) return
      if (payload.presence === 'leave') {
        this.peers.delete(sender)
        this.typingPeers.delete(sender)
      } else this.notePeer(sender)
      this.emitActivity()
      return
    }
    if (payload.kind === 'typing') {
      if (!this.isFresh(payload.sentAt)) return
      this.notePeer(sender)
      if (payload.typing && (payload.expiresAt ?? 0) > Date.now()) {
        this.typingPeers.set(sender, { identityKey: sender, lastSeen: Date.now(), expiresAt: payload.expiresAt as number })
      } else this.typingPeers.delete(sender)
      this.emitActivity()
      return
    }
    if (payload.kind === 'reconcile') {
      if (this.isFresh(payload.sentAt)) this.notePeer(sender)
      await this.options.onSyncRequested()
    }
  }

  async drain(): Promise<void> {
    const client = this.client
    if (this.stopped || client === null) return
    try {
      const messages = await client.listMessages({ messageBox: this.boxFor(this.options.identityKey), host: MESSAGEBOX_HOST })
      for (const message of messages) await this.handle(message.messageId, message.sender, message.body)
    } catch {
      this.options.onState('fallback')
      this.scheduleReconnect()
    }
  }

  async publishEvent(event: ConversationEvent): Promise<number> {
    if (!isEvent(event, this.options.conversationId, this.options.epoch, this.options.identityKey)) {
      throw new Error('Cannot publish an invalid realtime conversation event')
    }
    return await this.publishPayload({ kind: 'event', event })
  }

  publishTyping(active: boolean): void {
    if (this.stopped) return
    if (this.typingIdleTimer !== null) clearTimeout(this.typingIdleTimer)
    if (active) {
      const now = Date.now()
      if (!this.localTyping || now - this.lastTypingSentAt >= TYPING_REFRESH_MS) {
        this.localTyping = true
        this.lastTypingSentAt = now
        void this.publishPayload({ kind: 'typing', typing: true, expiresAt: now + TYPING_TIMEOUT_MS })
      }
      this.typingIdleTimer = setTimeout(() => this.publishTyping(false), TYPING_IDLE_MS)
    } else if (this.localTyping) {
      this.localTyping = false
      void this.publishPayload({ kind: 'typing', typing: false, expiresAt: Date.now() })
    }
  }

  private async publishPresence(presence: 'join' | 'ping' | 'leave'): Promise<number> {
    return await this.publishPayload({ kind: 'presence', presence })
  }

  private async publishPayload(partial: Omit<LivePayload, 'conversationId' | 'epoch' | 'sentAt'>): Promise<number> {
    const envelopeId = randomId()
    const payload: LivePayload = {
      ...partial,
      conversationId: this.options.conversationId,
      epoch: this.options.epoch.epoch,
      sentAt: Date.now(),
    }
    const envelope: LiveEnvelope = {
      type: 'convo-v2-live',
      v: 2,
      envelopeId,
      ciphertext: encryptJson(this.options.epoch.rootKey, `live:${envelopeId}`, payload, 1_024),
    }
    let delivered = 0
    for (const recipient of this.options.epoch.members.filter((member) => member !== this.options.identityKey)) {
      if (await this.sendPrepared(recipient, envelope)) delivered += 1
    }
    return delivered
  }

  private async sendPrepared(recipient: string, envelope: LiveEnvelope): Promise<boolean> {
    let delivered = false
    const queued = this.outboundTail.then(async () => {
      const client = this.client
      if (client === null || this.stopped) return
      try {
        await client.sendLiveMessage({ recipient, messageBox: this.boxFor(recipient), body: envelope }, MESSAGEBOX_HOST)
        delivered = true
      } catch {
        this.options.onState('fallback')
        this.scheduleReconnect()
      }
    })
    this.outboundTail = queued.catch(() => undefined)
    await queued
    return delivered
  }

  private notePeer(identityKey: string): void {
    if (identityKey === this.options.identityKey) return
    this.peers.set(identityKey, { identityKey, lastSeen: Date.now() })
    this.emitActivity()
  }

  private prunePeers(): void {
    const now = Date.now()
    for (const [identityKey, peer] of this.peers) {
      if (now - peer.lastSeen >= PRESENCE_TIMEOUT_MS) {
        this.peers.delete(identityKey)
        this.typingPeers.delete(identityKey)
      }
    }
    this.emitActivity()
  }

  private pruneTyping(): void {
    const now = Date.now()
    let changed = false
    for (const [identityKey, peer] of this.typingPeers) {
      if (peer.expiresAt <= now) {
        this.typingPeers.delete(identityKey)
        changed = true
      }
    }
    if (changed) this.emitActivity()
  }

  private emitActivity(): void {
    this.options.onPeersChange?.([...this.peers.values()])
    this.options.onTypingChange?.([...this.typingPeers.values()])
  }

  private trimSet(set: Set<string>): void {
    while (set.size > 1_000) {
      const oldest = set.values().next().value as string | undefined
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  async stop(): Promise<void> {
    await this.publishPresence('leave').catch(() => undefined)
    this.publishTyping(false)
    this.stopped = true
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    window.removeEventListener('pagehide', this.pageHideHandler)
    if (this.drainTimer) clearInterval(this.drainTimer)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    if (this.presenceTimer) clearInterval(this.presenceTimer)
    if (this.typingPruneTimer) clearInterval(this.typingPruneTimer)
    if (this.typingIdleTimer) clearTimeout(this.typingIdleTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.drainTimer = null
    this.reconcileTimer = null
    this.presenceTimer = null
    this.typingPruneTimer = null
    this.typingIdleTimer = null
    this.reconnectTimer = null
    const client = this.client
    this.client = null
    await client?.leaveRoom(this.boxFor(this.options.identityKey)).catch(() => undefined)
    await client?.disconnectWebSocket().catch(() => undefined)
  }
}
