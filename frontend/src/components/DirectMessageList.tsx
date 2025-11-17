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
import { addThreadSummary, getThreadSummary, getAllThreadSummaries } from '../utils/threadCache'

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
  isGroup: boolean
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
      service: "ls_convo",
      query: {
        type: "listLatestMessages",
        skip: 0,
        limit: 10
      }
    });

    if (response.type !== "output-list") {
      throw new Error(`Unexpected response type: ${response.type}`);
    }

    // Convert overlay outputs → decode-ready form
    const toDecode = response.outputs.map((o) => ({
      beef: o.beef,
      outputIndex: o.outputIndex,
      timestamp: parseInt(Utils.toUTF8(o.context ?? [])),
    }));

    const decoded = await decodeOutputs(toDecode);

    const summaries: ThreadSummary[] = [];

    for (let i = 0; i < decoded.length; i++) {
      const msg = decoded[i];
      if (msg.type !== "message") continue;

      const {
        threadId,
        recipients = [],
        createdAt,
        threadName,
        encryptedThreadNameHeader,
        encryptedThreadNameCiphertext,
      } = msg;

      // Only include threads where *this wallet* participates
      if (!recipients.includes(identityKey)) continue;

      // Skip group threads (those go to ThreadList)
      const isGroup =
        !!threadName ||
        (!!encryptedThreadNameHeader && !!encryptedThreadNameCiphertext);
      if (isGroup) continue;

      // -------------------------------------------------------
      // 🔥 CACHE CHECK
      // -------------------------------------------------------
      const cached = getThreadSummary(threadId);

      if (cached && cached.lastTimestamp >= createdAt) {
        // Cache is fresh → reuse
        summaries.push(cached);
        continue;
      }

      // -------------------------------------------------------
      // ❗ Cache miss → must compute fresh summary
      // -------------------------------------------------------

      const map = await resolveDisplayNames(recipients, identityKey);

      // All participants except self
      const displayNames = Array.from(map.entries())
        .filter(([pub]) => pub !== identityKey)
        .map(([_, name]) => name);

      const summary: ThreadSummary = {
        threadId,
        recipientKeys: recipients,
        displayNames,
        lastTimestamp: createdAt,
        isGroup: false
      };

      // -------------------------------------------------------
      // 🔥 UPDATE CACHE
      // -------------------------------------------------------
      addThreadSummary(summary);

      summaries.push(summary);
    }

    // Sort newest → oldest
    summaries.sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    setThreads(summaries);

  } catch (err) {
    console.warn("[DirectMessageList] Lookup failed:", err);
  } finally {
    setLoading(false);
  }
};



//   useEffect(() => {
//   if (!loading) {
//     loadThreads()
//   }
// }, [loading])

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
