// src/utils/sendMessage.ts
import {
  PushDrop,
  WalletClient,
  Utils,
  Transaction,
  TopicBroadcaster,
  Hash
} from '@bsv/sdk'
import constants from './constants'
import { CurvePoint } from 'curvepoint'
import { getThreadParticipants } from './threadStore' // must return identity keys for this thread

/**
 * Shape of the cleartext message payload that we encrypt per message.
 * You can add more fields later; this is just the minimal text + optional image ref.
 */
export type OutboundMessageBody = {
  text: string
  image?: string
}

/**
 * Params used to send a message.
 *
 * - `threadId` uniquely identifies the conversation (we use it in the PushDrop fields).
 * - `senderIdentityKeyHex` is our wallet identity pubkey (compressed hex) that the UI already fetched.
 * - `threadKey` is deprecated; CurvePoint owns per-message symmetric keys now. Kept for BC only.
 * - `recipients` optionally overrides who gets access. If omitted, we read them from threadStore.
 * - `body` is the plaintext we will JSON-serialize and encrypt with CurvePoint.
 * - `messageId` & `sentAt` can be provided by caller for deterministic testing; otherwise auto-filled.
 */
export type OutboundMessageParams = {
  threadId: string
  senderIdentityKeyHex: string
  /** ⛔️ DEPRECATED: no longer used with CurvePoint; kept for backward compatibility */
  threadKey?: Uint8Array
  /** Optional explicit recipients; if omitted, pulled from threadStore */
  recipients?: string[]
  body: OutboundMessageBody
  messageId?: string
  sentAt?: number
}

/**
 * Encrypts the message with CurvePoint, builds a PushDrop output carrying the
 * CurvePoint header + ciphertext, signs the tx with the wallet, and broadcasts
 * it via the Topic Broadcaster so the overlay indexes it for lookup.
 *
 * Returns the basic broadcast info plus the messageId/sentAt that got used.
 */
export default async function sendMessage(params: OutboundMessageParams): Promise<{
  txid: string
  vout: number
  messageId: string
  sentAt: number
}> {
  const {
    threadId,
    senderIdentityKeyHex,
    recipients: recipientsParam,
    body,
    messageId = makeMessageId(),
    sentAt = Date.now()
  } = params

  /**
   * Resolve the list of recipients to seal this message to.
   * - If caller passed an explicit list, use that.
   * - Otherwise, pull it from our local threadStore (what we saved at thread creation/sync).
   * Normalize to lowercase compressed hex and de-dupe.
   */
  const recipients = (recipientsParam ?? getThreadParticipants(threadId))
    .map(k => k?.toLowerCase())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v!) === i) as string[]

  if (recipients.length === 0) {
    throw new Error(
      `No recipients found for thread ${threadId}. Ensure you store participants on thread creation/sync.`
    )
  }

  // Defensive: make sure the sender is included, so we can decrypt our own message later.
  if (!recipients.includes(senderIdentityKeyHex.toLowerCase())) {
    recipients.push(senderIdentityKeyHex.toLowerCase())
  }

  /* ===================== 1) Encrypt with CurvePoint =====================

     CurvePoint does:
       - Generate a fresh symmetric key per message
       - Encrypt our JSON body with that key
       - Seal (encrypt) that symmetric key individually to each recipient
       - Return:
           * header: a compact structure containing (version, N recipients,
                     recipient pubkey, sender pubkey, boxed key, …) + a length prefix
           * encryptedMessage: the payload encrypted under that symmetric key

     On receive, the wallet identity checks the header for an entry addressed to it,
     recovers the symmetric key, and decrypts the message.

     We namespace this with a stable protocol tuple and keyID so the wallet routes
     crypto correctly. Keep these constants consistent across the app.
  */
  const wallet = new WalletClient('auto', constants.walletHost)
  const curve = new CurvePoint(wallet)
  const plaintext = Utils.toArray(JSON.stringify(body), 'utf8') as number[]
  const CURVE_KEY_ID = '1'

  const { header, encryptedMessage } = await curve.encrypt(
    plaintext,
    [1, 'ConvoCurve'],
    CURVE_KEY_ID,
    recipients
  )

  // Store header and ciphertext as base64 strings in the PushDrop fields
  const headerB64 = Utils.toBase64(header)
  const cipherB64 = Utils.toBase64(encryptedMessage)

  /* ===================== 2) Build PushDrop fields =====================

     For CurvePoint messages we admit the following 6 fields (see Topic Manager):
       [ threadId, messageId, senderHex, sentAt, headerB64, cipherB64 ]

     The overlay TopicManager recognizes this shape and admits the output to our topic.
  */
  const fields: number[][] = [
    Utils.toArray(threadId, 'utf8'),
    Utils.toArray(messageId, 'utf8'),
    Utils.toArray(senderIdentityKeyHex, 'utf8'),
    Utils.toArray(String(sentAt), 'utf8'),
    Utils.toArray(headerB64, 'utf8'),
    Utils.toArray(cipherB64, 'utf8')
  ]

  // Lock the PushDrop with the same app protocol family we use elsewhere
  const pushdrop = new PushDrop(wallet)
  const lockingScript = await pushdrop.lock(
    fields,
    [1, 'ConvoMessenger'], // app/topic tag for wallet discovery
    '1',
    'anyone',
    true
  )

  /* ===================== 3) Create & broadcast action =====================

     We make a single-output action (1 sat) carrying our PushDrop script, then
     broadcast it via TopicBroadcaster so the overlay’s TM sees and indexes it.
  */
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

  const transaction = Transaction.fromAtomicBEEF(tx)
  const txid = transaction.id('hex')
  const vout = 0

  const broadcaster = new TopicBroadcaster([constants.overlayTM], {
    networkPreset: constants.networkPreset
  })
  await broadcaster.broadcast(transaction)

  return { txid, vout, messageId, sentAt }
}

/**
 * makeMessageId()
 * ----------------
 * Pseudo-random message identifier (hex) for dedup/reference.
 * Not a cryptographic nonce for CurvePoint; purely an app-level id we show/store.
 */
function makeMessageId(): string {
  const seed = `${Date.now()}_${Math.random()}`
  return Utils.toHex(Hash.sha256(Utils.toArray(seed, 'utf8') as number[]))
}
