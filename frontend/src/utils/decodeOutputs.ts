// src/utils/decodeOutputs.ts

import { Transaction, PushDrop, Utils } from '@bsv/sdk'

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
  parentMessageId?: string    // optional: txid of message being replied to
  encryptedThreadNameHeader?: number[]
  encryptedThreadNameCiphertext?: number[]
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
): Promise<DecodedMessage> {
  const decodedTx = Transaction.fromBEEF(beef)
  const output = decodedTx.outputs[outputIndex]
  const decoded = PushDrop.decode(output.lockingScript)
  const fields = decoded.fields

  // console.log(`[decodeOutput] ▼ Decoding TX ${decodedTx.id('hex')} @vout ${outputIndex}`)
  // console.log(`[decodeOutput] Decoding vout ${outputIndex} at timestamp ${timestamp}`)
  // console.log('[decodeOutput] PushDrop fields length:', fields.length)

//     fields.forEach((f, i) => {
//   const hex = Utils.toHex(f)
//   let utf8: string
//   try {
//     utf8 = Utils.toUTF8(f)
//   } catch {
//     utf8 = '(non-UTF8 binary)'
//   }
//   console.log(`Field[${i}] → HEX: ${hex}`)
//   console.log(`Field[${i}] → UTF8: ${utf8}`)
// })


  // --- Detect record type from field[0] marker ---
  const marker = Utils.toUTF8(fields[0])
  // console.log('[decodeOutput] Marker:', marker)

  // REACTION RECORD
  if (marker === 'tmconvo_reaction') {
    if (fields.length < 8) throw new Error('Invalid reaction PushDrop: missing fields')

    const threadId = Utils.toUTF8(fields[1])
    const messageTxid = Utils.toUTF8(fields[2])
    const messageVout = parseInt(Utils.toUTF8(fields[3]), 10)
    const reaction = Utils.toUTF8(fields[4])
    const sender = Utils.toUTF8(fields[5])
    const uniqueID = Utils.toUTF8(fields[7])

    // console.log(`[decodeOutput] Parsed reaction: ${reaction} from ${sender} on ${messageTxid}:${messageVout}`)

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
      uniqueID,
      parentMessageId: undefined
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

  // console.log('Thread ID:', threadId)
  // console.log('Sender pubkey:', sender)

  let recipients: string[] = []

  try {
    const headerField = fields[4]

    // Convert PushDrop field into a byte array
    const headerBytes: number[] = Array.isArray(headerField)
      ? headerField as number[]
      : Array.from(headerField as unknown as Uint8Array)

    const reader = new Utils.Reader(headerBytes)

    // FIX: read the header length first (varint)
    const headerLength = reader.readVarIntNum()

    // Extract just the header section (don't read payload!)
    const headerOnly = reader.read(headerLength)

    // Now parse *inside* the header
    const headerReader = new Utils.Reader(headerOnly)

    const version = headerReader.readUInt32LE()
    const recipientCount = headerReader.readVarIntNum()

    const acc: string[] = []

    for (let i = 0; i < recipientCount; i++) {
      const recipPK = Utils.toHex(headerReader.read(33)) // 33 bytes recipient pubkey
      headerReader.read(33)                               // skip sender pubkey
      const encLen = headerReader.readVarIntNum()         // symmetric key length
      headerReader.read(encLen)                           // skip encrypted symmetric key
      acc.push(recipPK)
    }

    recipients = acc
  } catch (e) {
    console.warn('[decodeOutput] Could not parse recipients from header:', e)
  }

    // Field 7: per-message unique ID
    let uniqueID: string | undefined
    try {
      uniqueID = Utils.toUTF8(fields[7])
      // console.log('[decodeOutput] Unique ID:', uniqueID)
    } catch (err) {
      console.warn('[decodeOutput] Failed to decode uniqueID field:', err)
    }

    let parentMessageId: string | undefined
  let encryptedThreadNameHeader: number[] | undefined
  let encryptedThreadNameCiphertext: number[] | undefined

  // Field 8 (optional): thread name (UTF8 string)
  let threadName: string | undefined
  if (fields.length === 11) {
    // encrypted thread name (header + ciphertext)
    encryptedThreadNameHeader = Array.from(fields[8] as unknown as Uint8Array)
    encryptedThreadNameCiphertext = Array.from(fields[9] as unknown as Uint8Array)

  } else if (fields.length === 10) {
  const possibleValue = Utils.toUTF8(fields[8]).trim()
  // A TXID is always 64 hex chars (0–9, a–f)
  if (/^[0-9a-f]{64}$/i.test(possibleValue)) {
    parentMessageId = possibleValue
    // console.log('[decodeOutput] ParentMessageId detected (10-field schema):', parentMessageId)
  } else {
    threadName = possibleValue
    // console.log('[decodeOutput] Legacy plaintext thread name:', threadName)
  }
}else if (fields.length === 12)
  {
    try {
      parentMessageId = Utils.toUTF8(fields[8]).trim()
      // console.log('[decodeOutput] ParentMessageId detected:', parentMessageId)
    } catch (err) {
      console.warn('[decodeOutput] Failed to decode parentMessageId field:', err)
  }
}

  // console.log('[decodeOutput] Thread ID:', threadId)
  // console.log('[decodeOutput] Sender:', sender)
  // console.log('[decodeOutput] Recipients:', recipients)
  // if (parentMessageId) console.log('[decodeOutput] This message is a reply to:', parentMessageId)

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
    uniqueID,
    parentMessageId,
    encryptedThreadNameHeader,
    encryptedThreadNameCiphertext
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
  outputs: Array<{ beef: number[]; outputIndex: number; timestamp: number }>
): Promise<DecodedMessage[]> {
  return Promise.all(
    outputs.map(({ beef, outputIndex, timestamp }) =>
      decodeOutput(beef, outputIndex, timestamp).catch((err) => {
        console.warn(`[decodeOutputs] Skipping invalid output @ vout ${outputIndex}:`, err)
        return null
      })
    )
  ).then((results) => results.filter((m): m is DecodedMessage => m !== null))
}

