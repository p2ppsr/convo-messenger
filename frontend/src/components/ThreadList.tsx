// frontend/src/components/ThreadList.tsx

import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  ListItemButton
} from '@mui/material'

export interface ThreadSummary {
  threadId: string
  displayNames: string[]
  recipientKeys: string[]
  lastTimestamp: number
  threadName?: string
}

interface ThreadListProps {
  threads: ThreadSummary[]
  onSelectThread: (threadId: string, recipientKeys: string[]) => void
}

const ThreadList = ({ threads, onSelectThread }: ThreadListProps) => {
  return (
    <Box sx={{ padding: 2, width: 300, borderRight: '1px solid #ccc' }}>
      <Typography variant="h6" gutterBottom>
        Threads
      </Typography>

      <List>
        {threads.map((thread) => (
          <ListItem key={thread.threadId} disablePadding>
            <ListItemButton
              onClick={() => onSelectThread(thread.threadId, thread.recipientKeys)}
            >
              <ListItemText
                primary={
                  thread.threadName
                    ? thread.threadName
                    : thread.displayNames.length > 0
                      ? `To: ${thread.displayNames.join(', ')}`
                      : 'Unnamed Thread'
                }
                secondary={`Last activity: ${new Date(thread.lastTimestamp).toLocaleString()}`}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Box>
  )
}

export default ThreadList
