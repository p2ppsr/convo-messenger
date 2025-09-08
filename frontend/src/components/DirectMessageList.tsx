import { useEffect, useState } from 'react'
import {
  Box,
  Typography,
  List,
  ListItemButton,
  ListItemText,
  CircularProgress
} from '@mui/material'
import {
  LookupResolver,
  Utils,
  WalletClient,
  SecurityLevel
} from '@bsv/sdk'

import { decodeOutputs } from '../utils/decodeOutputs'
import { decryptMessageBatch } from '../utils/MessageDecryptor'
import { resolveDisplayNames } from '../utils/resolveDisplayNames'
import type { DirectMessageEntry } from '../types/types'

interface DirectMessageListProps {
  identityKey: string
  client: WalletClient
  protocolID: [SecurityLevel, string]
  keyID: string
  onSelectThread: (threadId: string) => void
}

const DirectMessageList = ({
  identityKey,
  client,
  onSelectThread,
  protocolID,
  keyID
}: DirectMessageListProps) => {
  const [messages, setMessages] = useState<DirectMessageEntry[]>([])
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    const loadDirectMessages = async () => {
      try {
        const resolver = new LookupResolver({
          networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
        })

        const response = await resolver.query({
          service: 'ls_convo',
          query: { type: 'findAll' }
        })

        if (response.type !== 'output-list') {
          throw new Error(`Unexpected response type: ${response.type}`)
        }

        const outputs = response.outputs ?? []

        const toDecode = outputs.map((o) => ({
          beef: o.beef,
          outputIndex: o.outputIndex,
          timestamp: parseInt(Utils.toUTF8(o.context ?? []))
        }))

        const decoded = await decodeOutputs(toDecode)
        const decrypted = await decryptMessageBatch(client, decoded, protocolID, keyID)

        // Filter to direct messages only
        const filtered = decrypted.filter(
          (msg) =>
            msg.threadId &&
            msg.payload?.recipients?.length === 1
        )

        // Group by threadId → keep most recent per thread
        const grouped: Record<string, { threadId: string, participantKey: string, lastTimestamp: number }> = {}

        for (const msg of filtered) {
          const { threadId, sender, payload, createdAt } = msg

          const otherKey = sender === identityKey
            ? payload?.recipients?.[0] ?? ''
            : sender

          if (!otherKey) continue

          if (
            !grouped[threadId] ||
            createdAt > grouped[threadId].lastTimestamp
          ) {
            grouped[threadId] = {
              threadId,
              participantKey: otherKey,
              lastTimestamp: createdAt
            }
          }
        }

        const uniqueEntries = Object.values(grouped)

        // Resolve all participant keys
        const keyMap = await resolveDisplayNames(
          uniqueEntries.map((entry) => entry.participantKey),
          identityKey
        )

        const dedupedByKey = new Map<string, DirectMessageEntry>()

        for (const entry of uniqueEntries) {
          const displayName = keyMap.get(entry.participantKey) ?? entry.participantKey.slice(0, 12) + '...'

          // Ensure only one thread per identityKey (most recent one)
          if (
            !dedupedByKey.has(entry.participantKey) ||
            entry.lastTimestamp > (dedupedByKey.get(entry.participantKey)?.lastTimestamp ?? 0)
          ) {
            dedupedByKey.set(entry.participantKey, {
              threadId: entry.threadId,
              otherParticipantKey: entry.participantKey,
              otherParticipantName: displayName,
              lastTimestamp: entry.lastTimestamp
            })
          }
        }

        const finalMessages = Array.from(dedupedByKey.values()).sort(
          (a, b) => b.lastTimestamp - a.lastTimestamp
        )

        setMessages(finalMessages)
      } catch (err) {
        console.error('[DirectMessageList] Failed to load messages:', err)
      } finally {
        setLoading(false)
      }
    }

    loadDirectMessages()
  }, [identityKey, protocolID, keyID])

  return (
    <Box sx={{ padding: 2, width: 300, borderLeft: '1px solid #ccc' }}>
      <Typography variant="h6" gutterBottom>
        Direct Messages
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
          <CircularProgress />
        </Box>
      ) : messages.length === 0 ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ padding: 2, textAlign: 'center' }}
        >
          No direct messages yet
        </Typography>
      ) : (
        <List>
          {messages.map((msg) => (
            <ListItemButton
              key={msg.threadId}
              onClick={() => onSelectThread(msg.threadId)}
            >
              <ListItemText
                primary={msg.otherParticipantName}
                secondary={`Last: ${new Date(msg.lastTimestamp).toLocaleString()}`}
              />
            </ListItemButton>
          ))}
        </List>
      )}
    </Box>
  )
}

export default DirectMessageList
