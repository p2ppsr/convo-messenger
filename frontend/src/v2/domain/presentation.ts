import type { ConversationSecret } from './types'
import { identityName, shortIdentity, type IdentityProfileMap } from '../hooks/useIdentityProfiles'

export function currentMembers(secret: ConversationSecret): string[] {
  return secret.epochs.find((epoch) => epoch.epoch === secret.currentEpoch)?.members ?? []
}

export function directPeer(secret: ConversationSecret, identityKey: string): string | undefined {
  return secret.kind === 'direct' ? currentMembers(secret).find((member) => member !== identityKey) : undefined
}

export function conversationName(secret: ConversationSecret, identityKey: string, profiles: IdentityProfileMap): string {
  const peer = directPeer(secret, identityKey)
  if (!peer) return secret.title
  return profiles[peer]?.name || shortIdentity(peer)
}

export function conversationSearchText(secret: ConversationSecret, identityKey: string, profiles: IdentityProfileMap): string {
  const members = currentMembers(secret)
  return [secret.title, conversationName(secret, identityKey, profiles), ...members.map((member) => identityName(profiles, member, shortIdentity(member)))]
    .join(' ')
    .toLocaleLowerCase()
}
