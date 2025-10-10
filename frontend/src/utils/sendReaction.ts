import {
  PushDrop, WalletClient, Transaction, Utils, TopicBroadcaster, Hash
} from '@bsv/sdk'

export interface SendReactionOptions {
    client: WalletClient
    senderPublicKey: string
    threadId: string
    reaction: string
    topic?: string
    basket?: string
    messageTxid: string
    messageVout: number
}

export async function sendReaction({
  client,
  senderPublicKey,
  threadId,
  reaction,
  topic = 'convo',
  basket = 'convo',
  messageTxid,
  messageVout,
}: SendReactionOptions): Promise<string> {
  const pushdrop = new PushDrop(client)
  const broadcaster = new TopicBroadcaster([`tm_${topic}`], {
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  const timestamp = Date.now()
  const uniqueID = Utils.toHex(Hash.sha256(Utils.toArray(Math.random().toString(), 'utf8')))

   const fields = [
    Utils.toArray('tmconvo_reaction', 'utf8'),  // 0: marker
    Utils.toArray(threadId, 'utf8'),            // 1: thread id
    Utils.toArray(messageTxid, 'utf8'),         // 2: target txid
    Utils.toArray(String(messageVout), 'utf8'), // 3: target vout
    Utils.toArray(reaction, 'utf8'),            // 4: emoji or label
    Utils.toArray(senderPublicKey, 'utf8'),     // 5: sender key
    Utils.toArray(String(timestamp), 'utf8'),   // 6: timestamp
    Utils.toArray(uniqueID, 'utf8')             // 7: unique reaction id
  ]

  const lockingScript = await pushdrop.lock(fields, [2, basket], '1', 'anyone', true)
  const { tx } = await client.createAction({
    outputs: [
      {
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: 'Convo Reaction',
        basket
      }
    ],
    description: 'Send convo reaction',
    options: {
      acceptDelayedBroadcast: false,
      randomizeOutputs: false
    }
  })

  if (!tx) {
    throw new Error('[Convo Reaction] Failed to create reaction transaction.')
  }

  const transaction = Transaction.fromAtomicBEEF(tx)
  const txid = transaction.id('hex')
  // Broadcast to overlay
  try {
    await broadcaster.broadcast(transaction)
    console.log(`[Convo Reaction] Broadcast to overlay succeeded. txid: ${txid}`)
  } catch (error) {
    console.error(`[Convo Reaction] Broadcast failed:`, error)
    throw error
  }

  return txid
}

