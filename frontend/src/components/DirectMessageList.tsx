import { useEffect, useState, useRef } from 'react'
import { LookupResolver, Utils } from '@bsv/sdk'
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  ListItemButton,
  CircularProgress
} from '@mui/material'

import { decodeOutputs } from '../utils/decodeOutputs'
import { decryptMessageBatch } from '../utils/MessageDecryptor'
import { resolveDisplayNames } from '../utils/resolveDisplayNames'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'

interface ThreadSummary {
  threadId: string
  displayNames: string[]
  recipientKeys: string[]
  lastTimestamp: number
}

interface DirectMessageListProps {
  identityKey: string
  wallet: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  onSelectThread: (threadId: string, recipientKeys: string[]) => void
}

const POLLING_INTERVAL_MS = 5000

const DirectMessageList = ({
  identityKey,
  wallet,
  protocolID,
  keyID,
  onSelectThread
}: DirectMessageListProps) => {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  const loadThreads = async () => {
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

      const toDecode = response.outputs.map((o) => ({
        beef: o.beef,
        outputIndex: o.outputIndex,
        timestamp: parseInt(Utils.toUTF8(o.context ?? []))
      }))

      const decoded = await decodeOutputs(toDecode)
      const decrypted = await decryptMessageBatch(wallet, decoded, protocolID, keyID)

      const grouped: Record<string, ThreadSummary & { isGroup: boolean }> = {}

      for (const msg of decrypted) {
        const { threadId, createdAt, payload } = msg
        if (!payload) continue

        const threadName = payload.name?.trim()
        const recipients = payload.recipients ?? []

        if (!grouped[threadId]) {
          const nameMap = await resolveDisplayNames(recipients, identityKey)
          const displayNames = Array.from(nameMap.values())

          grouped[threadId] = {
            threadId,
            displayNames,
            recipientKeys: recipients,
            lastTimestamp: createdAt,
            isGroup: !!threadName
          }
        } else {
          grouped[threadId].lastTimestamp = Math.max(
            grouped[threadId].lastTimestamp,
            createdAt
          )
          if (threadName) {
            grouped[threadId].isGroup = true
          }
        }
      }

      // ✅ Filter out group threads before display
      const directThreads = Object.values(grouped)
        .filter((t) => !t.isGroup)
        .sort((a, b) => b.lastTimestamp - a.lastTimestamp)

      const hasChanged = JSON.stringify(threads) !== JSON.stringify(directThreads)
      if (hasChanged) setThreads(directThreads)
    } catch (err) {
      console.error('[DirectMessageList] Failed to load threads:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadThreads()
    pollingRef.current = setInterval(loadThreads, POLLING_INTERVAL_MS)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [identityKey, wallet, protocolID, keyID])

  return (
    <Box sx={{ padding: 2, width: 300, borderRight: '1px solid #ccc' }}>
      <Typography variant="h6" gutterBottom>
        Direct Messages
      </Typography>

      {loading ? (
        <CircularProgress />
      ) : (
        <List>
          {threads.map((thread) => (
            <ListItem key={thread.threadId} disablePadding>
              <ListItemButton onClick={() => onSelectThread(thread.threadId, thread.recipientKeys)}>
                <ListItemText
                  primary={
                    thread.displayNames.length > 0
                      ? `To: ${thread.displayNames.join(', ')}`
                      : 'Unnamed Thread'
                  }
                  secondary={`Last activity: ${new Date(thread.lastTimestamp).toLocaleString()}`}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  )
}

export default DirectMessageList
