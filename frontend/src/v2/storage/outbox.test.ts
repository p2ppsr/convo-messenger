import { describe, expect, it } from 'vitest'
import type { ConversationSecret, MessageEvent, OutboxItem } from '../domain/types'
import { generateRootKey } from '../domain/crypto'
import { EncryptedOutbox, type OutboxBackingStore } from './outbox'

class MemoryBacking implements OutboxBackingStore {
  values: OutboxItem[] = []
  load() { return this.values }
  save(_identityKey: string, items: OutboxItem[]) { this.values = items }
}

describe('encrypted durable outbox', () => {
  it('stores no message plaintext and survives a new outbox instance', () => {
    const identity = '02' + '11'.repeat(32)
    const secret: ConversationSecret = {
      v: 2, conversationId: 'aa'.repeat(32), kind: 'direct', title: 'Private', currentEpoch: 1,
      epochs: [{ epoch: 1, rootKey: generateRootKey(), members: [identity], admins: [identity], activatedAt: 1 }],
      createdAt: 1, updatedAt: 1, preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
    }
    const event: MessageEvent = { v: 2, type: 'message', id: 'event', conversationId: secret.conversationId, epoch: 1, sender: identity, createdAt: 1, body: 'never store me in plaintext' }
    const backing = new MemoryBacking()
    new EncryptedOutbox(identity, backing).enqueue(secret, event)
    expect(JSON.stringify(backing.values)).not.toContain(event.body)
    expect(new EncryptedOutbox(identity, backing).decrypt(secret, backing.values[0])).toEqual(event)
  })
})
