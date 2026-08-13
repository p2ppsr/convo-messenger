import { describe, expect, it } from 'vitest'
import { activeMentionDraft, displayMessageText, insertMention, mentionedIdentities } from './mentions'

const alice = `02${'11'.repeat(32)}`

describe('encrypted mention tokens', () => {
  it('detects a draft and inserts a canonical identity-key token', () => {
    const draft = activeMentionDraft('hello @<ali', 11)
    expect(draft).toEqual({ start: 6, end: 11, query: 'ali' })
    expect(insertMention('hello @<ali', draft!, alice)).toEqual({ value: `hello @<${alice}> `, cursor: 76 })
  })

  it('resolves canonical tokens for display while preserving the authenticated key', () => {
    const body = `hello @<${alice}>`
    expect(mentionedIdentities(body)).toEqual([alice])
    expect(displayMessageText(body, { [alice]: { identityKey: alice, name: 'Alice Admin' } })).toBe('hello @Alice Admin')
  })

  it('does not treat ordinary at-sign text as a mention', () => {
    expect(activeMentionDraft('email@example.com', 17)).toBeNull()
    expect(mentionedIdentities('@<not-a-key>')).toEqual([])
  })
})
