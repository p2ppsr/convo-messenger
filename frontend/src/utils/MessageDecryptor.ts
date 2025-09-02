import { WalletInterface, WalletProtocol, Utils } from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import type { MessagePayload } from '../types/types'
import type { DecodedMessage } from '../utils/decodeOutputs'

/**
 * Decrypts a message using CurvePoint.
 *
 * @param wallet - The recipient’s WalletInterface
 * @param header - The CurvePoint header (number[])
 * @param encryptedPayload - The encrypted message (number[])
 * @param protocolID - Protocol ID (e.g. [2, 'convo'])
 * @param keyID - Recipient's key ID (e.g. '1')
 * @returns The decrypted and parsed MessagePayload, or null if decryption fails
 */
export async function decryptMessage(
  wallet: WalletInterface,
  header: number[],
  encryptedPayload: number[],
  protocolID: WalletProtocol,
  keyID: string
): Promise<MessagePayload | null> {
  try {
    console.log('\n[MessageDecryptor] --------------------------------------')
    console.log('[MessageDecryptor] Decryption Attempt Starting')
    console.log('[MessageDecryptor] Header length:', header.length)
    console.log('[MessageDecryptor] Encrypted payload length:', encryptedPayload.length)
    console.log('[MessageDecryptor] Protocol ID:', protocolID)
    console.log('[MessageDecryptor] Key ID:', keyID)
    console.log('[MessageDecryptor] Header (hex preview):', Utils.toHex(header.slice(0, 16)), '...')
    console.log('[MessageDecryptor] Encrypted payload (hex preview):', Utils.toHex(encryptedPayload.slice(0, 16)), '...')

    const pubKey = await wallet.getPublicKey({
  protocolID,
  keyID,
  counterparty: 'self'
})
console.log('[MessageDecryptor] My derived public key:', pubKey)

    const curvePoint = new CurvePoint(wallet)

    // Combine header and payload into one ciphertext buffer
    const ciphertext = [...header, ...encryptedPayload]
    console.log('[MessageDecryptor] Total ciphertext length:', ciphertext.length)
    console.log('[MessageDecryptor] Ciphertext (hex preview):', Utils.toHex(ciphertext.slice(0, 32)), '...')

    const decryptedBytes = await curvePoint.decrypt(ciphertext, protocolID, keyID)

    const json = new TextDecoder().decode(Uint8Array.from(decryptedBytes))
    console.log('[MessageDecryptor] Decrypted JSON string preview:', json.slice(0, 128), json.length > 128 ? '...' : '')

    const parsed = JSON.parse(json) as MessagePayload
    console.log('[MessageDecryptor] Decryption successful. Parsed payload:', parsed)

    return parsed
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
): Promise<Array<DecodedMessage & { payload: MessagePayload | null }>> {
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

      return {
        ...msg,
        payload
      }
    })
  )
  console.log('[MessageDecryptor] Batch decryption complete.')
  return results
}
