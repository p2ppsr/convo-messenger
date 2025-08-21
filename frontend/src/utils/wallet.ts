// utils/wallet.ts
//
// Tiny wallet utilities used across the app.
// - We centralize construction of WalletClient so the whole app talks to the same host.
// - We still expose the old per-member key boxing helpers for backward compatibility,
//   but new flows use CurvePoint envelopes instead (see createThreadAndInvite/syncThreads).

import { WalletClient, Utils } from '@bsv/sdk'
import constants from './constants'

/**
 * Single WalletClient instance for the UI.
 * 'auto' selects the right transport (desktop/mobile/bridge) and we pass our host
 * so local dev works the same way everywhere.
 */
export const wallet = new WalletClient('auto', constants.walletHost)

/**
 * Return my compressed identity public key (02/03… hex).
 * Caller code treats this as the stable user identifier on-chain.
 */
export async function myIdentityKeyHex(): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return publicKey
}

/**
 * Generate a fresh 32-byte random key (Uint8Array).
 * We use this for legacy AES-GCM thread keys and sometimes as seeds.
 * CurvePoint messages don’t require this, but we keep it for interop.
 */
export function randomKey32(): Uint8Array {
  const a = new Uint8Array(32)
  crypto.getRandomValues(a)
  return a
}

/* ===========================================================================
   LEGACY PER-MEMBER BOXING HELPERS
   ---------------------------------------------------------------------------
   New threads use CurvePoint to wrap (envelope) the group key once, sealing it
   to all recipients at once. The overlay stores that envelope.

   These helpers remain for:
   - backward compatibility (old threads that still box the key per member);
   - migration paths where we may need to regenerate the old “keyBox” fields.

   Protocol: [1, 'ConvoGroupKey'] / keyID '1'
   ========================================================================== */

/**
 * Encrypt (box) a raw 32-byte group key for a single member.
 * Returns base64 ciphertext suitable for storing in a membership record.
 *
 * @deprecated Use CurvePoint envelopes instead (see createThreadAndInvite).
 */
export async function boxKeyForMember(rawKey: Uint8Array, memberIdHex: string): Promise<string> {
  const enc = await wallet.encrypt({
    protocolID: [1, 'ConvoGroupKey'],
    keyID: '1',
    counterparty: memberIdHex,
    plaintext: Array.from(rawKey)
  })
  return Utils.toBase64(enc.ciphertext)
}

/**
 * Decrypt (unbox) a legacy per-member key box that was produced by boxKeyForMember.
 * Returns the raw 32-byte group key as Uint8Array.
 *
 * @deprecated Prefer decrypting CurvePoint envelopes (see syncThreads) when available.
 */
export async function unboxKeyFrom(keyBoxB64: string, keyFromHex: string): Promise<Uint8Array> {
  const dec = await wallet.decrypt({
    protocolID: [1, 'ConvoGroupKey'],
    keyID: '1',
    counterparty: keyFromHex,
    ciphertext: Utils.toArray(keyBoxB64, 'base64') as number[]
  })
  return Uint8Array.from(dec.plaintext)
}
