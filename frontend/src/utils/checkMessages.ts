/**
 * checkMessages.ts
 *
 * I query the overlay for recent message outputs for a set of threadIds,
 * decode each PushDrop output, and decrypt the message payload with CurvePoint.
 *
 * Key points:
 * - This version uses CurvePoint (header + ciphertext) — no per-thread AES key
 *   is required to read messages (the wallet’s identity key unwraps the per-message
 *   symmetric key from the header).
 * - I still accept a `lastSeen` map so the UI only appends newer messages.
 * - The overlay is queried via LookupResolver with the 'findMessages' query.
 */

import {
  LookupResolver,
  Transaction,
  PushDrop,
  WalletClient,
  Utils
} from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import constants from './constants'

export interface ChatMessage {
  text: string
  authorId: string
  image?: string
}

/**
 * Pull & decrypt new messages for the given threadIds using CurvePoint.
 * No per-thread symmetric key is needed anymore (header carries a wrapped key).
 *
 * @param threadIds   List of thread IDs I want to poll.
 * @param lastSeen    Map of threadId -> last 'sentAt' timestamp I've already shown.
 * @param limitPerThread  Optional page size per thread (default 100).
 *
 * @returns Map(threadId -> ChatMessage[]) of messages newer than `lastSeen[threadId]`.
 */
export default async function checkMessages(
  threadIds: string[],
  lastSeen: Record<string, number>,
  limitPerThread = 100
): Promise<Map<string, ChatMessage[]>> {
  // Lookup into the overlay, using our configured network (local/testnet/mainnet)
  const resolver = new LookupResolver({ networkPreset: constants.networkPreset })

  // I need a wallet instance so CurvePoint can use my identity key to unwrap the header key.
  const wallet = new WalletClient('auto', constants.walletHost)
  const curve = new CurvePoint(wallet)

  // Keeping the keyID consistent across app (this is the label we used when encrypting).
  const CURVE_KEY_ID = '1'

  const out = new Map<string, ChatMessage[]>()

  // I poll each thread in parallel. If one fails, others continue.
  await Promise.all(
    threadIds.map(async (threadId) => {
      let response: any
      try {
        response = await resolver.query({
          service: constants.overlayTopic,            // e.g. 'ls_convo'
          query: { type: 'findMessages', threadId, limit: limitPerThread }
        })
      } catch (e) {
        console.error('[checkMessages] lookup error', { threadId, e })
        return
      }

      // The LookupService for messages returns an "output-list" shape:
      //   { type: 'output-list', outputs: [{ beef, outputIndex }, ...] }
      if (response?.type !== 'output-list' || !Array.isArray(response.outputs)) {
        // Not fatal; just no outputs to process for this thread.
        return
      }

      // Only surface messages newer than the last time the UI saw something for this thread.
      const since = lastSeen[threadId] ?? 0
      const collected: ChatMessage[] = []

      for (const o of response.outputs) {
        try {
          // 1) Decode the transaction/output so I can parse the PushDrop fields.
          const tx = Transaction.fromBEEF(o.beef)
          const script = tx.outputs[o.outputIndex]?.lockingScript
          if (!script) continue

          // 2) Decode PushDrop fields. For CurvePoint messages we emit 6 fields:
          //    [0]=threadId
          //    [1]=messageId     (not used here, but kept for reference)
          //    [2]=senderHex
          //    [3]=sentAt (ms)
          //    [4]=headerB64     (CurvePoint header with wrapped symmetric keys)
          //    [5]=cipherB64     (ciphertext of the JSON body)
          const { fields } = PushDrop.decode(script)
          if (!Array.isArray(fields) || fields.length !== 6) continue

          const fThreadId = Utils.toUTF8(fields[0])
          // const messageId = Utils.toUTF8(fields[1]) // available if/when I want it for dedupe
          const senderHex = Utils.toUTF8(fields[2])
          const sentAtStr = Utils.toUTF8(fields[3])
          const headerB64 = Utils.toUTF8(fields[4])
          const cipherB64 = Utils.toUTF8(fields[5])

          // Basic sanity + only process rows belonging to the thread I'm polling
          if (fThreadId !== threadId) continue

          const sentAt = Number(sentAtStr) || 0
          if (sentAt <= since) continue

          // 3) Reconstruct the CurvePoint ciphertext: header || message
          //    (The decrypt() expects a single byte array with the header prefix.)
          const header = Utils.toArray(headerB64, 'base64') as number[]
          const encMsg = Utils.toArray(cipherB64, 'base64') as number[]
          const ciphertext = header.concat(encMsg)

          // 4) Decrypt with my wallet identity (CurvePoint does: unwrap symmetric key from header, then decrypt body)
          //    Protocol ID must match the one used by the sender in sendMessage().
          const plaintext = await curve.decrypt(ciphertext, [1, 'ConvoCurve'], CURVE_KEY_ID)

          // 5) The body is JSON: { text: string; image?: string }
          const textJson = Utils.toUTF8(plaintext)
          let body: { text: string; image?: string }
          try {
            body = JSON.parse(textJson)
          } catch {
            // If a sender ever pushed plain text (not a JSON object), I coerce.
            body = { text: String(textJson) }
          }

          // Add to the batch for this thread
          collected.push({
            text: body.text,
            image: body.image,
            authorId: senderHex
          })
        } catch (e) {
          // Skip this single output on error and keep going; I don't want one bad row to stop the thread.
          console.error('[checkMessages] decode/decrypt failed', { threadId, error: e })
        }
      }

      if (collected.length) out.set(threadId, collected)
    })
  )

  return out
}
