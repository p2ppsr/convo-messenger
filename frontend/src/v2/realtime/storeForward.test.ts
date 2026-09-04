import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageBoxClient } from '@bsv/message-box-client'
import { encryptJson, generateRootKey, liveBoxName, randomId } from '../domain/crypto'
import type { ConversationSecret, MessageEvent } from '../domain/types'
import { ConversationTransport, listControlMessages, listWorkspaceRoomUpdates, MESSAGE_BATCH_SIZE } from './messaging'
const alice = `02${'11'.repeat(32)}`
const bob = `03${'22'.repeat(32)}`
const secret: ConversationSecret = { v: 2, conversationId: randomId(), kind: 'direct', title: 'Pair', currentEpoch: 1,
  epochs: [{ epoch: 1, rootKey: generateRootKey(), members: [alice, bob], admins: [alice], activatedAt: 1 }],
  createdAt: 1, updatedAt: 1, preferences: { favorite: false, archived: false, muted: false, lastReadAt: 0 } }
function message(index = 0, kind: 'event' | 'presence' = 'event', epoch = secret.epochs[0]) {
  const event: MessageEvent = { v: 2, type: 'message', id: randomId(), conversationId: secret.conversationId,
    epoch: epoch.epoch, sender: alice, createdAt: Date.now(), body: `Message ${index}` }
  const envelopeId = randomId()
  return { messageId: `transport-${index}`, sender: alice, body: { type: 'convo-v2-live', v: 2, envelopeId,
    ciphertext: encryptJson(epoch.rootKey, `live:${envelopeId}`, { conversationId: secret.conversationId,
      epoch: epoch.epoch, kind, event: kind === 'event' ? event : undefined, presence: 'ping', sentAt: Date.now() }) } }
}
class Box {
  rows: ReturnType<typeof message>[] = []
  listener?: (row: ReturnType<typeof message>) => void
  listMessages = vi.fn(async (request: { limit?: number }) => this.rows.slice(0, request.limit))
  acknowledgeMessage = vi.fn(async ({ messageIds }: { messageIds: string[] }) => {
    this.rows = this.rows.filter((row) => !messageIds.includes(row.messageId))
  })
  async listenForLiveMessages({ onMessage }: { onMessage: Box['listener'] }) { this.listener = onMessage }
  sendLiveMessage = vi.fn(async () => undefined)
  async disconnectWebSocket() {}
  async leaveRoom() {}
}
const running: ConversationTransport[] = []
function transport(box: Box, onEvent: () => Promise<void> = vi.fn(async () => undefined)) {
  const result = new ConversationTransport({ clientFactory: () => box as unknown as MessageBoxClient, identityKey: bob,
    conversationId: secret.conversationId, epoch: secret.epochs[0], onEvent, onSyncRequested: async () => undefined, onState: () => undefined })
  running.push(result)
  return result
}
afterEach(async () => { for (const item of running.splice(0)) await item.stop(); vi.restoreAllMocks() })
describe('store and forward queue lifecycle', () => {
  it('drains more than one page with batched acknowledgments and bounded SDK reads', async () => {
    const box = new Box()
    box.rows = Array.from({ length: 205 }, (_, i) => message(i))
    const received = vi.fn(async () => undefined)
    await transport(box, received).start()
    expect(received).toHaveBeenCalledTimes(205)
    expect(box.rows).toHaveLength(0)
    expect(box.acknowledgeMessage.mock.calls.map(([request]) => request.messageIds.length)).toEqual([100, 100, 5])
    expect(box.listMessages.mock.calls.every(([request]) => request.limit === MESSAGE_BATCH_SIZE)).toBe(true)
  })
  it('retries a failed acknowledgment without reapplying the received event', async () => {
    const box = new Box()
    box.rows = [message()]
    box.acknowledgeMessage.mockRejectedValueOnce(new Error('Temporary outage'))
    const received = vi.fn(async () => undefined)
    const connection = transport(box, received)
    await connection.start()
    expect(box.rows).toHaveLength(1)
    await connection.drain()
    expect(box.rows).toHaveLength(0)
    expect(received).toHaveBeenCalledTimes(1)
  })
  it('does not acknowledge or deduplicate an event until durable receipt succeeds', async () => {
    const box = new Box()
    box.rows = [message()]
    const received = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('Disk full'))
    const connection = transport(box, received)
    await connection.start()
    expect(box.rows).toHaveLength(1)
    expect(box.acknowledgeMessage).not.toHaveBeenCalled()
    await connection.drain()
    expect(received).toHaveBeenCalledTimes(2)
    expect(box.rows).toHaveLength(0)
  })
  it('serializes simultaneous socket and polling receipt of the same message', async () => {
    const box = new Box()
    const received = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    const connection = transport(box, received)
    await connection.start()
    box.rows = [message()]
    box.listener?.(box.rows[0])
    await Promise.all([connection.drain(), connection.drain()])
    expect(received).toHaveBeenCalledTimes(1)
    expect(box.rows).toHaveLength(0)
  })
  it('drains unopened direct chats and old epoch boxes only after durable handoff', async () => {
    const oldEpoch = { ...secret.epochs[0], epoch: 2, rootKey: generateRootKey() }
    const rotated = { ...secret, epochs: [...secret.epochs, oldEpoch], currentEpoch: 2 }
    const boxes = new Map([[liveBoxName(secret.epochs[0].rootKey, bob), [message(1)]], [liveBoxName(oldEpoch.rootKey, bob), [message(2, 'event', oldEpoch), message(3, 'presence', oldEpoch)]]])
    const client = {
      listMessages: vi.fn(async ({ messageBox }: { messageBox: string }) => boxes.get(messageBox) ?? []),
      acknowledgeMessage: vi.fn(async ({ messageIds }: { messageIds: string[] }) => {
        for (const [key, rows] of boxes) boxes.set(key, rows.filter((row) => !messageIds.includes(row.messageId)))
      }),
    }
    const receive = vi.fn(async () => undefined)
    await listWorkspaceRoomUpdates(client as unknown as MessageBoxClient, bob, [rotated], undefined, receive)
    expect(receive).toHaveBeenCalledTimes(2)
    expect([...boxes.values()].flat()).toHaveLength(0)
    expect(client.acknowledgeMessage).toHaveBeenCalledTimes(2)
  })
  it('retains failed background events but removes expired activity and invalid envelopes', async () => {
    const box = new Box()
    box.rows = [message(1), message(2, 'presence'), { ...message(3), body: { type: 'invalid' } } as never]
    await expect(listWorkspaceRoomUpdates(box as unknown as MessageBoxClient, bob, [secret], undefined, async () => { throw new Error('Disk full') })).rejects.toThrow('queued for retry')
    expect(box.rows.map((row) => row.messageId)).toEqual(['transport-1'])
  })
  it('does not send typing traffic to offline members', async () => {
    const box = new Box()
    const connection = transport(box)
    await connection.start()
    box.sendLiveMessage.mockClear()
    connection.publishTyping(true)
    await Promise.resolve()
    expect(box.sendLiveMessage).not.toHaveBeenCalled()
  })
  it('persists invitation decisions locally before acknowledgment and retains wallet decryption failures', async () => {
    const invite = { v: 2, type: 'convo-v2-invite', conversationId: secret.conversationId, title: 'Pair', kind: 'direct',
      epoch: 1, envelope: 'encrypted', members: [alice, bob], admins: [alice], createdAt: Date.now() }
    const order: string[] = []
    const client = { listMessages: async () => [{ messageId: 'invite', sender: alice, body: invite }, { messageId: 'locked', sender: alice, body: '[Error: Failed to decrypt or parse message]' }],
      acknowledgeMessage: vi.fn(async () => { order.push('acknowledged') }) }
    const persist = vi.fn(async () => { order.push('persisted') })
    await listControlMessages(client as unknown as MessageBoxClient, persist)
    expect(order).toEqual(['persisted', 'acknowledged'])
    expect(client.acknowledgeMessage).toHaveBeenCalledWith(expect.objectContaining({ messageIds: ['invite'] }))
    client.acknowledgeMessage.mockClear()
    await expect(listControlMessages(client as unknown as MessageBoxClient, async () => { throw new Error('Wallet locked') })).rejects.toThrow()
    expect(client.acknowledgeMessage).not.toHaveBeenCalled()
  })
})
