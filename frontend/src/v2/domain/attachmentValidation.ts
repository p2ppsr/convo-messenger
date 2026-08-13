import { StorageUtils } from '@bsv/sdk'
import type { AttachmentKeyEnvelope, AttachmentReference } from './types'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 20
export const ATTACHMENT_SCHEME = 'curvepoint-uhrp-v1' as const

export function attachmentKeyId(conversationId: string, epoch: number, batchId: string): string {
  return `attachment:${conversationId}:${epoch}:${batchId}`
}

export function attachmentKeyMatchesScope(keyId: string, conversationId: string, epoch: number): boolean {
  return new RegExp(`^attachment:${conversationId}:${epoch}:[0-9a-f]{64}$`).test(keyId)
}

export function validAttachmentReference(value: unknown): value is AttachmentReference {
  if (typeof value !== 'object' || value === null) return false
  const attachment = value as Partial<AttachmentReference>
  return typeof attachment.id === 'string' && /^[0-9a-f]{64}$/.test(attachment.id)
    && typeof attachment.handle === 'string' && attachment.handle.length <= 2_048
    && StorageUtils.isValidURL(attachment.handle)
    && typeof attachment.name === 'string' && attachment.name.length > 0 && attachment.name.length <= 255
    && typeof attachment.mimeType === 'string' && attachment.mimeType.length > 0 && attachment.mimeType.length <= 255
    && Number.isSafeInteger(attachment.size) && (attachment.size ?? -1) >= 0 && (attachment.size ?? Infinity) <= MAX_ATTACHMENT_BYTES
    && typeof attachment.digest === 'string' && /^[0-9a-f]{64}$/.test(attachment.digest)
}

export function validAttachmentKey(value: unknown, conversationId: string, epoch: number): value is AttachmentKeyEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const key = value as Partial<AttachmentKeyEnvelope>
  return key.scheme === ATTACHMENT_SCHEME
    && typeof key.keyId === 'string' && attachmentKeyMatchesScope(key.keyId, conversationId, epoch)
    && typeof key.envelope === 'string' && key.envelope.length > 0 && key.envelope.length <= 100_000
    && /^[A-Za-z0-9+/]+={0,2}$/.test(key.envelope)
}

export function validAttachmentSet(
  attachments: unknown,
  attachmentKey: unknown,
  conversationId: string,
  epoch: number,
): boolean {
  if (attachments === undefined) return attachmentKey === undefined
  return Array.isArray(attachments)
    && attachments.length > 0 && attachments.length <= MAX_ATTACHMENTS_PER_MESSAGE
    && attachments.every(validAttachmentReference)
    && attachments.reduce((total, attachment) => total + (attachment as AttachmentReference).size, 0) <= MAX_ATTACHMENT_TOTAL_BYTES
    && validAttachmentKey(attachmentKey, conversationId, epoch)
}

const INLINE_IMAGE_TYPES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const INLINE_AUDIO_TYPES = new Set(['audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm'])

export function isInlineImage(attachment: AttachmentReference): boolean {
  return INLINE_IMAGE_TYPES.has(attachment.mimeType.toLocaleLowerCase())
}

export function isInlineAudio(attachment: AttachmentReference): boolean {
  return INLINE_AUDIO_TYPES.has(attachment.mimeType.toLocaleLowerCase())
}
