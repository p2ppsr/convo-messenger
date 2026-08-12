import { describe, expect, it } from 'vitest'
import type { ConversationEvent, ConversationSecret } from '../domain/types'
import { epochHistoryDigest, eventDigest, generateRootKey, manifestLocator, pageLocator } from '../domain/crypto'
import { GlobalConversationStore, type ConversationOverlay, type OverlayEntry } from './globalConversationStore'

class SharedOverlayState {
  entries = new Map<string, OverlayEntry>()
  publicWrites: Array<{ controller: string; key: string; value: string }> = []
}

class MemoryOverlay implements ConversationOverlay {
  constructor(private state: SharedOverlayState, private controller: string) {}
  async get(query: { key: string; controller: string }) { return this.state.entries.get(`${query.controller}:${query.key}`) }
  async set(key: string, value: string) {
    const token = { txid: `${this.state.publicWrites.length}`.padStart(64, '0'), outputIndex: 0 }
    this.state.entries.set(`${this.controller}:${key}`, { value, token })
    this.state.publicWrites.push({ controller: this.controller, key, value })
    return `${token.txid}.${token.outputIndex}`
  }
}

const alice = '02' + '11'.repeat(32)
const bob = '03' + '22'.repeat(32)
const carol = '02' + '33'.repeat(32)

function baseSecret(rootKey: string): ConversationSecret {
  return {
    v: 2, conversationId: 'aa'.repeat(32), kind: 'group', title: 'Invisible members', currentEpoch: 1,
    epochs: [{ epoch: 1, rootKey, members: [alice, bob], admins: [alice], activatedAt: 1 }],
    createdAt: 1, updatedAt: 1, preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
  }
}

function message(secret: ConversationSecret, sender: string, id: string, body: string, epoch = secret.currentEpoch): ConversationEvent {
  return { v: 2, type: 'message', id, conversationId: secret.conversationId, epoch, sender, createdAt: Number(id.replace(/\D/g, '')) || 1, body }
}

describe('GlobalKVStore private page model', () => {
  it('publishes only secret-derived locators and padded ciphertext', async () => {
    const state = new SharedOverlayState()
    const secret = baseSecret(generateRootKey())
    const store = new GlobalConversationStore(new MemoryOverlay(state, alice))
    await store.append(secret, alice, message(secret, alice, 'event-1', 'private payload'))

    const publicRepresentation = JSON.stringify(state.publicWrites)
    expect(publicRepresentation).not.toContain(secret.title)
    expect(publicRepresentation).not.toContain('private payload')
    expect(publicRepresentation).not.toContain(bob)
    expect(state.publicWrites.map((item) => item.key)).toEqual(expect.arrayContaining([
      pageLocator(secret.epochs[0].rootKey, alice, 0),
      manifestLocator(secret.epochs[0].rootKey, alice),
    ]))
    expect((await store.read(secret)).events).toHaveLength(1)
  })

  it('combines member-owned pages while keeping their locators unlinkable without the root key', async () => {
    const state = new SharedOverlayState()
    const secret = baseSecret(generateRootKey())
    const aliceStore = new GlobalConversationStore(new MemoryOverlay(state, alice))
    const bobStore = new GlobalConversationStore(new MemoryOverlay(state, bob))
    await aliceStore.append(secret, alice, message(secret, alice, 'event-1', 'from alice'))
    await bobStore.append(secret, bob, message(secret, bob, 'event-2', 'from bob'))
    const result = await aliceStore.read(secret)
    expect(result.events.map((event) => event.sender)).toEqual(expect.arrayContaining([alice, bob]))
    expect(pageLocator(secret.epochs[0].rootKey, alice, 0)).not.toBe(pageLocator(secret.epochs[0].rootKey, bob, 0))
  })

  it('prevents a removed member from locating or decrypting a new epoch', async () => {
    const state = new SharedOverlayState()
    const first = baseSecret(generateRootKey())
    const aliceStore = new GlobalConversationStore(new MemoryOverlay(state, alice))
    await aliceStore.append(first, alice, message(first, alice, 'event-1', 'old epoch'))

    const firstEvent = message(first, alice, 'event-1', 'old epoch')
    const eventDigests = { [firstEvent.id]: eventDigest(firstEvent) }
    const rotated: ConversationSecret = {
      ...first,
      currentEpoch: 2,
      epochs: [
        { ...first.epochs[0], closure: { closedAt: 2, eventDigests, eventCount: 1, historyDigest: epochHistoryDigest(eventDigests) } },
        { epoch: 2, rootKey: generateRootKey(), members: [alice, carol], admins: [alice], activatedAt: 2 },
      ],
    }
    await aliceStore.append(rotated, alice, message(rotated, alice, 'event-2', 'new epoch', 2))
    await aliceStore.append(first, alice, message(first, alice, 'event-3', 'injected after rotation'))

    const removedMembersCopy = await new GlobalConversationStore(new MemoryOverlay(state, bob)).read(first, { tailPages: 10 })
    const currentMembersCopy = await aliceStore.read(rotated, { tailPages: 10 })
    // A removed wallet can still mutate its own obsolete local view because it knows epoch one.
    expect(removedMembersCopy.events.map((event) => event.id)).toEqual(['event-1', 'event-3'])
    expect(currentMembersCopy.events.map((event) => event.id)).toEqual(expect.arrayContaining(['event-1', 'event-2']))
    expect(currentMembersCopy.events.map((event) => event.id)).not.toContain('event-3')
    expect(pageLocator(first.epochs[0].rootKey, alice, 0)).not.toBe(pageLocator(rotated.epochs[1].rootKey, alice, 0))
  })
})
