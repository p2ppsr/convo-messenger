import { WalletInterface, WalletProtocol } from '@bsv/sdk'
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
  // 1. Convert message to bytes
  const plaintext = JSON.stringify(payload)
  const dataBytes = Array.from(new TextEncoder().encode(plaintext))

  // 2. Construct CurvePoint instance with wallet
  const curvePoint = new CurvePoint(wallet)

  // 3. Encrypt the message using CurvePoint
  const { encryptedMessage, header } = await curvePoint.encrypt(
    dataBytes,
    protocolID,
    keyID,
    recipients
  )

  return {
    encryptedPayload: encryptedMessage,
    header
  }
}
