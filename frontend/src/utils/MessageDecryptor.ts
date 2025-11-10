// src/utils/decryptMessage.ts

import { WalletInterface, WalletProtocol, Utils } from '@bsv/sdk'
import { getCurvePoint } from './curvePointSingleton'
import type { MessagePayload } from '../types/types'
import type { DecodedMessage } from './decodeOutputs'

import * as cp from './curvePointSingleton'
// console.log('curvePointSingleton exports:', cp)

/**
 * decryptMessage
 *
 * Purpose:
 *   - Takes a PushDrop message (header + encrypted payload)
 *   - Uses CurvePoint to attempt decryption
 *   - Returns a parsed MessagePayload + recipient list
 *
 * Inputs:
 *   - wallet: WalletInterface → provides identity keys for decryption
 *   - header: encrypted header containing key material + routing info
 *   - encryptedPayload: actual ciphertext body of the message
 *   - protocolID, keyID: specify which derived key to use
 *
 * Returns:
 *   - MessagePayload (JSON parsed body) plus recipients[] array
 *   - Or null if decryption fails
 */
export async function decryptMessage(
  wallet: WalletInterface,
  header: number[],
  encryptedPayload: number[],
  protocolID: WalletProtocol,
  keyID: string
): Promise<(MessagePayload & { recipients?: string[] }) | null> {
  const perfStart = performance.now()
  console.log(`\n%cdeclryptMessage() START @ ${perfStart.toFixed(3)} ms`, "color: orange")

  try {
    // console.log('\n[MessageDecryptor] --------------------------------------')
    // console.log('[MessageDecryptor] Decryption Attempt Starting')
    // console.log('[MessageDecryptor] Header length:', header.length)
    // console.log('[MessageDecryptor] Encrypted payload length:', encryptedPayload.length)
    // console.log('[MessageDecryptor] Protocol ID:', protocolID)
    // console.log('[MessageDecryptor] Key ID:', keyID)

    // --- Step 1: Initialize CurvePoint with wallet ---
    // CurvePoint manages key wrapping/unwrapping logic for recipients
     const tInit = performance.now()
    const curvePoint = getCurvePoint(wallet)
    console.log(`[Decrypt][timing] getCurvePoint(): ${(performance.now() - tInit).toFixed(2)} ms`)

    // Combine header + encrypted payload into one ciphertext blob
    const ciphertext = [...header, ...encryptedPayload]
    // console.log('[MessageDecryptor] Total ciphertext length:', ciphertext.length)
    // console.log(
    //   '[MessageDecryptor] Ciphertext (hex preview):',
    //   Utils.toHex(ciphertext.slice(0, 32)),
    //   '...'
    // )

    // --- Step 2: Attempt decryption ---
    // CurvePoint.decrypt() tries to unwrap the symmetric key for this wallet
    // using protocolID + keyID, then decrypts payload.
    const tDecrypt = performance.now()
    const decryptedBytes = await curvePoint.decrypt(ciphertext, protocolID, keyID)
    console.log(`[Decrypt][timing] CurvePoint.decrypt(): ${(performance.now() - tDecrypt).toFixed(2)} ms`)


    // Convert decrypted bytes → string → JSON
    const tJSON = performance.now()
    const json = new TextDecoder().decode(Uint8Array.from(decryptedBytes))
    const parsed = JSON.parse(json) as MessagePayload
    console.log(`[Decrypt][timing] JSON.parse: ${(performance.now() - tJSON).toFixed(2)} ms`)


    // --- Step 3: Parse recipients from the header ---
    // parseHeader extracts structural metadata (like numRecipients).
    const tParseHeader = performance.now()
    const parsedHeader = curvePoint.parseHeader(ciphertext)
    const reader = new Utils.Reader(parsedHeader.header)

    // Read header format:
    // - First 4 bytes = version
    // - Next = varint number of recipients
    const version = reader.readUInt32LE()
    const numRecipients = reader.readVarIntNum()

    // console.log('[MessageDecryptor] Header version:', version)

    const recipients: string[] = []

    // For each recipient:
    //   - Read recipient pubkey (33 bytes)
    //   - Log + store as hex
    //   - Skip sender key (33 bytes)
    //   - Skip encrypted symmetric key blob
    for (let i = 0; i < numRecipients; i++) {
      const recipientKey = reader.read(33)
      const recipientHex = Utils.toHex(recipientKey)

      // console.log(`[MessageDecryptor] Recipient #${i}:`)
      // console.log(`  Raw Bytes:`, recipientKey)
      // console.log(`  Hex: ${recipientHex}`)

      recipients.push(recipientHex)

      // Skip over paired sender pubkey (33 bytes)
      reader.read(33)
      // Skip over encrypted key material
      const encryptedKeyLength = reader.readVarIntNum()
      reader.read(encryptedKeyLength)
    }

    console.log(`[Decrypt][timing] parseHeader(): ${(performance.now() - tParseHeader).toFixed(2)} ms`)

    console.log(`%cdeclryptMessage() COMPLETE: ${(performance.now() - perfStart).toFixed(2)} ms`, "color: lime; font-weight: bold")

    // --- Step 4: Return parsed payload + recipients list ---
    return {
      ...parsed,
      recipients
    }
  } catch (err) {
    // If decrypt fails, CurvePoint throws "Decryption failed" or
    // "Your key is not found in the header".
    console.error('[MessageDecryptor] Failed to decrypt message:', err)
    return null
  }
}

/**
 * decryptMessageBatch
 *
 * Purpose:
 *   - Runs decryptMessage() for an array of decoded overlay messages
 *   - Adds threadName back in if it was carried in the PushDrop
 */
export async function decryptMessageBatch(
  wallet: WalletInterface,
  messages: DecodedMessage[],
  protocolID: WalletProtocol,
  keyID: string
): Promise<Array<DecodedMessage & { payload: MessagePayload | null; recipients?: string[] }>> {
  // console.log('\n[MessageDecryptor] Starting batch decryption for', messages.length, 'messages')

  const results = await Promise.all(
    messages.map(async (msg, index) => {
      // console.log(`\n[MessageDecryptor] >>> Decrypting message #${index + 1} of ${messages.length}`)

      const payload = await decryptMessage(
        wallet,
        msg.header!,
        msg.encryptedPayload!,
        protocolID,
        keyID
      )

      // If decrypted payload didn’t carry its name, but PushDrop had one, restore it
      if (payload && !payload.name && msg.threadName) {
        payload.name = msg.threadName
      }

      return {
        ...msg,
        payload,
        recipients: payload?.recipients ?? []
      }
    })
  )

  // console.log('[MessageDecryptor] Batch decryption complete.')
  return results
}
