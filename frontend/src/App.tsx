// frontend/src/App.tsx

import { useEffect, useState } from 'react'
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom'
import { WalletClient, SecurityLevel } from '@bsv/sdk'

// Components
import ThreadList from './components/ThreadList'
import Chat from './components/Chat'

// Utils
import checkForMetaNetClient from './utils/checkForMetaNetClient'

// Styles
import './App.scss'

const App = () => {
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null)
  const [identityKey, setIdentityKey] = useState<string | null>(null)

  useEffect(() => {
    const initWallet = async () => {
      const client = new WalletClient('auto', 'localhost')

      const status = await checkForMetaNetClient()

      if (status === 0) {
        console.warn('[Convo] MetaNet client not detected. Read-only mode enabled.')
        return
      }

      await client.waitForAuthentication()
      console.log('[Convo] MetaNet client detected and authenticated.')

      await client.getPublicKey({ identityKey: true }) // preload identity key

      const pubkey = await client.getPublicKey({
        protocolID: [2, 'convo'],
        keyID: '1',
        counterparty: 'self'
      })

      console.log('[Convo] Derived identity key:', pubkey)
      setWalletClient(client)
      setIdentityKey(pubkey.publicKey)
    }

    initWallet()
  }, [])

  if (!walletClient || !identityKey) {
    return <div className="loading">Connecting to MetaNet Client...</div>
  }

return (
  <Router>
    <Routes>
      <Route
        path="/"
        element={
          <ThreadList
            identityKey={identityKey}
            onSelectThread={(threadId) => {
              window.location.href = `/thread/${threadId}`
            }}
          />
        }
      />
      <Route
        path="/thread/:threadId"
        element={
          <ChatWrapper
            wallet={walletClient}
            identityKey={identityKey}
          />
        }
      />
    </Routes>
  </Router>
)
}

export default App

// ChatWrapper component to extract threadId and render Chat
const ChatWrapper = ({
  wallet,
  identityKey
}: {
  wallet: WalletClient
  identityKey: string
}) => {
  const { threadId } = useParams()

  const protocolID: [SecurityLevel, string] = [2, 'convo']
  const keyID = '1'

  // TODO: Replace with actual thread data or state later
  const recipientPublicKeys: string[] = []

  if (!threadId) return <div>Invalid thread ID</div>

  return (
    <Chat
      threadId={threadId}
      client={wallet}
      protocolID={protocolID}
      keyID={keyID}
      senderPublicKey={identityKey}
      recipientPublicKeys={recipientPublicKeys}
    />
  )
}
