// src/utils/decodeOutputs.ts

import { Transaction, PushDrop, Utils, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { decryptMessage } from './MessageDecryptor'

/**
 * DecodedMessage
 * Represents the structure of a message that has been pulled
 * from the blockchain overlay but has NOT yet been decrypted.
 * - Contains sender, recipients, threadId, and raw header/payload.
 */
export interface DecodedMessage {
  type?: 'message' | 'reaction'
  threadId: string            // unique thread ID (set by sender)
  sender: string              // pubkey of message sender
  header?: number[]            // encrypted header (contains key wrapping)
  encryptedPayload?: number[]  // ciphertext of the actual message payload
  createdAt: number           // timestamp (provided by overlay context)
  txid: string                // blockchain txid
  vout: number                // output index inside the tx
  beef: number[]              // raw BEEF encoding of tx for reference
  recipients?: string[]        // all recipient keys extracted from PushDrop
  threadName?: string         // optional group thread name
  uniqueID?: string           // optional unique ID for deduplication
  messageTxid?: string
  messageVout?: number
  reaction?: string
}

/**
 * decodeOutput
 *
 * Takes:
 *   - beef: raw BEEF encoding of a transaction
 *   - outputIndex: which output contains the PushDrop
 *   - timestamp: overlay-provided message timestamp
 *
 * Steps:
 *   1. Reconstruct Transaction from BEEF
 *   2. Grab the correct output
 *   3. Decode PushDrop fields (structured slots in the locking script)
 *   4. Extract threadId, sender pubkey, header, ciphertext, recipients, etc.
 *
 * Returns:
 *   A DecodedMessage object that can be passed to decryptMessage().
 */
export async function decodeOutput(
  beef: number[],
  outputIndex: number,
  timestamp: number,
  wallet?: WalletInterface,
  protocolID?: WalletProtocol,
  keyID?: string
): Promise<DecodedMessage> {
  const decodedTx = Transaction.fromBEEF(beef)
  const output = decodedTx.outputs[outputIndex]
  const decoded = PushDrop.decode(output.lockingScript)
  const fields = decoded.fields

  console.log(`[decodeOutput] Decoding vout ${outputIndex} at timestamp ${timestamp}`)
  console.log('[decodeOutput] PushDrop fields length:', fields.length)

  // --- Detect record type from field[0] marker ---
  const marker = Utils.toUTF8(fields[0])
  console.log('[decodeOutput] Marker:', marker)

  // REACTION RECORD
  if (marker === 'tmconvo_reaction') {
    if (fields.length < 8) throw new Error('Invalid reaction PushDrop: missing fields')

    const threadId = Utils.toUTF8(fields[1])
    const messageTxid = Utils.toUTF8(fields[2])
    const messageVout = parseInt(Utils.toUTF8(fields[3]), 10)
    const reaction = Utils.toUTF8(fields[4])
    const sender = Utils.toUTF8(fields[5])
    const uniqueID = Utils.toUTF8(fields[7])

    console.log(`[decodeOutput] Parsed reaction: ${reaction} from ${sender} on ${messageTxid}:${messageVout}`)

    return {
      type: 'reaction',
      threadId,
      messageTxid,
      messageVout,
      reaction,
      sender,
      createdAt: timestamp,
      txid: decodedTx.id('hex'),
      vout: outputIndex,
      beef,
      uniqueID
    }
  }



  // Expecting at least 7 fields in our schema
  if (fields.length < 7) {
    throw new Error('Invalid PushDrop message: not enough fields')
  }

  // Field 3: threadId (UTF8 string)
  const threadId = Utils.toUTF8(fields[3])

  // Field 2: sender public key (hex)
  const sender = Utils.toHex(Array.from(fields[2] as unknown as Uint8Array))

  // Field 6: recipients array (each an identity key)
  const recipients = Array.isArray(fields[6])
    ? fields[6]
        .map((r: unknown) => {
          try {
            return Utils.toHex(Array.from(r as unknown as Uint8Array))
          } catch (err) {
            console.warn('[decodeOutput] Failed to decode recipient field:', r, err)
            return ''
          }
        })
        .filter((r) => r.length > 0)
    : []

    // Field 7: per-message unique ID
    let uniqueID: string | undefined
    try {
      uniqueID = Utils.toUTF8(fields[7])
      console.log('[decodeOutput] Unique ID:', uniqueID)
    } catch (err) {
      console.warn('[decodeOutput] Failed to decode uniqueID field:', err)
    }

  // Field 8 (optional): thread name (UTF8 string)
  let threadName: string | undefined
  if (fields.length > 10) {
    const nameHeader = fields[8] as unknown as Uint8Array
    const nameCiphertext = fields[9] as unknown as Uint8Array
    console.log('[decodeOutput] Found encrypted thread name:')

    if (wallet && protocolID && keyID) {
      const decryptedName = await decryptMessage(
        wallet,
        Array.from(nameHeader),
        Array.from(nameCiphertext),
        protocolID,
        keyID
      )

      // decryptedName is a MessagePayload object
      if (decryptedName?.content) {
        threadName = decryptedName.content.trim()
        console.log('[decodeOutput] Found thread name:', threadName)
      }
    } else {
      console.log('[decodeOutput] Encrypted thread name detected but no wallet/protocol provided')
    }
  } else if (fields.length === 10) {
    // Legacy plaintext thread name for older messages
    try {
      threadName = Utils.toUTF8(fields[8])
      console.log('[decodeOutput] Legacy plaintext thread name:', threadName)
    } catch (err) {
      console.warn('[decodeOutput] Failed to decode legacy plaintext thread name:', err)
    }
  }
 

  console.log('[decodeOutput] Thread ID:', threadId)
  console.log('[decodeOutput] Sender:', sender)
  console.log('[decodeOutput] Recipients:', recipients)

  return {
    type: 'message',
    threadId,
    sender,
    header: fields[4],             // encrypted symmetric key header
    encryptedPayload: fields[5],   // actual ciphertext payload
    createdAt: timestamp,
    txid: decodedTx.id('hex'),
    vout: outputIndex,
    beef,
    recipients,
    threadName,
    uniqueID
  }
}

/**
 * decodeOutputs
 *
 * Convenience wrapper for decoding multiple outputs at once.
 * - Runs decodeOutput() on each.
 * - Skips and logs any failures instead of crashing the whole batch.
 */
export async function decodeOutputs(
  outputs: Array<{ beef: number[]; outputIndex: number; timestamp: number }>,
  wallet?: WalletInterface,
  protocolID?: WalletProtocol,
  keyID?: string
): Promise<DecodedMessage[]> {
  return Promise.all(
    outputs.map(({ beef, outputIndex, timestamp }) =>
      decodeOutput(beef, outputIndex, timestamp, wallet, protocolID, keyID).catch((err) => {
        console.warn(`[decodeOutputs] Skipping invalid output at vout ${outputIndex}:`, err)
        return null
      })
    )
  ).then((results) => results.filter((m): m is DecodedMessage => m !== null))
}

