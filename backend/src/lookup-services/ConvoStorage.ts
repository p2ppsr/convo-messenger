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

const P = '[ConvoStorage]'

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

    console.log(`${P} init`, {
      db: db.databaseName,
      collections: {
        messages: this.messages.collectionName,
        threads: this.threads.collectionName,
        members: this.members.collectionName,
        profiles: this.profiles.collectionName,
      }
    })

    void this.ensureIndexes().catch(err =>
      console.warn(`${P} ensureIndexes failed:`, err)
    )
  }

  /* ------------------------------- Indexes ------------------------------- */

  private async ensureIndexes(): Promise<void> {
    const res = await Promise.allSettled([
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
    console.log(`${P} indexes ensured`, res.map(r => r.status))
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
    try {
      const r = await this.messages.updateOne(
        { txid: doc.txid, outputIndex: doc.outputIndex },
        { $set: doc },
        { upsert: true }
      )
      console.log(`${P} insertAdmittedMessage`, {
        utxo: `${doc.txid}:${doc.outputIndex}`,
        threadId: doc.threadId,
        sentAt: doc.sentAt,
        matched: r.matchedCount,
        upsertedId: (r as any).upsertedId ?? null,
        acknowledged: r.acknowledged
      })
    } catch (e) {
      console.error(`${P} insertAdmittedMessage FAILED`, {
        utxo: `${rec.txid}:${rec.outputIndex}`,
        err: e
      })
      throw e
    }
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
      projection: {} as const,
      sort: { sentAt: -1, _id: -1 },
      limit,
    })

    const items = await cursor.toArray()
    const nextBefore =
      items.length === limit ? items[items.length - 1].sentAt : undefined

    console.log(`${P} findAdmittedMessages`, {
      threadId: this.lowerHex(threadId),
      limit, before,
      count: items.length,
      nextBefore: nextBefore ?? null
    })

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

    const r = await this.threads.updateOne(
      { threadId },
      {
        ...(Object.keys($setOnInsert).length ? { $setOnInsert } : {}),
        $set: { ...rest, threadId },
      },
      { upsert: true }
    )

    console.log(`${P} upsertThread`, {
      threadId,
      setOnInsert: Object.keys($setOnInsert),
      matched: r.matchedCount,
      upsertedId: (r as any).upsertedId ?? null,
      acknowledged: r.acknowledged
    })
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
    console.log(`${P} findThreadsByMember: member has`, { member, threads: threadIds.length })

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

    console.log(`${P} findThreadsByMember result`, {
      count: items.length,
      nextAfter: nextAfter ?? null
    })

    return { items, nextAfter }
  }

  /* ------------------------------ Memberships ----------------------------- */

  async upsertMemberships(ms: ThreadMember[]): Promise<void> {
    if (!ms?.length) {
      console.log(`${P} upsertMemberships (no items)`)
      return
    }

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

    const r = await this.members.bulkWrite(ops, { ordered: false })
    console.log(`${P} upsertMemberships`, {
      requested: ms.length,
      upserted: r.upsertedCount,
      modified: r.modifiedCount,
      matched: r.matchedCount
    })
  }

  async findMembers(threadId: string): Promise<ThreadMember[]> {
    const items = await this.members
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

    console.log(`${P} findMembers`, { threadId: this.lowerHex(threadId), count: items.length })
    return items
  }

  /* -------------------------------- Profiles ------------------------------ */

  async setProfile(p: Profile): Promise<void> {
    const identityKey = this.lowerHex(p.identityKey)!
    const r = await this.profiles.updateOne(
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
    console.log(`${P} setProfile`, {
      identityKey,
      matched: r.matchedCount,
      upsertedId: (r as any).upsertedId ?? null
    })
  }

  async getProfile(identityKey: string): Promise<Profile | null> {
    const res = await this.profiles.findOne(
      { identityKey: this.lowerHex(identityKey)! },
      { projection: { _id: 0 } }
    )
    console.log(`${P} getProfile`, { identityKey: this.lowerHex(identityKey), found: !!res })
    return res
  }
}
