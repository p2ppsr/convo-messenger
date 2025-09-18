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

/**
 * Props passed into Home
 * - identityKey: current user's public identity key
 * - walletClient: WalletClient instance for blockchain actions
 * - protocolID: namespace identifier (ex: [2, 'convo'])
 * - keyID: which key derivation index to use
 */
interface HomeProps {
  identityKey: string
  walletClient: WalletClient
  protocolID: WalletProtocol
  keyID: string
}

/**
 * Home component
 * This is the **main layout** of Convo Messenger:
 * - Column 1: Group Threads sidebar
 * - Column 2: Direct Messages sidebar
 * - Column 3: Main Chat area
 *
 * Navigation between threads is handled via react-router,
 * so the currently open threadId comes from URL params.
 */
const Home: React.FC<HomeProps> = ({
  identityKey,
  walletClient,
  protocolID,
  keyID
}) => {
  const navigate = useNavigate()
  const { threadId } = useParams() // threadId is in the URL (e.g. /thread/:threadId)
  const location = useLocation()   // holds extra state like recipients, threadName

  // Dialog toggles
  const [showComposeThread, setShowComposeThread] = useState(false)
  const [showComposeDM, setShowComposeDM] = useState(false)

  /**
   * Called when a thread is selected from either sidebar.
   * - Updates the route to /thread/:threadId
   * - Passes along recipients + threadName in navigation state
   */
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
        {/* Header row: label + "Start" button */}
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

        {/* Group threads list */}
        <ThreadList
          identityKey={identityKey}
          wallet={walletClient}
          protocolID={protocolID}
          keyID={keyID}
          onSelectThread={handleThreadSelect}
        />

        {/* ComposeThread modal */}
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
        {/* Header row: label + "New" button */}
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

        {/* Direct message list */}
        <DirectMessageList
          identityKey={identityKey}
          wallet={walletClient}
          protocolID={protocolID}
          keyID={keyID}
          onSelectThread={handleThreadSelect}
        />

        {/* ComposeDirectMessage modal */}
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

      {/* Column 3: Chat View (main panel) */}
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
          // If a thread is selected, render Chat with its props
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
          // Placeholder if no thread selected
          <Typography variant="h5" sx={{ color: '#888' }}>
            Select a thread to view messages.
          </Typography>
        )}
      </Box>
    </Box>
  )
}

export default Home
