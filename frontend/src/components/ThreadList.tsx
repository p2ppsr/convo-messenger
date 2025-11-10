// frontend/src/components/ThreadList.tsx

import { useEffect, useState, useRef } from 'react'
import { LookupResolver, Utils } from '@bsv/sdk'
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
  threadName: string
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
  onSelectThread
}: ThreadListProps) => {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  /**
   * Load all threads from overlay
   */
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

    // 🔥 decode only — NOT decrypting messages
    const decoded = await decodeOutputs(toDecode)

    const grouped: Record<string, ThreadSummary> = {}

    for (const msg of decoded) {
      if (msg.type !== 'message') continue

      const { threadId, createdAt, recipients = [], threadName, encryptedThreadNameHeader, encryptedThreadNameCiphertext } = msg

      // Skip direct messages (no thread name, no encrypted thread name)
      const hasEncryptedName = encryptedThreadNameHeader && encryptedThreadNameCiphertext
      const hasPlaintextName = threadName && threadName.trim().length > 0

      if (!hasEncryptedName && !hasPlaintextName) {
        continue
      }

      // seed entry if first time we see this threadId
      if (!grouped[threadId]) {
        grouped[threadId] = {
          threadId,
          displayNames: [],
          recipientKeys: recipients,
          lastTimestamp: createdAt,
          threadName: '' // filled below
        }
      }

      grouped[threadId].lastTimestamp = Math.max(
        grouped[threadId].lastTimestamp,
        createdAt
      )

      // Only decrypt the first threadname we encounter
      if (!grouped[threadId].threadName) {
        if (hasPlaintextName) {
          grouped[threadId].threadName = threadName!.trim()
        }

        if (hasEncryptedName) {
          const result = await decryptMessage(
            wallet,
            encryptedThreadNameHeader!,
            encryptedThreadNameCiphertext!,
            protocolID,
            keyID
          )

          if (result?.content) {
            grouped[threadId].threadName = result.content.trim()
          }
        }

        // Resolve human readable names only once
        if (grouped[threadId].displayNames.length === 0) {
          const map = await resolveDisplayNames(recipients, identityKey)
          grouped[threadId].displayNames = Array.from(map.values())
        }
      }
    }

    const sortedThreads = Object.values(grouped).sort(
      (a, b) => b.lastTimestamp - a.lastTimestamp
    )

    setThreads(sortedThreads)
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
