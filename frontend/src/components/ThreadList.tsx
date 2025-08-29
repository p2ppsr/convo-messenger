import { useEffect, useState } from 'react'
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

interface ThreadSummary {
  threadId: string
  title: string
  lastTimestamp: number
}

interface ThreadListProps {
  identityKey: string
  onSelectThread: (threadId: string) => void
}

const ThreadList = ({ identityKey, onSelectThread }: ThreadListProps) => {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
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

        const result = response.outputs
        if (!result?.length) {
          setThreads([])
          return
        }

        // Prepare outputs for decoding
        const toDecode = result.map((o) => ({
            beef: o.beef,
            outputIndex: o.outputIndex,
            timestamp: parseInt(Utils.toUTF8(o.context ?? []))
            }))

        const decodedMessages = await decodeOutputs(toDecode)

        const grouped: Record<string, ThreadSummary> = {}

        for (const message of decodedMessages) {
        const { threadId, createdAt } = message

        if (!grouped[threadId]) {
            const title = `Thread ${threadId.slice(0, 10)}...`

            grouped[threadId] = {
            threadId,
            title,
            lastTimestamp: createdAt
            }
        } else {
            grouped[threadId].lastTimestamp = Math.max(
            grouped[threadId].lastTimestamp,
            createdAt
            )
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

    loadThreads()
  }, [identityKey])

  return (
    <Box sx={{ padding: 2, width: 300, borderRight: '1px solid #ccc' }}>
        <Typography variant="h6" gutterBottom>
        Threads
        </Typography>

        {loading ? (
        <CircularProgress />
        ) : (
        <List>
            {threads.map((thread) => (
            <ListItem key={thread.threadId} disablePadding>
                <ListItemButton onClick={() => onSelectThread(thread.threadId)}>
                <ListItemText
                    primary={thread.title}
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
