import { useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'

// Components
import ThreadList from './ThreadList'
import DirectMessageList from './DirectMessageList.js'
import ComposeThread from './ComposeThread'
import ComposeDirectMessage from './ComposeDirectMessage.js'

// Types
import type { WalletClient, WalletProtocol } from '@bsv/sdk'

interface HomeProps {
  identityKey: string
  walletClient: WalletClient
  protocolID: WalletProtocol
  keyID: string
}

const Home: React.FC<HomeProps> = ({
  identityKey,
  walletClient,
  protocolID,
  keyID
}) => {
  const navigate = useNavigate()
  const [showComposeThread, setShowComposeThread] = useState(false)
  const [showComposeDM, setShowComposeDM] = useState(false)

  const handleThreadSelect = (threadId: string) => {
    navigate(`/thread/${threadId}`)
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* LEFT: Thread list + new thread button */}
      <Box
        sx={{
          width: '50%',
          borderRight: '1px solid #ccc',
          padding: 2,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 2
          }}
        >
          <Typography variant="h6">Group Threads</Typography>
          <Button variant="contained" onClick={() => setShowComposeThread(true)}>
            Start Thread
          </Button>
        </Box>

        <ThreadList
          identityKey={identityKey}
          onSelectThread={handleThreadSelect}
        />

        {showComposeThread && (
          <ComposeThread
            client={walletClient}
            senderPublicKey={identityKey}
            protocolID={protocolID}
            keyID={keyID}
            onThreadCreated={(threadId) => {
              setShowComposeThread(false)
              handleThreadSelect(threadId)
            }}
            onClose={() => setShowComposeThread(false)}
          />
        )}
      </Box>

      {/* RIGHT: DM list + new DM button */}
      <Box
        sx={{
          width: '50%',
          padding: 2,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 2
          }}
        >
          <Typography variant="h6">1-on-1 Messages</Typography>
          <Button variant="contained" onClick={() => setShowComposeDM(true)}>
            New 1-on-1
          </Button>
        </Box>

        <DirectMessageList
          identityKey={identityKey}
          client={walletClient}
          protocolID={protocolID}
          keyID={keyID}
          onSelectThread={handleThreadSelect}
        />

        {showComposeDM && (
          <ComposeDirectMessage
            open={showComposeDM}
            client={walletClient}
            senderPublicKey={identityKey}
            protocolID={protocolID}
            keyID={keyID}
            onCreate={(threadId: string) => {
              setShowComposeDM(false)
              handleThreadSelect(threadId)
            }}
            onClose={() => setShowComposeDM(false)}
          />
        )}
      </Box>
    </Box>
  )
}

export default Home
