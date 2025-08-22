// src/utils/sendMessage.ts
import {
  PushDrop,
  WalletClient,
  Utils,
  Transaction,
  TopicBroadcaster,
  Hash,
  LookupResolver
} from '@bsv/sdk'
import constants from './constants'
import { CurvePoint } from 'curvepoint'
import {
  getThreadParticipants,
  setThreadParticipants, // cache fetched participants
} from './threadStore' // must return/set identity keys for this thread

/* ----------------------------- Types & guards ----------------------------- */

export type OutboundMessageBody = {
  text: string
  image?: string
}

export type OutboundMessageParams = {
  threadId: string
  senderIdentityKeyHex: string
  /** ⛔️ DEPRECATED: no longer used with CurvePoint; kept for backward compatibility */
  threadKey?: Uint8Array
  /** Optional explicit recipients; if omitted, pulled/cached from threadStore/overlay */
  recipients?: string[]
  body: OutboundMessageBody
  messageId?: string
  sentAt?: number
}

type JsonAnswer<T> = { type: 'json'; value: T }
function isJson<T>(a: unknown): a is JsonAnswer<T> {
  return typeof a === 'object' && a != null && (a as any).type === 'json'
}

/* -------------------------- Overlay lookup client ------------------------- */

const resolver = new LookupResolver({
  networkPreset: constants.networkPreset,
  // @ts-expect-error optional override from app constants
  hosts: (constants as any)?.lookupHosts
})

async function safeLookup(service: string, query: Record<string, unknown>) {
  try {
    console.debug('[sendMessage] /lookup request ->', { service, query })
    const ans = await resolver.query({ service, query })
    console.debug('[sendMessage] /lookup response <-', {
      type: (ans as any)?.type ?? '(unknown)'
    })
    return ans as any
  } catch (err) {
    console.warn('[sendMessage] /lookup FAILED', { service, query, err })
    return null
  }
}

async function fetchParticipantsFromOverlay(threadId: string): Promise<string[]> {
  const res = await safeLookup(constants.overlayTopic, {
    type: 'findMembers',
    threadId
  })
  if (!isJson<any[]>(res) || !Array.isArray(res.value)) {
    console.warn('[sendMessage] findMembers unexpected answer', res)
    return []
  }
  const list = Array.from(
    new Set(
      res.value
        .map((m: any) => (typeof m?.memberId === 'string' ? m.memberId.toLowerCase() : ''))
        .filter(Boolean)
    )
  )
  console.debug('[sendMessage] fetched participants from overlay', {
    threadId,
    count: list.length
  })
  return list
}

/* --------------------------------- Main ---------------------------------- */

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

  /* 1) Resolve recipients (self-heal if missing) */
  let recipients = (recipientsParam ?? getThreadParticipants(threadId) ?? [])
    .map(k => k?.toLowerCase())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v!) === i) as string[]

  if (!recipients.length) {
    console.debug('[sendMessage] no cached participants; fetching via findMembers', { threadId })
    recipients = await fetchParticipantsFromOverlay(threadId)
    if (recipients.length) setThreadParticipants(threadId, recipients)
  }

  if (!recipients.length) {
    const msg = `No recipients found for thread ${threadId}. Ensure you store participants on thread creation/sync.`
    console.error('[sendMessage] aborting:', msg)
    throw new Error(msg)
  }

  // Ensure we can decrypt our own message
  const me = senderIdentityKeyHex.toLowerCase()
  if (!recipients.includes(me)) recipients.push(me)

  console.debug('[sendMessage] recipients resolved', {
    threadId,
    count: recipients.length
  })

  /* 2) Encrypt message with CurvePoint (per-message symmetric key) */
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

  const headerB64 = Utils.toBase64(header)
  const cipherB64 = Utils.toBase64(encryptedMessage)

  /* 3) Build PushDrop (6 fields) */
  const fields: number[][] = [
    Utils.toArray(threadId, 'utf8'),
    Utils.toArray(messageId, 'utf8'),
    Utils.toArray(senderIdentityKeyHex, 'utf8'),
    Utils.toArray(String(sentAt), 'utf8'),
    Utils.toArray(headerB64, 'utf8'),
    Utils.toArray(cipherB64, 'utf8')
  ]

  const pushdrop = new PushDrop(wallet)
  const lockingScript = await pushdrop.lock(
    fields,
    [1, 'ConvoMessenger'], // app/topic tag
    '1',
    'anyone',
    true
  )

  /* 4) Create the action & broadcast through the TopicBroadcaster */
  const { tx } = await wallet.createAction({
    outputs: [
      {
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: 'Convo Message',
        basket: constants.basket
      }
    ],
    description: `Convo: send message (${threadId.slice(0, 8)}…)`,
    options: {
      acceptDelayedBroadcast: false,
      randomizeOutputs: false
    }
  })

  if (!tx) {
    console.error('[sendMessage] createAction returned no tx')
    throw new Error('Transaction creation failed')
  }

  const transaction = Transaction.fromAtomicBEEF(tx)
  const txid = transaction.id('hex')
  const vout = 0

  console.debug('[sendMessage] broadcasting via TopicBroadcaster', {
    topic: constants.overlayTM,
    txid
  })
  const broadcaster = new TopicBroadcaster([constants.overlayTM], {
    networkPreset: constants.networkPreset
  })
  await broadcaster.broadcast(transaction)

  console.debug('[sendMessage] broadcast complete', { txid, vout, messageId, sentAt })
  return { txid, vout, messageId, sentAt }
}

/* --------------------------------- Utils ---------------------------------- */

function makeMessageId(): string {
  const seed = `${Date.now()}_${Math.random()}`
  return Utils.toHex(Hash.sha256(Utils.toArray(seed, 'utf8') as number[]))
}
