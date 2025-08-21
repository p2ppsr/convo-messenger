// backend/src/lookup-services/ConvoLookupServiceFactory.ts
import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import type { Db } from 'mongodb'

// ✅ correct location for storage
import { ConvoStorage } from './ConvoStorage'

import type {
  FindThreadsQuery,
  FindMessagesQuery,
  FindMembersQuery,
  FindProfileQuery,
  ThreadMember,
  StoredMessageRecord,
  Thread
} from '../types.js'

/** Service + protocol constants */
const SERVICE_NAME = 'ls_convo'
const TOPIC_NAME   = 'tm_ls_convo'
const PROTOCOL_TAG = 'convo-v1'

// Small helpers for consistent envelopes/logging
const asJson = (value: unknown): LookupFormula => ({ type: 'json', value } as any)
const arrLen = (v: unknown) => (Array.isArray(v) ? v.length : 0)

export class ConvoLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor (public storage: ConvoStorage) {}

  /** Overlay notifies us when an output matching our topic is admitted */
  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')

    const { topic, lockingScript, txid, outputIndex } = payload
    if (topic !== TOPIC_NAME) return

    try {
      const decoded = PushDrop.decode(lockingScript)
      const fields  = decoded.fields
      const getUtf8 = (i: number) => Utils.toUTF8(fields[i])

      // Signer pubkey (identity) from PushDrop chunk[0]
      const creatorIdentityHex =
        lockingScript.chunks?.[0]?.data ? Utils.toHex(lockingScript.chunks[0].data!) : 'unknown'

      // CONTROL records start with ["ls_convo","convo-v1", kind, threadId, ...]
      if (Array.isArray(fields) && fields.length >= 4) {
        const f0 = getUtf8(0)
        const f1 = getUtf8(1)
        if (f0 === SERVICE_NAME && f1 === PROTOCOL_TAG) {
          const kind     = getUtf8(2)
          const threadId = getUtf8(3)
          const ts       = Date.now()

          if (kind === 'create_thread') {
            // fields[4] = title?; fields[5] = JSON payload; fields[6] = optional timestamp
            const title = fields[4] ? getUtf8(4) : undefined

            // Accept BOTH new envelope+recipients and legacy boxes payloads.
            let keyEnvelopeB64: string | undefined
            let recipients: string[] = []
            let boxes: Record<string, string> = {}

            try {
              if (fields[5]) {
                const j = JSON.parse(getUtf8(5))
                if (j && typeof j === 'object') {
                  if (typeof (j as any).keyEnvelopeB64 === 'string') keyEnvelopeB64 = (j as any).keyEnvelopeB64
                  if (Array.isArray((j as any).recipients)) {
                    recipients = (j as any).recipients
                      .filter((x: unknown) => typeof x === 'string')
                      .map((x: string) => x.toLowerCase())
                  }
                  if ((j as any).boxes && typeof (j as any).boxes === 'object') {
                    boxes = (j as any).boxes as Record<string, string>
                  }
                }
              }
            } catch (e) {
              console.warn('[ls_convo] create_thread payload JSON parse failed:', e)
            }

            const memberCount =
              (recipients && recipients.length) ||
              (boxes && Object.keys(boxes).length) ||
              1

            // Upsert thread summary
            const tPartial: Partial<Thread> & { threadId: string } = {
              threadId,
              title,
              createdAt: ts,
              createdBy: creatorIdentityHex,
              lastMessageAt: ts,
              memberCount,
              envelopeVersion: keyEnvelopeB64 ? 2 : 1
            } as any
            await this.storage.upsertThread(tPartial)

            // Persist memberships in whichever format we have
            if (keyEnvelopeB64 && recipients.length) {
              type MemberRow = ThreadMember & { groupKeyEnvelopeB64?: string }
              const memberships: MemberRow[] = recipients.map(memberId => ({
                _type: 'membership',
                threadId,
                memberId,
                role: 'member',
                joinedAt: ts,
                status: 'active',
                groupKeyEnvelopeB64: keyEnvelopeB64,
                // keep legacy fields empty in v2
                groupKeyBox: '',
                groupKeyFrom: creatorIdentityHex
              }))
              await this.storage.upsertMemberships(memberships as unknown as ThreadMember[])
              console.log('[ls_convo] CONTROL create_thread (envelope)', {
                threadId, recipients: recipients.length
              })
            } else if (boxes && Object.keys(boxes).length) {
              const memberships: ThreadMember[] = Object.entries(boxes).map(([memberId, boxB64]) => ({
                _type: 'membership',
                threadId,
                memberId: memberId.toLowerCase(),
                role: 'member',
                joinedAt: ts,
                status: 'active',
                groupKeyBox: boxB64,
                groupKeyFrom: creatorIdentityHex
              }))
              await this.storage.upsertMemberships(memberships)
              console.log('[ls_convo] CONTROL create_thread (legacy boxes)', {
                threadId, members: Object.keys(boxes).length
              })
            } else {
              console.warn('[ls_convo] CONTROL create_thread with no recipients/boxes', { threadId })
            }

            // 🔐 record the admission UTXO for this thread
            try {
              await this.storage.recordThreadAdmission(threadId, txid, outputIndex)
            } catch (e) {
              console.warn('[ls_convo] recordThreadAdmission failed', { threadId, txid, outputIndex, err: e })
            }

            return
          }

          // Other control kinds can be handled later
          console.log('[ls_convo] CONTROL (ignored kind)', { kind, threadId })
          return
        }
      }

      // MESSAGE records (6 fields):
      // [ threadId, messageId, senderKeyHex, sentAtMs, headerB64, cipherB64 ]
      if (!Array.isArray(fields) || fields.length !== 6) return

      const threadId = Utils.toUTF8(fields[0])
      const messageId = Utils.toUTF8(fields[1])
      const senderIdentityKeyHex = Utils.toUTF8(fields[2])
      const sentAtStr = Utils.toUTF8(fields[3])
      const headerB64 = Utils.toUTF8(fields[4])
      const cipherB64 = Utils.toUTF8(fields[5])

      const sentAt = Number(sentAtStr) || Date.now()
      if (!threadId || !messageId) return

      const rec: StoredMessageRecord = {
        txid,
        outputIndex,
        threadId,
        messageId,
        sender: senderIdentityKeyHex,
        sentAt,
        headerB64,
        cipherB64,
        createdAt: new Date()
      }
      await this.storage.insertAdmittedMessage(rec)
      await this.storage.upsertThread({ threadId, lastMessageAt: sentAt } as any)

      // Ensure a membership row for the sender (light presence)
      const membership: ThreadMember = {
        _type: 'membership',
        threadId,
        memberId: senderIdentityKeyHex.toLowerCase(),
        role: 'member',
        joinedAt: sentAt,
        status: 'active',
        groupKeyBox: '',
        groupKeyFrom: ''
      }
      await this.storage.upsertMemberships([membership])

      console.log('[ls_convo] MESSAGE admitted', {
        threadId,
        messageId,
        utxo: `${txid}:${outputIndex}`
      })
    } catch (err) {
      console.error('[ls_convo] Failed to decode/store admitted output:', err)
    }
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    if (payload.topic !== TOPIC_NAME) return
    // Optional: cleanup on spend if you track exact UTXOs
  }

  async outputEvicted (_txid: string, _outputIndex: number): Promise<void> {
    // Optional: eviction policy
  }

  /** Lookup handler */
  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    // Compact trace for every lookup
    const qType = (question as any)?.query?.type ?? '(none)'
    console.log('[ls_convo] lookup →', { service: question.service, qType })

    if (!question.query) throw new Error('A valid query must be provided!')
    if (question.service !== SERVICE_NAME) {
      throw new Error(`Lookup service not supported: ${question.service}`)
    }

    const q = question.query as
      | (FindMessagesQuery & { type?: 'findMessages' })
      | (FindThreadsQuery  & { type?: 'findThreads'  })
      | (FindMembersQuery  & { type?: 'findMembers'  })
      | (FindProfileQuery  & { type?: 'findProfile'  })

    let result: any

    // findMessages -> array of UTXO refs (engine returns type: 'output-list')
    if (isFindMessages(q)) {
      const { threadId, limit = 50, before } = q
      const { items } = await this.storage.findAdmittedMessages(threadId, limit, before)
      const out = items.map(m => ({ txid: m.txid, outputIndex: m.outputIndex }))
      console.log('[ls_convo] findMessages → output-list size', out.length)
      result = out
      // return as array (not wrapped) so Engine emits { type:'output-list', ... }
      return result
    }

    // findThreads -> JSON envelope (NOT iterable)
    if (isFindThreads(q)) {
      const { memberId, limit = 50, after } = q
      const payload = await this.storage.findThreadsByMember(memberId, limit, after)
      console.log('[ls_convo] findThreads → json', {
        items: arrLen((payload as any)?.items),
        nextAfter: (payload as any)?.nextAfter ?? null
      })
      result = asJson(payload)
      return result
    }

    // findMembers -> JSON envelope
    if (isFindMembers(q)) {
      const { threadId } = q
      const members = await this.storage.findMembers(threadId)
      console.log('[ls_convo] findMembers → json length', members.length)
      result = asJson(members)
      return result
    }

    // findProfile -> JSON envelope (array of length 0|1)
    if (isFindProfile(q)) {
      const { identityKey } = q
      const profile = await this.storage.getProfile(identityKey)
      console.log('[ls_convo] findProfile → json found', !!profile)
      result = asJson(profile ? [profile] : [])
      return result
    }

    throw new Error('Unsupported or unknown query.')
  }

  async getDocumentation (): Promise<string> {
    return `ls_convo: findMessages (output-list), findThreads/findMembers/findProfile (json)`
  }

  async getMetaData (): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return { name: SERVICE_NAME, shortDescription: 'Convo Messaging Lookup Service' }
  }
}

/* ---------------- Type Guards ---------------- */

function isObject (v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function isFindMessages (q: any): q is FindMessagesQuery {
  return isObject(q) && (q.type === 'findMessages' || q.type == null) && typeof q.threadId === 'string'
}
function isFindThreads (q: any): q is FindThreadsQuery {
  return isObject(q) && (q.type === 'findThreads' || q.type == null) && typeof q.memberId === 'string'
}
function isFindMembers (q: any): q is FindMembersQuery {
  return isObject(q) && (q.type === 'findMembers' || q.type == null) && typeof q.threadId === 'string'
}
function isFindProfile (q: any): q is FindProfileQuery {
  return isObject(q) && (q.type === 'findProfile' || q.type == null) && typeof q.identityKey === 'string'
}

/* -------- Factory export -------- */
export default (db: Db): ConvoLookupService => {
  return new ConvoLookupService(new ConvoStorage(db))
}
