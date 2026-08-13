import { Hash, Random, SymmetricKey, Utils } from '@bsv/sdk'
import type { ConversationEvent } from './types'

const DOMAIN = 'convo:v2'

export function generateRootKey(): string {
  return Utils.toBase64(Random(32))
}

export function randomId(): string {
  return Utils.toHex(Random(32))
}

export function deriveKey(rootKey: string, purpose: string): number[] {
  return Hash.sha256hmac(
    Utils.toArray(rootKey, 'base64'),
    Utils.toArray(`${DOMAIN}:${purpose}`, 'utf8'),
  )
}

export function deriveLocator(rootKey: string, purpose: string): string {
  return Utils.toHex(deriveKey(rootKey, `locator:${purpose}`))
}

function paddedJson(value: unknown, blockSize: number): number[] {
  const payload = JSON.stringify(value)
  const prefix = `{"v":2,"payload":${payload},"padding":"`
  const suffix = '"}'
  const baseLength = Utils.toArray(prefix + suffix, 'utf8').length
  const paddingLength = (blockSize - (baseLength % blockSize)) % blockSize
  return Utils.toArray(prefix + '.'.repeat(paddingLength) + suffix, 'utf8')
}

export function encryptJson(rootKey: string, purpose: string, value: unknown, blockSize = 512): string {
  const key = new SymmetricKey(deriveKey(rootKey, `content:${purpose}`))
  return Utils.toBase64(key.encrypt(paddedJson(value, blockSize)) as number[])
}

export function decryptJson<T>(rootKey: string, purpose: string, ciphertext: string): T {
  const key = new SymmetricKey(deriveKey(rootKey, `content:${purpose}`))
  const plaintext = key.decrypt(Utils.toArray(ciphertext, 'base64')) as number[]
  const decoded = JSON.parse(Utils.toUTF8(plaintext)) as { v?: unknown; payload?: T }
  if (decoded.v !== 2 || decoded.payload === undefined) throw new Error('Unsupported encrypted payload')
  return decoded.payload
}

export function manifestLocator(rootKey: string, identityKey: string): string {
  return deriveLocator(rootKey, `manifest:${identityKey}`)
}

export function pageLocator(rootKey: string, identityKey: string, page: number): string {
  return deriveLocator(rootKey, `page:${identityKey}:${page}`)
}

/** Immutable event entries share only a secret-derived tag, never a public roster identifier. */
export function eventTag(rootKey: string, identityKey: string): string {
  return deriveLocator(rootKey, `events:${identityKey}`)
}

export function eventLocator(rootKey: string, identityKey: string, eventId: string): string {
  return deriveLocator(rootKey, `event:${identityKey}:${eventId}`)
}

export function liveBoxName(rootKey: string, recipientIdentity: string): string {
  return `convo-v2-${deriveLocator(rootKey, `live:${recipientIdentity}`).slice(0, 40)}`
}

export function hashBytes(bytes: number[]): string {
  return Utils.toHex(Hash.sha256(bytes))
}

export function eventDigest(event: ConversationEvent): string {
  return hashBytes(Utils.toArray(JSON.stringify(event), 'utf8'))
}

export function epochHistoryDigest(eventDigests: Record<string, string>): string {
  const canonical = Object.entries(eventDigests).sort(([left], [right]) => left.localeCompare(right))
  return hashBytes(Utils.toArray(JSON.stringify(canonical), 'utf8'))
}
