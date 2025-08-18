import { WalletClient } from '@bsv/sdk'

const isLocal = typeof window !== 'undefined' && window.location.hostname === 'localhost'

export async function getIdentityKeyHex(): Promise<string> {
  // 1) Try wallet first (desktop/mobile)
  try {
    const wallet = new WalletClient('auto', isLocal ? 'localhost' : undefined)
    const { publicKey } = await wallet.getPublicKey({ identityKey: true })
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(publicKey)) return publicKey
  } catch {
    // ignore; fall back to env
  }

  // 2) Fallback for local dev
  const k =
    typeof import.meta !== 'undefined'
      ? (import.meta as any).env?.VITE_IDENTITY_PUBKEY
      : undefined

  if (typeof k === 'string' && /^(02|03)[0-9a-fA-F]{64}$/.test(k)) return k

  throw new Error(
    'Missing identity key. Start your MetaNet Client OR set VITE_IDENTITY_PUBKEY for development.'
  )
}
