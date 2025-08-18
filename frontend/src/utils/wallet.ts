import { WalletClient, Utils } from '@bsv/sdk'

export const wallet = new WalletClient()

export async function myIdentityKeyHex(): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return publicKey
}

export function randomKey32(): Uint8Array {
  const a = new Uint8Array(32)
  crypto.getRandomValues(a)
  return a
}

export async function boxKeyForMember(rawKey: Uint8Array, memberIdHex: string): Promise<string> {
  const enc = await wallet.encrypt({
    protocolID: [1, 'ConvoGroupKey'],
    keyID: '1',
    counterparty: memberIdHex,
    plaintext: Array.from(rawKey)
  })
  return Utils.toBase64(enc.ciphertext)
}

export async function unboxKeyFrom(keyBoxB64: string, keyFromHex: string): Promise<Uint8Array> {
  const dec = await wallet.decrypt({
    protocolID: [1, 'ConvoGroupKey'],
    keyID: '1',
    counterparty: keyFromHex,
    ciphertext: Utils.toArray(keyBoxB64, 'base64') as number[]
  })
  return Uint8Array.from(dec.plaintext)
}
