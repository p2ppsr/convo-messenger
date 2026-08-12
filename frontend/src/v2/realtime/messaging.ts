import { MessageBoxClient } from '@bsv/message-box-client'
import { CurvePoint } from 'curvepoint'
import { Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { liveBoxName } from '../domain/crypto'
import type {
  ConversationEpoch,
  ConversationInvite,
  EpochCommitment,
  LiveNotification,
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

function isLiveNotification(value: unknown): value is LiveNotification {
  if (typeof value !== 'object' || value === null) return false
  const notification = value as Partial<LiveNotification>
  return notification.type === 'convo-v2-event'
    && notification.v === 2
    && typeof notification.conversationId === 'string'
    && typeof notification.epoch === 'number'
    && typeof notification.eventId === 'string'
    && typeof notification.sentAt === 'number'
}

export class ConversationTransport {
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readonly processed = new Set<string>()

  constructor(
    private readonly client: MessageBoxClient,
    private readonly identityKey: string,
    private readonly conversationId: string,
    private readonly epoch: ConversationEpoch,
    private readonly onSyncRequested: () => Promise<void>,
    private readonly onState: (state: 'connecting' | 'live' | 'fallback') => void,
  ) {}

  private boxFor(recipient: string): string {
    return liveBoxName(this.epoch.rootKey, recipient)
  }

  async start(): Promise<void> {
    this.stopped = false
    this.onState('connecting')
    try {
      await this.client.listenForLiveMessages({
        messageBox: this.boxFor(this.identityKey),
        overrideHost: MESSAGEBOX_HOST,
        onMessage: (message) => { void this.handle(message.messageId, message.sender, message.body) },
      })
      this.onState('live')
    } catch {
      this.onState('fallback')
    }
    await this.drain()
    this.timer = setInterval(() => { void this.drain() }, 30_000)
  }

  private async handle(messageId: string, sender: string, rawBody: unknown): Promise<void> {
    if (this.stopped || this.processed.has(messageId) || !this.epoch.members.includes(sender)) return
    const body = typeof rawBody === 'string' ? safeJson(rawBody) : rawBody
    if (!isLiveNotification(body)
      || body.conversationId !== this.conversationId
      || body.epoch !== this.epoch.epoch) return
    this.processed.add(messageId)
    await this.onSyncRequested()
    await this.client.acknowledgeMessage({ messageIds: [messageId], host: MESSAGEBOX_HOST }).catch(() => undefined)
  }

  async drain(): Promise<void> {
    if (this.stopped) return
    try {
      const messages = await this.client.listMessages({ messageBox: this.boxFor(this.identityKey), host: MESSAGEBOX_HOST })
      for (const message of messages) await this.handle(message.messageId, message.sender, message.body)
    } catch {
      this.onState('fallback')
    }
  }

  async notify(eventId: string): Promise<number> {
    const notification: LiveNotification = {
      type: 'convo-v2-event',
      v: 2,
      conversationId: this.conversationId,
      epoch: this.epoch.epoch,
      eventId,
      sentAt: Date.now(),
    }
    let delivered = 0
    for (const recipient of this.epoch.members.filter((member) => member !== this.identityKey)) {
      try {
        await this.client.sendLiveMessage(
          { recipient, messageBox: this.boxFor(recipient), body: notification },
          MESSAGEBOX_HOST,
        )
        delivered += 1
      } catch {
        // Durable overlay state is authoritative; the encrypted outbox retries notification.
      }
    }
    return delivered
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.client.leaveRoom(this.boxFor(this.identityKey)).catch(() => undefined)
    await this.client.disconnectWebSocket().catch(() => undefined)
  }
}
