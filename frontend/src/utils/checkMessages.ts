import { decodeOutputs } from './decodeOutputs'
import { decryptMessage } from './MessageDecryptor'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'

/**
 * checkMessages
 *
 * Purpose:
 *   - Given a set of overlay lookup results (BEEF outputs),
 *     try to decode and decrypt them into usable messages.
 *
 * Workflow:
 *   1. Decode raw outputs into structured message envelopes
 *   2. Attempt decryption with provided wallet + protocolID + keyID
 *   3. Collect only successful messages into the return array
 *
 * Parameters:
 *   - client: wallet used for decryption
 *   - protocolID: e.g. [2, 'convo'] (namespaces this protocol’s data)
 *   - keyID: string that determines which identity key to derive
 *   - lookupResults: list of overlay outputs from a LookupResolver query
 *
 * Returns:
 *   - An array of successfully decrypted messages (with metadata)
 */
export async function checkMessages({
  client,
  protocolID,
  keyID,
  lookupResults
}: {
  client: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  lookupResults: Array<{ beef: number[]; outputIndex: number; timestamp: number }>
}) {
  // Final container for decrypted messages
  const messages: any[] = []
  const reactions: any[] = []

  // console.log(`[checkMessages] ---------------------------------------------`)
  // console.log(`[checkMessages] Starting with ${lookupResults.length} lookup results`)
  // console.log(`[checkMessages] protocolID: ${JSON.stringify(protocolID)}, keyID: ${keyID}`)

  // Step 1: Decode outputs (from BEEF into structured envelope parts)
  const parsed = await decodeOutputs(lookupResults)
  // console.log(`[checkMessages] Decoded ${parsed.length} outputs successfully`)

  if (!parsed || parsed.length === 0) {
    console.warn('[checkMessages] No valid decoded outputs found.')
    return { messages: [], reactions: [] }
  }

  const reactionRecords = parsed.filter(p => p.type === 'reaction')
  const messageRecords = parsed.filter(p => !p.type || p.type === 'message')

  // console.log(`[checkMessages] ${messageRecords.length} messages, ${reactionRecords.length} reactions found`)

  // Narrow to only entries that actually have header & encryptedPayload
  function hasEncFields(m: any): m is { header: number[]; encryptedPayload: number[] } {
    return Array.isArray(m.header) && Array.isArray(m.encryptedPayload)
  }

  // Step 2: Try to decrypt each decoded message
  for (const msg of messageRecords) {
    try {
      if (!hasEncFields(msg)) {
      console.warn(`[Convo] Missing header/payload for ${msg.txid}:${msg.vout}; skipping.`)
      continue
    }
      // console.log(`[Convo] Attempting to decrypt tx ${msg.txid}, vout ${msg.vout}`)
      // console.log(`[Convo] From: ${msg.sender}, Thread: ${msg.threadId}, Timestamp: ${msg.createdAt}`)
      // console.log(`[Convo] Header:`, msg.header)
      // console.log(`[Convo] Encrypted Payload:`, msg.encryptedPayload)

      // Call decryptMessage util (wraps CurvePoint.decrypt under the hood)
      const decrypted = await decryptMessage(
        client,
        msg.header,
        msg.encryptedPayload,
        protocolID,
        keyID
      )

      if (decrypted) {
        //console.log(`[Convo] Successfully decrypted message:`, decrypted)

        // Push a normalized object into results
        messages.push({
          txid: msg.txid,
          vout: msg.vout,
          threadId: msg.threadId,
          sender: msg.sender,
          content: decrypted.content,
          mediaURL: decrypted.mediaURL,
          createdAt: msg.createdAt,
          // recipients: decrypted.recipients || [],
          recipients: msg.recipients ?? decrypted.recipients ?? [],
          threadName: msg.threadName || undefined,
          uniqueID: msg.uniqueID || undefined,
          parentMessageId: msg.parentMessageId || undefined
        })

        // console.log(`[checkMessages] Added message ${msg.txid}`)
        // console.log(`     threadId=${msg.threadId}`)
        // console.log(`     parentMessageId=${msg.parentMessageId || '(none)'}`)
        // console.log(`     threadName=${msg.threadName || '(none)'}`)
        // console.log(`     uniqueID=${msg.uniqueID || '(none)'}`)
      } else {
        // decryptMessage returned null = no matching key in header
        console.warn(`[checkMessages] Decryption returned null for tx ${msg.txid}`)
      }
    } catch (err) {
      // If any error occurs (bad header, corrupt ciphertext, wrong key)
      console.error(`[checkMessages] Failed to decrypt or parse message in tx ${msg.txid}:`, err)
    }
  }

  // --- Step 4: Collect reactions directly (no decryption needed) ---
  for (const r of reactionRecords) {
    reactions.push({
      txid: r.txid,
      vout: r.vout,
      threadId: r.threadId,
      messageTxid: r.messageTxid,
      messageVout: r.messageVout,
      reaction: r.reaction,
      sender: r.sender,
      createdAt: r.createdAt,
      uniqueID: r.uniqueID,
      parentMessageId: r.parentMessageId || undefined
    })
  }

  // console.log(`[checkMessages] Finished processing. Total decrypted messages: ${messages.length}`)

  return { messages, reactions }
}
