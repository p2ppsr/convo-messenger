import { LocalKVStore, Utils, type WalletInterface } from '@bsv/sdk'
import { epochHistoryDigest } from '../domain/crypto'
import type { ConversationEpoch, ConversationSecret, PendingControlDelivery } from '../domain/types'

const CONTEXT = 'convo private v2'
const INDEX_KEY = 'conversation-index'
const SECRET_PREFIX = 'conversation:'

export interface PrivateKeyValueStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<unknown>
  remove(key: string): Promise<unknown>
}

class WalletPrivateStore implements PrivateKeyValueStore {
  private readonly store: LocalKVStore

  constructor(wallet: WalletInterface) {
    this.store = new LocalKVStore(wallet, CONTEXT, true)
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.store.get(key)
    return typeof value === 'string' ? value : undefined
  }

  async set(key: string, value: string): Promise<unknown> {
    return await this.store.set(key, value)
  }

  async remove(key: string): Promise<unknown> {
    return await this.store.remove(key)
  }
}

const storesByWallet = new WeakMap<object, ConversationSecretRepository>()

export class ConversationSecretRepository {
  constructor(private readonly store: PrivateKeyValueStore) {}

  private secretKey(conversationId: string): string {
    return `${SECRET_PREFIX}${conversationId}`
  }

  async list(): Promise<ConversationSecret[]> {
    const rawIndex = await this.store.get(INDEX_KEY)
    const ids = parseIndex(rawIndex)
    const secrets = await Promise.all(ids.map(async (id) => await this.get(id)))
    return secrets
      .filter((secret): secret is ConversationSecret => secret !== null)
      .sort((a, b) => Number(b.preferences.favorite) - Number(a.preferences.favorite) || b.updatedAt - a.updatedAt)
  }

  async get(conversationId: string): Promise<ConversationSecret | null> {
    const raw = await this.store.get(this.secretKey(conversationId))
    return parseSecret(raw)
  }

  /** Persist the secret first, then make it discoverable from the private index. */
  async save(secret: ConversationSecret): Promise<void> {
    validateSecret(secret)
    await this.store.set(this.secretKey(secret.conversationId), JSON.stringify(secret))
    const ids = parseIndex(await this.store.get(INDEX_KEY))
    if (!ids.includes(secret.conversationId)) {
      await this.store.set(INDEX_KEY, JSON.stringify([...ids, secret.conversationId]))
    }
  }

  async remove(conversationId: string): Promise<void> {
    await this.store.remove(this.secretKey(conversationId))
    const ids = parseIndex(await this.store.get(INDEX_KEY))
    await this.store.set(INDEX_KEY, JSON.stringify(ids.filter((id) => id !== conversationId)))
  }
}

export function secretRepositoryFor(wallet: WalletInterface): ConversationSecretRepository {
  const key = wallet as object
  const existing = storesByWallet.get(key)
  if (existing) return existing
  const repository = new ConversationSecretRepository(new WalletPrivateStore(wallet))
  storesByWallet.set(key, repository)
  return repository
}

function parseIndex(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)))]
      : []
  } catch {
    return []
  }
}

function parseSecret(raw: string | undefined): ConversationSecret | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ConversationSecret
    validateSecret(parsed)
    return parsed
  } catch {
    return null
  }
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validPendingControl(
  secret: ConversationSecret,
  current: ConversationEpoch,
  delivery: PendingControlDelivery,
): boolean {
  const body = delivery.body
  if (!/^[0-9a-f]{64}$/.test(delivery.id)
    || (delivery.prerequisiteEventId !== undefined && !/^[0-9a-f]{64}$/.test(delivery.prerequisiteEventId))
    || !/^(02|03)[0-9a-f]{64}$/i.test(delivery.recipient)
    || !current.members.includes(delivery.recipient)
    || body.v !== 2
    || body.conversationId !== secret.conversationId
    || body.epoch !== secret.currentEpoch
    || body.title.length === 0 || body.title.length > 100
    || body.envelope.length === 0 || body.envelope.length > 1_000_000
    || body.createdAt !== current.activatedAt
    || !sameList(body.members, current.members)
    || !sameList(body.admins, current.admins)) return false
  if (body.type === 'convo-v2-invite') return body.kind === secret.kind
  const prior = secret.epochs.find((epoch) => epoch.epoch === secret.currentEpoch - 1)?.closure
  return prior !== undefined
    && body.previousEpochCommitment.closedAt === prior.closedAt
    && body.previousEpochCommitment.eventCount === prior.eventCount
    && body.previousEpochCommitment.historyDigest === prior.historyDigest
}

export function validateSecret(secret: ConversationSecret): void {
  if (secret.v !== 2 || !/^[0-9a-f]{64}$/.test(secret.conversationId)) throw new Error('Invalid conversation secret')
  if ((secret.kind !== 'direct' && secret.kind !== 'group') || typeof secret.title !== 'string' || secret.title.length === 0 || secret.title.length > 100) throw new Error('Invalid conversation metadata')
  if (!Number.isSafeInteger(secret.currentEpoch) || secret.currentEpoch < 1) throw new Error('Invalid conversation epoch')
  if (!Array.isArray(secret.epochs) || secret.epochs.length === 0 || secret.epochs.length > 10_000) throw new Error('Conversation requires an epoch')
  const epochNumbers = new Set<number>()
  for (const epoch of secret.epochs) {
    if (!Number.isSafeInteger(epoch.epoch) || epoch.epoch < 1 || epochNumbers.has(epoch.epoch)) throw new Error('Invalid conversation epoch sequence')
    epochNumbers.add(epoch.epoch)
    if (Utils.toArray(epoch.rootKey, 'base64').length !== 32) throw new Error('Invalid conversation root key')
    if (epoch.members.length === 0 || epoch.members.length > 100 || epoch.admins.length === 0) throw new Error('Conversation requires members and administrators')
    if (new Set(epoch.members).size !== epoch.members.length || epoch.members.some((member) => !/^(02|03)[0-9a-f]{64}$/i.test(member))) throw new Error('Invalid conversation member')
    if (epoch.admins.some((admin) => !epoch.members.includes(admin))) throw new Error('Administrators must be members')
    if (epoch.closure && (!Number.isFinite(epoch.closure.closedAt)
      || !Number.isSafeInteger(epoch.closure.eventCount) || epoch.closure.eventCount < 0
      || epoch.closure.eventCount !== Object.keys(epoch.closure.eventDigests).length
      || epoch.closure.historyDigest !== epochHistoryDigest(epoch.closure.eventDigests)
      || Object.entries(epoch.closure.eventDigests).some(([id, digest]) => id.length === 0 || id.length > 128 || !/^[0-9a-f]{64}$/.test(digest)))) throw new Error('Invalid epoch closure')
  }
  if (!epochNumbers.has(secret.currentEpoch)) throw new Error('Conversation current epoch is missing')
  const current = secret.epochs.find((epoch) => epoch.epoch === secret.currentEpoch)!
  if (secret.pendingControl && (secret.pendingControl.length > 100
    || secret.pendingControl.some((delivery) => !validPendingControl(secret, current, delivery)))) throw new Error('Invalid pending control delivery')
}
