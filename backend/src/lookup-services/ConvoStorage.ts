// backend/src/lookup-services/ConvoStorage.ts
import type { Db, Collection, Filter } from 'mongodb'
import type {
  StoredMessageRecord,
  Thread,
  ThreadMember,
  Profile,
} from '../types.js'

type Paginated<T> = {
  items: T[]
  nextBefore?: number
  nextAfter?: number
}

export class ConvoStorage {
  private messages: Collection<StoredMessageRecord>
  private threads: Collection<Thread>
  private members: Collection<ThreadMember>
  private profiles: Collection<Profile>

  constructor (db: Db, collectionPrefix = 'convo') {
    this.messages = db.collection<StoredMessageRecord>(`${collectionPrefix}_messages`)
    this.threads  = db.collection<Thread>(`${collectionPrefix}_threads`)
    this.members  = db.collection<ThreadMember>(`${collectionPrefix}_memberships`)
    this.profiles = db.collection<Profile>(`${collectionPrefix}_profiles`)

    void this.ensureIndexes().catch(err =>
      console.warn('[ConvoStorage] ensureIndexes failed:', err)
    )
  }

  /* ------------------------------- Indexes ------------------------------- */

  private async ensureIndexes(): Promise<void> {
    await Promise.allSettled([
      // Messages: paging & uniqueness by admitted UTXO
      this.messages.createIndex({ threadId: 1, sentAt: -1 }),
      this.messages.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),

      // Threads: list most-recent first, address by id
      this.threads.createIndex({ lastMessageAt: -1 }),
      this.threads.createIndex({ threadId: 1 }, { unique: true }),

      // Memberships: uniqueness per (thread, member), fast lookups by member
      this.members.createIndex({ threadId: 1, memberId: 1 }, { unique: true }),
      this.members.createIndex({ memberId: 1, status: 1 }),

      // Profiles: one per identity
      this.profiles.createIndex({ identityKey: 1 }, { unique: true }),
    ])
  }

  /* --------------------------- Helper: normalize -------------------------- */

  private lowerHex(s: string | undefined): string | undefined {
    return typeof s === 'string' ? s.replace(/^0x/i, '').toLowerCase() : s
  }

  /* -------------------------- Messages (admitted) ------------------------- */

  /**
   * Upsert one admitted message UTXO (by txid:vout).
   * `createdAt` should be a number (ms) timestamp of when we ingested it.
   */
  async insertAdmittedMessage(rec: StoredMessageRecord): Promise<void> {
    const doc: StoredMessageRecord = {
      ...rec,
      threadId: this.lowerHex(rec.threadId)!,
      sender: this.lowerHex(rec.sender)!,
    }
    await this.messages.updateOne(
      { txid: doc.txid, outputIndex: doc.outputIndex },
      { $set: doc },
      { upsert: true }
    )
  }

  /**
   * Page messages newest→older. Use `before=<sentAtMs>` to page further back.
   * Returns items and the next cursor (`nextBefore`) if there are more.
   */
  async findAdmittedMessages(
    threadId: string,
    limit = 50,
    before?: number
  ): Promise<Paginated<StoredMessageRecord>> {
    const q: Filter<StoredMessageRecord> = {
      threadId: this.lowerHex(threadId)!,
      ...(Number.isFinite(before) ? { sentAt: { $lt: before } } : {}),
    }

    const cursor = this.messages.find<StoredMessageRecord>(q, {
      projection: { /* … */ } as const,
      sort: { sentAt: -1, _id: -1 },
      limit,
    })

    const items = await cursor.toArray()
    const nextBefore =
      items.length === limit ? items[items.length - 1].sentAt : undefined

    return { items, nextBefore }
  }

  /* -------------------------------- Threads ------------------------------- */

  /**
   * Upsert a thread summary by id.
   * - createdAt/createdBy are only set on insert
   * - everything else is $set on every call
   */
  async upsertThread(partial: Partial<Thread> & { threadId: string }): Promise<void> {
    const threadId = this.lowerHex(partial.threadId)!
    const createdBy = this.lowerHex(partial.createdBy)

    const $setOnInsert: Partial<Thread> = {}
    if (typeof partial.createdAt === 'number') $setOnInsert.createdAt = partial.createdAt
    if (createdBy) $setOnInsert.createdBy = createdBy

    const { createdAt, createdBy: _cb, threadId: _tid, ...rest } = partial

    await this.threads.updateOne(
      { threadId },
      {
        ...(Object.keys($setOnInsert).length ? { $setOnInsert } : {}),
        $set: { ...rest, threadId },
      },
      { upsert: true }
    )
  }

  /**
   * List threads for a member, newest activity first.
   * Page with `after=<lastMessageAtMs>` to get older threads.
   */
  async findThreadsByMember(
    memberId: string,
    limit = 50,
    after?: number
  ): Promise<Paginated<Thread>> {
    const member = this.lowerHex(memberId)!
    const threadIds = await this.members.distinct('threadId', { memberId: member, status: 'active' })
    if (!threadIds.length) return { items: [] }

    const q: Filter<Thread> = {
      threadId: { $in: threadIds },
      ...(Number.isFinite(after) ? { lastMessageAt: { $lt: after } } : {}),
    }

    const items = await this.threads
    .find(q, { sort: { lastMessageAt: -1, _id: -1 }, limit })
    .project<Thread>({ _id: 0 })
    .toArray()

    const nextAfter =
      items.length === limit ? items[items.length - 1].lastMessageAt : undefined

    return { items, nextAfter }
  }

  /* ------------------------------ Memberships ----------------------------- */

  async upsertMemberships(ms: ThreadMember[]): Promise<void> {
    if (!ms?.length) return

    const ops = ms.map((m) => {
      const normalized: ThreadMember = {
        ...m,
        threadId: this.lowerHex(m.threadId)!,
        memberId: this.lowerHex(m.memberId)!,
        status: m.status ?? 'active',
        joinedAt: m.joinedAt ?? Date.now(),
      }
      return {
        updateOne: {
          filter: { threadId: normalized.threadId, memberId: normalized.memberId },
          update: {
            $setOnInsert: { joinedAt: normalized.joinedAt },
            $set: {
              status: normalized.status,
              role: normalized.role,
              leftAt: normalized.leftAt,
              lastReadAt: normalized.lastReadAt,
            },
          },
          upsert: true,
        },
      }
    })

    await this.members.bulkWrite(ops, { ordered: false })
  }

  async findMembers(threadId: string): Promise<ThreadMember[]> {
    return this.members
      .find({ threadId: this.lowerHex(threadId)! })
      .project<ThreadMember>({
        _id: 0,
        threadId: 1,
        memberId: 1,
        joinedAt: 1,
        status: 1,
        role: 1,
        leftAt: 1,
        lastReadAt: 1,
      } as const)
      .toArray()
  }

  /* -------------------------------- Profiles ------------------------------ */

  async setProfile(p: Profile): Promise<void> {
    const identityKey = this.lowerHex(p.identityKey)!
    await this.profiles.updateOne(
      { identityKey },
      {
        $set: {
          identityKey,
          displayName: p.displayName,
          avatar: p.avatar,
        },
      },
      { upsert: true }
    )
  }

  async getProfile(identityKey: string): Promise<Profile | null> {
    return this.profiles.findOne(
      { identityKey: this.lowerHex(identityKey)! },
      { projection: { _id: 0 } }
    )
  }
}
