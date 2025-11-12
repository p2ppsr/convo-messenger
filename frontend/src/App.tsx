// frontend/src/App.tsx

import { useEffect, useState } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { WalletClient, SecurityLevel, LookupResolver } from '@bsv/sdk'
import { ThemeProvider, CssBaseline } from '@mui/material'
import theme from './theme'

import Home from './components/Home'
import checkForMetaNetClient from './utils/checkForMetaNetClient'

import './App.scss'

const App = () => {
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null)
  const [identityKey, setIdentityKey] = useState<string | null>(null)

  const [resolver] = useState(
    () =>
      new LookupResolver({
        networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet',
      })
  )

  useEffect(() => {
    const init = async () => {
      const client = new WalletClient('auto', 'localhost')
      const status = await checkForMetaNetClient()

      if (status === 0) {
        console.warn('[Convo] MetaNet client not detected (read-only mode).')
      } else {
        await client.waitForAuthentication()
        console.log('[Convo] MetaNet client authenticated.')
      }

      // Use MetaNet Identity Key
      const pubkey = await client.getPublicKey({ identityKey: true })
      setWalletClient(client)
      setIdentityKey(pubkey.publicKey)
    }

    init()
  }, [resolver])

  if (!walletClient || !identityKey) {
    return <div className="loading">Connecting to MetaNet Client...</div>
  }

  const protocolID: [SecurityLevel, string] = [2, 'convo']
  const keyID = '1'

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
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
                resolver={resolver}
              />
            }
          />
          <Route
            path="/thread/:threadId"
            element={
              <Home
                identityKey={identityKey}
                walletClient={walletClient}
                protocolID={protocolID}
                keyID={keyID}
                resolver={resolver}
              />
            }
          />
        </Routes>
      </Router>
    </ThemeProvider>
  )
}

export default App
