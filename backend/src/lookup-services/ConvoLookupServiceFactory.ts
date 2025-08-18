import {
  LookupService, LookupQuestion, LookupFormula,
  AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent
} from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import type { Db } from 'mongodb'
import { ConvoStorage } from './ConvoStorage'
import type {
  FindThreadsQuery, FindMessagesQuery, FindMembersQuery, FindProfileQuery, ThreadMember
} from '../types.js'

const SERVICE_NAME = 'ls_convo'
const TOPIC_NAME = 'tm_ls_convo'

export class ConvoLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'
  constructor (public storage: ConvoStorage) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    if (payload.topic !== TOPIC_NAME) return
    const { lockingScript, txid, outputIndex } = payload

    try {
      const decoded = PushDrop.decode(lockingScript)
      const fields = decoded.fields.map(a => new Uint8Array(a))
      const f = (i: number) => Utils.toUTF8(Array.from(fields[i] ?? []))

      // Message: 7 fields
      if (fields.length === 7) {
        const threadId = f(0)
        const messageId = f(1)
        const senderKey = f(2)
        const sentAt = Number(f(3)) || Date.now()

        await this.storage.insertMessage({
          _type: 'message',
          threadId, messageId, sender: senderKey, sentAt,
          txid, outputIndex
        } as any)

        await this.storage.upsertThread({
          _type: 'thread',
          threadId,
          createdAt: sentAt,
          createdBy: senderKey,
          lastMessageAt: sentAt,
          memberCount: 0,
          envelopeVersion: 1
        } as any)

        await this.storage.upsertMemberships([{
          _type: 'membership',
          threadId,
          memberId: senderKey,
          role: 'member',
          joinedAt: sentAt,
          status: 'active',
          groupKeyBox: '',
          groupKeyFrom: senderKey
        }])

        return
      }

      const topic = f(0), proto = f(1), kind = f(2)
      if (topic === 'ls_convo' && proto === 'convo-v1' && kind === 'create_thread') {
        const threadId = f(3)
        const title    = f(4)
        const boxesRaw = f(5)
        const creatorIdentityHex = fields[6] ? Utils.toHex(Array.from(fields[6])) : ''
        const tsStr   = fields[7] ? f(7) : String(Date.now())
        const ts      = Number(tsStr) || Date.now()

        let boxes: Record<string, string> = {}
        try { boxes = JSON.parse(boxesRaw)?.boxes || {} } catch {}

        await this.storage.upsertThread({
          _type: 'thread',
          threadId,
          title: title || undefined,
          createdAt: ts,
          createdBy: creatorIdentityHex || 'unknown',
          lastMessageAt: ts,
          memberCount: Object.keys(boxes).length,
          envelopeVersion: 1
        } as any)

        const memberships: ThreadMember[] = Object
          .entries(boxes as Record<string, string>)
          .map(([memberId, boxB64]): ThreadMember => ({
            _type: 'membership',
            threadId,
            memberId: memberId.toLowerCase(),
            role: 'member',
            joinedAt: ts,
            status: 'active',
            groupKeyBox: boxB64,
            groupKeyFrom: creatorIdentityHex ?? 'unknown'
          }))

        if (memberships.length) {
          await this.storage.upsertMemberships(memberships)
        }
      }
    } catch (err) {
      console.error('[ConvoLookupService] decode/store failed:', err)
    }
  }

  async outputSpent (_payload: OutputSpent): Promise<void> {
    // Optional Cleanup
  }
  async outputEvicted (_txid: string, _vout: number): Promise<void> {}

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    if (!question.query) throw new Error('A valid query must be provided!')
    if (question.service !== SERVICE_NAME) throw new Error(`Unsupported service ${question.service}`)

    const q = question.query as FindMessagesQuery | FindThreadsQuery | FindMembersQuery | FindProfileQuery

    if (isFindMessages(q)) {
      // Return output-list so clients can fetch ciphertext UTXOs
      const { threadId, limit = 50, before } = q
      const { items } = await this.storage.findMessages(threadId, limit, before)
      return items
        .filter((m: any) => m.txid && typeof m.outputIndex === 'number')
        .map((m: any) => ({ txid: m.txid, outputIndex: m.outputIndex }))

    } else if (isFindThreads(q)) {
      // Return JSON thread summaries for discovery
      const { memberId, limit = 50, after } = q
      const { items, nextAfter } = await this.storage.findThreadsByMember(memberId, limit, after)
      return { type: 'json', value: { items, nextAfter } } as any

    } else if (isFindMembers(q)) {
      const members = await this.storage.findMembers(q.threadId)
      return { type: 'json', value: members } as any

    } else if (isFindProfile(q)) {
      const profile = await this.storage.getProfile(q.identityKey)
      return { type: 'json', value: profile ? [profile] : [] } as any
    }

    throw new Error('Unknown query')
  }

  async getDocumentation () { return 'ls_convo: findMessages/findThreads/findMembers/findProfile' }
  async getMetaData () { return { name: SERVICE_NAME, shortDescription: 'Convo Messaging Lookup Service' } }
}

function isObj (v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null }
function isFindMessages (q: any): q is FindMessagesQuery { return isObj(q) && q.type === 'findMessages' && typeof q.threadId === 'string' }
function isFindThreads  (q: any): q is FindThreadsQuery  { return isObj(q) && q.type === 'findThreads'  && typeof q.memberId === 'string' }
function isFindMembers  (q: any): q is FindMembersQuery  { return isObj(q) && q.type === 'findMembers'  && typeof q.threadId === 'string' }
function isFindProfile  (q: any): q is FindProfileQuery  { return isObj(q) && q.type === 'findProfile'  && typeof q.identityKey === 'string' }

export default (db: Db): ConvoLookupService => new ConvoLookupService(new ConvoStorage(db))
