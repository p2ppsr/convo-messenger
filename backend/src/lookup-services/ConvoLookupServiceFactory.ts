// backend/src/lookup-services/ConvoLookupServiceFactory.ts
import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent,
} from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import type { Db } from 'mongodb'

import { ConvoStorage } from './ConvoStorage.js'

import type {
  StoredMessageRecord,
  Thread,
  ThreadMember,
} from '../types.js'

/** ------------------ Service + protocol constants ------------------ */
const SERVICE_NAME  = 'ls_convo'
const TOPIC_NAME    = 'tm_ls_convo'
const PROTOCOL_TAG  = 'convo-v1'

const LOG = '[ls_convo]'

// Helpers
const json = (value: unknown): LookupFormula => ({ type: 'json', value } as any)
const safeLen = (v: unknown) => (Array.isArray(v) ? v.length : 0)
const isB64 = (s: string) => {
  if (typeof s !== 'string' || s.length < 8) return false
  try { Utils.toArray(s, 'base64'); return true } catch { return false }
}

/** --------------------------- Lookup Service --------------------------- */
export class ConvoLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor (public storage: ConvoStorage) {}

  /** Overlay tells us when a topic-matching output is admitted */
  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, lockingScript, txid, outputIndex } = payload
    if (topic !== TOPIC_NAME) return

    try {
      const decoded = PushDrop.decode(lockingScript)
      const { fields } = decoded
      const getUtf8 = (i: number) => Utils.toUTF8(fields[i] ?? [])

      console.log(`${LOG} admitted output:`, {
        txid,
        outputIndex,
        topic,
        fieldCount: Array.isArray(fields) ? fields.length : -1,
      })

      // signer identity pubkey (compressed hex) from chunk[0]
      const signerHex =
        lockingScript.chunks?.[0]?.data ? Utils.toHex(lockingScript.chunks[0].data!) : 'unknown'

      /** ---------- CONTROL records:
       * ["ls_convo","convo-v1", kind, threadId, jsonPayload?]
       * We allow extra trailing fields from PushDrop.
       */
      if (Array.isArray(fields) && fields.length >= 4) {
        const f0 = getUtf8(0)
        const f1 = getUtf8(1)
        if (f0 === SERVICE_NAME && f1 === PROTOCOL_TAG) {
          const kind     = getUtf8(2)
          const threadId = (getUtf8(3) || '').toLowerCase()
          const ts       = Date.now()

          if (kind === 'create_thread') {
            let title: string | undefined
            let rawRecipients: string[] = []

            try {
              const raw = fields[4] ? getUtf8(4) : ''
              if (raw) {
                const j = JSON.parse(raw)
                if (typeof j?.title === 'string') title = j.title
                if (Array.isArray(j?.recipients)) {
                  rawRecipients = j.recipients.filter((x: unknown): x is string => typeof x === 'string')
                }
              }
            } catch (e) {
              console.warn(`${LOG} create_thread payload parse failed:`, e)
            }

            // normalize & build full member set (include creator)
            const creator = signerHex.toLowerCase()
            const normalizedRecipients = rawRecipients.map(k => k.toLowerCase())
            const members = Array.from(new Set<string>([creator, ...normalizedRecipients]))
            const memberCount = members.length
            const isDirect = memberCount === 2

            // upsert thread summary
            await this.storage.upsertThread({
              threadId,
              title,
              createdAt: ts,
              createdBy: creator,
              lastMessageAt: ts,
              memberCount,
              isDirect,
            })

            // persist memberships for everyone
            await this.storage.upsertMemberships(
              members.map(memberId => ({
                threadId,
                memberId,
                joinedAt: ts,
                status: 'active',
                role: 'member',
              }))
            )

            console.log(`${LOG} CONTROL create_thread:`, { threadId, memberCount, isDirect })
            return
          }

          // future control kinds
          console.log(`${LOG} CONTROL (ignored kind):`, { kind, threadId })
          return
        }
      }

      /** ---------- MESSAGE records:
       * [ threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64 ]
       * Accept >= 6 fields; ignore any additional trailing fields.
       */
      if (!Array.isArray(fields) || fields.length < 6) {
        console.log(`${LOG} not a MESSAGE: insufficient fields`, { fieldCount: Array.isArray(fields) ? fields.length : -1 })
        return
      }

      const use = fields.slice(0, 6) // take first 6 only
      const f = (i: number) => Utils.toUTF8(use[i] ?? [])

      const threadId     = (f(0) || '').toLowerCase()
      const messageId    = f(1) || ''
      const senderKeyHex = (f(2) || '').toLowerCase()
      const sentAtStr    = f(3) || ''
      const headerB64    = f(4) || ''
      const cipherB64    = f(5) || ''

      const sentAt = Number(sentAtStr)
      const problems: string[] = []
      if (!threadId) problems.push('threadId empty')
      if (!messageId) problems.push('messageId empty')
      if (!(Number.isFinite(sentAt) && sentAt > 0)) problems.push(`sentAt bad: ${sentAtStr}`)
      if (!isB64(headerB64)) problems.push('headerB64 invalid')
      if (!isB64(cipherB64)) problems.push('cipherB64 invalid')

      if (problems.length) {
        console.warn(`${LOG} MESSAGE parse rejected:`, { txid, outputIndex, problems })
        return
      }

      const rec: StoredMessageRecord = {
        txid,
        outputIndex,
        threadId,
        messageId,
        sender: senderKeyHex,
        sentAt,
        headerB64,
        cipherB64,
        createdAt: Date.now(),
      }
      await this.storage.insertAdmittedMessage(rec)

      // bump thread activity
      await this.storage.upsertThread({ threadId, lastMessageAt: sentAt })

      // ensure sender has a membership row
      await this.storage.upsertMemberships([{
        threadId,
        memberId: senderKeyHex,
        joinedAt: sentAt,
        status: 'active',
        role: 'member',
      }])

      console.log(`${LOG} MESSAGE stored:`, { threadId, messageId, utxo: `${txid}:${outputIndex}` })
    } catch (err) {
      console.error(`${LOG} Failed to decode/store admitted output:`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    if (payload.topic !== TOPIC_NAME) return
    // Optional: if tracking exact UTXOs for cleanup, can delete here.
  }

  async outputEvicted(_txid: string, _outputIndex: number): Promise<void> {
    // Optional: eviction handling
  }

  /** ------------------------------ Lookup ------------------------------ */
  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    console.log(`${LOG} lookup ->`, {
      service: question.service,
      qType: (question as any)?.query?.type ?? '(none)',
    })

    if (!question.query) throw new Error('A valid query must be provided!')
    if (question.service !== SERVICE_NAME) {
      throw new Error(`Lookup service not supported: ${question.service}`)
    }

    const q = question.query as
      | (FindMessagesQuery & { type?: 'findMessages' })
      | (FindThreadsQuery  & { type?: 'findThreads'  })
      | (FindMembersQuery  & { type?: 'findMembers'  })
      | (FindProfileQuery  & { type?: 'findProfile'  })

    // findMessages -> array of { txid, outputIndex }  (ENGINE EXPECTS ITERABLE)
    if (isFindMessages(q)) {
      const { threadId, limit = 50, before } = q
      // normalize to lower-case in case callers pass mixed-case ids
      const normThreadId = (threadId || '').toLowerCase()
      console.log(`${LOG} findMessages query:`, { threadId: normThreadId, limit, before })
      const { items } = await this.storage.findAdmittedMessages(normThreadId, limit, before)
      console.log(`${LOG} findMessages DB count:`, items.length)
      const utxos = items.map(m => ({ txid: m.txid, outputIndex: m.outputIndex }))
      console.log(`${LOG} findMessages -> output-list size:`, utxos.length)
      return utxos
    }

    // findThreads -> JSON envelope
    if (isFindThreads(q)) {
      const { memberId, limit = 50, after } = q
      const payload = await this.storage.findThreadsByMember(memberId.toLowerCase(), limit, after)
      console.log(`${LOG} findThreads -> json:`, {
        items: safeLen((payload as any)?.items),
        nextAfter: (payload as any)?.nextAfter ?? null,
      })
      return json(payload)
    }

    // findMembers -> JSON envelope (array)
    if (isFindMembers(q)) {
      const { threadId } = q
      const members = await this.storage.findMembers(threadId.toLowerCase())
      console.log(`${LOG} findMembers -> json length:`, members.length)
      return json(members)
    }

    // findProfile -> JSON envelope (array of 0|1)
    if (isFindProfile(q)) {
      const { identityKey } = q
      const profile = await this.storage.getProfile(identityKey.toLowerCase())
      console.log(`${LOG} findProfile -> json found:`, !!profile)
      return json(profile ? [profile] : [])
    }

    throw new Error('Unsupported or unknown query.')
  }

  async getDocumentation(): Promise<string> {
    return `ls_convo: findMessages (output-list), findThreads/findMembers/findProfile (json)`
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: SERVICE_NAME,
      shortDescription: 'Convo Messaging Lookup Service',
    }
  }
}

/** ------------------------------ Type guards ------------------------------ */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export type FindMessagesQuery = { type?: 'findMessages'; threadId: string; limit?: number; before?: number }
export type FindThreadsQuery  = { type?: 'findThreads';  memberId: string; limit?: number; after?: number }
export type FindMembersQuery  = { type?: 'findMembers';  threadId: string }
export type FindProfileQuery  = { type?: 'findProfile';  identityKey: string }

function isFindMessages(q: any): q is FindMessagesQuery {
  return isObj(q) && (q.type === 'findMessages' || q.type == null) && typeof q.threadId === 'string'
}
function isFindThreads(q: any): q is FindThreadsQuery {
  return isObj(q) && (q.type === 'findThreads'  || q.type == null) && typeof q.memberId === 'string'
}
function isFindMembers(q: any): q is FindMembersQuery {
  return isObj(q) && (q.type === 'findMembers'  || q.type == null) && typeof q.threadId === 'string'
}
function isFindProfile(q: any): q is FindProfileQuery {
  return isObj(q) && (q.type === 'findProfile'  || q.type == null) && typeof q.identityKey === 'string'
}

/** ------------------------------ Factory ------------------------------ */
export default (db: Db): ConvoLookupService => {
  return new ConvoLookupService(new ConvoStorage(db))
}
