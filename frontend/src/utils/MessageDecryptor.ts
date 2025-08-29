import { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import type { MessagePayload } from '../types/types'

/**
 * Decrypts a message using CurvePoint.
 *
 * @param wallet - The recipient’s WalletInterface
 * @param header - The CurvePoint header (number[])
 * @param encryptedPayload - The encrypted message (number[])
 * @param protocolID - Protocol ID (e.g. [2, 'tmsg'])
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
    const curvePoint = new CurvePoint(wallet)

    // Combine header and payload into one ciphertext buffer
    const ciphertext = [...header, ...encryptedPayload]

    console.log('[MessageDecryptor] Attempting decryption...')
    const decryptedBytes = await curvePoint.decrypt(ciphertext, protocolID, keyID)

    const json = new TextDecoder().decode(Uint8Array.from(decryptedBytes))
    const parsed = JSON.parse(json) as MessagePayload

    console.log('[MessageDecryptor] Decryption successful:', parsed)
    return parsed
  } catch (err) {
    console.error('[MessageDecryptor] Failed to decrypt message:', err)
    return null
  }
}
