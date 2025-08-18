import {
  PushDrop,
  WalletClient,
  Utils,
  SymmetricKey,
  Transaction,
  TopicBroadcaster,
  Hash
} from '@bsv/sdk'
import constants from './constants'

export type OutboundMessageBody = {
  text: string
  image?: string
}

export type OutboundMessageParams = {
  threadId: string
  senderIdentityKeyHex: string
  threadKey: Uint8Array
  body: OutboundMessageBody
  messageId?: string
  sentAt?: number
}

export default async function sendMessage(params: OutboundMessageParams): Promise<{
  txid: string
  vout: number
  messageId: string
  sentAt: number
}> {
  const {
    threadId,
    senderIdentityKeyHex,
    threadKey,
    body,
    messageId = makeMessageId(),
    sentAt = Date.now()
  } = params

  if (threadKey.length !== 32) {
    throw new Error(`threadKey must be 32 bytes (got ${threadKey.length})`)
  }

  const wallet = new WalletClient('auto', constants.walletHost)
  const pushdrop = new PushDrop(wallet)
  const broadcaster = new TopicBroadcaster(
    [constants.overlayTM],
    { networkPreset: constants.networkPreset }
  )

  // 1) Encrypt the plaintext JSON with the thread symmetric key.
  const plaintext = Utils.toArray(JSON.stringify(body), 'utf8') as number[]
  const sym = new SymmetricKey(Array.from(threadKey))
  const sealedAny = sym.encrypt(plaintext)
  const sealed = Array.isArray(sealedAny)
    ? sealedAny
    : (Utils.toArray(sealedAny, 'hex') as number[])

  const iv   = sealed.slice(0, 32)
  const tail = sealed.slice(32)
  const tag  = tail.slice(-16)
  const ct   = tail.slice(0, -16)

  // 2) Build the PushDrop locking script fields (order must match decoder)
  const fields: number[][] = [
    Utils.toArray(threadId, 'utf8') as number[],
    Utils.toArray(messageId, 'utf8') as number[],
    Utils.toArray(senderIdentityKeyHex, 'utf8') as number[],
    Utils.toArray(String(sentAt), 'utf8') as number[],
    Utils.toArray(Utils.toBase64(iv), 'utf8') as number[],
    Utils.toArray(Utils.toBase64(tag), 'utf8') as number[],
    Utils.toArray(Utils.toBase64(ct), 'utf8') as number[]
  ]

  const lockingScript = await pushdrop.lock(
    fields,
    [2, 'ConvoMessenger'],
    '1',
    'anyone',
    true
  )

  // 3) Build the TX output and create/sign with the wallet
  const { tx } = await wallet.createAction({
    outputs: [
      {
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: 'Convo Message',
        basket: constants.basket
      }
    ],
    description: 'Convo: send message',
    options: {
      acceptDelayedBroadcast: false,
      randomizeOutputs: false
    }
  })

  if (!tx) throw new Error('Transaction creation failed')

  // 4) Broadcast to overlay topic
  const transaction = Transaction.fromAtomicBEEF(tx)
  const txid = transaction.id('hex')
  const vout = 0

  await broadcaster.broadcast(transaction)

  return { txid, vout, messageId, sentAt }
}

function makeMessageId(): string {
  const seed = `${Date.now()}_${Math.random()}`
  return Utils.toHex(Hash.sha256(Utils.toArray(seed, 'utf8') as number[]))
}
