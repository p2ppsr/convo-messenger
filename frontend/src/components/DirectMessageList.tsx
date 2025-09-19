import { useEffect, useState, useRef } from 'react'
import { LookupResolver, Utils } from '@bsv/sdk'
import {
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

/**
 * ThreadSummary
 * Compact representation of a direct message thread.
 * - threadId: unique identifier (hash of participants + time)
 * - displayNames: human-readable participant names
 * - recipientKeys: all identity keys in this conversation
 * - lastTimestamp: timestamp of the most recent message
 */
interface ThreadSummary {
  threadId: string
  displayNames: string[]
  recipientKeys: string[]
  lastTimestamp: number
}

/**
 * Props expected by DirectMessageList
 */
interface DirectMessageListProps {
  identityKey: string
  wallet: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  onSelectThread: (threadId: string, recipientKeys: string[]) => void
}

const POLLING_INTERVAL_MS = 5000  // optional refresh interval (ms)

/**
 * DirectMessageList
 * Sidebar component that displays a list of direct (1-on-1) conversations.
 * 
 * Process:
 *  1. Query the overlay (ls_convo) for all stored conversation outputs
 *  2. Decode each output from BEEF → PushDrop fields → DecodedMessage
 *  3. Decrypt payloads using the current wallet identity
 *  4. Group by threadId, merging recipients across all messages
 *  5. Filter out group threads (those with a threadName)
 *  6. Sort by latest activity
 *  7. Render the result as a clickable list
 */
const DirectMessageList = ({
  identityKey,
  wallet,
  protocolID,
  keyID,
  onSelectThread
}: DirectMessageListProps) => {
  // Local state for thread summaries
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  // Whether we’re still waiting for overlay responses
  const [loading, setLoading] = useState<boolean>(true)
  const pollingRef = useRef<NodeJS.Timeout | null>(null) // keep interval id if polling enabled

  /**
   * Query overlay + rebuild the local thread summary list
   */
  const loadThreads = async () => {
    try {
      // 1. Create resolver targeting local or mainnet
      const resolver = new LookupResolver({
        networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
      })

      // 2. Ask overlay for all convo outputs
      const response = await resolver.query({
        service: 'ls_convo',
        query: { type: 'findAll' }
      })

      if (response.type !== 'output-list') {
        throw new Error(`Unexpected response type: ${response.type}`)
      }

      // 3. Normalize results for decodeOutputs
      const toDecode = response.outputs.map((o) => ({
        beef: o.beef,                        // raw tx in BEEF encoding
        outputIndex: o.outputIndex,          // which vout
        timestamp: parseInt(Utils.toUTF8(o.context ?? [])) // overlay attaches context timestamp
      }))

      // 4. Decode PushDrop fields + 5. Attempt batch decryption
      const decoded = await decodeOutputs(toDecode)
      const decrypted = await decryptMessageBatch(wallet, decoded, protocolID, keyID)

      // 6. Group messages into thread summaries
      const grouped: Record<string, ThreadSummary & { isGroup: boolean }> = {}

      for (const msg of decrypted) {
        const { threadId, createdAt, payload } = msg
        if (!payload) continue // skip undecryptable

        const threadName = payload.name?.trim()
        const recipients = payload.recipients ?? []

        if (!grouped[threadId]) {
          // First message for this thread → seed summary
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
          // Existing thread → update with new info
          grouped[threadId].lastTimestamp = Math.max(
            grouped[threadId].lastTimestamp,
            createdAt
          )
          if (threadName) grouped[threadId].isGroup = true

          // Merge in any new recipients discovered later in the thread
          const existing = new Set(grouped[threadId].recipientKeys)
          let changed = false
          for (const r of recipients) {
            if (!existing.has(r)) {
              existing.add(r)
              changed = true
            }
          }
          if (changed) {
            grouped[threadId].recipientKeys = Array.from(existing)
            const nameMap = await resolveDisplayNames(grouped[threadId].recipientKeys, identityKey)
            grouped[threadId].displayNames = Array.from(nameMap.values())
          }
        }
      }

      // 7. Only keep DM threads (no explicit threadName = not a group)
      const directThreads = Object.values(grouped)
        .filter((t) => !t.isGroup)
        .sort((a, b) => b.lastTimestamp - a.lastTimestamp) // newest first

      // Only update state if something actually changed
      const hasChanged = JSON.stringify(threads) !== JSON.stringify(directThreads)
      if (hasChanged) setThreads(directThreads)
    } catch (err) {
      console.error('[DirectMessageList] Failed to load threads:', err)
    } finally {
      setLoading(false)
    }
  }

  /**
   * On mount (and whenever identity/wallet/protocolID/keyID change), reload thread list.
   * Polling support is left in place but commented out for now.
   */
  useEffect(() => {
    loadThreads()
    pollingRef.current = setInterval(loadThreads, POLLING_INTERVAL_MS)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [identityKey, wallet, protocolID, keyID])

  /**
   * Render direct message list
   */
  return (
    <>
      {loading ? (
        <CircularProgress />
      ) : (
        <List disablePadding>
          {threads.map((thread) => (
            <ListItem key={thread.threadId} disablePadding sx={{ mb: 0.5 }}>
              <ListItemButton
                onClick={() => onSelectThread(thread.threadId, thread.recipientKeys)}
                sx={(theme) => ({
                  borderRadius: '9999px', // pill look
                  px: 2,
                  py: 0.75,
                  '&:hover': {
                    backgroundColor: theme.palette.action.hover,
                  },
                  '&.Mui-selected': {
                    backgroundColor: theme.palette.primary.main,
                    color: theme.palette.primary.contrastText,
                    '&:hover': {
                      backgroundColor: theme.palette.primary.dark,
                    },
                  },
                })}
              >
                <ListItemText
                  primary={
                    thread.displayNames.length > 0
                      ? `To: ${thread.displayNames.join(', ')}`
                      : 'Unnamed Thread'
                  }
                  secondary={`Last activity: ${new Date(thread.lastTimestamp).toLocaleString()}`}
                  slotProps={{
                    primary: {
                      noWrap: true,
                      sx: { fontSize: 14 },
                    },
                    secondary: {
                      sx: { fontSize: 12, color: 'text.secondary' },
                    },
                  }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      )}
    </>
  )
}

export default DirectMessageList
