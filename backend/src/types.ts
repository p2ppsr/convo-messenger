// backend/src/types.ts (shared with frontend if you like)

/** ---- Core enums / literals ---- */
export type Role = 'member' | 'admin'
export type MemberStatus = 'active' | 'left'

/** ---- Crypto payloads ---- */
export interface CipherBlob {
  alg: 'AES-256-GCM'
  iv: string   // base64
  tag: string  // base64
  payload: string // base64
  aad?: string // base64 (optional)
}

export interface AttachmentRef {
  type: 'image' | 'file' | 'audio' | 'video'
  uhrp: string
  name?: string
  size?: number
  enc?: { iv: string; tag: string }
  mime?: string
}

/** ---- Domain entities ---- */
export interface Thread {
  _type: 'thread'
  threadId: string
  title?: string
  createdAt: number
  createdBy: string      // identity pubkey (compressed hex)
  lastMessageAt: number  // for sorting/recency
  memberCount: number
  envelopeVersion: number // increments on group-key rotation
}

export interface ThreadMember {
  _type: 'membership'
  threadId: string
  memberId: string
  role: Role
  joinedAt: number
  status: MemberStatus
  groupKeyBox: string          // base64 ciphertext
  groupKeyFrom: string         // identity key of the encrypter (needed for decrypt)
  curvepoint?: unknown
}

export interface Message {
  _type: 'message'
  threadId: string
  messageId: string
  sender: string        // identity pubkey (compressed hex)
  sentAt: number
  cipher: CipherBlob
  attachments?: AttachmentRef[]
  // Optional sender signature over header (base64) 
  sig?: string
}

export interface Profile {
  _type: 'profile'
  identityKey: string   // identity pubkey (compressed hex)
  displayName?: string
  avatar?: string       // UHRP hash/url
}

/** ---- Lookup (query) payloads ---- */
export interface FindThreadsQuery {
  memberId: string
  limit?: number
  after?: number // paginate by lastMessageAt (strictly older)
}

export interface FindMessagesQuery {
  threadId: string
  limit?: number
  before?: number // paginate by sentAt (strictly older)
}

export interface FindMembersQuery {
  threadId: string
}

export interface FindProfileQuery {
  identityKey: string
}

// Optional
export type ConvoLookupQuery =
  | { type: 'findThreads'; value: FindThreadsQuery }
  | { type: 'findMessages'; value: FindMessagesQuery }
  | { type: 'findMembers';  value: FindMembersQuery }
  | { type: 'findProfile';  value: FindProfileQuery }

/** ---- Topic actions (used by a Topic Manager router) ---- */
export interface CreateThreadAction {
  thread: Thread
  memberships: ThreadMember[]
  firstMessage?: Message
}

export interface PostMessageAction {
  message: Message
}

export interface AddMembersAction {
  threadId: string
  memberships: ThreadMember[]
}

export interface LeaveThreadAction {
  threadId: string
}

export interface RotateGroupKeyAction {
  threadId: string
  memberships: Array<Pick<ThreadMember, 'threadId' | 'memberId' | 'groupKeyBox'>>
  envelopeVersion: number
}

export interface SetProfileAction {
  profile: Profile
}

/** ---- Pagination wrapper ---- */
export interface Paginated<T> {
  items: T[]
  nextAfter?: number
  nextBefore?: number
}

/** ---- Overlay / storage helpers (backend) ---- */
export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface StoredMessageRecord {
  txid: string
  outputIndex: number
  threadId: string
  messageId: string
  sender: string
  sentAt: number
  // Optional
  ivB64?: string
  tagB64?: string
  ctB64?: string
  createdAt: Date
}

export interface StoredThreadSummary {
  threadId: string
  lastMessageAt: number
  memberCount: number
  createdBy: string
  createdAt: number
}
