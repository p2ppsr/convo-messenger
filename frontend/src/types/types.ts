// frontend/src/types/types.ts

export interface DecryptedMessage {
  txid: string
  threadId: string
  sender: string
  content: string            // Decrypted plaintext
  createdAt: number
  mediaURL?: string
}

export interface MessagePayload {
  type?: 'message' | 'thread-init' | 'custom'
  content: string
  mediaURL?: string
  contentType?: 'text' | 'image' | 'video' | 'file' | 'custom'
  recipients?: string[]
  name?: string
}

export interface MessagePayloadWithMetadata extends MessagePayload {
  txid: string
  vout: number
  sender: string
  threadId: string
  createdAt: number // Unix timestamp in ms or seconds (consistent with your data)
}

export interface DirectMessageEntry {
  threadId: string
  otherParticipantKey: string
  otherParticipantName: string
  lastTimestamp: number
  lastMessagePreview?: string
  unreadCount?: number
  avatarURL?: string
}
