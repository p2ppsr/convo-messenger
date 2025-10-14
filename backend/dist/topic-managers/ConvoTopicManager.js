// backend/src/lookup-services/ConvoTopicManager.ts
import { Transaction, PushDrop, Utils } from '@bsv/sdk';
import docs from './ConvoTopicDocs.md.js';
export default class ConvoTopicManager {
    async identifyAdmissibleOutputs(beef, previousCoins) {
        const admissibleOutputs = [];
        try {
            const tx = Transaction.fromBEEF(beef);
            console.log('[ConvoTopicManager] Evaluating transaction:', tx.id);
            for (const [index, output] of tx.outputs.entries()) {
                try {
                    const decoded = PushDrop.decode(output.lockingScript);
                    const fields = decoded.fields;
                    if (fields.length < 2)
                        continue;
                    const marker = Utils.toUTF8(fields[0]);
                    const protocol = Utils.toUTF8(fields[1] ?? []);
                    // Accept either normal messages or reactions
                    const isMessage = marker === 'convo' && protocol === 'tmconvo';
                    const isReaction = marker === 'tmconvo_reaction';
                    if (!isMessage && !isReaction) {
                        console.log(`[ConvoTopicManager] Output #${index} – Not a convo message or reaction: ${marker}, ${protocol}`);
                        continue;
                    }
                    console.log(`[ConvoTopicManager] Output #${index} – Valid Convo ${isReaction ? 'reaction' : 'message'}`);
                    admissibleOutputs.push(index);
                }
                catch (err) {
                    console.log(`[ConvoTopicManager] Skipping output #${index}:`, err);
                }
            }
            if (admissibleOutputs.length === 0) {
                console.warn('[ConvoTopicManager] No valid Convo outputs found in transaction');
            }
            return {
                outputsToAdmit: admissibleOutputs,
                coinsToRetain: previousCoins
            };
        }
        catch (err) {
            console.error('[ConvoTopicManager] Failed to parse transaction:', err);
            return {
                outputsToAdmit: [],
                coinsToRetain: []
            };
        }
    }
    async getDocumentation() {
        return docs;
    }
    async getMetaData() {
        return {
            name: 'tm_convo',
            shortDescription: 'Convo Messenger Topic Manager',
            version: '1.1.0'
        };
    }
}
