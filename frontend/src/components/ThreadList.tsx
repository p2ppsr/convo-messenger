// frontend/src/components/ThreadList.tsx

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
  threadName: string
}

interface ThreadListProps {
  identityKey: string
  wallet: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  onSelectThread: (threadId: string, recipientKeys: string[], threadName?: string) => void
}

// const POLLING_INTERVAL_MS = 5000

const ThreadList = ({ identityKey, wallet, protocolID, keyID, onSelectThread }: ThreadListProps) => {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  // const pollingRef = useRef<NodeJS.Timeout | null>(null)

  const loadThreads = async () => {
    console.log('[ThreadList] loadThreads called with protocolID:', protocolID, 'keyID:', keyID)
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

      const grouped: Record<string, ThreadSummary> = {}

      for (const msg of decrypted) {
        const { threadId, createdAt, payload } = msg

        if (!payload) continue // Skip failed decryption

        const recipients = payload.recipients ?? []

        if (!grouped[threadId]) {
          const threadName = payload.name?.trim()

          if (!threadName) continue

          const nameMap = await resolveDisplayNames(recipients, identityKey)
          const displayNames = Array.from(nameMap.values())

          grouped[threadId] = {
            threadId,
            displayNames,
            recipientKeys: recipients,
            lastTimestamp: createdAt,
            threadName
          }
        }
      }
      const sortedThreads = Object.values(grouped).sort(
        (a, b) => b.lastTimestamp - a.lastTimestamp
      )

      const hasChanged = JSON.stringify(threads) !== JSON.stringify(sortedThreads)
      if (hasChanged) setThreads(sortedThreads)
    } catch (err) {
      console.error('[ThreadList] Failed to load threads:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadThreads()
    // pollingRef.current = setInterval(loadThreads, POLLING_INTERVAL_MS)
    // return () => {
    //   if (pollingRef.current) clearInterval(pollingRef.current)
    // }
  }, [identityKey, wallet, protocolID, keyID]) // re-poll if identity changes

  return (
    <Box sx={{ padding: 2, width: 300, borderRight: '1px solid #ccc' }}>
      <Typography variant="h6" gutterBottom>
        Threads
      </Typography>

      {loading ? (
        <CircularProgress />
      ) : (
        <List>
          {threads
            .filter((t) => t.threadName && t.threadName.length > 0)
            .map((thread) => (
              <ListItem key={thread.threadId} disablePadding>
                <ListItemButton onClick={() => onSelectThread(thread.threadId, thread.recipientKeys, thread.threadName)}>
                  <ListItemText
                    primary={thread.threadName}
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

export default ThreadList
