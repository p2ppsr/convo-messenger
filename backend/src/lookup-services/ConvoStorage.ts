// backend/src/lookup-services/ConvoStorage.ts

import { Collection, Db } from "mongodb"
import { EncryptedMessage, Thread, ParticipantChangeLog } from "../types"

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export class ConvoStorage {
  private threads: Collection<Thread>
  private messages: Collection<EncryptedMessage>
  private logs: Collection<ParticipantChangeLog>

  constructor(private db: Db) {
    this.threads = db.collection<Thread>("convoThreads")
    this.messages = db.collection<EncryptedMessage>("convoMessages")
    this.logs = db.collection<ParticipantChangeLog>("convoChangeLogs")

    this.threads.createIndex({ threadId: 1 }, { unique: true })
    this.messages.createIndex({ threadId: 1 })
    this.logs.createIndex({ threadId: 1 })
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
    await this.messages.insertOne(message)
  }

  async getMessagesByThread(threadId: string): Promise<EncryptedMessage[]> {
    return await this.messages.find({ threadId }).sort({ createdAt: 1 }).toArray()
  }

  async getMessageByTxid(txid: string): Promise<EncryptedMessage | null> {
    return await this.messages.findOne({ txid })
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
}
