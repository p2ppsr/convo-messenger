// backend/src/topic-managers/ConvoTopicManager.ts
import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop, Utils } from '@bsv/sdk'

const TOPIC_TAG = 'ls_convo'
const PROTOCOL_TAG = 'convo-v1'

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
          const { fields } = PushDrop.decode(out.lockingScript)
          const fieldsAsUint8: Uint8Array[] = Array.isArray(fields)
            ? fields.map(f => new Uint8Array(f))
            : []

          if (isMessageFields(fieldsAsUint8) || isControlFields(fieldsAsUint8)) {
            outputsToAdmit.push(index)
          }
        } catch {
          // Ignore outputs that aren't valid PushDrop or don't match our shapes
        }
      }
    } catch {
      // Fall through
    }

    return { outputsToAdmit, coinsToRetain: previousCoins }
  }

  async getDocumentation(): Promise<string> {
    return 'Convo Topic Manager: admits message ciphertext (CurvePoint) and control (thread/key) records.'
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string; version?: string }> {
    return { name: 'tm_ls_convo', shortDescription: 'Convo Messenger Topic Manager', version: '1.0.0' }
  }
}

/* ---------------- Helpers ---------------- */

type Field = Uint8Array

/**
 * Accepts:
 *  - CurvePoint (current): 6 fields
 *      [ threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64 ]
 *  - Legacy (optional): 7 fields (iv/tag/ct)
 *      [ threadId, messageId, senderKeyHex, sentAtMs, ivB64, tagB64, ctB64 ]
 */
function isMessageFields(fields?: Field[]): boolean {
  if (!Array.isArray(fields)) return false

  if (fields.length === 6) {
    // CurvePoint header+cipher shape
    const threadId   = sUtf8(fields[0])
    const messageId  = sUtf8(fields[1])
    const senderKey  = sUtf8(fields[2])
    const sentAtStr  = sUtf8(fields[3])
    const headerB64  = sUtf8(fields[4])
    const cipherB64  = sUtf8(fields[5])

    if (!threadId || !messageId) return false
    if (!isCompressedHex(senderKey)) return false

    const sentAt = Number(sentAtStr)
    if (!Number.isFinite(sentAt) || sentAt <= 0) return false

    // Header must be valid base64 and look like a CurvePoint header
    if (!isB64(headerB64) || !looksLikeCurvePointHeader(headerB64)) return false
    // Cipher must be valid base64, non-empty
    if (!isB64(cipherB64)) return false

    return true
  }

  if (fields.length === 7) {
    // Legacy acceptance (iv/tag/ct) – keep if you want backwards compat
    const threadId = sUtf8(fields[0])
    const messageId = sUtf8(fields[1])
    const senderKey = sUtf8(fields[2])
    const sentAtStr = sUtf8(fields[3])
    const ivB64 = sUtf8(fields[4])
    const tagB64 = sUtf8(fields[5])
    const ctB64 = sUtf8(fields[6])

    if (!threadId || !messageId) return false
    if (!isCompressedHex(senderKey)) return false

    const sentAt = Number(sentAtStr)
    if (!Number.isFinite(sentAt) || sentAt <= 0) return false

    return isB64(ivB64) && isB64(tagB64) && isB64(ctB64)
  }

  return false
}

function isControlFields(fields?: Field[]): boolean {
  if (!Array.isArray(fields) || fields.length < 4) return false

  const topic = sUtf8(fields[0])
  const proto = sUtf8(fields[1])
  const kind  = sUtf8(fields[2])
  const threadId = sUtf8(fields[3])

  if (topic !== TOPIC_TAG || proto !== PROTOCOL_TAG) return false
  if (!['create_thread','rotate_key','add_members','set_profile'].includes(kind)) return false
  if (!threadId) return false

  // payload (fields[4]...) is free form; no further validation here
  return true
}

/* -------- parsing/validation helpers -------- */

function sUtf8(b?: Uint8Array): string {
  try { return b ? Utils.toUTF8(Array.from(b)) : '' } catch { return '' }
}

function isCompressedHex(s: string): boolean {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(s)
}

function isB64(s: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0
}

/**
 * Quick sanity check that a base64 string decodes to a plausible CurvePoint header:
 * varint(totalLen) || [version: u32le] || varint(numRecipients) || ...
 */
function looksLikeCurvePointHeader(headerB64: string): boolean {
  try {
    const bytes = Utils.toArray(headerB64, 'base64') as number[]
    const r = new Utils.Reader(bytes)
    const headerLen = r.readVarIntNum()
    if (headerLen <= 0) return false
    if (headerLen > bytes.length - r.pos) return false

    const start = r.pos
    const inner = new Utils.Reader(bytes.slice(start, start + headerLen))
    const version = inner.readUInt32LE()
    if (!Number.isInteger(version) || version < 1) return false

    const numRecipients = inner.readVarIntNum()
    if (!Number.isInteger(numRecipients) || numRecipients <= 0 || numRecipients > 2048) return false

    return true
  } catch {
    return false
  }
}
