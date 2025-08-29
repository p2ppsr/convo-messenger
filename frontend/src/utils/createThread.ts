// frontend/src/utils/createThread.ts

import type { WalletProtocol, WalletClient } from '@bsv/sdk'
import { Hash, Utils } from '@bsv/sdk'

import { sendMessage } from './sendMessage'
import type { MessagePayload } from '../types/types'

export interface CreateThreadOptions {
  client: WalletClient
  senderPublicKey: string               // identity pubkey (hex)
  recipientPublicKeys: string[]        // other participant pubkeys
  threadName?: string                  // optional name for group chats
  protocolID: WalletProtocol
  keyID: string
}

/**
 * Creates a new conversation thread and sends the initial message.
 */
export async function createThread({
  client,
  senderPublicKey,
  recipientPublicKeys,
  threadName = 'Untitled Thread',
  protocolID,
  keyID
}: CreateThreadOptions): Promise<string> {
  // 🧑‍🤝‍🧑 Combine sender + recipients and sort to create deterministic ID
  const allParticipants = [...recipientPublicKeys, senderPublicKey].sort()
  const threadSeed = allParticipants.join('|') + '|' + Date.now()
  const threadId = Utils.toHex(Hash.sha256(Utils.toArray(threadSeed, 'utf8')))

  console.log('[Convo] Creating new thread:')
  console.log('  ID:', threadId)
  console.log('  Participants:', allParticipants)

  // 📨 Send initial system message to start the thread
  const payload: MessagePayload = {
    type: 'thread-init',
    content: `${senderPublicKey.slice(0, 12)}... started a thread: "${threadName}"`,
    mediaURL: undefined
  }

  await sendMessage({
    client,
    threadId,
    protocolID,
    keyID,
    senderPublicKey,
    recipients: recipientPublicKeys, // don't include sender here
    content: payload.content
  })

  console.log('[Convo] Thread created successfully.')
  return threadId
}
