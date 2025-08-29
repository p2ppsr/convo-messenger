// backend/src/lookup-services/ConvoLookupServiceFactory.ts

import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'

import { PushDrop, Utils } from '@bsv/sdk'
import { ConvoStorage } from './ConvoStorage.js'
import { Db } from 'mongodb'
import { EncryptedMessage } from '../types.js'
import docs from './ConvoLookupDocs.md.js'

export class ConvoLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: ConvoStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, lockingScript, txid, outputIndex } = payload

    if (topic !== 'tm_convo') {
      console.warn(`[ConvoLookupService] Ignoring unknown topic: "${topic}"`)
      return
    }

    try {
      const decoded = PushDrop.decode(lockingScript)
      const [senderBuf, threadIdBuf, headerBuf, payloadBuf] = decoded.fields

      const sender = Utils.toHex(senderBuf)
      const threadId = Utils.toUTF8(threadIdBuf)
      const header = Array.from(headerBuf)
      const encryptedPayload = Array.from(payloadBuf)
      const createdAt = Date.now()

      const record: EncryptedMessage = {
        txid,
        threadId,
        outputIndex,
        sender,
        encryptedPayload,
        header,
        createdAt
      }

      console.log('[ConvoLookupService] Storing message:', {
        threadId,
        sender,
        txid
      })

      await this.storage.storeMessage(record)
    } catch (err) {
      console.error('[ConvoLookupService] Failed to decode/store message:', err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid } = payload

    if (topic !== 'tm_convo') {
      console.warn(`[ConvoLookupService] Ignoring spent from unknown topic: "${topic}"`)
      return
    }

    console.log(`[ConvoLookupService] Deleting message: ${txid}`)
    await this.storage.deleteMessage(txid)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    console.log(`[ConvoLookupService] Evicting message: ${txid}`)
    await this.storage.deleteMessage(txid)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (!question.query) throw new Error('Query required.')

    if (question.service !== 'ls_convo') {
      console.warn(`[ConvoLookupService] Unknown service: "${question.service}"`)
      throw new Error('Unsupported lookup service.')
    }

    const query = question.query as any

    if (typeof query === 'object' && query.type === 'findByThreadId') {
      const messages = await this.storage.getMessagesByThread(query.value.threadId)
      return this.formatAsLookupAnswers(messages)
    }

    if (typeof query === 'object' && query.type === 'getMessage') {
      const message = await this.storage.getMessageByTxid(query.value.txid)
      return message ? this.formatAsLookupAnswers([message]) : []
    }

    if (typeof query === 'object' && query.type === 'findAll') {
      const messages = await this.storage.findAllMessages()
      return this.formatAsLookupAnswers(messages)
    }

    throw new Error('Unknown or unsupported query type.')
  }

  private formatAsLookupAnswers(messages: EncryptedMessage[]): LookupFormula {
  return messages.map(msg => ({
    txid: msg.txid,
    outputIndex: msg.outputIndex,
    context: [
      ...[], // add other context values here if needed
      ...Utils.toArray(msg.createdAt.toString(), 'utf8') // Send timestamp as UTF-8
    ]
  }))
}

  async getDocumentation(): Promise<string> {
    return docs
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'ls_convo',
      shortDescription: 'Convo Messenger Overlay Lookup Service'
    }
  }
}

export default (db: Db): ConvoLookupService => {
  return new ConvoLookupService(new ConvoStorage(db))
}
