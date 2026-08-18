import { useCallback, useEffect, useRef, useState } from 'react'
import { WalletClient } from '@bsv/sdk'

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

export async function connectWithSdkAuto<T extends { getVersion: () => Promise<unknown> }>(
  createClient: () => T,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<T> {
  const client = createClient()
  try {
    await withTimeout(client.getVersion(), timeoutMs)
    return client
  } catch {
    throw new Error('WALLET_UNAVAILABLE')
  }
}

export function createAutoWalletClient(): WalletClient {
  return new WalletClient('auto')
}

async function connectAvailableWallet(): Promise<WalletClient> {
  // The SDK owns substrate priority and fallback semantics. This preserves
  // binary Cicada while allowing embedded wallets to answer over CWI or XDM.
  return await connectWithSdkAuto(createAutoWalletClient)
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
