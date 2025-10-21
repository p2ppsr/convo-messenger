import { PushDrop, Utils } from '@bsv/sdk';
import { ConvoStorage } from './ConvoStorage.js';
import docs from './ConvoLookupDocs.md.js';
export class ConvoLookupService {
    storage;
    admissionMode = 'locking-script';
    spendNotificationMode = 'none';
    constructor(storage) {
        this.storage = storage;
    }
    async outputAdmittedByTopic(payload) {
        if (payload.mode !== 'locking-script')
            throw new Error('Invalid mode');
        const { topic, lockingScript, txid, outputIndex } = payload;
        console.log(`[ConvoLookupService] outputAdmittedByTopic called for topic: "${topic}", txid: ${txid}, outputIndex: ${outputIndex}`);
        if (topic !== 'tm_convo') {
            console.warn(`[ConvoLookupService] Ignoring unknown topic: "${topic}"`);
            return;
        }
        try {
            const decoded = PushDrop.decode(lockingScript);
            const fields = decoded.fields;
            if (fields.length < 2)
                return;
            const marker = Utils.toUTF8(fields[0]);
            const protocol = Utils.toUTF8(fields[1] ?? []);
            // 🔹 Normal encrypted message
            if (marker === 'convo' && protocol === 'tmconvo') {
                const sender = Utils.toHex(fields[2]);
                const threadId = Utils.toUTF8(fields[3]);
                const header = Array.from(fields[4]);
                const encryptedPayload = Array.from(fields[5]);
                const createdAt = fields[6] ? parseInt(Utils.toUTF8(fields[6])) : Date.now();
                const uniqueId = fields[7] ? Utils.toUTF8(fields[7]) : undefined;
                // Optional parentMessageId (used for replies)
                let parentMessageId;
                if (fields.length > 8) {
                    try {
                        const possibleParent = Utils.toUTF8(fields[8]);
                        if (/^[0-9a-f]{64}$/i.test(possibleParent)) {
                            parentMessageId = possibleParent;
                            console.log(`[ConvoLookupService] Parsed parentMessageId: ${parentMessageId}`);
                        }
                    }
                    catch { }
                }
                // Optional plaintext thread name for group threads
                let threadName;
                try {
                    const idx = parentMessageId ? 9 : 8;
                    if (fields.length > idx)
                        threadName = Utils.toUTF8(fields[idx]);
                }
                catch { }
                const record = {
                    txid,
                    threadId,
                    outputIndex,
                    sender,
                    encryptedPayload,
                    header,
                    createdAt,
                    ...(uniqueId ? { uniqueId } : {}),
                    ...(threadName ? { threadName } : {}),
                    ...(parentMessageId ? { parentMessageId } : {})
                };
                console.log('[ConvoLookupService] Storing message record:', record);
                await this.storage.storeMessage(record);
            }
            // Reaction record
            else if (marker === 'tmconvo_reaction') {
                const threadId = Utils.toUTF8(fields[1]);
                const messageTxid = Utils.toUTF8(fields[2]);
                const messageVout = parseInt(Utils.toUTF8(fields[3]), 10);
                const reaction = Utils.toUTF8(fields[4]);
                const sender = Utils.toUTF8(fields[5]);
                const createdAt = Date.now();
                const uniqueId = fields[7] ? Utils.toUTF8(fields[7]) : undefined;
                const record = {
                    txid,
                    threadId,
                    outputIndex,
                    messageTxid,
                    messageVout,
                    reaction,
                    sender,
                    createdAt,
                    ...(uniqueId ? { uniqueId } : {})
                };
                console.log('[ConvoLookupService] Storing reaction record:', record);
                await this.storage.storeReaction(record);
            }
            else {
                console.warn(`[ConvoLookupService] Ignoring non-convo output: marker=${marker}, protocol=${protocol}`);
            }
        }
        catch (err) {
            console.error('[ConvoLookupService] Failed to decode/store output:', err);
        }
    }
    async outputSpent(payload) {
        if (payload.mode !== 'none')
            throw new Error('Invalid mode');
        const { topic, txid } = payload;
        if (topic !== 'tm_convo') {
            console.warn(`[ConvoLookupService] Ignoring spent from unknown topic: "${topic}"`);
            return;
        }
        console.log(`[ConvoLookupService] Deleting message: ${txid}`);
        await this.storage.deleteMessage(txid);
    }
    async outputEvicted(txid, outputIndex) {
        console.log(`[ConvoLookupService] Evicting message: ${txid}, outputIndex: ${outputIndex}`);
        await this.storage.deleteMessage(txid);
    }
    async lookup(question) {
        if (!question.query)
            throw new Error('Query required.');
        if (question.service !== 'ls_convo')
            throw new Error('Unsupported lookup service.');
        const query = question.query;
        console.log(`[ConvoLookupService] Performing lookup with query type: "${query.type}"`, query);
        if (query.type === 'findByThreadId') {
            const [messages, reactions] = await Promise.all([
                this.storage.getMessagesByThread(query.value.threadId),
                this.storage.getReactionsByThread(query.value.threadId)
            ]);
            const all = [...messages, ...reactions];
            return this.formatAsLookupAnswers(all);
        }
        if (query.type === 'getMessage') {
            const message = await this.storage.getMessageByTxid(query.value.txid);
            return message ? this.formatAsLookupAnswers([message]) : [];
        }
        if (query.type === 'findAll') {
            const messages = await this.storage.findAllMessages();
            return this.formatAsLookupAnswers(messages);
        }
        // Lookup replies for a given parent message
        if (query.type === 'findRepliesByParent') {
            const parentId = query.value.parentMessageId;
            // Fetch reply messages
            const replies = await this.storage.getRepliesByParent(parentId);
            console.log(`[ConvoLookupService] Found ${replies.length} replies for parent: ${parentId}`);
            // Get all reply txids
            const replyTxids = replies.map(r => r.txid);
            // Fetch reactions that target any of those replies
            let reactions = [];
            if (replyTxids.length > 0) {
                reactions = await this.storage.getReactionsByMessages(replyTxids);
                console.log(`[ConvoLookupService] Found ${reactions.length} reactions for replies under parent: ${parentId}`);
            }
            // Combine and return
            const all = [...replies, ...reactions];
            return this.formatAsLookupAnswers(all);
        }
        throw new Error(`Unsupported query type: "${query.type}"`);
    }
    formatAsLookupAnswers(messages) {
        return messages.map(msg => ({
            txid: msg.txid,
            outputIndex: msg.outputIndex,
            context: Utils.toArray(msg.createdAt.toString(), 'utf8')
        }));
    }
    async getDocumentation() {
        return docs;
    }
    async getMetaData() {
        return {
            name: 'ls_convo',
            shortDescription: 'Convo Messenger Overlay Lookup Service'
        };
    }
}
export default (db) => {
    return new ConvoLookupService(new ConvoStorage(db));
};
