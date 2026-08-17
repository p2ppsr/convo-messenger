import { useCallback, useEffect, useRef, useState } from 'react'
import { HTTPWalletJSON, HTTPWalletWire, WalletClient, WalletWireTransceiver } from '@bsv/sdk'

export type WalletSession =
  | { status: 'connecting'; client: null; identityKey: null; message: string }
  | { status: 'ready'; client: WalletClient; identityKey: string; message: string }
  | { status: 'unavailable' | 'error'; client: null; identityKey: null; message: string }

const CONNECT_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 3_000
const BRIDGE_PROBE_TIMEOUT_MS = 3_000
const XDM_PROBE_TIMEOUT_MS = 750

type WalletProbe<T> = {
  create: () => T
  timeoutMs: number
}

type LocalNetworkRequestInit = RequestInit & {
  targetAddressSpace: 'local'
}

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

export async function connectFirstAvailableWallet<T extends { getVersion: () => Promise<unknown> }>(candidates: Array<WalletProbe<T>>): Promise<T> {
  for (const candidate of candidates) {
    try {
      const client = candidate.create()
      await withTimeout(client.getVersion(), candidate.timeoutMs)
      return client
    } catch {
      // Wallet substrates are fallbacks. Continue in priority order.
    }
  }
  throw new Error('WALLET_UNAVAILABLE')
}

export function createLocalNetworkFetch(baseFetch: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => baseFetch(input, {
    ...init,
    targetAddressSpace: 'local',
  } as LocalNetworkRequestInit)) as typeof fetch
}

async function connectAvailableWallet(): Promise<WalletClient> {
  const boundFetch = window.fetch.bind(window)
  const localNetworkFetch = createLocalNetworkFetch(boundFetch)
  // Convo targets the local Metanet Client first; stop discovery as soon as its
  // binary Cicada substrate answers so lower-priority transports are untouched.
  const candidates: Array<WalletProbe<WalletClient>> = [
    {
      create: () => new WalletClient(new WalletWireTransceiver(new HTTPWalletWire(undefined, undefined, localNetworkFetch))),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
    ...(typeof (window as unknown as { CWI?: unknown }).CWI === 'object'
      ? [{ create: () => new WalletClient('window.CWI'), timeoutMs: BRIDGE_PROBE_TIMEOUT_MS }]
      : []),
    {
      create: () => new WalletClient(new HTTPWalletJSON(undefined, 'https://localhost:2121', localNetworkFetch)),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
    {
      create: () => new WalletClient(new HTTPWalletJSON(undefined, 'http://localhost:3321', localNetworkFetch)),
      timeoutMs: PROBE_TIMEOUT_MS,
    },
    { create: () => new WalletClient('XDM'), timeoutMs: XDM_PROBE_TIMEOUT_MS },
  ]
  return await connectFirstAvailableWallet(candidates)
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
