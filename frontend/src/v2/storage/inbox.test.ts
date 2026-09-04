import { beforeEach, describe, expect, it } from 'vitest'
import { EncryptedInbox } from './inbox'
import { eventDigest, generateRootKey, randomId } from '../domain/crypto'
import type { ConversationSecret, MessageEvent } from '../domain/types'
const alice = `02${'11'.repeat(32)}`
const bob = `03${'22'.repeat(32)}`
const secret: ConversationSecret = { v: 2, conversationId: randomId(), kind: 'direct', title: 'Private team', currentEpoch: 1,
  epochs: [{ epoch: 1, rootKey: generateRootKey(), members: [alice, bob], admins: [alice], activatedAt: 1 }],
  createdAt: 1, updatedAt: 1, preferences: { favorite: false, archived: false, muted: false, lastReadAt: 0 } }
const event = (): MessageEvent => ({ v: 2, type: 'message', id: randomId(), conversationId: secret.conversationId,
  epoch: 1, sender: alice, createdAt: Date.now(), body: 'Confidential message body' })
beforeEach(() => localStorage.clear())
describe('encrypted recipient handoff', () => {
  it('survives restart without plaintext content, identifiers, or roster in browser storage', async () => {
    const message = event()
    await new EncryptedInbox(bob).receive(secret, message)
    const raw = JSON.stringify(localStorage)
    for (const value of [message.body, secret.conversationId, alice, bob, secret.title]) expect(raw).not.toContain(value)
    const reopened = new EncryptedInbox(bob)
    expect(reopened.events(secret)).toEqual([message])
    expect(reopened.activity(secret).unread).toBe(1)
    await reopened.receive(secret, message)
    expect(reopened.activity(secret).unread).toBe(1)
  })
  it('only prunes exactly confirmed events, retaining unread state and pending edits', async () => {
    const inbox = new EncryptedInbox(bob)
    const message = event()
    await inbox.receive(secret, message)
    await inbox.reconcile(secret, [{ ...message, body: 'conflicting content' }])
    expect(inbox.events(secret)).toHaveLength(1)
    await inbox.reconcile(secret, [message])
    expect(inbox.events(secret)).toHaveLength(0)
    expect(inbox.activity(secret).unread).toBe(1)
    await inbox.markRead(secret, message.createdAt)
    await inbox.receive(secret, message)
    expect(inbox.activity(secret).unread).toBe(0)
  })
  it('propagates storage quota failures so the transport cannot acknowledge', async () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('Quota exceeded') } } as unknown as Storage
    await expect(new EncryptedInbox(bob, storage).receive(secret, event())).rejects.toThrow('Quota exceeded')
  })
  it('honors closed epoch commitments and rejects conflicting event IDs', async () => {
    const inbox = new EncryptedInbox(bob)
    const message = event()
    await inbox.receive(secret, message)
    await expect(inbox.receive(secret, { ...message, body: 'altered' })).rejects.toThrow('Conflicting')
    const closed = { ...secret, epochs: [{ ...secret.epochs[0], closure: { closedAt: Date.now(), eventCount: 1, historyDigest: '', eventDigests: { [message.id]: eventDigest(message) } } }] }
    await inbox.receive(closed, event())
    expect(inbox.events(closed)).toEqual([message])
  })
})
