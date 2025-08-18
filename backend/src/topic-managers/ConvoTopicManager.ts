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
          const fieldsAsUint8: Uint8Array[] = Array.isArray(fields) ? fields.map(f => new Uint8Array(f)) : []
          if (isMessageFields(fieldsAsUint8) || isControlFields(fieldsAsUint8)) {
            outputsToAdmit.push(index)
          }
        } catch {
          // Ignore outputs that aren't valid PushDrop or don't match shapes
        }
      }
    } catch {
      // Fall through
    }

    return { outputsToAdmit, coinsToRetain: previousCoins }
  }

  async getDocumentation(): Promise<string> {
    return 'Convo Topic Manager: admits message ciphertext and control (thread/key) records.'
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string; version?: string }> {
    return { name: 'tm_ls_convo', shortDescription: 'Convo Messenger Topic Manager', version: '1.0.0' }
  }
}

/* ---------------- Helpers ---------------- */

type Field = Uint8Array

function isMessageFields(fields?: Field[]): boolean {
  if (!Array.isArray(fields) || fields.length !== 7) return false

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

function isControlFields(fields?: Field[]): boolean {
  if (!Array.isArray(fields) || fields.length < 6) return false
  const topic = sUtf8(fields[0])
  const proto = sUtf8(fields[1])
  const kind  = sUtf8(fields[2])
  const threadId = sUtf8(fields[3])

  if (topic !== 'ls_convo' || proto !== 'convo-v1') return false
  if (!['create_thread','rotate_key','add_members','set_profile'].includes(kind)) return false
  if (!threadId) return false
  return true
}

function sUtf8(b?: Uint8Array): string {
  try { return b ? Utils.toUTF8(Array.from(b)) : '' } catch { return '' }
}
function isCompressedHex(s: string): boolean {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(s)
}
function isB64(s: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0
}
