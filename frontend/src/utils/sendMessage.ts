// frontend/src/utils/sendMessage.ts

import {
  PushDrop,
  WalletClient,
  Utils,
  Transaction,
  TopicBroadcaster,
  Hash,
  WalletProtocol
} from '@bsv/sdk'

import { encryptMessage } from './MessageEncryptor'
import type { MessagePayload } from '../types/types'

export interface SendMessageOptions {
  client: WalletClient
  senderPublicKey: string
  threadId: string
  content: string
  recipients: string[]
  protocolID?: WalletProtocol
  keyID?: string
  topic?: string
  basket?: string
}

export async function sendMessage({
  client,
  senderPublicKey,
  threadId,
  content,
  recipients,
  protocolID = [2, 'tmconvo'],
  keyID = '1',
  topic = 'convo',
  basket = 'convo'
}: SendMessageOptions): Promise<string> {
  const pushdrop = new PushDrop(client)
  const broadcaster = new TopicBroadcaster([`tm_${topic}`], {
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  console.log(`\n[Convo] ----------------------------------------`)
  console.log(`[Convo] Preparing message for thread "${threadId}"`)
  console.log(`[Convo] Sender public key: ${senderPublicKey}`)
  console.log(`[Convo] Raw content: ${content}`)
  console.log(`[Convo] ProtocolID: ${JSON.stringify(protocolID)}, keyID: ${keyID}`)
  console.log(`[Convo] Topic: ${topic}, Basket: ${basket}`)

  const uniqueRecipients = Array.from(new Set([...recipients, senderPublicKey]))
  console.log(`[Convo] Recipients (${uniqueRecipients.length}):`, uniqueRecipients)

  const payload: MessagePayload = {
    type: 'message',
    content,
    mediaURL: undefined
  }

  let header: number[], encryptedPayload: number[]
  try {
    console.log('[Convo] Calling encryptMessage...')
    ;({ header, encryptedPayload } = await encryptMessage(
      client,
      payload,
      uniqueRecipients,
      protocolID,
      keyID
    ))

    console.log('[Convo] Encryption succeeded.')
    console.log('[Convo] Header preview (first 8 bytes):', header.slice(0, 8))
    console.log('[Convo] Encrypted payload length:', encryptedPayload.length)
    console.log('[Convo] Encrypted header length:', header.length)
    console.log('[Convo] Encrypted header (hex preview):', Utils.toHex(header.slice(0, 16)), '...')
    console.log('[Convo] Encrypted payload (hex preview):', Utils.toHex(encryptedPayload.slice(0, 16)), '...')
  } catch (err) {
    console.error('[Convo] Encryption failed:', err)
    throw new Error('Failed to encrypt message.')
  }

  const timestamp = Date.now()
  const uniqueID = Utils.toHex(Hash.sha256(Utils.toArray(Math.random().toString(), 'utf8')))

  console.log(`[Convo] Timestamp: ${timestamp}`)
  console.log(`[Convo] Unique ID: ${uniqueID}`)

  const fields = [
    Utils.toArray(topic, 'utf8'),                       // 0
    Utils.toArray('tmconvo', 'utf8'),                   // 1
    Utils.toArray(senderPublicKey, 'utf8'),             // 2
    Utils.toArray(threadId, 'utf8'),                    // 3
    header,                                             // 4
    encryptedPayload,                                   // 5
    Utils.toArray(String(timestamp), 'utf8'),           // 6
    Utils.toArray(uniqueID, 'utf8')                     // 7
  ]

  console.log(`[Convo] PushDrop Field Breakdown:`)
  fields.forEach((field, index) => {
    let preview = Array.isArray(field)
      ? field.slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join(' ')
      : 'non-array field'
    let stringValue = ''

    try {
      if (index <= 3 || index >= 6) {
        stringValue = Utils.toUTF8(field as number[])
      } else if (index === 4) {
        stringValue = '[header bytes]'
      } else if (index === 5) {
        stringValue = '[encrypted payload]'
      }
    } catch (e) {
      stringValue = '[decode error]'
    }

    console.log(`  [${index}] ${stringValue} (${field.length} bytes): ${preview}`)
  })

  const lockingScript = await pushdrop.lock(fields, [2, basket], keyID, 'anyone', true)
  console.log('[Convo] Locking script constructed.')

  const { tx } = await client.createAction({
    outputs: [
      {
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: 'Encrypted Convo Message',
        basket
      }
    ],
    description: 'Send encrypted Convo message',
    options: {
      acceptDelayedBroadcast: false,
      randomizeOutputs: false
    }
  })

  if (!tx) {
    throw new Error('[Convo] Failed to create transaction.')
  }

  const transaction = Transaction.fromAtomicBEEF(tx)
  const txid = transaction.id('hex')
  console.log(`[Convo] Created transaction. txid: ${txid}`)

  try {
    await broadcaster.broadcast(transaction)
    console.log(`[Convo] Broadcast to overlay succeeded. txid: ${txid}`)
  } catch (error) {
    console.error(`[Convo] Broadcast failed:`, error)
    throw error
  }

  return txid
}
