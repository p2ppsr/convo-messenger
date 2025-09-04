// frontend/src/App.tsx

import { useEffect, useState } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { WalletClient, SecurityLevel } from '@bsv/sdk'

// Components
import Home from './components/Home'
import { Chat } from './components/Chat'

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

      const pubkey = await client.getPublicKey({ identityKey: true })

      console.log('[Convo] Derived identity key:', pubkey)
      setWalletClient(client)
      setIdentityKey(pubkey.publicKey)
    }

    initWallet()
  }, [])

  if (!walletClient || !identityKey) {
    return <div className="loading">Connecting to MetaNet Client...</div>
  }

  const protocolID: [SecurityLevel, string] = [2, 'convo']
  const keyID = '1'

  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={
            <Home
              identityKey={identityKey}
              walletClient={walletClient}
              protocolID={protocolID}
              keyID={keyID}
            />
          }
        />
      <Route
          path="/thread/:threadId"
          element={(
            <Chat
              client={walletClient}
              senderPublicKey={identityKey}
              protocolID={protocolID}
              keyID={keyID}
              recipientPublicKeys={[]}
            />
          )}
        />
      </Routes>
    </Router>
  )
}

export default App
