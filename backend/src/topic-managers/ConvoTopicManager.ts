// backend/src/lookup-services/ConvoTopicManager.ts

import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop, Utils } from '@bsv/sdk'
import docs from './ConvoTopicDocs.md.js'

export default class ConvoTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const admissibleOutputs: number[] = []

    try {
      const tx = Transaction.fromBEEF(beef)
      console.log('[ConvoTopicManager] Evaluating transaction:', tx.id)

      for (const [index, output] of tx.outputs.entries()) {
        try {
          const decoded = PushDrop.decode(output.lockingScript)
          const fields = decoded.fields

          if (fields.length < 8) {
            console.log(`[ConvoTopicManager] Output #${index} – Too few fields: ${fields.length}`)
            continue
          }

          const topic = Utils.toUTF8(fields[0])
          const protocol = Utils.toUTF8(fields[1])

          if (protocol !== 'tmconvo' || topic !== 'convo') {
            console.log(`[ConvoTopicManager] Output #${index} – Invalid topic or protocol: ${topic}, ${protocol}`)
            continue
          }

          // Passed all checks
          console.log(`[ConvoTopicManager] Output #${index} – Valid Convo message`)
          admissibleOutputs.push(index)

        } catch (err) {
          console.log(`[ConvoTopicManager] Skipping output #${index}:`, err)
        }
      }

      if (admissibleOutputs.length === 0) {
        console.warn('[ConvoTopicManager] No valid Convo outputs found in transaction')
      }

      return {
        outputsToAdmit: admissibleOutputs,
        coinsToRetain: previousCoins
      }

    } catch (err) {
      console.error('[ConvoTopicManager] Failed to parse transaction:', err)
      return {
        outputsToAdmit: [],
        coinsToRetain: []
      }
    }
  }

  async getDocumentation() {
    return docs
  }

  async getMetaData() {
    return {
      name: 'tm_convo',
      shortDescription: 'Convo Messenger Topic Manager',
      version: '1.1.0'
    }
  }
}
