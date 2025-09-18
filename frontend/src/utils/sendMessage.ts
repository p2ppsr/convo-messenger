// Import needed SDK utilities and helpers
import {
  PushDrop,            // For building locking scripts with structured fields
  WalletClient,        // Client interface for wallet actions
  Utils,               // Encoding/decoding helpers
  Transaction,         // For working with transactions
  TopicBroadcaster,    // Publishes transactions to an overlay topic
  Hash,
  WalletProtocol
} from '@bsv/sdk'

import { encryptMessage } from './MessageEncryptor'  // Our CurvePoint encryption wrapper
import type { MessagePayload } from '../types/types'

// Define expected options when sending a message
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
  threadName?: string
}

/**
 * sendMessage
 *
 * Purpose:
 *   - Encrypt a chat message payload with CurvePoint for a set of recipients.
 *   - Wrap encrypted data + metadata into a PushDrop locking script.
 *   - Broadcast transaction to overlay via TopicBroadcaster.
 *
 * Key idea:
 *   -> The "header" from encryptMessage is where all recipient keys live.
 *   -> If the recipient is missing here, they will never be able to decrypt.
 */
export async function sendMessage({
  client,
  senderPublicKey,
  threadId,
  content,
  recipients,
  protocolID = [2, 'tmconvo'],   // Default protocol if not passed
  keyID = '1',                   // Default key slot
  topic = 'convo',               // Overlay topic tag
  basket = 'convo',              // Basket for wallet bookkeeping
  threadName
}: SendMessageOptions): Promise<string> {
  // Setup helpers
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

  // Deduplicate and always include the sender themselves in the recipient list.
  // This ensures the sender can also decrypt their own messages.
  const uniqueRecipients = Array.from(new Set([...recipients, senderPublicKey]))
  console.log(`[Convo] Recipients (${uniqueRecipients.length}):`, uniqueRecipients)

  // Create the actual message payload object
  const payload: MessagePayload = {
    type: 'message',
    content,
    mediaURL: undefined
  }

  // Encrypt the payload with CurvePoint
  let header: number[], encryptedPayload: number[]
  try {
    console.log('[Convo] Calling encryptMessage...')
    ;({ header, encryptedPayload } = await encryptMessage(
      client,
      payload,
      uniqueRecipients,   // <--- THIS is critical: every intended recipient must be here
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

  // Timestamp and random unique ID for this message
  const timestamp = Date.now()
  const uniqueID = Utils.toHex(Hash.sha256(Utils.toArray(Math.random().toString(), 'utf8')))

  console.log(`[Convo] Timestamp: ${timestamp}`)
  console.log(`[Convo] Unique ID: ${uniqueID}`)

  // Build the PushDrop fields in a fixed order
  const fields = [
    Utils.toArray(topic, 'utf8'),                       // 0: overlay topic
    Utils.toArray('tmconvo', 'utf8'),                   // 1: static marker for convo messages
    Utils.toArray(senderPublicKey, 'utf8'),             // 2: sender identity key
    Utils.toArray(threadId, 'utf8'),                    // 3: thread ID
    header,                                             // 4: CurvePoint header (contains recipient key slots)
    encryptedPayload,                                   // 5: ciphertext
    Utils.toArray(String(timestamp), 'utf8'),           // 6: message timestamp
    Utils.toArray(uniqueID, 'utf8')                     // 7: per-message unique ID
  ]

  // Optional thread name for group threads
  if (threadName) {
    fields.push(Utils.toArray(threadName, 'utf8'))      // 8: thread name
    console.log(`[Convo] Included threadName: "${threadName}"`)
  }

  // Debug log: show breakdown of fields for sanity checking
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

  // Build the locking script for the PushDrop message
  const lockingScript = await pushdrop.lock(fields, [2, basket], keyID, 'anyone', true)
  console.log('[Convo] Locking script constructed.')

  // Create the transaction
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

  // Parse transaction and extract ID
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
