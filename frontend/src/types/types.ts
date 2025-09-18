// frontend/src/types/types.ts

/**
 * Represents a **fully decrypted message** retrieved from the overlay.
 * This is what you display in the UI (Chat.tsx).
 */
export interface DecryptedMessage {
  txid: string              // Blockchain transaction ID containing the message
  threadId: string          // Unique ID for the thread this belongs to
  sender: string            // Sender's public key (identity)
  content: string           // Decrypted plaintext message
  createdAt: number         // Timestamp (ms since epoch)
  mediaURL?: string         // Optional URL for attachments (images, video, etc.)
}

/**
 * The **raw payload structure** that gets encrypted into the message.
 * This is what you pass into CurvePoint.encrypt before broadcast.
 */
export interface MessagePayload {
  type?: 'message' | 'thread-init' | 'custom' // message type
  content: string                             // plaintext content
  mediaURL?: string                           // optional attachment
  contentType?: 'text' | 'image' | 'video' | 'file' | 'custom' // MIME category
  recipients?: string[]                       // public keys of participants
  name?: string                               // optional: group thread name
}

/**
 * A payload merged with **blockchain metadata**.
 * This is what loadMessages/decryptMessageBatch returns after processing.
 */
export interface MessagePayloadWithMetadata extends MessagePayload {
  txid: string            // blockchain transaction ID
  vout: number            // which output in the transaction
  sender: string          // sender's pubkey
  threadId: string        // unique thread ID (hash of participants or explicit ID)
  createdAt: number       // timestamp of message (ms or s depending on source)
}

/**
 * A summary object for displaying **direct message conversations** in a list.
 * Helps build the sidebar (DirectMessageList).
 */
export interface DirectMessageEntry {
  threadId: string              // which thread this entry belongs to
  otherParticipantKey: string   // identity key of the "other person"
  otherParticipantName: string  // resolved display name
  lastTimestamp: number         // most recent activity time
  lastMessagePreview?: string   // preview snippet for sidebar
  unreadCount?: number          // unread message badge
  avatarURL?: string            // optional avatar (future use)
}
