// backend/src/lookup-services/ConvoStorage.ts
export class ConvoStorage {
    db;
    threads;
    messages;
    logs;
    constructor(db) {
        this.db = db;
        this.threads = db.collection("convoThreads");
        this.messages = db.collection("convoMessages");
        this.logs = db.collection("convoChangeLogs");
        this.threads.createIndex({ threadId: 1 }, { unique: true });
        this.messages.createIndex({ threadId: 1 });
        this.logs.createIndex({ threadId: 1 });
    }
    // ========== THREADS ==========
    async storeThread(thread) {
        await this.threads.insertOne(thread);
    }
    async updateThreadTimestamp(threadId, lastMessageAt) {
        await this.threads.updateOne({ threadId }, { $set: { lastMessageAt } });
    }
    async getThreadById(threadId) {
        return await this.threads.findOne({ threadId });
    }
    async findThreadsByParticipant(pubkey) {
        return await this.threads.find({ participants: pubkey }).toArray();
    }
    // ========== MESSAGES ==========
    async storeMessage(message) {
        await this.messages.insertOne(message);
    }
    async getMessagesByThread(threadId) {
        return await this.messages.find({ threadId }).sort({ createdAt: 1 }).toArray();
    }
    async getMessageByTxid(txid) {
        return await this.messages.findOne({ txid });
    }
    // ========== PARTICIPANT CHANGE LOGS ==========
    async storeChangeLog(entry) {
        await this.logs.insertOne(entry);
    }
    async getChangeLogsByThread(threadId) {
        return await this.logs.find({ threadId }).sort({ timestamp: 1 }).toArray();
    }
    // ========== UTILITIES ==========
    async findAllMessages() {
        return await this.messages.find({}).toArray();
    }
    async deleteMessage(txid) {
        await this.messages.deleteOne({ txid });
    }
    async deleteThread(threadId) {
        await this.threads.deleteOne({ threadId });
        await this.messages.deleteMany({ threadId });
        await this.logs.deleteMany({ threadId });
    }
}
