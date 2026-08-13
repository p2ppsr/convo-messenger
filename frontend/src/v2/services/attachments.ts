import {
  StorageDownloader,
  StorageUploader,
  SymmetricKey,
  Utils,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import {
  ATTACHMENT_SCHEME,
  attachmentKeyId,
  attachmentKeyMatchesScope,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_TOTAL_BYTES,
  validAttachmentKey,
  validAttachmentReference,
} from '../domain/attachmentValidation'
import { deriveKey, hashBytes, randomId } from '../domain/crypto'
import type { AttachmentKeyEnvelope, AttachmentReference, ConversationEpoch } from '../domain/types'

const STORAGE_URL = 'https://nanostore.babbage.systems'
const RETENTION_MINUTES = 60 * 24 * 365
const PROTOCOL_ID: WalletProtocol = [2, 'Convo Messenger']

export { MAX_ATTACHMENT_BYTES } from '../domain/attachmentValidation'

export interface AttachmentBatch {
  attachments: AttachmentReference[]
  attachmentKey: AttachmentKeyEnvelope
}

interface AttachmentStorage {
  publish(data: Uint8Array): Promise<string>
  download(handle: string): Promise<Uint8Array>
}

function uhrpStorage(wallet: WalletInterface): AttachmentStorage {
  const uploader = new StorageUploader({ storageURL: STORAGE_URL, wallet })
  const downloader = new StorageDownloader({ networkPreset: 'mainnet' })
  return {
    publish: async (data) => {
      const uploaded = await uploader.publishFile({
        file: { data, type: 'application/octet-stream' },
        retentionPeriod: RETENTION_MINUTES,
      })
      if (!uploaded?.uhrpURL) throw new Error('Encrypted attachment upload did not return a UHRP handle')
      return uploaded.uhrpURL
    },
    download: async (handle) => {
      const downloaded = await downloader.download(handle)
      if (!downloaded?.data) throw new Error('Encrypted attachment is unavailable')
      return downloaded.data
    },
  }
}

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
  private readonly storage: AttachmentStorage
  private readonly openedKeys = new Map<string, Promise<string>>()

  constructor(private readonly wallet: WalletInterface, storage?: AttachmentStorage) {
    this.storage = storage ?? uhrpStorage(wallet)
  }

  async upload(files: File[], conversationId: string, epoch: ConversationEpoch): Promise<AttachmentBatch> {
    if (files.length === 0 || files.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error('A message supports 1 to 20 attachments')
    let total = 0
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachments are limited to 25 MB each')
      if (!file.name || file.name.length > 255) throw new Error('Attachment filename is invalid')
      if (file.type.length > 255) throw new Error('Attachment type is invalid')
      total += file.size
    }
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error('Attachments are limited to 50 MB per message')
    if (!epoch.members.length) throw new Error('Attachment recipients are unavailable')

    const masterKey = SymmetricKey.fromRandom()
    const batchId = randomId()
    const keyId = attachmentKeyId(conversationId, epoch.epoch, batchId)
    const curvePoint = new CurvePoint(this.wallet)
    const sealed = await curvePoint.encrypt(masterKey.toArray(), PROTOCOL_ID, keyId, epoch.members)
    const attachmentKey: AttachmentKeyEnvelope = {
      scheme: ATTACHMENT_SCHEME,
      keyId,
      envelope: Utils.toBase64([...sealed.header, ...sealed.encryptedMessage]),
    }
    const rootKey = Utils.toBase64(masterKey.toArray())
    const attachments: AttachmentReference[] = []

    for (const file of files) {
      const id = randomId()
      const original = Array.from(new Uint8Array(await file.arrayBuffer()))
      const payload = [...writeLength(original.length), ...original]
      payload.push(...new Array(paddedLength(payload.length) - payload.length).fill(0))
      const cipher = new SymmetricKey(deriveKey(rootKey, `attachment:${id}`))
      const handle = await this.storage.publish(Uint8Array.from(cipher.encrypt(payload) as number[]))
      const reference: AttachmentReference = {
        id,
        handle,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: original.length,
        digest: hashBytes(original),
      }
      if (!validAttachmentReference(reference)) throw new Error('Storage provider returned an invalid UHRP handle')
      attachments.push(reference)
    }
    return { attachments, attachmentKey }
  }

  async download(
    reference: AttachmentReference,
    attachmentKey: AttachmentKeyEnvelope,
    conversationId: string,
    epoch: ConversationEpoch,
  ): Promise<Blob> {
    if (!validAttachmentReference(reference)) throw new Error('Attachment reference is invalid')
    if (!validAttachmentKey(attachmentKey, conversationId, epoch.epoch)
      || !attachmentKeyMatchesScope(attachmentKey.keyId, conversationId, epoch.epoch)) {
      throw new Error('Attachment key scope is invalid')
    }
    const downloaded = await this.storage.download(reference.handle)
    const rootKey = await this.openKey(attachmentKey)
    const cipher = new SymmetricKey(deriveKey(rootKey, `attachment:${reference.id}`))
    const decrypted = cipher.decrypt(Array.from(downloaded)) as number[]
    const length = readLength(decrypted)
    if (length > MAX_ATTACHMENT_BYTES || length !== reference.size) throw new Error('Attachment integrity check failed')
    const original = decrypted.slice(4, 4 + length)
    if (original.length !== reference.size || hashBytes(original) !== reference.digest) {
      throw new Error('Attachment integrity check failed')
    }
    return new Blob([Uint8Array.from(original)], { type: reference.mimeType })
  }

  private openKey(attachmentKey: AttachmentKeyEnvelope): Promise<string> {
    const cacheKey = `${attachmentKey.keyId}:${hashBytes(Utils.toArray(attachmentKey.envelope, 'base64'))}`
    const cached = this.openedKeys.get(cacheKey)
    if (cached) return cached
    const opening = new CurvePoint(this.wallet)
      .decrypt(Utils.toArray(attachmentKey.envelope, 'base64'), PROTOCOL_ID, attachmentKey.keyId)
      .then((key) => Utils.toBase64(key))
      .catch((error) => {
        this.openedKeys.delete(cacheKey)
        throw error
      })
    this.openedKeys.set(cacheKey, opening)
    return opening
  }
}
