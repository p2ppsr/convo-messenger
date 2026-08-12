import { describe, expect, it } from 'vitest'
import type { ConversationEvent, ConversationSecret } from './types'
import { applyConversationEvent, materializeConversation } from './materialize'

const alice = '02' + '11'.repeat(32)
const bob = '03' + '22'.repeat(32)
const secret: ConversationSecret = {
  v: 2,
  conversationId: 'aa'.repeat(32),
  kind: 'direct',
  title: 'Initial',
  currentEpoch: 1,
  epochs: [{ epoch: 1, rootKey: 'root', members: [alice, bob], admins: [alice], activatedAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
  preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
}

const base = { v: 2 as const, conversationId: secret.conversationId, epoch: 1, sender: alice }

describe('conversation materialization', () => {
  it('deterministically applies edits, reactions, metadata, duplicates, and deletion', () => {
    const events: ConversationEvent[] = [
      { ...base, type: 'message', id: 'm1', createdAt: 1, body: 'original' },
      { ...base, type: 'edit', id: 'e1', createdAt: 2, targetId: 'm1', body: 'edited' },
      { ...base, type: 'reaction', id: 'r1', createdAt: 3, targetId: 'm1', emoji: '👍' },
      { ...base, type: 'metadata', id: 't1', createdAt: 4, title: 'Renamed' },
      { ...base, type: 'message', id: 'm2', createdAt: 5, body: 'remove me' },
      { ...base, type: 'delete', id: 'd1', createdAt: 6, targetId: 'm2' },
    ]
    const result = materializeConversation(secret, [events[3], ...events, events[0]])
    expect(result.title).toBe('Renamed')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({ id: 'm1', body: 'edited', edited: true })
    expect(result.messages[0].reactions).toEqual([{ sender: alice, emoji: '👍' }])
  })

  it('rejects edits from another sender', () => {
    const result = materializeConversation(secret, [
      { ...base, type: 'message', id: 'm1', createdAt: 1, body: 'original' },
      { ...base, sender: bob, type: 'edit', id: 'e1', createdAt: 2, targetId: 'm1', body: 'tampered' },
    ])
    expect(result.messages[0].body).toBe('original')
  })

  it('drops conflicting event IDs instead of choosing a nondeterministic winner', () => {
    const result = materializeConversation(secret, [
      { ...base, type: 'message', id: 'collision', createdAt: 1, body: 'first' },
      { ...base, sender: bob, type: 'message', id: 'collision', createdAt: 2, body: 'second' },
    ])
    expect(result.messages).toEqual([])
  })

  it('projects live events immediately and deduplicates the later durable copy', () => {
    const initial = materializeConversation(secret, [])
    const message = { ...base, type: 'message' as const, id: 'live-message', createdAt: 10, body: 'shown before chain confirmation' }
    const optimistic = applyConversationEvent(initial, secret, message)
    expect(optimistic.messages).toEqual([expect.objectContaining({ id: 'live-message', body: message.body })])
    expect(applyConversationEvent(optimistic, secret, message)).toEqual(optimistic)
  })
})
