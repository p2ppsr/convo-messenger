import React from 'react'
import { Box, Divider, Paper, Typography, Button } from '@mui/material'
import ThreadList from './ThreadList'
import DirectMessageList from './DirectMessageList'

interface SidebarProps {
  onSelectThread: (threadId: string, recipientKeys: string[], threadName?: string) => void
  onNewThread: () => void
  onNewDM: () => void
  identityKey: string
  client: any
  protocolID: any
  keyID: string
}

const Sidebar: React.FC<SidebarProps> = ({
  onSelectThread,
  onNewThread,
  onNewDM,
  identityKey,
  client,
  protocolID,
  keyID,
}) => {
  return (
    <Box
      sx={{
        width: { xs: '100%', md: 300 },
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'background.default',
        borderRight: '1px solid rgba(255,255,255,0.08)',
        overflowY: 'auto', // scroll entire sidebar if long
      }}
    >
      {/* Group Threads */}
      <Paper elevation={0} sx={{ p: 1.5, flexShrink: 0, backgroundColor: 'background.default' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
            Group Threads
          </Typography>
          <Button size="small" variant="contained" onClick={onNewThread}>
            Start
          </Button>
        </Box>
        <ThreadList
          identityKey={identityKey}
          wallet={client}
          protocolID={protocolID}
          keyID={keyID}
          onSelectThread={onSelectThread}
        />
      </Paper>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)', my: 1 }} />

      {/* Direct Messages */}
      <Paper elevation={0} sx={{ p: 1.5, flexShrink: 0, backgroundColor: 'background.default' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
            Direct Messages
          </Typography>
          <Button size="small" variant="contained" onClick={onNewDM}>
            New
          </Button>
        </Box>
        <DirectMessageList
          identityKey={identityKey}
          wallet={client}
          protocolID={protocolID}
          keyID={keyID}
          onSelectThread={onSelectThread}
        />
      </Paper>
    </Box>
  )
}

export default Sidebar
