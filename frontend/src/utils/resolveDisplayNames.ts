// src/utils/resolveDisplayNames.ts
import { IdentityClient } from '@bsv/sdk'

const identityClient = new IdentityClient()

/**
 * Resolves an array of public keys to display names.
 * Falls back to the key if no name is found.
 * Optionally exclude the current user's key.
 */
export async function resolveDisplayNames(
  pubkeys: string[],
  excludeKey?: string
): Promise<Map<string, string>> {
  console.log('[resolveDisplayNames] Raw input pubkeys:', pubkeys)

  const filtered = pubkeys.filter(
    (key) => key && key.length > 0 && key !== excludeKey
  )

  console.log('[resolveDisplayNames] Filtered keys (excluding self and blanks):', filtered)

  const results = await Promise.all(
    filtered.map(async (key) => {
      try {
        console.log(`[resolveDisplayNames] Attempting to resolve: ${key}`)

        const identities = await identityClient.resolveByIdentityKey({ identityKey: key })

        console.log(`[resolveDisplayNames] Resolved identities for ${key}:`, identities)

        const name = identities.length > 0
          ? identities[0].name || key.slice(0, 10) + '...'
          : key.slice(0, 10) + '...'

        return [key, name] as const
      } catch (err) {
        console.warn(`[resolveDisplayNames] Failed to resolve name for ${key}`, err)
        return [key, key.slice(0, 10) + '...'] as const
      }
    })
  )

  const nameMap = new Map(results)

  console.log('[resolveDisplayNames] Final name map:', Object.fromEntries(nameMap))

  return nameMap
}
