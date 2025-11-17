// frontend/src/components/ThreadList.tsx

import { useEffect, useState, useRef } from 'react'
import { LookupResolver, Utils, Transaction } from '@bsv/sdk'
import {
  Box,
  List,
  ListItem,
  ListItemText,
  ListItemButton,
  CircularProgress
} from '@mui/material'

import { decodeOutputs } from '../utils/decodeOutputs'
import { decryptMessage } from '../utils/MessageDecryptor'
import { resolveDisplayNames } from '../utils/resolveDisplayNames'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { POLLING_ENABLED } from '../utils/constants'
import { addThreadSummary, getThreadSummary, getAllThreadSummaries } from '../utils/threadCache'
import { lookup } from 'dns'

/**
 * Summary of a group thread
 * - threadId: unique identifier (hash)
 * - displayNames: participant names resolved from identity keys
 * - recipientKeys: raw pubkeys of thread members
 * - lastTimestamp: last activity (message timestamp)
 * - threadName: user-specified thread/group name
 */
interface ThreadSummary {
  threadId: string
  displayNames: string[]
  recipientKeys: string[]
  lastTimestamp: number
  threadName?: string
  isGroup: boolean
}

/**
 * Props for ThreadList
 * - identityKey: current user's pubkey
 * - wallet: WalletInterface for decrypting messages
 * - protocolID: namespace identifier
 * - keyID: derivation path index
 * - onSelectThread: callback when a thread is clicked
 */
interface ThreadListProps {
  identityKey: string
  wallet: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  onSelectThread: (
    threadId: string,
    recipientKeys: string[],
    threadName?: string
  ) => void
  resolver: LookupResolver
}

const POLLING_INTERVAL_MS = 5000

/**
 * ThreadList component
 * Shows a sidebar of **group conversation threads**.
 * Workflow:
 *   1. Query overlay (ls_convo) for all outputs
 *   2. Decode them into envelopes
 *   3. Decrypt them with wallet + protocolID + keyID
 *   4. Group by threadId, collecting recipients + names
 *   5. Only keep messages with a valid `threadName`
 *   6. Sort by latest activity
 */
const ThreadList = ({
  identityKey,
  wallet,
  protocolID,
  keyID,
  onSelectThread,
  resolver
}: ThreadListProps) => {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  /**
   * Load all threads from overlay
   */
 const loadThreads = async () => {
  try {
    const response = await resolver.query({
      service: 'ls_convo',
      query: {
        type: 'listLatestMessages',
        skip: 0,
        limit: 10
      }
    })

    if (response.type !== 'output-list') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }

    // Convert into decode-ready items
    const toDecode = response.outputs.map((o) => ({
      beef: o.beef,
      outputIndex: o.outputIndex,
      timestamp: parseInt(Utils.toUTF8(o.context ?? []))
    }))

    // Decode only these (<= 10)
    const decoded = await decodeOutputs(toDecode)

    const summaries: ThreadSummary[] = []

    for (let i = 0; i < decoded.length; i++) {
      const msg = decoded[i]
      if (msg.type !== 'message') continue

      const {
        threadId,
        recipients = [],
        createdAt,
        threadName,
        encryptedThreadNameHeader,
        encryptedThreadNameCiphertext
      } = msg

      // Only include threads you are part of
      if (!recipients.includes(identityKey)) continue

      // Detect if this is a group thread
      const isGroup =
        !!threadName ||
        (!!encryptedThreadNameHeader && !!encryptedThreadNameCiphertext)

      if (!isGroup) continue // ThreadList = group threads only

      // -------------------------------------------------------
      // 🔥 CACHE CHECK
      // -------------------------------------------------------
      const cached = getThreadSummary(threadId)

      if (cached && cached.lastTimestamp >= createdAt) {
        // Cache is up-to-date or newer → reuse it
        summaries.push(cached)
        continue
      }

      // -------------------------------------------------------
      // ❗ Cache miss → must resolve identities + decrypt name
      // -------------------------------------------------------

      // Resolve display names
      const nameMap = await resolveDisplayNames(recipients, identityKey)
      const displayNames = Array.from(nameMap.values())

      // Attempt to get plaintext threadName
      let finalName = threadName?.trim() ?? ''
      if (!finalName && encryptedThreadNameHeader && encryptedThreadNameCiphertext) {
        try {
          const res = await decryptMessage(
            wallet,
            encryptedThreadNameHeader,
            encryptedThreadNameCiphertext,
            protocolID,
            keyID
          )
          finalName = res?.content?.trim() ?? ''
        } catch (e) {
          console.warn(`[ThreadList] Failed to decrypt group name`, e)
        }
      }

      const summary: ThreadSummary = {
        threadId,
        threadName: finalName,
        recipientKeys: recipients,
        displayNames,
        lastTimestamp: createdAt,
        isGroup: true
      }

      // -------------------------------------------------------
      // 🔥 UPDATE CACHE
      // -------------------------------------------------------
      addThreadSummary(summary)

      summaries.push(summary)
    }

    // Sort newest → oldest
    summaries.sort((a, b) => b.lastTimestamp - a.lastTimestamp)

    setThreads(summaries)

  } catch (err) {
    console.error('[ThreadList] Failed to load threads:', err)
  } finally {
    setLoading(false)
  }
}






  /**
   * Effect: load threads initially and whenever identity/wallet/protocolID/keyID changes
   * Polling is left commented out for now
   */
  useEffect(() => {
    loadThreads()
    if (POLLING_ENABLED) {
      pollingRef.current = setInterval(loadThreads, POLLING_INTERVAL_MS)
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [identityKey, wallet, protocolID, keyID]) // re-run if props change

  /**
   * Render the sidebar list
   */
  return (
    <Box>
      {loading ? (
        <CircularProgress />
      ) : (
        <List disablePadding>
          {threads
            .filter((t) => t.threadName && t.threadName.length > 0) // safeguard
            .map((thread) => (
              <ListItem key={thread.threadId} disablePadding sx={{ mb: 0.5 }}>
                <ListItemButton
                  onClick={() =>
                    onSelectThread(thread.threadId, thread.recipientKeys, thread.threadName)
                  }
                  sx={(theme) => ({
                    borderRadius: '9999px', // pill shape
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
                    primary={thread.threadName}
                    secondary={`Last activity: ${new Date(
                      thread.lastTimestamp
                    ).toLocaleString()}`}
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
    </Box>
  )
}

export default ThreadList
