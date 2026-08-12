import { decryptJson, encryptJson } from '../domain/crypto'
import type { ConversationEvent, ConversationSecret, OutboxItem } from '../domain/types'

export interface OutboxBackingStore {
  load(identityKey: string): OutboxItem[]
  save(identityKey: string, items: OutboxItem[]): void
}

class BrowserOutboxStore implements OutboxBackingStore {
  private key(identityKey: string): string {
    return `convo:v2:outbox:${identityKey}`
  }

  load(identityKey: string): OutboxItem[] {
    try {
      const raw = localStorage.getItem(this.key(identityKey))
      const parsed = raw ? JSON.parse(raw) as unknown : []
      return Array.isArray(parsed) ? parsed.filter(isOutboxItem) : []
    } catch {
      return []
    }
  }

  save(identityKey: string, items: OutboxItem[]): void {
    localStorage.setItem(this.key(identityKey), JSON.stringify(items))
  }
}

function isOutboxItem(value: unknown): value is OutboxItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<OutboxItem>
  return typeof item.id === 'string'
    && typeof item.conversationId === 'string'
    && typeof item.encryptedEvent === 'string'
    && typeof item.epoch === 'number'
    && typeof item.state === 'string'
}

export class EncryptedOutbox {
  constructor(
    private readonly identityKey: string,
    private readonly backing: OutboxBackingStore = new BrowserOutboxStore(),
  ) {}

  list(): OutboxItem[] {
    return this.backing.load(this.identityKey)
  }

  enqueue(secret: ConversationSecret, event: ConversationEvent): OutboxItem {
    const epoch = secret.epochs.find((candidate) => candidate.epoch === event.epoch)
    if (!epoch) throw new Error('Cannot queue an event without its epoch secret')
    const item: OutboxItem = {
      id: event.id,
      conversationId: secret.conversationId,
      epoch: event.epoch,
      encryptedEvent: encryptJson(epoch.rootKey, `outbox:${event.id}`, event, 512),
      state: 'queued',
      attempts: 0,
      updatedAt: Date.now(),
    }
    const items = this.list().filter((candidate) => candidate.id !== item.id)
    this.backing.save(this.identityKey, [...items, item])
    return item
  }

  decrypt(secret: ConversationSecret, item: OutboxItem): ConversationEvent {
    const epoch = secret.epochs.find((candidate) => candidate.epoch === item.epoch)
    if (!epoch) throw new Error('Outbox epoch is no longer available')
    return decryptJson<ConversationEvent>(epoch.rootKey, `outbox:${item.id}`, item.encryptedEvent)
  }

  update(id: string, patch: Partial<Pick<OutboxItem, 'state' | 'attempts' | 'lastError'>>): void {
    const items = this.list().map((item) => item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item)
    this.backing.save(this.identityKey, items)
  }

  remove(id: string): void {
    this.backing.save(this.identityKey, this.list().filter((item) => item.id !== id))
  }
}
