// backend/src/services/ConvoStorage.ts
import type { Db, Collection } from 'mongodb'
import type {
  Thread,
  ThreadMember,
  Profile,
  Paginated,
  StoredMessageRecord,
} from '../types.js'

export class ConvoStorage {
  private db: Db
  private prefix = 'convo'

  constructor(db: Db, opts?: { collectionPrefix?: string }) {
    this.db = db
    if (opts?.collectionPrefix) this.prefix = opts.collectionPrefix
    void this.ensureIndexes().catch(() => {})
  }

  private col<T extends import('mongodb').Document>(name: string): Collection<T> {
    return this.db.collection<T>(`${this.prefix}_${name}`)
  }

  // Optional: ensure indexes are created
  private async ensureIndexes(): Promise<void> {
    const messages = this.col<StoredMessageRecord>('messages')
    const threads  = this.col<Thread>('threads')
    const members  = this.col<ThreadMember>('memberships')
    const profiles = this.col<Profile>('profiles')

    await Promise.allSettled([
      messages.createIndex({ threadId: 1, sentAt: -1 }),
      messages.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),
      threads.createIndex({ lastMessageAt: -1 }),
      members.createIndex({ threadId: 1, memberId: 1 }, { unique: true }),
      members.createIndex({ memberId: 1, status: 1 }),
      profiles.createIndex({ identityKey: 1 }, { unique: true })
    ])
  }

  /* ========= UTXO-aware message records (used by LookupService) ========= */

  async insertAdmittedMessage(rec: StoredMessageRecord): Promise<void> {
    const messages = this.col<StoredMessageRecord>('messages')
    await messages.updateOne(
      { txid: rec.txid, outputIndex: rec.outputIndex },
      { $set: rec },
      { upsert: true }
    )
  }

  async findAdmittedMessages(
    threadId: string,
    limit = 50,
    before?: number
  ): Promise<Paginated<StoredMessageRecord>> {
    const messages = this.col<StoredMessageRecord>('messages')
    const q: any = { threadId }
    if (before) q.sentAt = { $lt: before }
    const items = await messages.find(q).sort({ sentAt: -1 }).limit(limit).toArray()
    const nextBefore = items.length === limit ? items[items.length - 1].sentAt : undefined
    return { items, nextBefore }
  }

  async insertMessage(rec: StoredMessageRecord): Promise<void> {
    return this.insertAdmittedMessage(rec)
  }

  async findMessages(
    threadId: string,
    limit = 50,
    before?: number
  ): Promise<Paginated<StoredMessageRecord>> {
    return this.findAdmittedMessages(threadId, limit, before)
  }

  /* ====================== Threads & membership ====================== */

  async upsertThread(partial: Partial<Thread> & { threadId: string }): Promise<void> {
    const coll = this.col<Thread>('threads')
    await coll.updateOne({ threadId: partial.threadId }, { $set: partial }, { upsert: true })
  }

  async findThreadsByMember(
    memberId: string,
    limit = 50,
    after?: number
  ): Promise<Paginated<Thread>> {
    const threads = this.col<Thread>('threads')
    const members = this.col<ThreadMember>('memberships')

    const threadIds = await members.distinct('threadId', { memberId, status: 'active' })
    const q: any = { threadId: { $in: threadIds } }
    if (after) q.lastMessageAt = { $lt: after }

    const items = await threads.find(q).sort({ lastMessageAt: -1 }).limit(limit).toArray()
    const nextAfter = items.length === limit ? items[items.length - 1].lastMessageAt : undefined
    return { items, nextAfter }
  }

  async upsertMemberships(ms: ThreadMember[]): Promise<void> {
    const coll = this.col<ThreadMember>('memberships')
    await Promise.all(ms.map(m =>
      coll.updateOne(
        { threadId: m.threadId, memberId: m.memberId },
        { $set: m },
        { upsert: true }
      )
    ))
  }

  async findMembers(threadId: string): Promise<ThreadMember[]> {
    return await this.col<ThreadMember>('memberships').find({ threadId }).toArray()
  }

  /* ============================ Profiles ============================ */

  async setProfile(p: Profile): Promise<void> {
    const coll = this.col<Profile>('profiles')
    await coll.updateOne({ identityKey: p.identityKey }, { $set: p }, { upsert: true })
  }

  async getProfile(identityKey: string): Promise<Profile | null> {
    return await this.col<Profile>('profiles').findOne({ identityKey })
  }
}
