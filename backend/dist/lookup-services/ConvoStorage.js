// backend/src/lookup-services/ConvoStorage.ts
export class ConvoStorage {
    db;
    threads;
    messages;
    reactions;
    logs;
    constructor(db) {
        this.db = db;
        this.threads = db.collection("convoThreads");
        this.messages = db.collection("convoMessages");
        this.reactions = db.collection("convoReactions");
        this.logs = db.collection("convoChangeLogs");
        // --- Indexes ---
        this.threads.createIndex({ threadId: 1 }, { unique: true });
        this.messages.createIndex({ threadId: 1 });
        this.messages.createIndex({ parentMessageId: 1 });
        this.reactions.createIndex({ threadId: 1 });
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
        await this.messages.insertOne({
            ...message,
            parentMessageId: message.parentMessageId || undefined
        });
    }
    async getMessagesByThread(threadId) {
        return await this.messages.find({ threadId }).sort({ createdAt: 1 }).toArray();
    }
    async getMessageByTxid(txid) {
        return await this.messages.findOne({ txid });
    }
    async getRepliesByParent(parentMessageId) {
        return await this.messages.find({ parentMessageId }).sort({ createdAt: 1 }).toArray();
    }
    // ========== REACTIONS ==========
    async storeReaction(reaction) {
        await this.reactions.insertOne(reaction);
    }
    async getReactionsByThread(threadId) {
        return await this.reactions.find({ threadId }).sort({ createdAt: 1 }).toArray();
    }
    async getReactionsByMessage(txid, vout) {
        return await this.reactions.find({ messageTxid: txid, messageVout: vout }).toArray();
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
    async getReactionsByMessages(txids) {
        if (txids.length === 0)
            return [];
        return await this.reactions
            .find({ messageTxid: { $in: txids } })
            .sort({ createdAt: 1 })
            .toArray();
    }
}
