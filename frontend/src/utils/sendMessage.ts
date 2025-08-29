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
  senderPublicKey: string            // identity public key (hex)
  threadId: string
  content: string                    // simplified from MessagePayload
  recipients: string[]              // recipient identity pubkeys
  protocolID?: WalletProtocol       // e.g. [2, 'tmsg']
  keyID?: string                    // e.g. '1'
  topic?: string                    // default: 'convo_messages'
  basket?: string                   // default: 'tmsg'
}

/**
 * Encrypts, signs, and sends a message to the overlay.
 */
export async function sendMessage({
  client,
  senderPublicKey,
  threadId,
  content,
  recipients,
  protocolID = [2, 'tmsg'],
  keyID = '1',
  topic = 'convo_messages',
  basket = 'tmsg'
}: SendMessageOptions): Promise<string> {
  const pushdrop = new PushDrop(client)
  const broadcaster = new TopicBroadcaster([`tm_${topic}`], {
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  console.log(`[Convo] Preparing message for thread "${threadId}" from sender "${senderPublicKey}"`)

  const payload: MessagePayload = {
    type: 'message',
    content,
    mediaURL: undefined
  }

  // Encrypt message
  let header: number[], encryptedPayload: number[]
  try {
    ({ header, encryptedPayload } = await encryptMessage(
      client,
      payload,
      recipients,
      protocolID,
      keyID
    ))
    console.log('[Convo] Encryption succeeded.')
  } catch (err) {
    console.error('[Convo] Encryption failed:', err)
    throw new Error('Failed to encrypt message.')
  }

  const timestamp = Date.now()
  const uniqueID = Utils.toHex(Hash.sha256(Utils.toArray(Math.random().toString(), 'utf8')))

  console.log(`[Convo] Timestamp: ${timestamp}, Unique ID: ${uniqueID}`)

  // Build locking script
  const lockingScript = await pushdrop.lock(
    [
      Utils.toArray(topic, 'utf8'),
      Utils.toArray(String(protocolID[0]), 'utf8'),
      Utils.toArray(senderPublicKey, 'utf8'),
      Utils.toArray(threadId, 'utf8'),
      header,
      encryptedPayload,
      Utils.toArray(String(timestamp), 'utf8'),
      Utils.toArray(uniqueID, 'utf8')
    ],
    [2, basket],
    keyID,
    'anyone',
    true
  )

  // Create action
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

  // Broadcast to overlay
  try {
    await broadcaster.broadcast(transaction)
    console.log(`[Convo] Broadcast to overlay succeeded. txid: ${txid}`)
  } catch (error) {
    console.error(`[Convo] Broadcast failed:`, error)
    throw error
  }

  return txid
}
