// frontend/src/components/Home.tsx

import { useEffect, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'

// Components
import MainLayout from './MainLayout'
import ThreadList from './ThreadList'
import DirectMessageList from './DirectMessageList'
import ComposeThread from './ComposeThread'
import ComposeDirectMessage from './ComposeDirectMessage'

// Utils
import { loadAllMessages, type ThreadSummary } from '../utils/loadAllMessages'

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
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [directMessages, setDirectMessages] = useState<ThreadSummary[]>([])

  const handleThreadSelect = (
    threadId: string,
    recipientPublicKeys: string[],
    threadName?: string
  ) => {
    navigate(`/thread/${threadId}`, {
      state: { recipientPublicKeys, threadName }
    })
  }

  // --- Polling all messages ---
  useEffect(() => {
    let isMounted = true

    const fetchMessages = async () => {
      try {
        const result = await loadAllMessages(walletClient, identityKey, protocolID, keyID)
        if (isMounted) {
          setThreads(result.threads)
          setDirectMessages(result.directMessages)
        }
      } catch (err) {
        console.error('[Home] Failed to load messages:', err)
      }
    }

    fetchMessages()
    const interval = setInterval(fetchMessages, 10000) // poll every 10s

    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [walletClient, identityKey, protocolID, keyID])

  // --- Sidebar: Thread List + Button ---
  const sidebar = (
    <Box sx={{ p: 2 }}>
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
          Start Thread
        </Button>
      </Box>

      <ThreadList
        threads={threads}
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
  )

  // --- Main Content: Direct Messages + Button ---
  const content = (
    <Box sx={{ p: 2 }}>
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
          New 1-on-1
        </Button>
      </Box>

      <DirectMessageList
        messages={directMessages}
        onSelectThread={handleThreadSelect}
      />

      {showComposeDM && (
        <ComposeDirectMessage
          open={showComposeDM}
          client={walletClient}
          senderPublicKey={identityKey}
          protocolID={protocolID}
          keyID={keyID}
          onCreate={((threadId: string, recipientKeys: string[]) => {
            setShowComposeDM(false)
            handleThreadSelect(threadId, recipientKeys)
          }) as unknown as (threadId: string) => void}
          onClose={() => setShowComposeDM(false)}
        />
      )}
    </Box>
  )

  return <MainLayout sidebar={sidebar} content={content} />
}

export default Home
