// backend/src/types.ts

export interface Thread {
  threadId: string         // Stable UUID or generated string (used for grouping)
  createdBy: string        // DID or pubkey of creator
  participants: string[]   // List of pubkeys (not DIDs) — needed for CurvePoint
  type: 'direct' | 'group'
  createdAt: number        // Unix ms
  lastMessageAt: number    // Last activity timestamp
  title?: string           // Optional thread title
  updatedBy?: string  // Optional: last participant to post (pubkey)
  archived?: boolean  // For future "hide/archive" support
}


export interface EncryptedMessage {
  txid: string                // From PushDrop createAction result
  outputIndex: number         // From PushDrop createAction result
  threadId: string            // Foreign key to Thread
  sender: string              // DID or pubkey of sender
  encryptedPayload: number[]  // Ciphertext (CurvePoint output)
  header: number[]            // CurvePoint header (with recipients + keys)
  createdAt: number           // Unix timestamp (ms)
  mediaURL?: string           // Optional pointer to uploaded media
  uniqueId?: string           // Optional unique identifier for the message
}

export interface ParticipantChangeLog {
  threadId: string
  txid: string
  action: 'added' | 'removed'
  participant: string       // Pubkey
  timestamp: number
}


export interface MessagePayload {
  content: string
  mediaURL?: string
  contentType?: 'text' | 'image' | 'video' | 'file' | 'custom'
}

export interface FindByThreadIdQuery {
  type: 'findByThreadId'
  value: { threadId: string }
}

export interface GetMessageQuery {
  type: 'getMessage'
  value: { txid: string }
}

export interface FindAllMessagesQuery {
  type: 'findAll'
  value?: {}
}

export type ConvoLookupQuery =
  | FindByThreadIdQuery
  | GetMessageQuery
  | FindAllMessagesQuery


