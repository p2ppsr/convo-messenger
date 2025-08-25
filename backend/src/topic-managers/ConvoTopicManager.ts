// backend/src/topic-managers/ConvoTopicManager.ts
import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop, Utils } from '@bsv/sdk'

/**
 * Convo Topic Manager
 * Admits outputs that look like either:
 * 1) CONTROL: ["ls_convo","convo-v1", kind, threadId, json?]
 * 2) MESSAGE: [threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64]
 */
export default class ConvoTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      const tx = Transaction.fromBEEF(beef)

      for (const [index, out] of tx.outputs.entries()) {
        try {
          const decoded = PushDrop.decode(out.lockingScript)
          const fields = decoded.fields

          // Helper decoders
          const utf8 = (i: number) => Utils.toUTF8(fields[i] ?? [])
          const looksHex = (s: string) => /^[0-9a-f]+$/i.test(s)
          const looksB64 = (s: string) => {
            if (typeof s !== 'string' || s.length < 8) return false
            try {
              // Throws if invalid
              Utils.toArray(s, 'base64')
              return true
            } catch {
              return false
            }
          }

          // ---------- CONTROL record?
          // ["ls_convo","convo-v1", kind, threadId, json?]
          if (Array.isArray(fields) && fields.length >= 4) {
            const f0 = utf8(0)
            const f1 = utf8(1)
            if (f0 === 'ls_convo' && f1 === 'convo-v1') {
              outputsToAdmit.push(index)
              continue
            }
          }

          // ---------- MESSAGE record?
          // [ threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64 ]
          if (Array.isArray(fields) && fields.length === 6) {
            const threadId   = utf8(0)
            const messageId  = utf8(1)
            const senderHex  = utf8(2)
            const sentAtStr  = utf8(3)
            const headerB64  = utf8(4)
            const cipherB64  = utf8(5)

            const sentAtOk   = Number.isFinite(Number(sentAtStr)) && Number(sentAtStr) > 0
            const idsOk      = looksHex(threadId) && threadId.length >= 32 && looksHex(messageId) && messageId.length >= 32
            const senderOk   = looksHex(senderHex) && (senderHex.length === 66) // compressed pubkey
            const payloadOk  = looksB64(headerB64) && looksB64(cipherB64)

            if (idsOk && senderOk && sentAtOk && payloadOk) {
              outputsToAdmit.push(index)
              continue
            }
          }

          // Not a Convo output we recognize
        } catch (e) {
          // Ignore malformed outputs; just don't admit them
          // console.debug('[tm_ls_convo] Skip output', index, e)
        }
      }

      if (outputsToAdmit.length === 0) {
        // Optional: verbose logging during bring-up
        // console.warn('[tm_ls_convo] No admissible outputs in tx')
      }

      return {
        outputsToAdmit,
        coinsToRetain: previousCoins
      }
    } catch (err) {
      // If we can't parse the tx, admit nothing and retain nothing
      // (overlay will handle safely)
      // console.error('[tm_ls_convo] Failed to parse tx:', err)
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
  }

  async getDocumentation() {
    return `tm_ls_convo: admits Convo control + message outputs.
- CONTROL: ["ls_convo","convo-v1", kind, threadId, json?]
- MESSAGE: [threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64]`
  }

  async getMetaData() {
    return {
      name: 'tm_ls_convo',
      shortDescription: 'Convo Messaging Topic Manager',
      version: '1.0.0'
    }
  }
}
