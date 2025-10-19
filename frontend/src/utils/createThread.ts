// frontend/src/utils/createThread.ts

import type { WalletProtocol, WalletClient } from '@bsv/sdk'
import { Hash, Utils } from '@bsv/sdk'

import { sendMessage } from './sendMessage'

/**
 * Options for creating a new thread
 * - client: WalletClient used for signing/encryption
 * - senderPublicKey: the identity key of the user creating the thread
 * - recipientPublicKeys: array of participant identity keys (hex)
 * - threadName: optional human-readable group name
 * - protocolID: namespace for this protocol (e.g. [2, 'convo'])
 * - keyID: which identity key derivation index to use
 */
export interface CreateThreadOptions {
  client: WalletClient
  senderPublicKey: string               // identity pubkey (hex)
  recipientPublicKeys: string[]         // other participant pubkeys
  threadName?: string                   // optional name for group chats
  protocolID: WalletProtocol
  keyID: string
}

/**
 * createThread
 *
 * Purpose:
 *   - Establishes a new group conversation thread.
 *   - Creates a deterministic threadId using participants + timestamp.
 *   - Immediately sends a "thread-init" system message so that
 *     the thread exists in the overlay and can be discovered.
 *
 * Flow:
 *   1. Gather all participants (sender + recipients).
 *   2. Generate a unique threadId by hashing participants + timestamp.
 *   3. Call sendMessage() to push a "thread-init" message.
 *   4. Return the new threadId to the caller.
 */
export async function createThread({
  client,
  senderPublicKey,
  recipientPublicKeys,
  threadName = 'Untitled Thread',
  protocolID,
  keyID
}: CreateThreadOptions): Promise<string> {
  // --- Step 1: Combine sender + recipients ---
  // Sorting ensures deterministic ordering (threadId is the same
  // for all participants who start with the same set of keys).
  const allParticipants = [...recipientPublicKeys, senderPublicKey].sort()

  // --- Step 2: Generate a unique threadId ---
  // We use a combination of participants + current timestamp.
  // Hashing ensures fixed-length deterministic ID.
  const threadSeed = allParticipants.join('|') + '|' + Date.now()
  const threadId = Utils.toHex(Hash.sha256(Utils.toArray(threadSeed, 'utf8')))

  // console.log('[Convo] Creating new thread:')
  // console.log('  ID:', threadId)
  // console.log('  Participants:', allParticipants)
  // console.log('  Thread name:', threadName)

  // --- Step 3: Send initial "thread-init" message ---
  // This is a system message to anchor the new thread in the overlay.
  // NOTE: Currently only recipientPublicKeys (not allParticipants)
  // are included in the `recipients` array sent to sendMessage().
  // This is likely why new participants sometimes can’t decrypt:
  // if their key isn’t added here, it won’t be included in the header.
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

  // console.log('[Convo] Thread created successfully.')
  return threadId
}
