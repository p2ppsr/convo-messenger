import {
  StorageDownloader,
  StorageUploader,
  SymmetricKey,
  type WalletInterface,
} from '@bsv/sdk'
import { deriveKey, hashBytes, randomId } from '../domain/crypto'
import type { AttachmentReference, ConversationEpoch } from '../domain/types'

const STORAGE_URL = 'https://nanostore.babbage.systems'
const RETENTION_MINUTES = 60 * 24 * 30
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

function paddedLength(length: number): number {
  let size = 4_096
  while (size < length) size *= 2
  return size
}

function writeLength(length: number): number[] {
  return [(length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]
}

function readLength(bytes: number[]): number {
  if (bytes.length < 4) throw new Error('Attachment payload is truncated')
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
}

export class AttachmentService {
  constructor(private readonly wallet: WalletInterface) {}

  async upload(file: File, epoch: ConversationEpoch): Promise<AttachmentReference> {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachments are limited to 25 MB')
    if (!file.name || file.name.length > 255) throw new Error('Attachment filename is invalid')
    if (file.type.length > 255) throw new Error('Attachment type is invalid')
    const id = randomId()
    const original = Array.from(new Uint8Array(await file.arrayBuffer()))
    const payload = [...writeLength(original.length), ...original]
    payload.push(...new Array(paddedLength(payload.length) - payload.length).fill(0))
    const cipher = new SymmetricKey(deriveKey(epoch.rootKey, `attachment:${id}`))
    const ciphertext = cipher.encrypt(payload) as number[]
    const uploader = new StorageUploader({ storageURL: STORAGE_URL, wallet: this.wallet })
    const uploaded = await uploader.publishFile({
      file: { data: Uint8Array.from(ciphertext), type: 'application/octet-stream' },
      retentionPeriod: RETENTION_MINUTES,
    })
    if (!uploaded?.uhrpURL) throw new Error('Encrypted attachment upload did not return a handle')
    return {
      id,
      handle: uploaded.uhrpURL,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: original.length,
      digest: hashBytes(original),
    }
  }

  async download(reference: AttachmentReference, epoch: ConversationEpoch): Promise<Blob> {
    if (!Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > MAX_ATTACHMENT_BYTES) {
      throw new Error('Attachment size is invalid')
    }
    const downloader = new StorageDownloader({ networkPreset: 'mainnet' })
    const downloaded = await downloader.download(reference.handle)
    if (!downloaded?.data) throw new Error('Encrypted attachment is unavailable')
    const cipher = new SymmetricKey(deriveKey(epoch.rootKey, `attachment:${reference.id}`))
    const decrypted = cipher.decrypt(Array.from(downloaded.data)) as number[]
    const length = readLength(decrypted)
    const original = decrypted.slice(4, 4 + length)
    if (original.length !== reference.size || hashBytes(original) !== reference.digest) {
      throw new Error('Attachment integrity check failed')
    }
    return new Blob([Uint8Array.from(original)], { type: reference.mimeType })
  }
}
