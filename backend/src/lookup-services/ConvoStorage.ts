// backend/src/lookup-services/ConvoStorage.ts

import { Collection, Db } from "mongodb"
import { EncryptedMessage, Thread, ParticipantChangeLog } from "../types"

export interface ReactionRecord {
  txid: string
  threadId: string
  outputIndex: number
  messageTxid: string
  messageVout: number
  reaction: string
  sender: string
  createdAt: number
  uniqueId?: string
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export class ConvoStorage {
  private threads: Collection<Thread>
  private messages: Collection<EncryptedMessage>
  private reactions: Collection<ReactionRecord>
  private logs: Collection<ParticipantChangeLog>

  constructor(private db: Db) {
    this.threads = db.collection<Thread>("convoThreads")
    this.messages = db.collection<EncryptedMessage>("convoMessages")
    this.reactions = db.collection<ReactionRecord>("convoReactions")
    this.logs = db.collection<ParticipantChangeLog>("convoChangeLogs")

    // --- Indexes ---
    this.threads.createIndex({ threadId: 1 }, { unique: true })
    this.messages.createIndex({ threadId: 1 })
    this.messages.createIndex({ parentMessageId: 1 })
    this.reactions.createIndex({ threadId: 1 })
    this.logs.createIndex({ threadId: 1 })
    this.messages.createIndex({ threadId: 1, createdAt: -1 })
  }

  // ========== THREADS ==========

  async storeThread(thread: Thread): Promise<void> {
    await this.threads.insertOne(thread)
  }

  async updateThreadTimestamp(threadId: string, lastMessageAt: number): Promise<void> {
    await this.threads.updateOne(
      { threadId },
      { $set: { lastMessageAt } }
    )
  }

  async getThreadById(threadId: string): Promise<Thread | null> {
    return await this.threads.findOne({ threadId })
  }

  async findThreadsByParticipant(pubkey: string): Promise<Thread[]> {
    return await this.threads.find({ participants: pubkey }).toArray()
  }

  // ========== MESSAGES ==========

  async storeMessage(message: EncryptedMessage): Promise<void> {
    await this.messages.insertOne({
      ...message,
      parentMessageId: message.parentMessageId || undefined
    })
  }

  async getMessagesByThread(threadId: string): Promise<EncryptedMessage[]> {
    return await this.messages.find({ threadId }).sort({ createdAt: 1 }).toArray()
  }

  async getMessageByTxid(txid: string): Promise<EncryptedMessage | null> {
    return await this.messages.findOne({ txid })
  }

  async getRepliesByParent(parentMessageId: string): Promise<EncryptedMessage[]> {
    return await this.messages.find({ parentMessageId }).sort({ createdAt: 1 }).toArray()
  }

  // ========== REACTIONS ==========

  async storeReaction(reaction: ReactionRecord): Promise<void> {
    await this.reactions.insertOne(reaction)
  }

  async getReactionsByThread(threadId: string): Promise<ReactionRecord[]> {
    return await this.reactions.find({ threadId }).sort({ createdAt: 1 }).toArray()
  }

  async getReactionsByMessage(txid: string, vout: number): Promise<ReactionRecord[]> {
    return await this.reactions.find({ messageTxid: txid, messageVout: vout }).toArray()
  }

  // ========== PARTICIPANT CHANGE LOGS ==========

  async storeChangeLog(entry: ParticipantChangeLog): Promise<void> {
    await this.logs.insertOne(entry)
  }

  async getChangeLogsByThread(threadId: string): Promise<ParticipantChangeLog[]> {
    return await this.logs.find({ threadId }).sort({ timestamp: 1 }).toArray()
  }

  // ========== UTILITIES ==========

  async findAllMessages(): Promise<EncryptedMessage[]> {
    return await this.messages.find({}).toArray()
  }

  async deleteMessage(txid: string): Promise<void> {
    await this.messages.deleteOne({ txid })
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.threads.deleteOne({ threadId })
    await this.messages.deleteMany({ threadId })
    await this.logs.deleteMany({ threadId })
  }

  async getReactionsByMessages(txids: string[]): Promise<ReactionRecord[]> {
  if (txids.length === 0) return []
  return await this.reactions
    .find({ messageTxid: { $in: txids } })
    .sort({ createdAt: 1 })
    .toArray()
}

/**
 * Returns the latest message for each threadId.
 * Supports pagination with skip + limit.
 */
async listLatestMessages(skip = 0, limit = 50): Promise<EncryptedMessage[]> {
  return await this.messages
    .aggregate<EncryptedMessage>([
      // Sort messages newest first
      { $sort: { createdAt: -1 } },

      // Group so each threadId keeps only its newest message
      {
        $group: {
          _id: "$threadId",
          threadId: { $first: "$threadId" },
          txid: { $first: "$txid" },
          outputIndex: { $first: "$outputIndex" },
          sender: { $first: "$sender" },
          header: { $first: "$header" },
          encryptedPayload: { $first: "$encryptedPayload" },
          createdAt: { $first: "$createdAt" },
          threadName: { $first: "$threadName" },
          parentMessageId: { $first: "$parentMessageId" },
          uniqueId: { $first: "$uniqueId" }
        }
      },

      // sort after grouping
      { $sort: { createdAt: -1 } },

      // pagination
      { $skip: skip },
      { $limit: limit }
    ])
    .toArray()
}


/**
 * Paginated messages inside a single thread.
 * Sorted oldest → newest (so the UI can append at the bottom naturally).
 */
async listThreadMessages(
  threadId: string,
  skip = 0,
  limit = 50
): Promise<EncryptedMessage[]> {

  const results = await this.messages
    .aggregate<EncryptedMessage>([
      { $match: { threadId } },

      // Sort newest → oldest so skip+limit works
      { $sort: { createdAt: -1 } },

      { $skip: skip },
      { $limit: limit }
    ])
    .toArray()

  // Reverse for UI (oldest → newest)
  return results.reverse()
}



async countThreadMessages(threadId: string): Promise<number> {
  return await this.messages.countDocuments({ threadId })
}

async countReplies(parentMessageId: string): Promise<number> {
  return await this.messages.countDocuments({ parentMessageId })
}

async listReplies(parentMessageId: string, skip = 0, limit = 50): Promise<EncryptedMessage[]> {
  const results = await this.messages
    .find({ parentMessageId })
    .sort({ createdAt: -1 }) // newest → oldest
    .skip(skip)
    .limit(limit)
    .toArray()

  return results.reverse() // oldest → newest for UI
}

}