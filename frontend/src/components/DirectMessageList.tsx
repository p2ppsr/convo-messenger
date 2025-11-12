import { useEffect, useState, useRef } from 'react'
import { LookupResolver, Utils, Transaction } from '@bsv/sdk'
import {
  List,
  ListItem,
  ListItemText,
  ListItemButton,
  CircularProgress
} from '@mui/material'

import { decodeOutputs } from '../utils/decodeOutputs'
import { resolveDisplayNames } from '../utils/resolveDisplayNames'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { addThreadSummary, getThreadSummary } from '../utils/threadCache'

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
  resolver: LookupResolver
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
  onSelectThread,
  resolver
}: DirectMessageListProps) => {
  // Local state for thread summaries
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  // Whether we’re still waiting for overlay responses
  const [loading, setLoading] = useState<boolean>(true)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null) // keep interval id if polling enabled

  /**
   * Query overlay + rebuild the local thread summary list
   */
  const loadThreads = async () => {
    try {
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
      const grouped: Record<string, ThreadSummary & { isGroup: boolean }> = {}

      for (let i = 0; i < decoded.length; i++) {
        const msg = decoded[i]
        if (msg.type !== 'message') continue

        const base = toDecode[i]
        const tx = Transaction.fromBEEF(base.beef)
        const txid = tx.id('hex')
        const lookupKey = `${txid}:${base.outputIndex}`

        const {
          threadId,
          recipients = [],
          createdAt,
          threadName,
          encryptedThreadNameHeader,
          encryptedThreadNameCiphertext
        } = msg

        const isGroup =
          !!threadName || (!!encryptedThreadNameHeader && !!encryptedThreadNameCiphertext)

        // Only include if I'm a participant
        if (!recipients.includes(identityKey)) continue
        // Check cache first
        const cached = getThreadSummary(threadId)

        if (cached) {
          // Already have a summary — just update timestamp if needed
          if (!grouped[threadId]) {
            grouped[threadId] = cached
          } else {
            grouped[threadId].lastTimestamp = Math.max(
              grouped[threadId].lastTimestamp,
              createdAt
            )
          }
          continue
        }

        // Not cached — resolve names once
        const nameMap = await resolveDisplayNames(recipients, identityKey)
        const displayNames = Array.from(nameMap.entries())
          .filter(([pub]) => pub !== identityKey)
          .map(([_, name]) => name)

        // Add to grouped summary
        if (!grouped[threadId]) {
          grouped[threadId] = {
            threadId,
            recipientKeys: recipients,
            displayNames,
            lastTimestamp: createdAt,
            isGroup: false
          }
        } else {
          grouped[threadId].lastTimestamp = Math.max(
            grouped[threadId].lastTimestamp,
            createdAt
          )
        }

        // Cache this thread summary for faster reuse
        addThreadSummary({
          threadId,
          threadName: '',
          recipientKeys: recipients,
          displayNames,
          lastTimestamp: createdAt,
          isGroup: false
        })


        if (!grouped[threadId]) {
          grouped[threadId] = {
            threadId,
            recipientKeys: recipients,
            displayNames,
            lastTimestamp: createdAt,
            isGroup
          }
        } else {
          grouped[threadId].lastTimestamp = Math.max(
            grouped[threadId].lastTimestamp,
            createdAt
          )
        }
      }

      const directThreads = Object.values(grouped)
        .filter((t) => !t.isGroup)
        .map(({ isGroup, ...rest }) => rest)
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
      if (pollingRef.current) {
        clearInterval(pollingRef.current as unknown as number)
        pollingRef.current = null
      }
    }
  }, [identityKey, wallet, protocolID, keyID])

  return loading ? (
    <CircularProgress />
  ) : (
    <List disablePadding>
      {threads.map((thread) => (
        <ListItem key={thread.threadId} disablePadding sx={{ mb: 0.5 }}>
          <ListItemButton
            onClick={() => onSelectThread(thread.threadId, thread.recipientKeys)}
            sx={(theme) => ({
              borderRadius: '9999px',
              px: 2,
              py: 0.75,
              '&:hover': {
                backgroundColor: theme.palette.action.hover
              }
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
                primary: { noWrap: true, sx: { fontSize: 14 } },
                secondary: { sx: { fontSize: 12, color: 'text.secondary' } }
              }}
            />
          </ListItemButton>
        </ListItem>
      ))}
    </List>
  )
}

export default DirectMessageList
