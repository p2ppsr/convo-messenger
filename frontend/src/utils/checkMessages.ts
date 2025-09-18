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

  console.log(`[Convo] Starting checkMessages with ${lookupResults.length} lookup results`)
  console.log(`[Convo] Using protocolID: ${JSON.stringify(protocolID)} | keyID: ${keyID}`)

  // Step 1: Decode outputs (from BEEF into structured envelope parts)
  const parsed = await decodeOutputs(lookupResults)
  console.log(`[Convo] Decoded ${parsed.length} outputs successfully`)

  // Step 2: Try to decrypt each decoded message
  for (const msg of parsed) {
    try {
      console.log(`[Convo] Attempting to decrypt tx ${msg.txid}, vout ${msg.vout}`)
      console.log(`[Convo] From: ${msg.sender}, Thread: ${msg.threadId}, Timestamp: ${msg.createdAt}`)
      console.log(`[Convo] Header:`, msg.header)
      console.log(`[Convo] Encrypted Payload:`, msg.encryptedPayload)

      // Call decryptMessage util (wraps CurvePoint.decrypt under the hood)
      const decrypted = await decryptMessage(
        client,
        msg.header,
        msg.encryptedPayload,
        protocolID,
        keyID
      )

      if (decrypted) {
        console.log(`[Convo] Successfully decrypted message:`, decrypted)

        // Push a normalized object into results
        messages.push({
          txid: msg.txid,
          vout: msg.vout,
          threadId: msg.threadId,
          sender: msg.sender,
          content: decrypted.content,
          mediaURL: decrypted.mediaURL,
          createdAt: msg.createdAt
        })

        console.log(`[Convo] Message from ${msg.sender} added to thread ${msg.threadId}`)
      } else {
        // decryptMessage returned null = no matching key in header
        console.warn(`[Convo] Decryption returned null for tx ${msg.txid}`)
      }
    } catch (err) {
      // If any error occurs (bad header, corrupt ciphertext, wrong key)
      console.error(`[Convo] Failed to decrypt or parse message in tx ${msg.txid}:`, err)
    }
  }

  console.log(`[Convo] Finished processing. Total decrypted messages: ${messages.length}`)

  return messages
}
