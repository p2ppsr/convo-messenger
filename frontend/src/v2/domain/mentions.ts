import { identityName, type IdentityProfileMap } from '../hooks/useIdentityProfiles'

const IDENTITY_KEY_SOURCE = '(?:02|03)[0-9a-f]{64}'
export const MENTION_PATTERN = new RegExp(`@<(${IDENTITY_KEY_SOURCE})>`, 'gi')

export interface MentionDraft {
  start: number
  end: number
  query: string
}

export function activeMentionDraft(value: string, cursor: number): MentionDraft | null {
  const before = value.slice(0, cursor)
  const match = /(?:^|\s)@<([^>\n]{0,100})$/.exec(before)
  if (!match) return null
  const markerOffset = match[0].lastIndexOf('@<')
  return { start: match.index + markerOffset, end: cursor, query: match[1].trim().toLocaleLowerCase() }
}

export function insertMention(value: string, draft: MentionDraft, identityKey: string): { value: string; cursor: number } {
  const token = `@<${identityKey}> `
  const next = `${value.slice(0, draft.start)}${token}${value.slice(draft.end)}`
  return { value: next, cursor: draft.start + token.length }
}

export function mentionedIdentities(body: string): string[] {
  return [...body.matchAll(new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags))].map((match) => match[1])
}

export function displayMessageText(body: string, profiles: IdentityProfileMap): string {
  return body.replace(new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags), (_token, identityKey: string) => `@${identityName(profiles, identityKey)}`)
}
