// src/utils/createThread.ts
/**
 * I create a brand-new thread and publish a control record to the overlay.
 * Instead of boxing the group key per recipient manually, I use CurvePoint to
 * produce a single header+ciphertext “envelope” that contains the per-recipient
 * wrapped symmetric key. The backend can store the envelope; each member can
 * unwrap their copy later with their wallet identity.
 */

import {
  WalletClient,
  PushDrop,
  Utils,
  Transaction,
  TopicBroadcaster,
} from '@bsv/sdk'
import { CurvePoint } from 'curvepoint'
import constants from './constants'

type Invitee = { identityKeyHex: string; role?: 'member' | 'admin' }

export async function createThreadAndInvite(args: {
  threadId: string
  /** Optional human title shown in side list (for 1:1 I pass the other party’s name) */
  title?: string
  /** Fresh 32-byte symmetric key that will protect message bodies in this thread */
  groupKey: Uint8Array
  /** Everyone who should get access (I’ll dedupe and also force-include the creator) */
  members: Invitee[]
}) {
  const { threadId, title, groupKey, members } = args

  // --- Wallet + CurvePoint -----------------------------------------------
  // I need a wallet so CurvePoint can use my identity key to wrap the group key
  // for each recipient inside the CurvePoint header.
  const wallet = new WalletClient('auto', constants.walletHost)
  const curve  = new CurvePoint(wallet)

  // --- Identify the creator (me) -----------------------------------------
  const { publicKey: creatorIdentityHex } = await wallet.getPublicKey({ identityKey: true })

  // --- Basic sanity checks ------------------------------------------------
  if (groupKey.length !== 32) {
    throw new Error(`createThreadAndInvite: groupKey must be 32 bytes (got ${groupKey.length})`)
  }

  // Build a unique, lowercase recipient list from the provided members.
  // I normalize to lowercase everywhere to avoid key-case mismatches.
  const recipients = Array.from(
    new Set(
      members
        .map(m => m.identityKeyHex?.toLowerCase())
        .filter((k): k is string => typeof k === 'string' && k.length > 0)
    )
  )

  // Ensure the creator can decrypt as well (sometimes callers forget to include me).
  if (!recipients.includes(creatorIdentityHex.toLowerCase())) {
    recipients.push(creatorIdentityHex.toLowerCase())
  }

  if (recipients.length === 0) {
    throw new Error('createThreadAndInvite: no recipients provided')
  }

  // --- Wrap the raw group key using CurvePoint ---------------------------
  // I use CurvePoint.encrypt() to produce:
  //   - header: per-recipient entries (recipient pubkey, sender pubkey, wrapped key)
  //   - encryptedMessage: the ciphertext for the “message” payload I pass in
  // Here I treat the “message” as the raw 32-byte groupKey itself.
  //
  // Protocol ID must be stable and match the decrypt side; I use [1, 'ConvoGroupKey'].
  // keyID '1' is just my app’s label for this envelope family.
  const { header, encryptedMessage } = await curve.encrypt(
    Array.from(groupKey),        // message payload: raw symmetric key bytes
    [1, 'ConvoGroupKey'],        // protocol namespace for group-key envelopes
    '1',                         // keyID (app-level label)
    recipients                   // everyone who should be able to unwrap
  )

  // CurvePoint consumers expect a single byte array: [headerLen+header][ciphertext].
  // I concatenate the two and stash as base64 in the control record.
  const envelope: number[] = [...header, ...encryptedMessage]
  const keyEnvelopeB64 = Utils.toBase64(envelope)

  // This JSON becomes the control record’s payload. I keep it small and explicit.
  // The backend will persist this and can materialize memberships from `recipients`.
  const payloadJson = JSON.stringify({
    keyEnvelopeB64,
    recipients,  // normalized hex (lowercase) so it’s easy to match on the server
    version: 1
  })

  // --- Build the PushDrop control record ---------------------------------
  // I follow my TopicManager’s “control shape”:
  //   [ "ls_convo", "convo-v1", "create_thread", threadId, title, payloadJson, creatorIdentityHex, timestampMs ]
  const fields: number[][] = [
    Utils.toArray('ls_convo', 'utf8'),
    Utils.toArray('convo-v1', 'utf8'),
    Utils.toArray('create_thread', 'utf8'),
    Utils.toArray(threadId, 'utf8'),
    Utils.toArray(title ?? '', 'utf8'),
    Utils.toArray(payloadJson, 'utf8'),
    Utils.toArray(creatorIdentityHex, 'hex'),
    Utils.toArray(String(Date.now()), 'utf8')
  ]

  const pushdrop = new PushDrop(wallet)
  // Locking script allows anyone to spend (overlay cares about the data, not spend policy).
  const script = await pushdrop.lock(
    fields,
    [1, 'ConvoMessenger'],  // consistent protocol family I use across Convo records
    '1',
    'anyone',
    true
  )

  // --- Create & broadcast the TX ----------------------------------------
  // I create a 1-sat output carrying the control record, and put it in my “basket”
  // so users can track Convo spends easily in the wallet UI.
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

  // Once I have the tx, I broadcast it via the overlay Topic Broadcaster so
  // everyone indexing this topic can discover the new thread.
  if (tx) {
    const broadcaster = new TopicBroadcaster([constants.overlayTM], {
      networkPreset: constants.networkPreset
    })
    await broadcaster.broadcast(Transaction.fromAtomicBEEF(tx))
  }

  // I return the txid so the caller can display a link or log it.
  return { txid }
}
