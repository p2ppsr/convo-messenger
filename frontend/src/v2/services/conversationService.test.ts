import { CompletedProtoWallet, PrivateKey, type WalletInterface } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { generateRootKey, randomId } from '../domain/crypto'
import type { ConversationEvent, ConversationInvite, ConversationSecret, OutboxItem } from '../domain/types'
import type { ConversationOverlay, OverlayEntry } from '../storage/globalConversationStore'
import { GlobalConversationStore } from '../storage/globalConversationStore'
import { EncryptedOutbox, type OutboxBackingStore } from '../storage/outbox'
import { ConversationSecretRepository, type PrivateKeyValueStore } from '../storage/privateConversationStore'
import { messageBoxFor } from '../realtime/messaging'
import { ConversationService } from './conversationService'

class MemoryPrivateStore implements PrivateKeyValueStore {
  values = new Map<string, string>()
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: string) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
}

const unusedOverlay: ConversationOverlay = {
  async get() { return undefined },
  async set() { throw new Error('Unexpected overlay write') },
}

class SharedOverlayState {
  entries = new Map<string, OverlayEntry>()
  writes = 0
}

class MemoryOverlay implements ConversationOverlay {
  constructor(private readonly state: SharedOverlayState, private readonly controller: string) {}
  async get(query: { key: string; controller: string }) { return this.state.entries.get(`${query.controller}:${query.key}`) }
  async set(key: string, value: string) {
    const token = { txid: `${this.state.writes++}`.padStart(64, '0'), outputIndex: 0 }
    this.state.entries.set(`${this.controller}:${key}`, { value, token })
    return `${token.txid}.0`
  }
}

class MemoryOutbox implements OutboxBackingStore {
  items: OutboxItem[] = []
  load() { return this.items }
  save(_identityKey: string, items: OutboxItem[]) { this.items = items }
}

describe('conversation control delivery', () => {
  it('keeps wallet review details private while preserving the failed encrypted outbox item', async () => {
    const alice = '02' + '31'.repeat(32)
    const bob = '03' + '42'.repeat(32)
    const secret: ConversationSecret = {
      v: 2, conversationId: 'ef'.repeat(32), kind: 'direct', title: 'Retry', currentEpoch: 1,
      epochs: [{ epoch: 1, rootKey: generateRootKey(), members: [alice, bob], admins: [alice], activatedAt: 1 }],
      createdAt: 1, updatedAt: 1, preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
    }
    const repository = new ConversationSecretRepository(new MemoryPrivateStore())
    await repository.save(secret)
    const backing = new MemoryOutbox()
    const outbox = new EncryptedOutbox(alice, backing)
    outbox.enqueue(secret, {
      v: 2, type: 'message', id: randomId(), conversationId: secret.conversationId,
      epoch: 1, sender: alice, createdAt: Date.now(), body: 'never expose me in an error',
    })
    const walletReview = Object.assign(new Error('internal wallet transaction detail'), {
      name: 'WERR_REVIEW_ACTIONS',
      reviewActionResults: [{ status: 'pending', competingTxs: ['secret transaction'] }],
    })
    const service = new ConversationService({} as WalletInterface, alice, {
      secrets: repository,
      store: { async append() { throw walletReview } } as never,
      outbox,
      messageBox: {} as ReturnType<typeof messageBoxFor>,
    })

    await expect(service.flushOutbox()).rejects.toThrow('A saved message is awaiting wallet review')
    expect(backing.items).toHaveLength(1)
    expect(backing.items[0]).toMatchObject({ state: 'failed', attempts: 1, lastError: 'WERR_REVIEW_ACTIONS (pending)' })
    expect(JSON.stringify(backing.items[0])).not.toContain('secret transaction')
    expect(JSON.stringify(backing.items[0])).not.toContain('internal wallet transaction detail')
  })

  it('serializes burst outbox writes so wallet actions never overlap', async () => {
    const alice = '02' + '31'.repeat(32)
    const bob = '03' + '42'.repeat(32)
    const secret: ConversationSecret = {
      v: 2, conversationId: 'cd'.repeat(32), kind: 'direct', title: 'Burst', currentEpoch: 1,
      epochs: [{ epoch: 1, rootKey: generateRootKey(), members: [alice, bob], admins: [alice], activatedAt: 1 }],
      createdAt: 1, updatedAt: 1, preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
    }
    const repository = new ConversationSecretRepository(new MemoryPrivateStore())
    await repository.save(secret)
    const backing = new MemoryOutbox()
    const outbox = new EncryptedOutbox(alice, backing)
    for (const body of ['one', 'two']) {
      outbox.enqueue(secret, {
        v: 2, type: 'message', id: randomId(), conversationId: secret.conversationId,
        epoch: 1, sender: alice, createdAt: Date.now(), body,
      })
    }
    let inFlight = 0
    let maxInFlight = 0
    let writes = 0
    const store = {
      async append() {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        writes += 1
        inFlight -= 1
      },
    }
    const service = new ConversationService({} as WalletInterface, alice, {
      secrets: repository,
      store: store as never,
      outbox,
      messageBox: {} as ReturnType<typeof messageBoxFor>,
    })

    await Promise.all([service.flushOutbox(), service.flushOutbox(), service.flushOutbox()])
    expect(writes).toBe(2)
    expect(maxInFlight).toBe(1)
    expect(backing.items.every((item) => item.state === 'confirmed')).toBe(true)
  })

  it('persists the exact private envelope and retries it after MessageBox failure', async () => {
    const alice = '02' + '11'.repeat(32)
    const bob = '03' + '22'.repeat(32)
    const invite: ConversationInvite = {
      type: 'convo-v2-invite', v: 2, conversationId: 'aa'.repeat(32), title: 'Private group', kind: 'direct',
      epoch: 1, envelope: 'sealed-once', members: [alice, bob], admins: [alice], createdAt: 1,
    }
    const deliveryId = randomId()
    const secret: ConversationSecret = {
      v: 2, conversationId: invite.conversationId, kind: invite.kind, title: invite.title, currentEpoch: 1,
      epochs: [{ epoch: 1, rootKey: generateRootKey(), members: invite.members, admins: invite.admins, activatedAt: 1 }],
      createdAt: 1, updatedAt: 1, preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
      pendingControl: [{ id: deliveryId, recipient: bob, body: invite }],
    }
    const repository = new ConversationSecretRepository(new MemoryPrivateStore())
    await repository.save(secret)
    const attempts: unknown[] = []
    const messageBox = {
      async sendMessage(request: { body: unknown }) {
        attempts.push(request.body)
        if (attempts.length === 1) throw new Error('offline')
      },
    } as unknown as ReturnType<typeof messageBoxFor>
    const service = new ConversationService({} as WalletInterface, alice, {
      secrets: repository,
      store: new GlobalConversationStore(unusedOverlay),
      messageBox,
    })

    await service.flushControlOutbox()
    expect((await repository.get(secret.conversationId))?.pendingControl).toHaveLength(1)

    await service.flushControlOutbox()
    expect((await repository.get(secret.conversationId))?.pendingControl).toEqual([])
    expect(attempts).toEqual([invite, invite])
  })

  it('rotates a group with a constant-size commitment that another member independently verifies', async () => {
    const wallets = [0, 1, 2].map(() => new CompletedProtoWallet(PrivateKey.fromRandom()))
    const identities = await Promise.all(wallets.map(async (wallet) => (await wallet.getPublicKey({ identityKey: true })).publicKey))
    const [alice, bob, carol] = identities
    const activatedAt = Date.now() - 1_000
    const initial: ConversationSecret = {
      v: 2, conversationId: 'bb'.repeat(32), kind: 'direct', title: 'Private pair', currentEpoch: 1,
      epochs: [{ epoch: 1, rootKey: generateRootKey(), members: [alice, bob], admins: [alice], activatedAt }],
      createdAt: activatedAt, updatedAt: activatedAt,
      preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
    }
    const events: ConversationEvent[] = [
      { v: 2, type: 'message', id: 'message-one', conversationId: initial.conversationId, epoch: 1, sender: alice, createdAt: activatedAt + 100, body: 'one' },
      { v: 2, type: 'message', id: 'message-two', conversationId: initial.conversationId, epoch: 1, sender: alice, createdAt: activatedAt + 200, body: 'two' },
    ]
    const overlayState = new SharedOverlayState()
    const aliceStore = new GlobalConversationStore(new MemoryOverlay(overlayState, alice))
    for (const event of events) await aliceStore.append(initial, alice, event)
    const aliceRepository = new ConversationSecretRepository(new MemoryPrivateStore())
    await aliceRepository.save(initial)
    const controlBodies: unknown[] = []
    const aliceBox = {
      async sendMessage(request: { body: { type?: string } }) {
        if (request.body.type === 'convo-v2-invite' || request.body.type === 'convo-v2-membership') {
          controlBodies.push(request.body)
          throw new Error('hold control delivery for inspection')
        }
      },
    } as unknown as ReturnType<typeof messageBoxFor>
    const aliceService = new ConversationService(wallets[0] as unknown as WalletInterface, alice, {
      secrets: aliceRepository,
      store: aliceStore,
      outbox: new EncryptedOutbox(alice, new MemoryOutbox()),
      messageBox: aliceBox,
    })

    const rotated = await aliceService.changeMembership(initial, [alice, bob, carol], [alice])
    const delivery = rotated.pendingControl?.find((item) => item.recipient === bob)
    expect(delivery?.body.type).toBe('convo-v2-membership')
    if (!delivery || delivery.body.type !== 'convo-v2-membership') throw new Error('Expected Bob membership delivery')
    expect(delivery.body.previousEpochCommitment.eventCount).toBe(2)
    expect(JSON.stringify(delivery.body)).not.toContain('eventDigests')
    expect(controlBodies).toHaveLength(2)

    const bobRepository = new ConversationSecretRepository(new MemoryPrivateStore())
    await bobRepository.save(initial)
    const bobBox = { async acknowledgeMessage() {} } as unknown as ReturnType<typeof messageBoxFor>
    const bobService = new ConversationService(wallets[1] as unknown as WalletInterface, bob, {
      secrets: bobRepository,
      store: new GlobalConversationStore(new MemoryOverlay(overlayState, bob)),
      outbox: new EncryptedOutbox(bob, new MemoryOutbox()),
      messageBox: bobBox,
    })
    const accepted = await bobService.acceptMembershipUpdate({
      messageId: 'update', sender: alice, update: delivery.body,
    })
    expect(accepted.currentEpoch).toBe(2)
    expect(accepted.kind).toBe('group')
    expect(accepted.epochs[0].closure).toMatchObject({ eventCount: 2, historyDigest: delivery.body.previousEpochCommitment.historyDigest })
    expect(Object.keys(accepted.epochs[0].closure?.eventDigests ?? {})).toHaveLength(2)
  })
})
