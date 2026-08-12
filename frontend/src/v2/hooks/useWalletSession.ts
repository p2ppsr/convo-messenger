import { useCallback, useEffect, useRef, useState } from 'react'
import { HTTPWalletJSON, HTTPWalletWire, WalletClient, WalletWireTransceiver } from '@bsv/sdk'

export type WalletSession =
  | { status: 'connecting'; client: null; identityKey: null; message: string }
  | { status: 'ready'; client: WalletClient; identityKey: string; message: string }
  | { status: 'unavailable' | 'error'; client: null; identityKey: null; message: string }

const CONNECT_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 3_000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('WALLET_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function connectAvailableWallet(): Promise<WalletClient> {
  const boundFetch = window.fetch.bind(window)
  const candidates: Array<{ name: string; create: () => WalletClient }> = [
    ...(typeof (window as unknown as { CWI?: unknown }).CWI === 'object'
      ? [{ name: 'window.CWI', create: () => new WalletClient('window.CWI') }]
      : []),
    {
      name: 'Cicada',
      create: () => new WalletClient(new WalletWireTransceiver(new HTTPWalletWire(undefined, undefined, boundFetch))),
    },
    {
      name: 'secure-json-api',
      create: () => new WalletClient(new HTTPWalletJSON(undefined, 'https://localhost:2121', boundFetch)),
    },
    {
      name: 'json-api',
      create: () => new WalletClient(new HTTPWalletJSON(undefined, 'http://localhost:3321', boundFetch)),
    },
    { name: 'XDM', create: () => new WalletClient('XDM') },
  ]
  try {
    return await Promise.any(candidates.map(async (candidate) => {
      const client = candidate.create()
      await withTimeout(client.getVersion(), PROBE_TIMEOUT_MS)
      return client
    }))
  } catch {
    throw new Error('WALLET_UNAVAILABLE')
  }
}

export function useWalletSession(): { session: WalletSession; retry: () => void } {
  const attempt = useRef(0)
  const [retryToken, setRetryToken] = useState(0)
  const [session, setSession] = useState<WalletSession>({
    status: 'connecting',
    client: null,
    identityKey: null,
    message: 'Connecting securely to Metanet Client…',
  })

  const retry = useCallback(() => setRetryToken((value) => value + 1), [])

  useEffect(() => {
    const currentAttempt = ++attempt.current
    setSession({ status: 'connecting', client: null, identityKey: null, message: 'Connecting securely to Metanet Client…' })
    void (async () => {
      try {
        const client = await connectAvailableWallet()
        const authentication = await withTimeout(client.isAuthenticated(), PROBE_TIMEOUT_MS)
        if (!authentication.authenticated) await withTimeout(client.waitForAuthentication(), CONNECT_TIMEOUT_MS)
        const result = await withTimeout(client.getPublicKey({ identityKey: true }), CONNECT_TIMEOUT_MS)
        if (currentAttempt !== attempt.current) return
        setSession({ status: 'ready', client, identityKey: result.publicKey, message: 'Wallet connected' })
      } catch (error) {
        if (currentAttempt !== attempt.current) return
        const isTimeout = error instanceof Error && (error.message === 'WALLET_TIMEOUT' || error.message === 'WALLET_UNAVAILABLE')
        setSession({
          status: isTimeout ? 'unavailable' : 'error',
          client: null,
          identityKey: null,
          message: isTimeout
            ? 'Metanet Client did not respond. Open it, finish authentication, then retry.'
            : 'Convo could not establish a wallet session. Your messages have not been accessed.',
        })
      }
    })()
    return () => { attempt.current += 1 }
  }, [retryToken])

  return { session, retry }
}
