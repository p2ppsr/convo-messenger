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

// Helpers
const json = (value: unknown): LookupFormula => ({ type: 'json', value } as any)
const safeLen = (v: unknown) => (Array.isArray(v) ? v.length : 0)

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
      const getUtf8 = (i: number) => Utils.toUTF8(fields[i])

      // signer identity pubkey (compressed hex) from chunk[0]
      const signerHex =
        lockingScript.chunks?.[0]?.data ? Utils.toHex(lockingScript.chunks[0].data!) : 'unknown'

      /** ---------- CONTROL records:
       * ["ls_convo","convo-v1", kind, threadId, jsonPayload?]
       */
      if (Array.isArray(fields) && fields.length >= 4) {
        const f0 = getUtf8(0)
        const f1 = getUtf8(1)
        if (f0 === SERVICE_NAME && f1 === PROTOCOL_TAG) {
          const kind     = getUtf8(2)
          const threadId = getUtf8(3)
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
              console.warn('[ls_convo] create_thread payload parse failed:', e)
            }

            // normalize & build full member set (include creator)
            const creator = signerHex.toLowerCase()
            const normalizedRecipients = rawRecipients.map(k => k.toLowerCase())
            const members = Array.from(new Set<string>([creator, ...normalizedRecipients]))
            const memberCount = members.length
            const isDirect = memberCount === 2

            // upsert thread summary
            await this.storage.upsertThread({
              threadId: threadId.toLowerCase(),
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

            console.log('[ls_convo] CONTROL create_thread:', { threadId, memberCount, isDirect })
            return
          }

          // future control kinds
          console.log('[ls_convo] CONTROL (ignored kind):', { kind, threadId })
          return
        }
      }

      /** ---------- MESSAGE records (6 fields):
       * [ threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64 ]
       */
      if (!Array.isArray(fields) || fields.length !== 6) return

      const threadId = Utils.toUTF8(fields[0])
      const messageId = Utils.toUTF8(fields[1])
      const senderKeyHex = Utils.toUTF8(fields[2])
      const sentAtStr = Utils.toUTF8(fields[3])
      const headerB64 = Utils.toUTF8(fields[4])
      const cipherB64 = Utils.toUTF8(fields[5])

      const sentAt = Number(sentAtStr) || Date.now()
      if (!threadId || !messageId) return

      const rec: StoredMessageRecord = {
        txid,
        outputIndex,
        threadId: threadId.toLowerCase(),
        messageId,
        sender: senderKeyHex.toLowerCase(),
        sentAt,
        headerB64,
        cipherB64,
        createdAt: Date.now(),
      }
      await this.storage.insertAdmittedMessage(rec)

      // bump thread activity
      await this.storage.upsertThread({ threadId: threadId.toLowerCase(), lastMessageAt: sentAt })

      // ensure sender has a membership row
      await this.storage.upsertMemberships([{
        threadId,
        memberId: senderKeyHex.toLowerCase(),
        joinedAt: sentAt,
        status: 'active',
        role: 'member',
      }])

      console.log('[ls_convo] MESSAGE admitted:', { threadId, messageId, utxo: `${txid}:${outputIndex}` })
    } catch (err) {
      console.error('[ls_convo] Failed to decode/store admitted output:', err)
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
    console.log('[ls_convo] lookup ->', {
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
      const { items } = await this.storage.findAdmittedMessages(threadId, limit, before)
      const utxos = items.map(m => ({ txid: m.txid, outputIndex: m.outputIndex }))
      console.log('[ls_convo] findMessages -> output-list size:', utxos.length)
      return utxos
    }

    // findThreads -> JSON envelope
    if (isFindThreads(q)) {
      const { memberId, limit = 50, after } = q
      const payload = await this.storage.findThreadsByMember(memberId, limit, after)
      console.log('[ls_convo] findThreads -> json:', {
        items: safeLen((payload as any)?.items),
        nextAfter: (payload as any)?.nextAfter ?? null,
      })
      return json(payload)
    }

    // findMembers -> JSON envelope (array)
    if (isFindMembers(q)) {
      const { threadId } = q
      const members = await this.storage.findMembers(threadId)
      console.log('[ls_convo] findMembers -> json length:', members.length)
      return json(members)
    }

    // findProfile -> JSON envelope (array of 0|1)
    if (isFindProfile(q)) {
      const { identityKey } = q
      const profile = await this.storage.getProfile(identityKey)
      console.log('[ls_convo] findProfile -> json found:', !!profile)
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
