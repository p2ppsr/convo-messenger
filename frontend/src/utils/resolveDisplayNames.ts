import { IdentityClient } from '@bsv/sdk'

// Initialize a global identity client.
// This is used to look up display names for identity keys (pubkeys).
const identityClient = new IdentityClient()

/**
 * sanitizeKey
 *
 * Purpose:
 *   - Some pubkeys might be hex-encoded UTF-8 strings rather than
 *     directly stored compressed pubkeys.
 *   - This function attempts to decode such cases back to the expected
 *     compressed pubkey format.
 *
 * Example:
 *   Input: "303233..." (hex of ASCII string "02...").
 *   Output: "02abc123..." (valid compressed pubkey).
 *
 * Returns:
 *   - A corrected key string if parsing succeeds.
 *   - Otherwise, the original input string is returned.
 */
function sanitizeKey(possibleUtf8EncodedHex: string): string {
  try {
    // Convert hex string to bytes
    const bytes = Uint8Array.from(
      possibleUtf8EncodedHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
    )

    // Interpret those bytes as UTF-8 text
    const utf8 = new TextDecoder().decode(bytes)

    // Check if the result looks like a compressed pubkey
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(utf8)) {
      return utf8
    }
  } catch (err) {
    // If anything fails, just return the original string unchanged
  }

  return possibleUtf8EncodedHex
}

/**
 * resolveDisplayNames
 *
 * Purpose:
 *   - Given an array of public keys, fetch friendly names using IdentityClient.
 *   - If a key cannot be resolved to a name, fall back to a shortened hex string.
 *   - Optionally, you can pass `excludeKey` to filter out your own identity key.
 *
 * Flow:
 *   1. Filter out empty keys and the excludeKey.
 *   2. Run each key through sanitizeKey() to normalize.
 *   3. For each sanitized key:
 *        - Ask IdentityClient to resolve the identity.
 *        - If resolved, use the provided display name.
 *        - Otherwise, fall back to the first 10 characters of the key.
 *   4. Collect results into a Map<pubkey, displayName>.
 *
 * Example:
 *   Input: ["02abc123...", "03789def..."]
 *   Output: Map {
 *     "02abc123..." => "Alice",
 *     "03789def..." => "Bob"
 *   }
 */
export async function resolveDisplayNames(
  pubkeys: string[],
  excludeKey?: string
): Promise<Map<string, string>> {
  console.log('[resolveDisplayNames] Raw input pubkeys:', pubkeys)

  // Step 1: filter out blanks and excluded key
  const filtered = pubkeys
    .filter((key) => key && key.length > 0 && key !== excludeKey)
    .map(sanitizeKey)

  console.log('[resolveDisplayNames] Filtered & sanitized keys:', filtered)

  // Step 2: Resolve each pubkey asynchronously
  const results = await Promise.all(
    filtered.map(async (key) => {
      try {
        console.log(`[resolveDisplayNames] Resolving: ${key}`)

        // IdentityClient will attempt to fetch profile information for this key
        const identities = await identityClient.resolveByIdentityKey({ identityKey: key })

        console.log(`[resolveDisplayNames] Resolved for ${key}:`, identities)

        const name =
          identities.length > 0
            ? identities[0].name || key.slice(0, 10) + '...' // Prefer friendly name
            : key.slice(0, 10) + '...' // Fallback: truncated hex

        return [key, name] as const
      } catch (err) {
        console.warn(`[resolveDisplayNames] Failed to resolve ${key}`, err)
        // On error, fallback to truncated key
        return [key, key.slice(0, 10) + '...'] as const
      }
    })
  )

  // Step 3: Convert array of tuples into a Map
  const nameMap = new Map(results)

  console.log('[resolveDisplayNames] Final name map:', Object.fromEntries(nameMap))

  return nameMap
}
