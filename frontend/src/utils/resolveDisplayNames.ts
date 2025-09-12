import { IdentityClient } from '@bsv/sdk'

const identityClient = new IdentityClient()

/**
 * Attempts to decode a hex-encoded UTF-8 string into a compressed public key
 */
function sanitizeKey(possibleUtf8EncodedHex: string): string {
  try {
    const bytes = Uint8Array.from(
      possibleUtf8EncodedHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
    )
    const utf8 = new TextDecoder().decode(bytes)

    // If the result looks like a compressed public key (02|03 + 64 hex chars)
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(utf8)) {
      return utf8
    }
  } catch (err) {
    // Ignore errors, fallback to original
  }

  return possibleUtf8EncodedHex
}

/**
 * Resolves an array of public keys to display names.
 * Falls back to key short form if name not found.
 */
export async function resolveDisplayNames(
  pubkeys: string[],
  excludeKey?: string
): Promise<Map<string, string>> {
  console.log('[resolveDisplayNames] Raw input pubkeys:', pubkeys)

  const filtered = pubkeys
    .filter((key) => key && key.length > 0 && key !== excludeKey)
    .map(sanitizeKey)

  console.log('[resolveDisplayNames] Filtered & sanitized keys:', filtered)

  const results = await Promise.all(
    filtered.map(async (key) => {
      try {
        console.log(`[resolveDisplayNames] Resolving: ${key}`)

        const identities = await identityClient.resolveByIdentityKey({ identityKey: key })

        console.log(`[resolveDisplayNames] Resolved for ${key}:`, identities)

        const name =
          identities.length > 0
            ? identities[0].name || key.slice(0, 10) + '...'
            : key.slice(0, 10) + '...'

        return [key, name] as const
      } catch (err) {
        console.warn(`[resolveDisplayNames] Failed to resolve ${key}`, err)
        return [key, key.slice(0, 10) + '...'] as const
      }
    })
  )

  const nameMap = new Map(results)

  console.log('[resolveDisplayNames] Final name map:', Object.fromEntries(nameMap))

  return nameMap
}
