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
            console.log(`[ConvoLookupService] Decoded ${fields.length} fields from lockingScript`);
            if (fields.length < 7) {
                console.warn('[ConvoLookupService] Not enough fields to store a message');
                return;
            }
            const [topicBuf, protocolBuf, senderBuf, threadIdBuf, headerBuf, payloadBuf, timestampBuf, uniqueIdBuf, threadNameBuf // optional
            ] = fields;
            const topicVal = Utils.toUTF8(topicBuf);
            const protocolVal = Utils.toUTF8(protocolBuf);
            if (topicVal !== 'convo' || protocolVal !== 'tmconvo') {
                console.warn(`[ConvoLookupService] Invalid topic/protocol values in script: ${topicVal}, ${protocolVal}`);
                return;
            }
            const sender = Utils.toHex(senderBuf);
            const threadId = Utils.toUTF8(threadIdBuf);
            const header = Array.from(headerBuf);
            const encryptedPayload = Array.from(payloadBuf);
            const createdAt = timestampBuf ? parseInt(Utils.toUTF8(timestampBuf)) : Date.now();
            const uniqueId = uniqueIdBuf ? Utils.toUTF8(uniqueIdBuf) : undefined;
            const threadName = threadNameBuf ? Utils.toUTF8(threadNameBuf) : undefined;
            const record = {
                txid,
                threadId,
                outputIndex,
                sender,
                encryptedPayload,
                header,
                createdAt,
                ...(uniqueId ? { uniqueId } : {}),
                ...(threadName ? { threadName } : {})
            };
            console.log('[ConvoLookupService] Storing message record:', record);
            await this.storage.storeMessage(record);
        }
        catch (err) {
            console.error('[ConvoLookupService] Failed to decode/store message:', err);
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
        if (question.service !== 'ls_convo') {
            console.warn(`[ConvoLookupService] Unknown service: "${question.service}"`);
            throw new Error('Unsupported lookup service.');
        }
        const query = question.query;
        console.log(`[ConvoLookupService] Performing lookup with query type: "${query.type}"`, query);
        if (query.type === 'findByThreadId') {
            const messages = await this.storage.getMessagesByThread(query.value.threadId);
            console.log(`[ConvoLookupService] Found ${messages.length} message(s) for threadId: ${query.value.threadId}`);
            return this.formatAsLookupAnswers(messages);
        }
        if (query.type === 'getMessage') {
            const message = await this.storage.getMessageByTxid(query.value.txid);
            console.log(`[ConvoLookupService] Found message for txid: ${query.value.txid}`, message);
            return message ? this.formatAsLookupAnswers([message]) : [];
        }
        if (query.type === 'findAll') {
            const messages = await this.storage.findAllMessages();
            console.log(`[ConvoLookupService] Returning all ${messages.length} stored messages`);
            return this.formatAsLookupAnswers(messages);
        }
        console.warn('[ConvoLookupService] Unsupported query type:', query);
        throw new Error('Unknown or unsupported query type.');
    }
    formatAsLookupAnswers(messages) {
        console.log(`[ConvoLookupService] Formatting ${messages.length} message(s) into LookupFormula`);
        return messages.map(msg => ({
            txid: msg.txid,
            outputIndex: msg.outputIndex,
            context: [
                ...[], // placeholder for future metadata
                ...Utils.toArray(msg.createdAt.toString(), 'utf8')
            ]
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
