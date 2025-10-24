// src/utils/fileEncryptor.ts
import {
  WalletInterface,
  WalletProtocol,
  StorageUploader,
  StorageDownloader
} from '@bsv/sdk'
import { getCurvePoint } from './curvePointSingleton'

// const STORAGE_URL = 'https://uhrp-lite.babbage.systems'
const STORAGE_URL = 'https://nanostore.babbage.systems'
const GATEWAY_URL = 'https://uhrp.babbage.systems' // only used to build a friendly downloadURL
const retentionPeriodMinutes = 60 * 24 * 7 // 7 days

/**
 * Encrypts and uploads a file to UHRP.
 */
export async function uploadEncryptedFile(
  wallet: WalletInterface,
  protocolID: WalletProtocol,
  keyID: string,
  recipients: string[],
  file: File,
  retentionPeriod = retentionPeriodMinutes
): Promise<{
  handle: string        // raw UHRP handle
  downloadURL: string   // friendly gateway URL (optional, not required for downloads)
  header: number[]
  filename: string
  mimetype: string
}> {
  const curvePoint = getCurvePoint(wallet)

  try {
    // 1. Read file bytes
    const buffer = await file.arrayBuffer()
    let fileBytes = Array.from(new Uint8Array(buffer))
    // console.log('[Upload] File:', {
    //   name: file.name,
    //   size: fileBytes.length,
    //   type: file.type
    // })

    // 2. Encrypt with CurvePoint
    const { encryptedMessage, header } = await curvePoint.encrypt(
      fileBytes,
      protocolID,
      keyID,
      recipients
    )
    // console.log('[Upload] Encryption complete:', {
    //   headerLength: header.length,
    //   encryptedLength: encryptedMessage.length,
    //   headerPreview: header.slice(0, 16),
    //   encryptedPreview: encryptedMessage.slice(0, 16),
    //   recipients
    // })

    // 3. Upload ciphertext
    const storageUploader = new StorageUploader({ storageURL: STORAGE_URL, wallet })
    // console.log('[Upload] Starting publishFile to', STORAGE_URL)

    // ensure minimum file size to avoid UHRP-Lite rejection
    if (fileBytes.length < 1024) {
      console.warn(`[Upload] File too small (${fileBytes.length} bytes) — padding to 1024`)
      fileBytes = [...fileBytes, ...new Array(1024 - fileBytes.length).fill(0)]
    }

    const mime = file.type || 'text/plain'

    const uploaded = await storageUploader.publishFile({
      file: {
        data: Uint8Array.from(encryptedMessage),
        type: mime
      },
      retentionPeriod
    })

    // console.log('[Upload] publishFile response:', uploaded)

    if (!uploaded || !uploaded.uhrpURL) {
      throw new Error('[Upload] Failed: no uhrpURL in response')
    }

    // console.log('[Upload] Success! Handle:', uploaded.uhrpURL)

    return {
      handle: uploaded.uhrpURL,
      downloadURL: `${GATEWAY_URL}/${uploaded.uhrpURL}`, // optional convenience
      header,
      filename: file.name,
      mimetype: file.type || 'application/octet-stream'
    }
  } catch (err) {
    console.error('[Upload] ERROR during uploadEncryptedFile:', err)
    throw err
  }
}

/**
 * Downloads and decrypts a file from UHRP.
 */
export async function downloadAndDecryptFile(
  wallet: WalletInterface,
  protocolID: WalletProtocol,
  keyID: string,
  uhrpUrl: string,   // raw UHRP URL (handle)
  header: number[],
  mimetype = 'application/octet-stream'
): Promise<Blob> {
  const curvePoint = getCurvePoint(wallet)
  const downloader = new StorageDownloader({ networkPreset: 'mainnet' })

  // console.log('[Download] Resolving + downloading from UHRP:', uhrpUrl)

  const result = await downloader.download(uhrpUrl)
  if (!result || !result.data) {
    throw new Error('[Download] No data returned from StorageDownloader')
  }

  const ciphertext = Array.from(result.data)

  // Recombine header + ciphertext
  const combined = [...header, ...ciphertext]

  // Decrypt
  const decryptedBytes = await curvePoint.decrypt(combined, protocolID, keyID)

  return new Blob([Uint8Array.from(decryptedBytes)], { type: mimetype })
}

/**
 * Looks up expiry information for a hosted file.
 */
export async function getFileExpiry(
  wallet: WalletInterface,
  uhrpUrl: string
): Promise<{ expiryTime?: number; expiresInMs?: number } | null> {
  try {
    const storageUploader = new StorageUploader({
      storageURL: STORAGE_URL,
      wallet
    })

    // @ts-ignore - method exists at runtime
    const result = await storageUploader.findFile(uhrpUrl)

    if (result?.expiryTime) {
      const expiresInMs = Math.max(0, result.expiryTime * 1000 - Date.now())
      return { expiryTime: result.expiryTime, expiresInMs }
    }

    return null
  } catch (err) {
    console.warn('[fileEncryptor] Failed to get file expiry:', err)
    return null
  }
}

/**
 * Renews a hosted file for additional minutes.
 */
export async function renewFileHosting(
  wallet: WalletInterface,
  uhrpUrl: string,
  additionalMinutes: number
): Promise<any> {
  try {
    const storageUploader = new StorageUploader({
      storageURL: STORAGE_URL,
      wallet
    })
    // @ts-ignore - method exists at runtime
    const result = await storageUploader.renewFile(uhrpUrl, additionalMinutes)
    return result
  } catch (err) {
    console.error('[fileEncryptor] Failed to renew file:', err)
    throw err
  }
}

