import { WalletInterface, WalletProtocol, Utils } from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import { MessagePayload } from '../types/types'

/**
 * Encrypts a message for a group of recipients using CurvePoint.
 *
 * @param wallet - The WalletInterface (e.g., WalletClient instance)
 * @param payload - The plaintext message payload to encrypt
 * @param recipients - Array of recipient public keys (hex)
 * @param protocolID - WalletProtocol context (e.g., ['tmsg'])
 * @param keyID - Unique key identifier (e.g., '1')
 * @returns The encrypted payload and CurvePoint header
 */
export async function encryptMessage(
  wallet: WalletInterface,
  payload: MessagePayload,
  recipients: string[],
  protocolID: WalletProtocol,
  keyID: string
): Promise<{ encryptedPayload: number[]; header: number[] }> {
  console.log('\n[MessageEncryptor] --------------------------------------')
  console.log('[MessageEncryptor] Starting encryption...')
  console.log('[MessageEncryptor] Recipients:', recipients)
  console.log('[MessageEncryptor] Protocol ID:', protocolID)
  console.log('[MessageEncryptor] Key ID:', keyID)
  console.log('[MessageEncryptor] Payload object:', payload)

  // 1. Convert message to bytes
  const plaintext = JSON.stringify(payload)
  const dataBytes = Array.from(new TextEncoder().encode(plaintext))
  console.log('[MessageEncryptor] Plaintext (string):', plaintext)
  console.log('[MessageEncryptor] Plaintext (bytes length):', dataBytes.length)
  console.log('[MessageEncryptor] Plaintext (hex preview):', Utils.toHex(dataBytes.slice(0, 16)), '...')

  // 2. Construct CurvePoint instance with wallet
  const curvePoint = new CurvePoint(wallet)

  // 3. Encrypt the message using CurvePoint
  const { encryptedMessage, header } = await curvePoint.encrypt(
    dataBytes,
    protocolID,
    keyID,
    recipients
  )

  console.log('[MessageEncryptor] Encryption successful.')
  console.log('[MessageEncryptor] Header length:', header.length)
  console.log('[MessageEncryptor] Encrypted message length:', encryptedMessage.length)
  console.log('[MessageEncryptor] Header (hex preview):', Utils.toHex(header.slice(0, 16)), '...')
  console.log('[MessageEncryptor] Encrypted message (hex preview):', Utils.toHex(encryptedMessage.slice(0, 16)), '...')

  return {
    encryptedPayload: encryptedMessage,
    header
  }
}
