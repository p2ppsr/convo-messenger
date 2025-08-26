// backend/src/topic-managers/ConvoTopicManager.ts
import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop, Utils } from '@bsv/sdk'

/**
 * Convo Topic Manager
 * Admits outputs that look like either:
 * 1) CONTROL: ["ls_convo","convo-v1", kind, threadId, json?]
 * 2) MESSAGE: [threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64]
 */

const TM_NAME = 'tm_ls_convo'
const CONTROL_SERVICE = 'ls_convo'
const CONTROL_PROTO   = 'convo-v1'


// Small helpers for readable diagnostics
const clip = (s: string, n = 64) => (s.length > n ? `${s.slice(0, n)}…(${s.length})` : s)
const preview = (s: string, n = 8) =>
  typeof s === 'string' ? (s.length <= 2 * n ? s : `${s.slice(0, n)}…${s.slice(-n)}`) : String(s)
const looksHex = (s: string) => typeof s === 'string' && /^[0-9a-f]+$/i.test(s)
const isB64 = (s: string) => {
  if (typeof s !== 'string' || s.length < 8) return false
  try { Utils.toArray(s, 'base64'); return true } catch { return false }
}

// Dump all fields as UTF-8 (bin-safe)
const dumpFields = (fields: number[][]) =>
  fields.map((_, i) => {
    try { return `[${i}]=${clip(Utils.toUTF8(fields[i]))}` }
    catch { return `[${i}]=<bin:${fields[i]?.length ?? 0}>` }
  }).join(' | ')

export default class ConvoTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
  beef: number[],
  previousCoins: number[]
): Promise<AdmittanceInstructions> {
  const outputsToAdmit: number[] = []

  try {
    const tx = Transaction.fromBEEF(beef)
    console.log(
      `[${TM_NAME}] checking tx ${tx.id('hex')} | outputs=${tx.outputs.length} coinsToRetain=${previousCoins.length}`
    )

    for (const [index, output] of tx.outputs.entries()) {
      try {
        const decoded = PushDrop.decode(output.lockingScript)
        const { fields } = decoded
        const utf8 = (i: number) => Utils.toUTF8(fields[i] ?? [])

        console.log(`[${TM_NAME}] o#${index} pushdrop fields=${fields.length}: ${dumpFields(fields)}`)

        // ---------- CONTROL ----------
        // ["ls_convo","convo-v1", kind, threadId, json?]
        if (Array.isArray(fields) && fields.length >= 4) {
          const f0 = utf8(0)
          const f1 = utf8(1)
          if (f0 === CONTROL_SERVICE && f1 === CONTROL_PROTO) {
            const kind = utf8(2)
            const threadId = utf8(3)
            console.log(
              `[${TM_NAME}] o#${index} CONTROL match: kind=${kind} thread=${preview(threadId)}`
            )
            outputsToAdmit.push(index)
            continue
          }
        }

        // ---------- MESSAGE ----------
        // [ threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64 ]
        if (Array.isArray(fields) && fields.length >= 6) {
          const threadId  = utf8(0)
          const messageId = utf8(1)
          const senderHex = utf8(2)
          const sentAtStr = utf8(3)
          const headerB64 = utf8(4)
          const cipherB64 = utf8(5)

          const sentAtNum = Number(sentAtStr)
          const sentAtOk  = Number.isFinite(sentAtNum) && sentAtNum > 0
          const threadOk  = looksHex(threadId)  && threadId.length  >= 32
          const msgIdOk   = looksHex(messageId) && messageId.length >= 32
          const senderOk  = looksHex(senderHex) && senderHex.length === 66  // 33 bytes compressed => 66 hex chars
          const headerOk  = isB64(headerB64)
          const cipherOk  = isB64(cipherB64)

          if (threadOk && msgIdOk && senderOk && sentAtOk && headerOk && cipherOk) {
            if (fields.length > 6) {
              console.log(`[tm_ls_convo] o#${index} MESSAGE admitted with ${fields.length - 6} extra field(s) from PushDrop.`)
            }
            outputsToAdmit.push(index)
            continue
          }

          const reasons: string[] = []
          if (!threadOk) reasons.push(`threadId bad (hex=${looksHex(threadId)} len=${threadId?.length})`)
          if (!msgIdOk) reasons.push(`messageId bad (hex=${looksHex(messageId)} len=${messageId?.length})`)
          if (!senderOk) reasons.push(`sender bad (hex=${looksHex(senderHex)} len=${senderHex?.length})`)
          if (!sentAtOk) reasons.push(`sentAt bad (${sentAtStr})`)
          if (!headerOk) reasons.push('headerB64 bad')
          if (!cipherOk) reasons.push('cipherB64 bad')

          console.warn(`[${TM_NAME}] o#${index} MESSAGE rejected: ${reasons.join('; ')}`)
          continue
        }

        console.warn(
          `[${TM_NAME}] o#${index} NOT RECOGNIZED (fields=${fields.length}) -> ${dumpFields(fields)}`
        )
      } catch (e) {
        console.warn(
          `[${TM_NAME}] o#${index} PushDrop.decode failed (lockingScript len=${output.lockingScript.toHex().length} hex):`,
          e
        )
      }
    }

    if (outputsToAdmit.length === 0) {
      console.warn(`[${TM_NAME}] no admissible outputs for tx ${tx.id('hex')}`)
    } else {
      console.log(`[${TM_NAME}] admit indices -> [${outputsToAdmit.join(', ')}]`)
    }

    return { outputsToAdmit, coinsToRetain: previousCoins }
  } catch (err) {
    console.error(`[${TM_NAME}] failed to parse tx/beef`, err)
    return { outputsToAdmit: [], coinsToRetain: [] }
  }
}


  async getDocumentation() {
    return `${TM_NAME}: admits Convo control + message outputs.
- CONTROL: ["${CONTROL_SERVICE}","${CONTROL_PROTO}", kind, threadId, json?]
- MESSAGE: [threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64]`
  }

  async getMetaData() {
    return {
      name: TM_NAME,
      shortDescription: 'Convo Messaging Topic Manager',
      version: '1.0.0'
    }
  }
}


