// src/utils/createThread.ts
import {
  WalletClient,
  PushDrop,
  Utils,
  Transaction,
  TopicBroadcaster,
} from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import constants from './constants'
import { upsertThread, setThreadParticipants } from './threadStore'

type Invitee = { identityKeyHex: string; role?: 'member' | 'admin' }

export async function createThreadAndInvite(args: {
  threadId: string
  title?: string
  groupKey: Uint8Array         // 32 bytes
  members: Invitee[]           // can be empty; we'll at least include creator
}) {
  const { threadId, title, groupKey, members } = args

  if (groupKey.length !== 32) {
    throw new Error(`createThreadAndInvite: groupKey must be 32 bytes (got ${groupKey.length})`)
  }

  // --- Wallet + identities
  const wallet = new WalletClient('auto', constants.walletHost)
  const curve  = new CurvePoint(wallet)
  const { publicKey: creatorIdentityHex } = await wallet.getPublicKey({ identityKey: true })
  const creator = creatorIdentityHex.toLowerCase()

  // --- Recipient list (normalize + dedupe + include creator)
  const recipients = Array.from(new Set([
    creator,
    ...members
      .map(m => m.identityKeyHex?.toLowerCase())
      .filter((k): k is string => typeof k === 'string' && k.length > 0),
  ]))

  if (recipients.length === 0) {
    throw new Error('createThreadAndInvite: no recipients provided')
  }

  // --- Wrap the 32-byte groupKey using CurvePoint
  const { header, encryptedMessage } = await curve.encrypt(
    Array.from(groupKey),
    [1, 'ConvoGroupKey'],   // protocol namespace for group-key envelopes
    '1',                    // app key id
    recipients
  )
  const envelope: number[]   = [...header, ...encryptedMessage]
  const keyEnvelopeB64: string = Utils.toBase64(envelope)

  // --- Put JSON payload at index 4 (matches server)
  // Keep title in the payload. Server extracts both.
  const payloadJson = JSON.stringify({
    title,
    recipients,        // lowercase compressed pubkeys
    keyEnvelopeB64,
    version: 1,
  })

  // CONTROL record fields:
  // [ "ls_convo", "convo-v1", "create_thread", threadId, payloadJson ]
  const fields: number[][] = [
    Utils.toArray('ls_convo', 'utf8'),
    Utils.toArray('convo-v1', 'utf8'),
    Utils.toArray('create_thread', 'utf8'),
    Utils.toArray(threadId, 'utf8'),
    Utils.toArray(payloadJson, 'utf8'),
  ]

  const pushdrop = new PushDrop(wallet)
  const script = await pushdrop.lock(
    fields,
    [1, 'ConvoMessenger'],
    '1',
    'anyone',
    true
  )

  // Create + broadcast
  const { tx } = await wallet.createAction({
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

  // --- Cache locally so sendMessage() can seal immediately (no /lookup needed)
  upsertThread({ id: threadId, name: title, participants: recipients })
  setThreadParticipants(threadId, recipients)

  return { threadId }
}
