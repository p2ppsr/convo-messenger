import { decodeOutputs } from './decodeOutputs'
import { decryptMessage } from './MessageDecryptor'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'

/**
 * Fetches, decodes, and decrypts messages from lookup results.
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
  const messages: any[] = []

  console.log(`[Convo] Starting checkMessages with ${lookupResults.length} lookup results`)
  console.log(`[Convo] Using protocolID: ${JSON.stringify(protocolID)} | keyID: ${keyID}`)

  const parsed = await decodeOutputs(lookupResults)
  console.log(`[Convo] Decoded ${parsed.length} outputs successfully`)

  for (const msg of parsed) {
    try {
      console.log(`[Convo] Attempting to decrypt tx ${msg.txid}, vout ${msg.vout}`)
      console.log(`[Convo] From: ${msg.sender}, Thread: ${msg.threadId}, Timestamp: ${msg.createdAt}`)
      console.log(`[Convo] Header:`, msg.header)
      console.log(`[Convo] Encrypted Payload:`, msg.encryptedPayload)

      const decrypted = await decryptMessage(
        client,
        msg.header,
        msg.encryptedPayload,
        protocolID,
        keyID
      )

      if (decrypted) {
        console.log(`[Convo] Successfully decrypted message:`, decrypted)

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
        console.warn(`[Convo] Decryption returned null for tx ${msg.txid}`)
      }
    } catch (err) {
      console.error(`[Convo] Failed to decrypt or parse message in tx ${msg.txid}:`, err)
    }
  }

  console.log(`[Convo] Finished processing. Total decrypted messages: ${messages.length}`)

  return messages
}
