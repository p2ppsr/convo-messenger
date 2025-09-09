// src/utils/decryptMessage.ts

import { WalletInterface, WalletProtocol, Utils } from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import type { MessagePayload } from '../types/types'
import type { DecodedMessage } from './decodeOutputs'

/**
 * Decrypts a message using CurvePoint.
 */
export async function decryptMessage(
  wallet: WalletInterface,
  header: number[],
  encryptedPayload: number[],
  protocolID: WalletProtocol,
  keyID: string
): Promise<(MessagePayload & { recipients?: string[] }) | null> {
  try {
    console.log('\n[MessageDecryptor] --------------------------------------')
    console.log('[MessageDecryptor] Decryption Attempt Starting')
    console.log('[MessageDecryptor] Header length:', header.length)
    console.log('[MessageDecryptor] Encrypted payload length:', encryptedPayload.length)
    console.log('[MessageDecryptor] Protocol ID:', protocolID)
    console.log('[MessageDecryptor] Key ID:', keyID)

    const curvePoint = new CurvePoint(wallet)
    const ciphertext = [...header, ...encryptedPayload]

    console.log('[MessageDecryptor] Total ciphertext length:', ciphertext.length)
    console.log('[MessageDecryptor] Ciphertext (hex preview):', Utils.toHex(ciphertext.slice(0, 32)), '...')

    const decryptedBytes = await curvePoint.decrypt(ciphertext, protocolID, keyID)
    const json = new TextDecoder().decode(Uint8Array.from(decryptedBytes))
    const parsed = JSON.parse(json) as MessagePayload

    // Extract recipients from the header
    const parsedHeader = curvePoint.parseHeader(ciphertext)
    const reader = new Utils.Reader(parsedHeader.header)

    const version = reader.readUInt32LE()
    const numRecipients = reader.readVarIntNum()

    console.log('[MessageDecryptor] Header version:', version)
    
    const recipients: string[] = []

    for (let i = 0; i < numRecipients; i++) {
      const recipientKey = reader.read(33)
      const recipientHex = Utils.toHex(recipientKey)

      console.log(`[MessageDecryptor] Recipient #${i}:`)
      console.log(`  Raw Bytes:`, recipientKey)
      console.log(`  Hex: ${recipientHex}`)

      recipients.push(recipientHex)

      reader.read(33) // skip sender key
      const encryptedKeyLength = reader.readVarIntNum()
      reader.read(encryptedKeyLength)
    }

    return {
      ...parsed,
      recipients
    }
  } catch (err) {
    console.error('[MessageDecryptor] Failed to decrypt message:', err)
    return null
  }
}

export async function decryptMessageBatch(
  wallet: WalletInterface,
  messages: DecodedMessage[],
  protocolID: WalletProtocol,
  keyID: string
): Promise<Array<DecodedMessage & { payload: MessagePayload | null; recipients?: string[] }>> {
  console.log('\n[MessageDecryptor] Starting batch decryption for', messages.length, 'messages')

  const results = await Promise.all(
    messages.map(async (msg, index) => {
      console.log(`\n[MessageDecryptor] >>> Decrypting message #${index + 1} of ${messages.length}`)

      const payload = await decryptMessage(
        wallet,
        msg.header,
        msg.encryptedPayload,
        protocolID,
        keyID
      )

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

  console.log('[MessageDecryptor] Batch decryption complete.')
  return results
}
