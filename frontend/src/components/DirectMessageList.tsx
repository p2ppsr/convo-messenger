import {
  Box,
  Typography,
  List,
  ListItemButton,
  ListItemText
} from '@mui/material'

import type { ThreadSummary } from './ThreadList'

interface DirectMessageListProps {
  messages: ThreadSummary[]
  onSelectThread: (threadId: string, recipientKeys: string[]) => void
}

const DirectMessageList = ({ messages, onSelectThread }: DirectMessageListProps) => {
  return (
    <Box sx={{ padding: 2, width: 300, borderLeft: '1px solid #ccc' }}>
      <Typography variant="h6" gutterBottom>
        Direct Messages
      </Typography>

      {messages.length === 0 ? (
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
              onClick={() => onSelectThread(msg.threadId, msg.recipientKeys)}
            >
              <ListItemText
                primary={
                  msg.displayNames.length > 0
                    ? msg.displayNames.join(', ')
                    : 'Unknown'
                }
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
