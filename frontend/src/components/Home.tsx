import { useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useNavigate, useParams, useLocation } from 'react-router-dom'

// Components
import Sidebar from './Sidebar'
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
      {/* Sidebar (threads + DMs stacked) */}
      <Sidebar
        onSelectThread={handleThreadSelect}
        onNewThread={() => setShowComposeThread(true)}
        onNewDM={() => setShowComposeDM(true)}
        identityKey={identityKey}
        client={walletClient}
        protocolID={protocolID}
        keyID={keyID}
      />

      {/* Chat view */}
      <Box
        sx={{
          flex: 1,
          backgroundColor: '#121212',
          color: 'white',
          display: 'flex',
          flexDirection: 'column',
          p: 2,
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

      {/* Modals for composing new threads/DMs */}
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
  )
}

export default Home
