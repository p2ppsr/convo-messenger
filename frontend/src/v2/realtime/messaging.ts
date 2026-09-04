import { MessageBoxClient } from '@bsv/message-box-client'
import { CurvePoint } from 'curvepoint'
import { Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { validAttachmentSet } from '../domain/attachmentValidation'
import { decryptJson, deriveLocator, encryptJson, liveBoxName, randomId } from '../domain/crypto'
import type {
  ConversationEvent,
  ConversationEpoch,
  ConversationInvite,
  ConversationSecret,
  EpochCommitment,
  MembershipUpdate,
} from '../domain/types'

export const MESSAGEBOX_HOST = 'https://messagebox.babbage.systems'
export const INVITES_BOX = 'convo-v2-invites'
const PROTOCOL_ID: WalletProtocol = [2, 'Convo Messenger']
const MESSAGEBOX_SEND_SPACING_MS = 300
const CONTROL_RATE_LIMIT_RETRIES = 3
let messageBoxSendTail = Promise.resolve()
let nextMessageBoxSendAt = 0

function delay(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration))
}

async function pacedMessageBoxSend<T>(operation: () => Promise<T>): Promise<T> {
  const queued = messageBoxSendTail.catch(() => undefined).then(async () => {
    const wait = import.meta.env.MODE === 'test' ? 0 : Math.max(0, nextMessageBoxSendAt - Date.now())
    if (wait > 0) await delay(wait)
    try {
      return await operation()
    } finally {
      nextMessageBoxSendAt = import.meta.env.MODE === 'test' ? 0 : Date.now() + MESSAGEBOX_SEND_SPACING_MS
    }
  })
  messageBoxSendTail = queued.then(() => undefined, () => undefined)
  return await queued
}

function isRateLimited(reason: unknown): boolean {
  const candidate = reason as { status?: unknown; code?: unknown; message?: unknown }
  return candidate?.status === 429
    || candidate?.code === 'ERR_RATE_LIMITED'
    || (typeof candidate?.message === 'string' && /(?:HTTP\s*429|ERR_RATE_LIMITED|too many requests)/i.test(candidate.message))
}

async function sendControlWithBackoff(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await pacedMessageBoxSend(operation)
      return
    } catch (reason) {
      if (!isRateLimited(reason) || attempt >= CONTROL_RATE_LIMIT_RETRIES) throw reason
      await delay(1_000 * (2 ** attempt))
    }
  }
}

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
  await sendControlWithBackoff(async () => { await client.sendMessage({ recipient, messageBox: INVITES_BOX, body: invite }, MESSAGEBOX_HOST) })
}

export async function sendMembershipUpdate(
  client: MessageBoxClient,
  recipient: string,
  update: MembershipUpdate,
): Promise<void> {
  await sendControlWithBackoff(async () => { await client.sendMessage({ recipient, messageBox: INVITES_BOX, body: update }, MESSAGEBOX_HOST) })
}

export async function listControlMessages(client: MessageBoxClient, persist?: (invites: PendingInvite[], updates: PendingMembershipUpdate[]) => Promise<void>): Promise<{
  invites: PendingInvite[]
  updates: PendingMembershipUpdate[]
}> {
  const messages = await client.listMessages({ messageBox: INVITES_BOX, host: MESSAGEBOX_HOST, limit: MESSAGE_BATCH_SIZE, pageSize: MESSAGE_BATCH_SIZE, maxPages: 2, acceptPayments: false })
  const invites: PendingInvite[] = []
  const updates: PendingMembershipUpdate[] = []
  const invalid: string[] = []
  for (const message of messages) {
    if (message.body === '[Error: Failed to decrypt or parse message]') continue
    const body = typeof message.body === 'string' ? safeJson(message.body) : message.body
    if (isInvite(body)) invites.push({ messageId: message.messageId, sender: message.sender, invite: body })
    if (isMembershipUpdate(body)) updates.push({ messageId: message.messageId, sender: message.sender, update: body })
    if (!isInvite(body) && !isMembershipUpdate(body)) invalid.push(message.messageId)
  }
  if (persist && (invites.length || updates.length)) {
    await persist(invites, updates)
    invalid.push(...invites.map((item) => item.messageId), ...updates.map((item) => item.messageId))
  }
  if (invalid.length) await client.acknowledgeMessage({ messageIds: invalid, host: MESSAGEBOX_HOST })
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

export const MESSAGE_BATCH_SIZE = 100
const MAX_DRAIN_BATCHES = 10

const PRESENCE_INTERVAL_MS = 60_000
const PRESENCE_TIMEOUT_MS = 190_000
const RECONCILE_INTERVAL_MS = 60_000
const INBOX_DRAIN_INTERVAL_MS = 30_000
const TYPING_REFRESH_MS = 2_000
const TYPING_TIMEOUT_MS = 5_000
const TYPING_IDLE_MS = 2_500
const SOCKET_RECONNECT_BASE_MS = 1_000
const SOCKET_RECONNECT_MAX_MS = 30_000
const CALL_SIGNAL_MAX_AGE_MS = 75_000

export interface RealtimePeer {
  identityKey: string
  lastSeen: number
}

export interface TypingPeer extends RealtimePeer {
  expiresAt: number
}

export type CallMedia = 'audio' | 'video'
export type CallSignal =
  | { v: 2; type: 'invite'; callId: string; to: string; media: CallMedia; participants: string[]; expiresAt: number }
  | { v: 2; type: 'room-open'; callId: string; to: string; media: CallMedia; participants: string[]; expiresAt: number }
  | { v: 2; type: 'join' | 'ready'; callId: string; to: string; media: CallMedia }
  | { v: 2; type: 'offer'; callId: string; to: string; media: CallMedia; sdp: string }
  | { v: 2; type: 'answer'; callId: string; to: string; sdp: string }
  | { v: 2; type: 'ice'; callId: string; to: string; candidate: RTCIceCandidateInit }
  | { v: 2; type: 'media-state'; callId: string; to: string; audioEnabled: boolean; videoEnabled: boolean }
  | { v: 2; type: 'ringing' | 'decline' | 'busy' | 'leave' | 'room-close'; callId: string; to: string; reason?: string }

export type MeetingCallSignal = CallSignal

export interface WorkspaceRoomUpdate {
  conversationId: string
  sender: string
  sentAt: number
  room?: {
    callId: string
    hostIdentityKey: string
    media: CallMedia
    memberIdentityKeys: string[]
    expiresAt: number
  }
  closedCallId?: string
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
  kind: 'event' | 'presence' | 'typing' | 'reconcile' | 'call'
  sentAt: number
  event?: ConversationEvent
  presence?: 'join' | 'ping' | 'leave'
  typing?: boolean
  expiresAt?: number
  call?: CallSignal
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
  onCallSignal?: (sender: string, signal: CallSignal) => void | Promise<void>
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
      && validAttachmentSet(event.attachments, event.attachmentKey, conversationId, epoch.epoch)
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

function isCallSignal(value: unknown, recipient: string): value is CallSignal {
  if (typeof value !== 'object' || value === null) return false
  const signal = value as Partial<CallSignal>
  if (typeof signal.callId !== 'string' || !/^[0-9a-f]{64}$/.test(signal.callId)
    || signal.to !== recipient) return false
  if (signal.v !== 2) return false
  if (signal.type === 'invite' || signal.type === 'room-open') return (signal.media === 'audio' || signal.media === 'video')
    && Array.isArray(signal.participants) && signal.participants.length >= 2 && signal.participants.length <= 8
    && new Set(signal.participants).size === signal.participants.length && signal.participants.includes(recipient)
    && signal.participants.every((identityKey) => typeof identityKey === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(identityKey))
    && typeof signal.expiresAt === 'number' && Number.isSafeInteger(signal.expiresAt)
    && signal.expiresAt > Date.now() - 5_000 && signal.expiresAt <= Date.now() + 120_000
  if (signal.type === 'join' || signal.type === 'ready') return signal.media === 'audio' || signal.media === 'video'
  if (signal.type === 'offer') return (signal.media === 'audio' || signal.media === 'video')
    && typeof signal.sdp === 'string' && signal.sdp.length > 0 && signal.sdp.length <= 50_000
  if (signal.type === 'answer') return typeof signal.sdp === 'string'
    && signal.sdp.length > 0 && signal.sdp.length <= 50_000
  if (signal.type === 'ice') return isIceCandidate(signal.candidate)
  if (signal.type === 'media-state') return typeof signal.audioEnabled === 'boolean' && typeof signal.videoEnabled === 'boolean'
  return (signal.type === 'ringing' || signal.type === 'decline' || signal.type === 'busy' || signal.type === 'leave' || signal.type === 'room-close')
    && (signal.reason === undefined || (typeof signal.reason === 'string' && signal.reason.length <= 160))
}

function isIceCandidate(candidate: unknown): candidate is RTCIceCandidateInit {
  return typeof candidate === 'object' && candidate !== null
    && typeof (candidate as RTCIceCandidateInit).candidate === 'string' && (candidate as RTCIceCandidateInit).candidate!.length <= 8_192
    && ((candidate as RTCIceCandidateInit).sdpMid === undefined || (candidate as RTCIceCandidateInit).sdpMid === null || (typeof (candidate as RTCIceCandidateInit).sdpMid === 'string' && (candidate as RTCIceCandidateInit).sdpMid!.length <= 256))
    && ((candidate as RTCIceCandidateInit).sdpMLineIndex === undefined || (candidate as RTCIceCandidateInit).sdpMLineIndex === null || (Number.isSafeInteger((candidate as RTCIceCandidateInit).sdpMLineIndex) && ((candidate as RTCIceCandidateInit).sdpMLineIndex as number) >= 0))
    && ((candidate as RTCIceCandidateInit).usernameFragment === undefined || (candidate as RTCIceCandidateInit).usernameFragment === null || (typeof (candidate as RTCIceCandidateInit).usernameFragment === 'string' && (candidate as RTCIceCandidateInit).usernameFragment!.length <= 256))
}

function isLivePayload(value: unknown, conversationId: string, epoch: ConversationEpoch, sender: string, recipient: string): value is LivePayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Partial<LivePayload>
  if (payload.conversationId !== conversationId
    || payload.epoch !== epoch.epoch
    || typeof payload.sentAt !== 'number' || !Number.isFinite(payload.sentAt)) return false
  if (payload.kind === 'event') return isEvent(payload.event, conversationId, epoch, sender)
  if (payload.kind === 'presence') return payload.presence === 'join' || payload.presence === 'ping' || payload.presence === 'leave'
  if (payload.kind === 'typing') return typeof payload.typing === 'boolean'
    && typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt)
  if (payload.kind === 'call') return isCallSignal(payload.call, recipient)
  return payload.kind === 'reconcile'
}

/** Drain every known recipient box, including direct chats and retired epochs.
 * Events must be durably accepted before the corresponding batch is acknowledged.
 * A failing event stays queued while other valid/expired traffic can drain.
 */
export async function listWorkspaceRoomUpdates(
  client: MessageBoxClient,
  identityKey: string,
  conversations: ConversationSecret[],
  excludedConversationId?: string,
  onEvent?: (secret: ConversationSecret, event: ConversationEvent) => Promise<void>,
): Promise<WorkspaceRoomUpdate[]> {
  const updates: WorkspaceRoomUpdate[] = []
  let failed = false
  for (const conversation of conversations) {
    for (const epoch of conversation.epochs) {
      if (!epoch.members.includes(identityKey)
        || (conversation.conversationId === excludedConversationId && epoch.epoch === conversation.currentEpoch)) continue
      for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
        let messages: Awaited<ReturnType<MessageBoxClient['listMessages']>>
        try {
          messages = await client.listMessages({ messageBox: liveBoxName(epoch.rootKey, identityKey), host: MESSAGEBOX_HOST,
            limit: MESSAGE_BATCH_SIZE, pageSize: MESSAGE_BATCH_SIZE, maxPages: 2, acceptPayments: false })
        } catch { failed = true; break }
        const acknowledged: string[] = []
        for (const message of messages) {
          if (message.body === '[Error: Failed to decrypt or parse message]') continue
          const body = typeof message.body === 'string' ? safeJson(message.body) : message.body
          let payload: LivePayload | undefined
          if (isLiveEnvelope(body) && epoch.members.includes(message.sender)) {
            try {
              const decoded = decryptJson<LivePayload>(epoch.rootKey, `live:${body.envelopeId}`, body.ciphertext)
              if (isLivePayload(decoded, conversation.conversationId, epoch, message.sender, identityKey)) payload = decoded
            } catch { /* Invalid ciphertext in our private box can be discarded. */ }
          }
          if (payload?.kind === 'event' && payload.event) {
            // No consumer means no durable handoff: retain the event.
            if (!onEvent) continue
            try { await onEvent(conversation, payload.event) } catch { failed = true; continue }
          }
          if (payload?.kind === 'call' && payload.call && epoch.epoch === conversation.currentEpoch) {
            const age = Date.now() - payload.sentAt
            if (age >= -300_000 && age < CALL_SIGNAL_MAX_AGE_MS) {
              if (payload.call.type === 'room-open' && payload.call.expiresAt > Date.now()) {
                updates.push({ conversationId: conversation.conversationId, sender: message.sender, sentAt: payload.sentAt,
                  room: { callId: payload.call.callId, hostIdentityKey: message.sender, media: payload.call.media,
                    memberIdentityKeys: payload.call.participants, expiresAt: payload.call.expiresAt } })
              } else if (payload.call.type === 'room-close') {
                updates.push({ conversationId: conversation.conversationId, sender: message.sender,
                  sentAt: payload.sentAt, closedCallId: payload.call.callId })
              }
            }
          }
          acknowledged.push(message.messageId)
        }
        if (acknowledged.length) {
          try { await client.acknowledgeMessage({ messageIds: acknowledged, host: MESSAGEBOX_HOST }) }
          catch { failed = true; break }
        }
        if (messages.length < MESSAGE_BATCH_SIZE || acknowledged.length !== messages.length) break
      }
    }
  }
  if (failed) throw new Error('Some inbox deliveries remain queued for retry')
  return updates.sort((left, right) => left.sentAt - right.sentAt)
}

export async function forwardStoredEvent(client: MessageBoxClient, secret: ConversationSecret, event: ConversationEvent,
  recipients: string[], onAccepted: (recipient: string) => void): Promise<void> {
  const epoch = secret.epochs.find((candidate) => candidate.epoch === event.epoch)
  if (!epoch || !isEvent(event, secret.conversationId, epoch, event.sender)) throw new Error('Invalid outgoing event')
  const envelopeId = randomId()
  const body: LiveEnvelope = { type: 'convo-v2-live', v: 2, envelopeId,
    ciphertext: encryptJson(epoch.rootKey, `live:${envelopeId}`, { conversationId: secret.conversationId,
      epoch: epoch.epoch, kind: 'event', event, sentAt: Date.now() }, 1_024) }
  for (const recipient of recipients) {
    await pacedMessageBoxSend(() => client.sendMessage({ recipient, messageBox: liveBoxName(epoch.rootKey, recipient), body,
      messageId: deriveLocator(epoch.rootKey, `forward:${event.sender}:${recipient}:${event.id}`), skipEncryption: true }, MESSAGEBOX_HOST))
    onAccepted(recipient)
  }
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
  private drainPromise: Promise<void> | null = null
  private readonly handling = new Map<string, Promise<void>>()
  private readonly pendingAcks = new Set<string>()
  private ackPromise: Promise<void> | null = null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
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
    if (this.stopped) return
    await this.drain()
    if (this.stopped) return
    document.addEventListener('visibilitychange', this.visibilityHandler)
    window.addEventListener('pagehide', this.pageHideHandler)
    this.drainTimer = setInterval(() => { void this.drain() }, INBOX_DRAIN_INTERVAL_MS)
    this.reconcileTimer = setInterval(() => {
      void this.options.onSyncRequested()
    }, RECONCILE_INTERVAL_MS)
    this.presenceTimer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void this.publishPresence('ping')
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
        onMessage: (message) => { void this.handle(message.messageId, message.sender, message.body).catch(() => this.options.onState('fallback')) },
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
    if (this.stopped) return
    const inflight = this.handling.get(messageId)
    if (inflight) return await inflight
    const operation = this.accept(messageId, sender, rawBody)
    this.handling.set(messageId, operation)
    try { await operation } finally { this.handling.delete(messageId) }
  }

  private async accept(messageId: string, sender: string, rawBody: unknown): Promise<void> {
    if (rawBody === '[Error: Failed to decrypt or parse message]') throw new Error('Wallet decryption needs a retry')
    if (!this.processed.has(messageId)) {
      const body = typeof rawBody === 'string' ? safeJson(rawBody) : rawBody
      let payload: LivePayload | undefined
      if (isLiveEnvelope(body) && this.options.epoch.members.includes(sender)) {
        try {
          const decoded = decryptJson<LivePayload>(this.options.epoch.rootKey, `live:${body.envelopeId}`, body.ciphertext)
          if (isLivePayload(decoded, this.options.conversationId, this.options.epoch, sender, this.options.identityKey)) payload = decoded
        } catch { /* Invalid private-room traffic must not poison the queue. */ }
      }
      if (payload) await this.applyPayload(sender, payload)
      // A failed consumer is never marked processed or acknowledged.
      this.processed.add(messageId)
      this.trimSet(this.processed)
    }
    // Duplicate delivery also retries a previously failed acknowledgment.
    this.pendingAcks.add(messageId)
    if (this.ackTimer === null) this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      void this.flushAcknowledgments().catch(() => this.options.onState('fallback'))
    }, 100)
  }

  private async flushAcknowledgments(): Promise<void> {
    if (this.ackPromise) return await this.ackPromise
    const client = this.client
    if (!client) return
    this.ackPromise = (async () => {
      while (this.pendingAcks.size) {
        const messageIds = [...this.pendingAcks].slice(0, MESSAGE_BATCH_SIZE)
        await client.acknowledgeMessage({ messageIds, host: MESSAGEBOX_HOST })
        for (const id of messageIds) this.pendingAcks.delete(id)
      }
    })()
    try { await this.ackPromise } finally { this.ackPromise = null }
  }

  private isFresh(sentAt: number): boolean {
    const age = Date.now() - sentAt
    return age >= -300_000 && age < PRESENCE_TIMEOUT_MS
  }

  private async applyPayload(sender: string, payload: LivePayload): Promise<void> {
    if (payload.kind === 'event' && payload.event) {
      if (this.processedEvents.has(payload.event.id)) return
      if (this.isFresh(payload.sentAt)) this.notePeer(sender)
      await this.options.onEvent(payload.event)
      this.processedEvents.add(payload.event.id)
      this.trimSet(this.processedEvents)
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
      return
    }
    if (payload.kind === 'call' && payload.call) {
      const age = Date.now() - payload.sentAt
      if (age < -300_000 || age >= CALL_SIGNAL_MAX_AGE_MS) return
      this.notePeer(sender)
      await this.options.onCallSignal?.(sender, payload.call)
    }
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return await this.drainPromise
    this.drainPromise = this.drainBatches()
    try { await this.drainPromise } finally { this.drainPromise = null }
  }

  private async drainBatches(): Promise<void> {
    const client = this.client
    if (this.stopped || client === null) return
    try {
      await this.flushAcknowledgments()
      for (let batch = 0; batch < MAX_DRAIN_BATCHES && !this.stopped; batch += 1) {
        const messages = await client.listMessages({ messageBox: this.boxFor(this.options.identityKey), host: MESSAGEBOX_HOST,
          limit: MESSAGE_BATCH_SIZE, pageSize: MESSAGE_BATCH_SIZE, maxPages: 2, acceptPayments: false })
        let failed = false
        for (const message of messages) {
          try { await this.handle(message.messageId, message.sender, message.body) } catch { failed = true }
        }
        await this.flushAcknowledgments()
        if (failed) { this.options.onState('fallback'); break }
        if (messages.length < MESSAGE_BATCH_SIZE) break
      }
    } catch {
      this.options.onState('fallback')
      this.scheduleReconnect()
    }
  }

  async publishEvent(event: ConversationEvent, recipients?: string[], onAccepted?: (recipient: string) => void): Promise<number> {
    if (!isEvent(event, this.options.conversationId, this.options.epoch, this.options.identityKey)) {
      throw new Error('Cannot publish an invalid realtime conversation event')
    }
    return await this.publishPayload({ kind: 'event', event }, recipients, onAccepted)
  }

  async publishCallSignal(recipient: string, signal: CallSignal): Promise<boolean> {
    if (!this.options.epoch.members.includes(recipient)
      || recipient === this.options.identityKey
      || !isCallSignal(signal, recipient)) {
      throw new Error('Cannot publish an invalid realtime call signal')
    }
    const envelopeId = randomId()
    const payload: LivePayload = {
      conversationId: this.options.conversationId,
      epoch: this.options.epoch.epoch,
      kind: 'call',
      sentAt: Date.now(),
      call: signal,
    }
    const envelope: LiveEnvelope = {
      type: 'convo-v2-live',
      v: 2,
      envelopeId,
      ciphertext: encryptJson(this.options.epoch.rootKey, `live:${envelopeId}`, payload, 1_024),
    }
    return await this.sendPrepared(recipient, envelope, true)
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

  private async publishPayload(partial: Omit<LivePayload, 'conversationId' | 'epoch' | 'sentAt'>, recipients?: string[], onAccepted?: (recipient: string) => void): Promise<number> {
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
    const ephemeral = partial.kind === 'typing' || (partial.kind === 'presence' && partial.presence !== 'join')
    for (const recipient of this.options.epoch.members.filter((member) => member !== this.options.identityKey
      && (!recipients || recipients.includes(member))
      && (!ephemeral || (this.peers.has(member) && this.isFresh(this.peers.get(member)!.lastSeen))))) {
      const messageId = partial.event ? deriveLocator(this.options.epoch.rootKey, `forward:${this.options.identityKey}:${recipient}:${partial.event.id}`) : undefined
      if (await this.sendPrepared(recipient, envelope, false, messageId)) { delivered += 1; onAccepted?.(recipient) }
    }
    return delivered
  }

  private async sendPrepared(recipient: string, envelope: LiveEnvelope, retryRateLimit = false, messageId?: string): Promise<boolean> {
    let delivered = false
    const queued = this.outboundTail.then(async () => {
      const client = this.client
      if (client === null || this.stopped) return
      try {
        // The realtime envelope is already padded and encrypted with the epoch
        // root key. Avoid a second wallet encryption for every recipient.
        const send = async () => await client.sendLiveMessage({
          recipient,
          messageBox: this.boxFor(recipient),
          body: envelope,
          messageId,
          skipEncryption: true,
        }, MESSAGEBOX_HOST)
        if (retryRateLimit) await sendControlWithBackoff(async () => { await send() })
        else await pacedMessageBoxSend(send)
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
    this.stopped = true
    await this.flushAcknowledgments().catch(() => undefined)
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    window.removeEventListener('pagehide', this.pageHideHandler)
    if (this.ackTimer) clearTimeout(this.ackTimer)
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
