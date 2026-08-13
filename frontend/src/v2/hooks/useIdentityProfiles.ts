import { useEffect, useMemo, useState } from 'react'
import { IdentityClient, type WalletInterface } from '@bsv/sdk'

export interface IdentityProfile {
  identityKey: string
  name: string
  badgeLabel?: string
}

export type IdentityProfileMap = Record<string, IdentityProfile>

const caches = new WeakMap<object, Map<string, Promise<IdentityProfile | null>>>()

function safeName(value: unknown, identityKey: string, abbreviatedKey?: string): string | null {
  if (typeof value !== 'string') return null
  const name = [...value].filter((character) => {
    const code = character.charCodeAt(0)
    return code > 31 && code !== 127
  }).join('').trim().slice(0, 100)
  if (!name || name === identityKey || name === abbreviatedKey) return null
  return name
}

function resolveCached(wallet: WalletInterface, identityKey: string): Promise<IdentityProfile | null> {
  let cache = caches.get(wallet as object)
  if (!cache) {
    cache = new Map()
    caches.set(wallet as object, cache)
  }
  const existing = cache.get(identityKey)
  if (existing) return existing
  const request = new IdentityClient(wallet).resolveByIdentityKey(
    { identityKey, limit: 5 },
    { useContacts: false },
  ).then((identities) => {
    const identity = identities.find((candidate) => candidate.identityKey === identityKey)
    const name = safeName(identity?.name, identityKey, identity?.abbreviatedKey)
    return identity && name ? {
      identityKey,
      name,
      badgeLabel: safeName(identity.badgeLabel, identityKey) ?? undefined,
    } : null
  }).catch(() => null)
  cache.set(identityKey, request)
  return request
}

/** Resolve public identity certificates in small batches and cache for the wallet session. */
export function useIdentityProfiles(wallet: WalletInterface | undefined, identityKeys: string[]): IdentityProfileMap {
  const fingerprint = useMemo(() => [...new Set(identityKeys)].sort().join(','), [identityKeys])
  const [profiles, setProfiles] = useState<IdentityProfileMap>({})

  useEffect(() => {
    if (!wallet || !fingerprint) { setProfiles({}); return }
    let cancelled = false
    const keys = fingerprint.split(',')
    void (async () => {
      const resolved: IdentityProfileMap = {}
      for (let offset = 0; offset < keys.length; offset += 6) {
        const batch = keys.slice(offset, offset + 6)
        const values = await Promise.all(batch.map(async (identityKey) => await resolveCached(wallet, identityKey)))
        if (cancelled) return
        values.forEach((profile) => { if (profile) resolved[profile.identityKey] = profile })
        setProfiles({ ...resolved })
      }
    })()
    return () => { cancelled = true }
  }, [fingerprint, wallet])

  return profiles
}

export function shortIdentity(identityKey?: string): string {
  return identityKey ? `${identityKey.slice(0, 8)}…${identityKey.slice(-6)}` : 'Metanet peer'
}

export function identityName(profiles: IdentityProfileMap, identityKey?: string, fallback = 'Metanet peer'): string {
  if (!identityKey) return fallback
  return profiles[identityKey]?.name || (fallback === 'Metanet peer' ? shortIdentity(identityKey) : fallback)
}

export function identityInitials(profiles: IdentityProfileMap, identityKey?: string): string {
  const label = identityKey ? profiles[identityKey]?.name : undefined
  if (label) {
    const words = label.split(/\s+/).filter(Boolean)
    return `${words[0]?.[0] ?? ''}${words.length > 1 ? words.at(-1)?.[0] ?? '' : words[0]?.[1] ?? ''}`.toUpperCase()
  }
  return identityKey?.slice(2, 4).toUpperCase() || 'ME'
}
