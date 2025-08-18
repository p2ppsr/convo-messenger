import { WalletClient, PushDrop, Utils, Transaction, TopicBroadcaster } from '@bsv/sdk'
import constants from './constants'

type Invitee = { identityKeyHex: string; role?: 'member' | 'admin' }

export async function createThreadAndInvite (args: {
  threadId: string
  title?: string
  groupKey: Uint8Array
  members: Invitee[]
}) {
  const { threadId, title, groupKey, members } = args
  const wallet = new WalletClient()

  const { publicKey: creatorIdentityHex } = await wallet.getPublicKey({ identityKey: true })

  const boxes: Record<string, string> = {}
  for (const m of members) {
    const enc = await wallet.encrypt({
      protocolID: [1, 'ConvoGroupKey'],
      keyID: '1',
      counterparty: m.identityKeyHex,
      plaintext: Array.from(groupKey)
    })
    boxes[m.identityKeyHex.toLowerCase()] = Utils.toBase64(enc.ciphertext)
  }

  const fields: number[][] = [
    Utils.toArray('ls_convo', 'utf8'),
    Utils.toArray('convo-v1', 'utf8'),
    Utils.toArray('create_thread', 'utf8'),
    Utils.toArray(threadId, 'utf8'),
    Utils.toArray(title ?? '', 'utf8'),
    Utils.toArray(JSON.stringify({ boxes }), 'utf8'),
    Utils.toArray(creatorIdentityHex, 'hex'),
    Utils.toArray(String(Date.now()), 'utf8')
  ]

  const pushdrop = new PushDrop(wallet)
  const script = await pushdrop.lock(fields, [1, 'ConvoMessenger'], '1', 'anyone', true)

  const { txid, tx } = await wallet.createAction({
    description: 'Create Convo thread',
    outputs: [{
      basket: constants.basket,
      lockingScript: script.toHex(),
      satoshis: 1,
      outputDescription: 'Convo thread control'
    }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })

  if (tx) {
    const broadcaster = new TopicBroadcaster([constants.overlayTM], {
      networkPreset: constants.networkPreset
    })
    await broadcaster.broadcast(Transaction.fromAtomicBEEF(tx))
  }

  return { txid }
}
