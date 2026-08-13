import { describe, expect, it } from 'vitest'
import type { ConversationSecret } from '../domain/types'
import { generateRootKey } from '../domain/crypto'
import { ConversationSecretRepository, type PrivateKeyValueStore } from './privateConversationStore'

class MemoryPrivateStore implements PrivateKeyValueStore {
  values = new Map<string, string>()
  operations: string[] = []
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: string) { this.operations.push(`set:${key}`); this.values.set(key, value) }
  async remove(key: string) { this.operations.push(`remove:${key}`); this.values.delete(key) }
}

function secret(id: string, updatedAt: number, favorite = false): ConversationSecret {
  const alice = '02' + '11'.repeat(32)
  return {
    v: 2, conversationId: id.repeat(64).slice(0, 64), kind: 'group', title: id, currentEpoch: 1,
    epochs: [{ epoch: 1, rootKey: generateRootKey(), members: [alice], admins: [alice], activatedAt: 1 }],
    createdAt: 1, updatedAt, preferences: { archived: false, favorite, muted: false, lastReadAt: 0 },
  }
}

describe('wallet-private conversation index', () => {
  it('persists secret material before making it discoverable', async () => {
    const store = new MemoryPrivateStore()
    const repository = new ConversationSecretRepository(store)
    await repository.save(secret('a', 1))
    expect(store.operations).toEqual(['set:conversation:' + 'a'.repeat(64), 'set:conversation-index'])
  })

  it('sorts favorites first and tolerates corrupt index entries', async () => {
    const store = new MemoryPrivateStore()
    const repository = new ConversationSecretRepository(store)
    await repository.save(secret('a', 20))
    await repository.save(secret('b', 10, true))
    store.values.set('conversation-index', JSON.stringify(['broken', 'a'.repeat(64), 'b'.repeat(64)]))
    const listed = await repository.list()
    expect(listed.map((item) => item.title)).toEqual(['b', 'a'])
  })

  it('rejects malformed wallet-private preferences', async () => {
    const store = new MemoryPrivateStore()
    const repository = new ConversationSecretRepository(store)
    const malformed = { ...secret('a', 1), preferences: { archived: 'yes', favorite: false, muted: false, lastReadAt: 0 } }
    store.values.set('conversation:' + 'a'.repeat(64), JSON.stringify(malformed))
    expect(await repository.get('a'.repeat(64))).toBeNull()
  })
})
