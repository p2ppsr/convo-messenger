// src/utils/resolveDisplayNames.ts
import { IdentityClient } from '@bsv/sdk'

/**
 * Identity Client
 *
 * Used to query identities by public key. We keep a single global instance
 * to avoid reinitializing a new client for every call.
 */
const identityClient = new IdentityClient()

/**
 * In-memory cache for display names
 *
 * Key:   PubKey string
 * Value: Friendly display name (or fallback truncated pubkey)
 *
 * Purpose:
 *   - Prevents repeated calls to `identityClient.resolveByIdentityKey` for the
 *     same pubkey within a single page session.
 */
const displayNameCache = new Map<string, string>()

/**
 * Persistent cache (localStorage)
 *
 * Purpose:
 *   - Optionally survive page reloads, so that the same identities aren’t
 *     re-fetched on every refresh.
 *   - Loaded once at module import time, merged into in-memory cache.
 */
const PERSIST_KEY = 'displayNameCache'

try {
  const persisted = localStorage.getItem(PERSIST_KEY)
  if (persisted) {
    const parsed: Record<string, string> = JSON.parse(persisted)
    for (const [k, v] of Object.entries(parsed)) {
      displayNameCache.set(k, v)
    }
    // console.log('[resolveDisplayNames] Restored cache from localStorage:', parsed)
  }
} catch (err) {
  console.warn('[resolveDisplayNames] Failed to load persistent cache', err)
}

/**
 * Helper: persist current cache to localStorage
 */
function persistCache() {
  try {
    const obj = Object.fromEntries(displayNameCache.entries())
    localStorage.setItem(PERSIST_KEY, JSON.stringify(obj))
  } catch (err) {
    console.warn('[resolveDisplayNames] Failed to persist cache', err)
  }
}

/**
 * sanitizeKey
 *
 * Purpose:
 *   - Some pubkeys might be hex-encoded UTF-8 strings rather than directly
 *     stored compressed pubkeys.
 *   - This function attempts to decode such cases back into the expected
 *     compressed pubkey format.
 *
 * Flow:
 *   1. Interpret input as hex → bytes.
 *   2. Decode bytes as UTF-8 string.
 *   3. If the result looks like a valid compressed pubkey (02/03 prefix, 33 bytes),
 *      return that.
 *   4. Otherwise, return the original input string.
 */
function sanitizeKey(possibleUtf8EncodedHex: string): string {
  try {
    const bytes = Uint8Array.from(
      possibleUtf8EncodedHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
    )
    const utf8 = new TextDecoder().decode(bytes)
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(utf8)) {
      return utf8
    }
  } catch {
    // Ignore parse errors, fall back below
  }
  return possibleUtf8EncodedHex
}

/**
 * resolveDisplayNames
 *
 * Purpose:
 *   - Given an array of pubkeys, fetch friendly display names.
 *   - Uses in-memory + persistent caching to avoid unnecessary lookups.
 *   - Falls back to truncated hex when no name is available.
 *
 * Parameters:
 *   @param pubkeys    Array of pubkeys to resolve.
 *   @param excludeKey Optional pubkey to ignore (usually "self").
 *
 * Flow:
 *   1. Filter out blanks and the excludeKey.
 *   2. Run each through sanitizeKey() to normalize.
 *   3. For each sanitized key:
 *        - If in cache → return cached name.
 *        - Else → query IdentityClient and cache the result.
 *   4. Update persistent cache (localStorage).
 *   5. Return a Map<pubkey, displayName>.
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
  // console.log('[resolveDisplayNames] Raw input pubkeys:', pubkeys)

  // Step 1: filter out blanks and excluded key
  const filtered = pubkeys
    .filter((key) => key && key.length > 0 && key !== excludeKey)
    .map(sanitizeKey)

  // console.log('[resolveDisplayNames] Filtered & sanitized keys:', filtered)

  // Step 2: Resolve each pubkey asynchronously (with caching)
  const results = await Promise.all(
    filtered.map(async (key) => {
      // Use cached name if present
      if (displayNameCache.has(key)) {
        return [key, displayNameCache.get(key)!] as const
      }

      try {
        // console.log(`[resolveDisplayNames] Resolving via IdentityClient: ${key}`)
        const identities = await identityClient.resolveByIdentityKey({ identityKey: key })

        const name =
          identities.length > 0
            ? identities[0].name || key.slice(0, 10) + '...' // Prefer friendly name
            : key.slice(0, 10) + '...' // Fallback: truncated hex

        displayNameCache.set(key, name)
        persistCache()
        return [key, name] as const
      } catch (err) {
        console.warn(`[resolveDisplayNames] Failed to resolve ${key}`, err)
        const fallback = key.slice(0, 10) + '...'
        displayNameCache.set(key, fallback)
        persistCache()
        return [key, fallback] as const
      }
    })
  )

  // Step 3: Convert array of tuples into a Map
  const nameMap = new Map(results)

  // console.log('[resolveDisplayNames] Final name map:', Object.fromEntries(nameMap))

  return nameMap
}
