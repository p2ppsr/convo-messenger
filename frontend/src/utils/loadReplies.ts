import { LookupResolver, type WalletInterface, type WalletProtocol, Utils } from '@bsv/sdk'
import { checkMessages } from './checkMessages'
import type { MessagePayloadWithMetadata } from '../types/types'
import { resolveDisplayNames } from './resolveDisplayNames'

export interface LoadRepliesOptions {
  client: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  parentMessageId: string
}

interface OverlayOutput {
  outputIndex: number
  beef: number[]
  context?: number[]
}

/**
 * Loads all replies belonging to a specific parent message (thread root).
 * Retrieves messages + reactions + sender display names.
 */
export async function loadReplies({
  client,
  protocolID,
  keyID,
  parentMessageId
}: LoadRepliesOptions): Promise<{
  messages: MessagePayloadWithMetadata[]
  reactions: Record<string, any[]>
  nameMap: Map<string, string>
}> {
  console.log(`\n[LoadReplies] --------------------------------------`)
  console.log(`[LoadReplies] Fetching replies for parentMessageId: ${parentMessageId}`)
  console.log('[LoadReplies] Protocol:', protocolID)
  console.log('[LoadReplies] KeyID:', keyID)

  const resolver = new LookupResolver({
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  let response
  try {
    response = await resolver.query({
      service: 'ls_convo',
      query: { type: 'findRepliesByParent', value: { parentMessageId } }
    })
    console.log('[LoadReplies] Overlay query succeeded.')
  } catch (err) {
    console.error('[LoadReplies] Overlay query failed:', err)
    return { messages: [], reactions: {}, nameMap: new Map() }
  }

  if (response.type !== 'output-list' || !Array.isArray(response.outputs)) {
    console.warn('[LoadReplies] Unexpected overlay response type:', response.type)
    return { messages: [], reactions: {}, nameMap: new Map() }
  }

  console.log(`[LoadReplies] ↳ Overlay returned ${response.outputs.length} outputs.`)

  // --- Extract timestamps and beefs ---
  const lookupResults = response.outputs.map((o: OverlayOutput, i: number) => {
    let timestamp = Date.now()
    try {
      if (o.context) {
        const decoded = Utils.toUTF8(o.context)
        const parsed = parseInt(decoded, 10)
        if (!isNaN(parsed)) timestamp = parsed
      }
    } catch {}
    console.log(`[LoadReplies] Output[${i}] summary:`, {
      outputIndex: o.outputIndex,
      hasContext: !!o.context,
      decodedTimestamp: timestamp
    })
    return { beef: o.beef, outputIndex: o.outputIndex, timestamp }
  })

  console.log(`[LoadReplies] Decoding and decrypting ${lookupResults.length} outputs...`)

  const { messages: rawMessages, reactions: rawReactions } = await checkMessages({
    client,
    protocolID,
    keyID,
    lookupResults
  })

  console.log(`[LoadReplies] Retrieved ${rawMessages.length} messages, ${rawReactions.length} reactions.`)

  // --- Normalize IDs ---
  const normalizedParent = parentMessageId.trim().toLowerCase()

  // --- Filter replies belonging to this parent ---
  const filtered = rawMessages.filter(m => {
    const current = (m.parentMessageId ?? '').trim().toLowerCase()
    const match = current === normalizedParent
    if (!match) {
      if (current) {
        console.debug(`[LoadReplies] Skipped ${m.txid} (parent=${current} ≠ ${normalizedParent})`)
      } else {
        console.debug(`[LoadReplies] Skipped ${m.txid} (no parentMessageId)`)
      }
    }
    return match
  })

  console.log(`[LoadReplies] Filtered ${filtered.length} messages that match parentMessageId.`)

  // --- If nothing matched, log distinct parents for debugging ---
  if (filtered.length === 0 && rawMessages.length > 0) {
    const distinctParents = Array.from(new Set(rawMessages.map(m => m.parentMessageId).filter(Boolean)))
    console.warn('[LoadReplies] No matches found. Distinct parentMessageIds among raw messages:', distinctParents)
  }

  // --- Deduplicate ---
  const deduped = Array.from(
    new Map(filtered.map(m => [m.uniqueID ?? `${m.txid}-${m.vout}`, m])).values()
  )
  console.log(`[LoadReplies] Deduped from ${filtered.length} → ${deduped.length} messages.`)

  // --- Group reactions by message (only for this thread's replies) ---
  const groupedReactions: Record<string, any[]> = {}
  const replyTxids = new Set(deduped.map(m => m.txid))

  console.log(`[LoadReplies] Grouping ${rawReactions.length} reactions:`)
  for (const r of rawReactions) {
    const key = `${r.messageTxid}:${r.messageVout}`
    const belongsToReply = replyTxids.has(r.messageTxid)

    if (!groupedReactions[key]) groupedReactions[key] = []
    groupedReactions[key].push(r)

    console.log(
      `  ↳ Reaction ${r.reaction} from ${r.sender} → ${r.messageTxid}:${r.messageVout} ${
        belongsToReply ? '(✔ belongs to this reply)' : '(✖ not part of this reply thread)'
      }`
    )
  }

  // Optionally remove reactions that don't belong to this thread
  Object.keys(groupedReactions).forEach(key => {
    const [txid] = key.split(':')
    if (!replyTxids.has(txid)) {
      delete groupedReactions[key]
    }
  })

  console.log(`[LoadReplies] Grouped ${Object.keys(groupedReactions).length} reaction sets for this reply thread.`)


  // --- Resolve sender display names ---
  const allSenders = [
    ...new Set(
      deduped
        .map(m => {
          try {
            if (typeof m.sender === 'string') return m.sender
            if (m.sender instanceof Uint8Array || Array.isArray(m.sender)) {
              return Buffer.from(m.sender).toString('base64')
            }
            return ''
          } catch {
            return ''
          }
        })
        .filter(Boolean)
    )
  ]
  console.log(`[LoadReplies] Resolving ${allSenders.length} unique sender identities…`, allSenders)
  const nameMap = await resolveDisplayNames(allSenders, keyID)
  console.log('[LoadReplies] Name resolution complete. Entries:', nameMap.size)

  // --- Sort by timestamp ---
  const sorted = deduped.sort((a, b) => a.createdAt - b.createdAt)
  console.log(`[LoadReplies] Returning ${sorted.length} replies.`)

  return {
    messages: sorted,
    reactions: groupedReactions,
    nameMap
  }
}
