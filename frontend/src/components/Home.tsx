import { useState } from 'react'
import { Box, Typography, IconButton } from '@mui/material'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'

// Components
import Sidebar from './Sidebar'
import ComposeThread from './ComposeThread'
import ComposeDirectMessage from './ComposeDirectMessage'
import Chat from './Chat'

// Utils
import { useIsMobile } from '../utils/useIsMobile'

// Types
import type { WalletClient, WalletProtocol, LookupResolver } from '@bsv/sdk'

interface HomeProps {
  identityKey: string
  walletClient: WalletClient
  protocolID: WalletProtocol
  keyID: string
  resolver: LookupResolver
}

const Home: React.FC<HomeProps> = ({
  identityKey,
  walletClient,
  protocolID,
  keyID,
  resolver
}) => {
  const navigate = useNavigate()
  const { threadId } = useParams()
  const location = useLocation()

  const [showComposeThread, setShowComposeThread] = useState(false)
  const [showComposeDM, setShowComposeDM] = useState(false)

  const isMobile = useIsMobile()

  const handleThreadSelect = (
    threadId: string,
    recipientPublicKeys: string[],
    threadName?: string
  ) => {
    navigate(`/thread/${threadId}`, {
      state: { recipientPublicKeys, threadName }
    })
  }

  const handleBack = () => {
    navigate('/') // Go back to the list on mobile
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh', bgcolor: '#121212' }}>
      {/* Desktop: Sidebar + Chat split */}
      {!isMobile && (
        <>
          <Sidebar
            onSelectThread={handleThreadSelect}
            onNewThread={() => setShowComposeThread(true)}
            onNewDM={() => setShowComposeDM(true)}
            identityKey={identityKey}
            client={walletClient}
            protocolID={protocolID}
            keyID={keyID}
            resolver={resolver}
          />

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
                resolver={resolver}
              />
            ) : (
              <Typography variant="h5" sx={{ color: '#888' }}>
                Select a thread to view messages.
              </Typography>
            )}
          </Box>
        </>
      )}

      {/* Mobile: show either Sidebar OR Chat */}
      {isMobile && (
        <>
          {!threadId && (
            <Box
              sx={{
                flex: 1,
                width: '100%',     // Full width on mobile
                height: '100%',    // Full height viewport
                display: 'flex',
                flexDirection: 'column',
                bgcolor: '#121212'
              }}
            >
              <Sidebar
                onSelectThread={handleThreadSelect}
                onNewThread={() => setShowComposeThread(true)}
                onNewDM={() => setShowComposeDM(true)}
                identityKey={identityKey}
                client={walletClient}
                protocolID={protocolID}
                keyID={keyID}
                resolver={resolver}
              />
            </Box>
          )}

          {threadId && (
            <Box
              sx={{
                flex: 1,
                width: '100%',     // Full width on mobile
                height: '100%',    // Full height viewport
                backgroundColor: '#121212',
                color: 'white',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* Sticky header on mobile */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  p: 1.5,
                  borderBottom: '1px solid #333',
                  position: 'sticky',
                  top: 0,
                  zIndex: 10,
                  backgroundColor: '#121212',
                }}
              >
                <IconButton
                  onClick={handleBack}
                  sx={{ color: 'white', mr: 1 }}
                  size="small"
                >
                  <ArrowBackIcon fontSize="small" />
                </IconButton>
                <Typography
                  variant="subtitle1"
                  sx={{
                    color: 'white',
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {location.state?.threadName || 'Chat'}
                </Typography>
              </Box>

              {/* Chat body scrolls under sticky header */}
              <Box sx={{ flex: 1, overflowY: 'auto' }}>
                <Chat
                  client={walletClient}
                  senderPublicKey={identityKey}
                  protocolID={protocolID}
                  keyID={keyID}
                  threadId={threadId}
                  recipientPublicKeys={location.state?.recipientPublicKeys || []}
                  threadName={location.state?.threadName}
                  resolver={resolver}
                />
              </Box>
            </Box>
          )}
        </>
      )}

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
