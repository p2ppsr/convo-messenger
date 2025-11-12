import { LookupResolver, type WalletInterface, type WalletProtocol, Utils } from '@bsv/sdk'
import { checkMessages } from './checkMessages'
import type { MessagePayloadWithMetadata } from '../types/types'
import { resolveDisplayNames } from './resolveDisplayNames'
import {
  addToCache,
  getFromCache,
  type CachedMessage
} from './messageCache'
import { Transaction } from '@bsv/sdk';

export interface LoadRepliesOptions {
  client: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  parentMessageId: string
  resolver: LookupResolver
}

interface OverlayOutput {
  outputIndex: number
  beef: number[]
  context?: number[]
}

/**
 * Loads all replies for a specific parent message (thread root)
 * Uses message cache to avoid decrypting messages that were already decrypted.
 */
export async function loadReplies({
  client,
  protocolID,
  keyID,
  parentMessageId,
  resolver
}: LoadRepliesOptions): Promise<{
  messages: MessagePayloadWithMetadata[]
  reactions: Record<string, any[]>
  nameMap: Map<string, string>
}> {

  console.log(`\n[LoadReplies] --------------------------------------`)
  console.log(`[LoadReplies] Fetching replies for parentMessageId: ${parentMessageId}`)

  let response
  try {
    response = await resolver.query({
      service: 'ls_convo',
      query: { type: 'findRepliesByParent', value: { parentMessageId } }
    })
  } catch (err) {
    console.error('[LoadReplies] Overlay query failed:', err)
    return { messages: [], reactions: {}, nameMap: new Map() }
  }

  if (response.type !== 'output-list' || !Array.isArray(response.outputs)) {
    return { messages: [], reactions: {}, nameMap: new Map() }
  }

  // Extract timestamps & lookup objects
  const lookupResults = response.outputs.map((o: OverlayOutput) => {
    let timestamp = Date.now()
    try {
      if (o.context) {
        const decoded = Utils.toUTF8(o.context)
        const parsed = parseInt(decoded, 10)
        if (!isNaN(parsed)) timestamp = parsed
      }
    } catch {}
    return { beef: o.beef, outputIndex: o.outputIndex, timestamp }
  })

  console.log(`[LoadReplies] Overlay returned ${lookupResults.length} outputs.`)

  // ---------------------------------------------------------------
//  CACHE AWARE REPLY LOADING (MATCHES loadMessages.ts EXACTLY)
// ---------------------------------------------------------------
const cachedMessages: MessagePayloadWithMetadata[] = []
const newOutputs: typeof lookupResults = []

for (const o of lookupResults) {
  // Always derive txid from BEEF
  const tx = Transaction.fromBEEF(o.beef)
  const txid = tx.id("hex")

  // Same cache key format used in loadMessages
  const lookupKey = `${txid}:${o.outputIndex}`

  const cached = getFromCache(lookupKey)

  if (cached) {
    console.log(`[Replies][CACHE-HIT] ${lookupKey}`)
    cachedMessages.push(cached.payload as MessagePayloadWithMetadata)
  } else {
    console.log(`[Replies][CACHE-MISS] ${lookupKey}`)
    newOutputs.push(o)
  }
}

console.log(`[LoadReplies] Using ${cachedMessages.length} cached replies, decrypting ${newOutputs.length} new`)


  // Decrypt only new replies
  let decryptedMessages: MessagePayloadWithMetadata[] = []
  let rawReactions: any[] = []

  // Decrypt only new replies
if (newOutputs.length > 0) {
  const result = await checkMessages({
    client,
    protocolID,
    keyID,
    lookupResults: newOutputs
  })

  decryptedMessages = result.messages
  rawReactions = result.reactions

  for (const m of decryptedMessages) {
    const lookupKey = m.uniqueID ?? `${m.txid}:${m.vout}`

    console.log(`[Replies][CACHE-ADD] ${lookupKey}`)

    addToCache({
      uniqueID: lookupKey,
      threadId: m.threadId,
      payload: m,
      createdAt: m.createdAt,
      filePreviews: {}
    })
  }
}


  const rawMessages = [...cachedMessages, ...decryptedMessages]

  // ------------------------------------------------------------------
  // Filter, dedupe, build reaction list
  // ------------------------------------------------------------------

  const normalizedParent = parentMessageId.trim().toLowerCase()

  const filtered = rawMessages.filter(m =>
    (m.parentMessageId ?? '').trim().toLowerCase() === normalizedParent
  )

  const deduped = Array.from(
    new Map(filtered.map(m => [m.uniqueID ?? `${m.txid}-${m.vout}`, m])).values()
  )

  // Group reactions that belong to these replies
  const groupedReactions: Record<string, any[]> = {}
  for (const r of rawReactions) {
    const key = `${r.messageTxid}:${r.messageVout}`
    if (!groupedReactions[key]) groupedReactions[key] = []
    groupedReactions[key].push(r)
  }

  // Resolve display names of participants
  const allSenders = [...new Set(deduped.map(m => m.sender).filter(Boolean))]
  const nameMap = await resolveDisplayNames(allSenders, keyID)

  const sorted = deduped.sort((a, b) => a.createdAt - b.createdAt)

  console.log(`[LoadReplies] Returning ${sorted.length} replies.`)

  return {
    messages: sorted,
    reactions: groupedReactions,
    nameMap
  }
}
