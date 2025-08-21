// backend/src/services/ConvoStorage.ts
import type { Db, Collection, Filter } from 'mongodb'
import type {
  Thread,
  ThreadMember,
  Profile,
  Paginated,
  StoredMessageRecord,
  UTXOReference
} from '../types.js'

type ThreadAdmission = {
  threadId: string
  txid: string
  outputIndex: number
  createdAt: Date
}

/**
 * ConvoStorage
 * ------------
 * Canonical return shapes:
 * - findAdmittedMessages(threadId, limit?, before?) → { items: StoredMessageRecord[], nextBefore?: number }
 *   * sorted by sentAt desc; pass `before=<ms>` to page older
 * - findThreadsByMember(memberId, limit?, after?) → { items: Thread[], nextAfter?: number }
 *   * sorted by lastMessageAt desc; pass `after=<ms>` to page older
 */
export class ConvoStorage {
  private db: Db
  private prefix = 'convo'

  constructor (db: Db, opts?: { collectionPrefix?: string }) {
    this.db = db
    if (opts?.collectionPrefix) this.prefix = opts.collectionPrefix
    void this.ensureIndexes().catch(() => {})
  }

  private col<T extends import('mongodb').Document>(name: string): Collection<T> {
    return this.db.collection<T>(`${this.prefix}_${name}`)
  }

  private async ensureIndexes (): Promise<void> {
    const messages = this.col<StoredMessageRecord>('messages')
    const threads  = this.col<Thread>('threads')
    const members  = this.col<ThreadMember>('memberships')
    const profiles = this.col<Profile>('profiles')
    const admits   = this.col<ThreadAdmission>('thread_admissions')

    await Promise.allSettled([
      // Messages are paged by (threadId, sentAt desc)
      messages.createIndex({ threadId: 1, sentAt: -1 }),
      // Each admitted UTXO ref should be unique
      messages.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),

      // Threads are listed/paged by lastMessageAt desc
      threads.createIndex({ lastMessageAt: -1 }),
      threads.createIndex({ threadId: 1 }, { unique: true }),

      // Membership lookups: who is in which thread
      members.createIndex({ threadId: 1, memberId: 1 }, { unique: true }),
      members.createIndex({ memberId: 1, status: 1 }),

      // Profiles by identity key
      profiles.createIndex({ identityKey: 1 }, { unique: true }),

      // Admission UTXOs: one per thread; also unique by exact UTXO
      admits.createIndex({ threadId: 1 }, { unique: true }),
      admits.createIndex({ txid: 1, outputIndex: 1 }, { unique: true })
    ])
  }

  /* ===================== UTXO-aware message records ===================== */

  async insertAdmittedMessage (rec: StoredMessageRecord): Promise<void> {
    const messages = this.col<StoredMessageRecord>('messages')
    await messages.updateOne(
      { txid: rec.txid, outputIndex: rec.outputIndex },
      { $set: rec },
      { upsert: true }
    )
  }

  /**
   * Messages page backward in time (older) using `before=sentAtMs`.
   * Sorted desc so newest first.
   */
  async findAdmittedMessages (
    threadId: string,
    limit = 50,
    before?: number
  ): Promise<Paginated<StoredMessageRecord>> {
    const messages = this.col<StoredMessageRecord>('messages')

    const q: Filter<StoredMessageRecord> = { threadId }
    if (Number.isFinite(before)) (q as any).sentAt = { $lt: before }

    const cursor = messages.find<StoredMessageRecord>(q, {
      projection: {
        _id: 0,         // strip _id so the shape matches StoredMessageRecord
        txid: 1,
        outputIndex: 1,
        threadId: 1,
        messageId: 1,
        sender: 1,
        sentAt: 1,
        headerB64: 1,
        cipherB64: 1,
        createdAt: 1
      } as const
    })
    .sort({ sentAt: -1, _id: -1 })
    .limit(limit)

    const items = await cursor.toArray() // StoredMessageRecord[]
    const nextBefore = items.length === limit ? items[items.length - 1].sentAt : undefined
    return { items, nextBefore }
  }

  // Back-compat aliases (ok to keep; same shape)
  async insertMessage (rec: StoredMessageRecord): Promise<void> {
    return this.insertAdmittedMessage(rec)
  }
  async findMessages (
    threadId: string,
    limit = 50,
    before?: number
  ): Promise<Paginated<StoredMessageRecord>> {
    return this.findAdmittedMessages(threadId, limit, before)
  }

  /* ===================== Thread admission UTXO helpers ===================== */

  /** Remember which UTXO created a thread (create_thread control). */
  async recordThreadAdmission (threadId: string, txid: string, outputIndex: number): Promise<void> {
    const admits = this.col<ThreadAdmission>('thread_admissions')
    await admits.updateOne(
      { threadId },
      { $set: { threadId, txid, outputIndex, createdAt: new Date() } },
      { upsert: true }
    )
  }

  /** Fetch admission UTXO refs for a list of threads (used by findThreads lookup). */
  async getThreadAdmissionRefs (threadIds: string[]): Promise<UTXOReference[]> {
    if (!threadIds.length) return []
    const admits = this.col<ThreadAdmission>('thread_admissions')
    const rows = await admits.find({ threadId: { $in: threadIds } })
      .project({ _id: 0, txid: 1, outputIndex: 1 })
      .toArray()
    // rows already have txid/outputIndex shape
    return rows as unknown as UTXOReference[]
  }

  /* =========================== Threads & membership ========================== */

  /**
   * Upsert a thread by threadId.
   * - Only sets createdAt/createdBy on insert (if provided)
   * - Any other fields in `partial` are $set on every call
   */
  async upsertThread (partial: Partial<Thread> & { threadId: string }): Promise<void> {
    const coll = this.col<Thread>('threads')
    const { createdAt, createdBy, ...rest } = partial

    const setOnInsert: Record<string, unknown> = {}
    if (createdAt !== undefined) setOnInsert.createdAt = createdAt
    if (createdBy !== undefined) setOnInsert.createdBy = createdBy

    await coll.updateOne(
      { threadId: partial.threadId },
      {
        $set: rest,
        ...(Object.keys(setOnInsert).length ? { $setOnInsert: setOnInsert } : {})
      },
      { upsert: true }
    )
  }

  /**
   * Threads page backward in time using `after=lastMessageAtMs` (older).
   * Sorted desc so most recent activity first.
   */
  async findThreadsByMember (
    memberId: string,
    limit = 50,
    after?: number
  ): Promise<Paginated<Thread>> {
    const threads = this.col<Thread>('threads')
    const members = this.col<ThreadMember>('memberships')

    const memberNorm = memberId.toLowerCase()
    const threadIds = await members.distinct('threadId', { memberId: memberNorm, status: 'active' })
    if (!threadIds.length) return { items: [] }

    const q: any = { threadId: { $in: threadIds } }
    if (Number.isFinite(after)) q.lastMessageAt = { $lt: after }

    const items = await threads
      .find(q)
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(limit)
      .toArray()

    const nextAfter = items.length === limit ? items[items.length - 1].lastMessageAt : undefined
    return { items, nextAfter }
  }

  async upsertMemberships (ms: ThreadMember[]): Promise<void> {
    const coll = this.col<ThreadMember>('memberships')
    if (!ms.length) return

    // Normalize memberId lowercase to keep joins stable
    const ops = ms.map(m => {
      const normalized: ThreadMember = { ...m, memberId: m.memberId.toLowerCase() }
      return {
        updateOne: {
          filter: { threadId: normalized.threadId, memberId: normalized.memberId },
          update: {
            $set: normalized,
            $setOnInsert: { joinedAt: normalized.joinedAt ?? Date.now() }
          },
          upsert: true
        }
      }
    })

    await coll.bulkWrite(ops, { ordered: false })
  }

  async findMembers (threadId: string): Promise<ThreadMember[]> {
    return this.col<ThreadMember>('memberships').find({ threadId }).toArray()
  }

  /* ================================ Profiles ================================ */

  async setProfile (p: Profile): Promise<void> {
    const coll = this.col<Profile>('profiles')
    const identityKey = p.identityKey.toLowerCase()
    await coll.updateOne(
      { identityKey },
      { $set: { ...p, identityKey } },
      { upsert: true }
    )
  }

  async getProfile (identityKey: string): Promise<Profile | null> {
    return this.col<Profile>('profiles').findOne({ identityKey: identityKey.toLowerCase() })
  }
}
