import { useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { useNavigate, useParams, useLocation } from 'react-router-dom'

// Components
import ThreadList from './ThreadList'
import DirectMessageList from './DirectMessageList'
import ComposeThread from './ComposeThread'
import ComposeDirectMessage from './ComposeDirectMessage'
import Chat from './Chat'

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
  const { threadId } = useParams()
  const location = useLocation()

  const [showComposeThread, setShowComposeThread] = useState(false)
  const [showComposeDM, setShowComposeDM] = useState(false)

  const handleThreadSelect = (
    threadId: string,
    recipientPublicKeys: string[],
    threadName?: string
  ) => {
    navigate(`/thread/${threadId}`, {
      state: { recipientPublicKeys, threadName }
    })
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      {/* Column 1: Group Threads */}
      <Box
        sx={{
          width: 280,
          backgroundColor: '#1e1e1e',
          color: 'white',
          borderRight: '1px solid #444',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          p: 2
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
          <Button
            variant="contained"
            onClick={() => setShowComposeThread(true)}
            size="small"
          >
            Start
          </Button>
        </Box>

        <ThreadList
          identityKey={identityKey}
          wallet={walletClient}
          protocolID={protocolID}
          keyID={keyID}
          onSelectThread={handleThreadSelect}
        />

        {showComposeThread && (
          <ComposeThread
            client={walletClient}
            senderPublicKey={identityKey}
            protocolID={protocolID}
            keyID={keyID}
            onThreadCreated={(threadId, recipientPublicKeys, threadName) => {
              setShowComposeThread(false)
              handleThreadSelect(threadId, recipientPublicKeys, threadName)
            }}
            onClose={() => setShowComposeThread(false)}
          />
        )}
      </Box>

      {/* Column 2: Direct Messages */}
      <Box
        sx={{
          width: 280,
          backgroundColor: '#1e1e1e',
          color: 'white',
          borderRight: '1px solid #444',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          p: 2
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
          <Button
            variant="contained"
            onClick={() => setShowComposeDM(true)}
            size="small"
          >
            New
          </Button>
        </Box>

        <DirectMessageList
          identityKey={identityKey}
          wallet={walletClient}
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
            onCreate={(threadId: string, recipientKeys: string[]) => {
              setShowComposeDM(false)
              handleThreadSelect(threadId, recipientKeys)
            }}
            onClose={() => setShowComposeDM(false)}
          />
        )}
      </Box>

      {/* Column 3: Chat View or Placeholder */}
      <Box
        sx={{
          flex: 1,
          backgroundColor: '#121212',
          color: 'white',
          display: 'flex',
          flexDirection: 'column',
          p: 2
        }}
      >
        {threadId ? (
          <Chat
            client={walletClient}
            senderPublicKey={identityKey}
            protocolID={protocolID}
            keyID={keyID}
            threadId={threadId}
            recipientPublicKeys={location.state?.recipientPublicKeys || []}
            threadName={location.state?.threadName}
          />
        ) : (
          <Typography variant="h5" sx={{ color: '#888' }}>
            Select a thread to view messages.
          </Typography>
        )}
      </Box>
    </Box>
  )
}

export default Home
