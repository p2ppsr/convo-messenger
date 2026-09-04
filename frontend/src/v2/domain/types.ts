export const CONVO_PROTOCOL_VERSION = 2 as const

export type ConversationKind = 'direct' | 'group'
export type MemberRole = 'admin' | 'member'

export interface ConversationEpoch {
  epoch: number
  rootKey: string
  members: string[]
  admins: string[]
  activatedAt: number
  closure?: EpochClosure
}

export interface EpochClosure {
  closedAt: number
  eventDigests: Record<string, string>
  eventCount: number
  historyDigest: string
}

export interface EpochCommitment {
  closedAt: number
  eventCount: number
  historyDigest: string
}

export interface ConversationPreferences {
  archived: boolean
  favorite: boolean
  muted: boolean
  lastReadAt: number
}

export interface ConversationSecret {
  v: typeof CONVO_PROTOCOL_VERSION
  conversationId: string
  kind: ConversationKind
  title: string
  currentEpoch: number
  epochs: ConversationEpoch[]
  createdAt: number
  updatedAt: number
  preferences: ConversationPreferences
  pendingControl?: PendingControlDelivery[]
}

export interface AttachmentReference {
  id: string
  handle: string
  name: string
  mimeType: string
  size: number
  digest: string
}

export interface AttachmentKeyEnvelope {
  scheme: 'curvepoint-uhrp-v1'
  keyId: string
  /** Contains the member-bearing CurvePoint header; keep only inside encrypted conversation events. */
  envelope: string
}

export interface EventBase {
  v: typeof CONVO_PROTOCOL_VERSION
  id: string
  conversationId: string
  epoch: number
  sender: string
  createdAt: number
}

export interface MessageEvent extends EventBase {
  type: 'message'
  body: string
  replyTo?: string
  attachments?: AttachmentReference[]
  attachmentKey?: AttachmentKeyEnvelope
}

export interface EditEvent extends EventBase {
  type: 'edit'
  targetId: string
  body: string
}

export interface DeleteEvent extends EventBase {
  type: 'delete'
  targetId: string
}

export interface ReactionEvent extends EventBase {
  type: 'reaction'
  targetId: string
  emoji: string
  removed?: boolean
}

export interface ConversationMetadataEvent extends EventBase {
  type: 'metadata'
  title?: string
}

export interface MembershipEvent extends EventBase {
  type: 'membership'
  members: string[]
  admins: string[]
  previousEpoch: number
}

export type ConversationEvent =
  | MessageEvent
  | EditEvent
  | DeleteEvent
  | ReactionEvent
  | ConversationMetadataEvent
  | MembershipEvent

export interface MemberManifest {
  v: typeof CONVO_PROTOCOL_VERSION
  epoch: number
  writer: string
  currentPage: number
  pageCount: number
  eventCount: number
  updatedAt: number
}

export interface EventPage {
  v: typeof CONVO_PROTOCOL_VERSION
  epoch: number
  writer: string
  index: number
  sealed: boolean
  events: ConversationEvent[]
}

export interface MaterializedMessage {
  id: string
  sender: string
  body: string
  createdAt: number
  epoch: number
  replyTo?: string
  attachments: AttachmentReference[]
  attachmentKey?: AttachmentKeyEnvelope
  reactions: Array<{ sender: string; emoji: string }>
  edited: boolean
}

export interface ConversationView {
  title: string
  members: string[]
  admins: string[]
  messages: MaterializedMessage[]
  partial: boolean
  loadedPages: number
}

export type DeliveryState = 'queued' | 'writing' | 'confirmed' | 'notified' | 'failed'

export type MessageDeliveryState = 'sending' | 'live' | 'saved' | 'retrying'

export interface OutboxItem {
  id: string
  conversationId: string
  epoch: number
  encryptedEvent: string
  encryptedReceipts?: string
  state: DeliveryState
  attempts: number
  updatedAt: number
  lastError?: string
}

export interface ConversationInvite {
  type: 'convo-v2-invite'
  v: typeof CONVO_PROTOCOL_VERSION
  conversationId: string
  title: string
  kind: ConversationKind
  epoch: number
  envelope: string
  members: string[]
  admins: string[]
  createdAt: number
}

export interface MembershipUpdate {
  type: 'convo-v2-membership'
  v: typeof CONVO_PROTOCOL_VERSION
  conversationId: string
  title: string
  epoch: number
  envelope: string
  members: string[]
  admins: string[]
  createdAt: number
  previousEpochCommitment: EpochCommitment
}

export interface PendingControlDelivery {
  id: string
  recipient: string
  body: ConversationInvite | MembershipUpdate
  prerequisiteEventId?: string
}
