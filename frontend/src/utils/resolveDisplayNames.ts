// frontend/src/utils/resolveDisplayNames.ts

import { IdentityClient } from '@bsv/sdk'
import { DisplayableIdentity } from '@bsv/identity-react'
import type { DirectMessageEntry } from '../components/DirectMessageList'

export async function resolveDisplayNames(
  entries: DirectMessageEntry[]
): Promise<DirectMessageEntry[]> {
  const client = new IdentityClient({
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  const names = await Promise.all(
    entries.map((entry) =>
      client
        .resolve(entry.otherParticipantKey)
        .then((identity) => ({
          ...entry,
          otherParticipantName:
            (identity as DisplayableIdentity)?.name || entry.otherParticipantKey.slice(0, 12) + '...'
        }))
        .catch(() => ({
          ...entry,
          otherParticipantName: entry.otherParticipantKey.slice(0, 12) + '...'
        }))
    )
  )

  return names
}
