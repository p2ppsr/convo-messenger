// frontend/src/utils/createThread.ts

import type { WalletProtocol, WalletClient } from '@bsv/sdk'
import { Hash, Utils } from '@bsv/sdk'

import { sendMessage } from './sendMessage'

export interface CreateThreadOptions {
  client: WalletClient
  senderPublicKey: string               // identity pubkey (hex)
  recipientPublicKeys: string[]        // other participant pubkeys
  threadName?: string                  // optional name for group chats
  protocolID: WalletProtocol
  keyID: string
}

/**
 * Creates a new conversation thread and sends the initial system "thread-init".
 */
export async function createThread({
  client,
  senderPublicKey,
  recipientPublicKeys,
  threadName = 'Untitled Thread',
  protocolID,
  keyID
}: CreateThreadOptions): Promise<string> {
  // Combine sender + recipients and sort to create deterministic ID
  const allParticipants = [...recipientPublicKeys, senderPublicKey].sort()
  const threadSeed = allParticipants.join('|') + '|' + Date.now()
  const threadId = Utils.toHex(Hash.sha256(Utils.toArray(threadSeed, 'utf8')))

  console.log('[Convo] Creating new thread:')
  console.log('  ID:', threadId)
  console.log('  Participants:', allParticipants)
  console.log('  Thread name:', threadName)

  // Send initial system "thread-init" (not a visible chat message)
  await sendMessage({
    client,
    threadId,
    protocolID,
    keyID,
    senderPublicKey,
    recipients: recipientPublicKeys,
    content: `🟢 Thread started: ${threadName}`,
    threadName
  })

  console.log('[Convo] Thread created successfully.')
  return threadId
}
