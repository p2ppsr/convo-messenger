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
  IdentityClient,
  WalletClient,
  SecurityLevel
} from '@bsv/sdk'

import { decodeOutputs } from '../utils/decodeOutputs'
import { decryptMessageBatch } from '../utils/MessageDecryptor' // includes batch decryption
import type { DirectMessageEntry } from '../types/types' // optionally extracted for reuse

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

        const identityClient = new IdentityClient(client)

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

        const filtered = decrypted.filter(
          (msg) =>
            msg.threadId &&
            msg.payload?.recipients?.length === 1 // ensure payload is present
        )

        const grouped: Record<string, DirectMessageEntry> = {}

        for (const message of filtered) {
          const { threadId, sender, payload, createdAt } = message
          const otherKey =
            sender === identityKey
              ? (payload && payload.recipients && payload.recipients[0])
                ? payload.recipients[0]
                : ''
              : sender

          if (!grouped[threadId]) {
            grouped[threadId] = {
              threadId,
              otherParticipantKey: otherKey,
              otherParticipantName: otherKey.slice(0, 12) + '...',
              lastTimestamp: createdAt
            }
          } else {
            grouped[threadId].lastTimestamp = Math.max(
              grouped[threadId].lastTimestamp,
              createdAt
            )
          }
        }

        const resolved = await Promise.all(
            Object.values(grouped).map(async (entry) => {
                try {
                const identities = await identityClient.resolveByIdentityKey({
                    identityKey: entry.otherParticipantKey
                })

                const identity = identities[0] // pick the first match, if any

                return {
                    ...entry,
                    otherParticipantName:
                    identity?.name || entry.otherParticipantKey.slice(0, 12) + '...'
                }
                } catch {
                return entry
                }
            })
            )

        setMessages(resolved.sort((a, b) => b.lastTimestamp - a.lastTimestamp))
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
