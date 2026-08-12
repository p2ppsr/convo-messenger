import { CompletedProtoWallet, PrivateKey, type WalletInterface } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { generateRootKey } from '../domain/crypto'
import { openEpochKey, sealEpochKey } from './messaging'

describe('CurvePoint epoch envelopes', () => {
  it('lets every private group member open the root key and excludes non-members', async () => {
    const wallets = [0, 1, 2, 3].map(() => new CompletedProtoWallet(PrivateKey.fromRandom()))
    const identities = await Promise.all(wallets.map(async (wallet) => (await wallet.getPublicKey({ identityKey: true })).publicKey))
    const rootKey = generateRootKey()
    const conversationId = 'ab'.repeat(32)
    const envelope = await sealEpochKey(wallets[0] as unknown as WalletInterface, conversationId, {
      epoch: 1,
      rootKey,
      members: identities.slice(0, 3),
      admins: [identities[0]],
      activatedAt: 1,
    })
    for (const wallet of wallets.slice(0, 3)) {
      await expect(openEpochKey(wallet as unknown as WalletInterface, conversationId, 1, envelope)).resolves.toBe(rootKey)
    }
    await expect(openEpochKey(wallets[3] as unknown as WalletInterface, conversationId, 1, envelope)).rejects.toThrow()
  })
})
