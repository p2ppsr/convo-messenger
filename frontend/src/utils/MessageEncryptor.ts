import { WalletInterface, WalletProtocol, Utils } from '@bsv/sdk'
import { getCurvePoint } from './curvePointSingleton'
import { MessagePayload } from '../types/types'

/**
 * encryptMessage
 *
 * Purpose:
 *   - Take a MessagePayload (your plaintext chat object).
 *   - Serialize it to bytes.
 *   - Use CurvePoint to wrap the payload with a header that contains:
 *       - The recipient list
 *       - Encrypted symmetric keys
 *       - Sender pubkey
 *   - Return:
 *       - header: used for recipient key validation and key unwrapping.
 *       - encryptedPayload: ciphertext for the actual chat content.
 *
 * Inputs:
 *   - wallet: provides the private key used to derive sender identity and
 *             generate symmetric key wrapping for recipients.
 *   - payload: message data (JSON).
 *   - recipients: **critical** – every recipient’s pubkey that should be
 *                 able to decrypt (MUST include sender too!).
 *   - protocolID, keyID: namespace for key derivation inside wallet.
 *
 * Returns:
 *   - { encryptedPayload, header }
 */
export async function encryptMessage(
  wallet: WalletInterface,
  payload: MessagePayload,
  recipients: string[],
  protocolID: WalletProtocol,
  keyID: string
): Promise<{ encryptedPayload: number[]; header: number[] }> {
  const perfStart = performance.now()
  console.log(`\n%cencryptMessage() START @ ${perfStart.toFixed(3)} ms`, "color: cyan")

  // console.log('\n[MessageEncryptor] --------------------------------------')
  // console.log('[MessageEncryptor] Starting encryption...')
  // console.log('[MessageEncryptor] Recipients:', recipients)
  // console.log('[MessageEncryptor] Protocol ID:', protocolID)
  // console.log('[MessageEncryptor] Key ID:', keyID)
  // console.log('[MessageEncryptor] Payload object:', payload)

   const tEncodeStart = performance.now()
  // --- Step 1: Convert payload object into a byte array ---
  const plaintext = JSON.stringify(payload)
  const dataBytes = Array.from(new TextEncoder().encode(plaintext))
console.log(`[Encrypt][timing] serialize payload: ${(performance.now() - tEncodeStart).toFixed(2)} ms`)


  // console.log('[MessageEncryptor] Plaintext (string):', plaintext)
  // console.log('[MessageEncryptor] Plaintext (bytes length):', dataBytes.length)
  // console.log(
  //   '[MessageEncryptor] Plaintext (hex preview):',
  //   Utils.toHex(dataBytes.slice(0, 16)),
  //   '...'
  // )

  // --- Step 2: Initialize CurvePoint with wallet ---
  // This ties encryption to the wallet’s key derivation logic.
    const tCPstart = performance.now()
  const curvePoint = getCurvePoint(wallet)
console.log(`[Encrypt][timing] getCurvePoint(): ${(performance.now() - tCPstart).toFixed(2)} ms`)
  // --- Step 3: Perform encryption ---
  // CurvePoint builds a header with:
  //   - numRecipients
  //   - each recipient’s pubkey
  //   - encrypted symmetric key material for each recipient
  // The same symmetric key is used for all recipients’ encryptedPayload.
  const tEncStart = performance.now()
  const { encryptedMessage, header } = await curvePoint.encrypt(
    dataBytes,
    protocolID,
    keyID,
    recipients
  )

  console.log(`[Encrypt][timing] CurvePoint.encrypt(): ${(performance.now() - tEncStart).toFixed(2)} ms`)

  console.log(`%cencryptMessage() COMPLETE: ${(performance.now() - perfStart).toFixed(2)} ms`, "color: lime; font-weight: bold")

  // console.log('[MessageEncryptor] Encryption successful.')
  // console.log('[MessageEncryptor] Header length:', header.length)
  // console.log('[MessageEncryptor] Encrypted message length:', encryptedMessage.length)
  // console.log('[MessageEncryptor] Header (hex preview):', Utils.toHex(header.slice(0, 16)), '...')
  // console.log(
  //   '[MessageEncryptor] Encrypted message (hex preview):',
  //   Utils.toHex(encryptedMessage.slice(0, 16)),
  //   '...'
  // )

  // --- Step 4: Return header + ciphertext ---
  return {
    encryptedPayload: encryptedMessage,
    header
  }
}
