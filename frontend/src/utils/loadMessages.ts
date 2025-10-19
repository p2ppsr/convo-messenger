import {
  LookupResolver,
  type WalletInterface,
  type WalletProtocol,
  Utils
} from '@bsv/sdk'
import { checkMessages } from './checkMessages'
import type { MessagePayloadWithMetadata } from '../types/types'
import { resolveDisplayNames } from './resolveDisplayNames'

export interface LoadMessagesOptions {
  client: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  topic: string
}

interface OverlayOutput {
  outputIndex: number
  beef: number[]
  context?: number[]
}

export async function loadMessages({
  client,
  protocolID,
  keyID,
  topic
}: LoadMessagesOptions): Promise<{
  messages: MessagePayloadWithMetadata[]
  reactions: Record<string, any[]>
  nameMap: Map<string, string>
  replyCounts: Record<string, number>
  latestReplyTimes: Record<string, number>
}> {
  console.log('\n[LoadMessages] --------------------------------------')
  console.log(`[LoadMessages] Starting message load for topic: ${topic}`)
  console.log('[LoadMessages] Protocol ID:', protocolID)
  console.log('[LoadMessages] Key ID:', keyID)

  const resolver = new LookupResolver({
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  let response
  try {
    response = await resolver.query({
      service: 'ls_convo',
      query: { type: 'findByThreadId', value: { threadId: topic } }
    })
    console.log('[LoadMessages] Overlay query succeeded.')
  } catch (err) {
    console.error('[LoadMessages] Overlay query failed:', err)
    return {
      messages: [],
      reactions: {},
      nameMap: new Map(),
      replyCounts: {},
      latestReplyTimes: {}
    }
  }

  if (response.type !== 'output-list' || !Array.isArray(response.outputs)) {
    console.warn('[LoadMessages] Unexpected overlay response type:', response.type)
    return {
      messages: [],
      reactions: {},
      nameMap: new Map(),
      replyCounts: {},
      latestReplyTimes: {}
    }
  }

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

  console.log(`[LoadMessages] Decoding and decrypting ${lookupResults.length} outputs...`)

  // --- Step 3: Decode + decrypt ---
  const { messages: rawMessages, reactions: rawReactions } = await checkMessages({
    client,
    protocolID,
    keyID,
    lookupResults
  })

  console.log(`[LoadMessages] Retrieved ${rawMessages.length} messages, ${rawReactions.length} reactions.`)

  // --- Step 4: Filter messages ---
  const filtered = rawMessages.filter(m => m.threadId === topic && !m.parentMessageId)
  const deduped = Array.from(
    new Map(filtered.map(m => [m.uniqueID ?? `${m.txid}-${m.vout}`, m])).values()
  )

  // --- Group reactions by message ---
  const groupedReactions: Record<string, any[]> = {}
  for (const r of rawReactions) {
    const key = `${r.messageTxid}:${r.messageVout}`
    if (!groupedReactions[key]) groupedReactions[key] = []
    groupedReactions[key].push(r)
  }

  // --- Step 5: Derive reply counts + latest reply times locally ---
  const replyCounts: Record<string, number> = {}
  const latestReplyTimes: Record<string, number> = {}

  try {
    const repliesByParent: Record<string, MessagePayloadWithMetadata[]> = {}

    for (const msg of rawMessages) {
      if (msg.parentMessageId) {
        if (!repliesByParent[msg.parentMessageId]) repliesByParent[msg.parentMessageId] = []
        repliesByParent[msg.parentMessageId].push(msg)
      }
    }

    for (const parentId of Object.keys(repliesByParent)) {
      const replies = repliesByParent[parentId]
      replyCounts[parentId] = replies.length
      latestReplyTimes[parentId] = Math.max(...replies.map(r => r.createdAt))
    }

    console.log('[LoadMessages] Derived replyCounts:', replyCounts)
    console.log('[LoadMessages] Derived latestReplyTimes:', latestReplyTimes)
  } catch (err) {
    console.error('[LoadMessages] Failed to derive reply data locally:', err)
  }

  // --- Step 6: Resolve sender names ---
  const allSenders = [...new Set(deduped.map(m => (typeof m.sender === 'string' ? m.sender : '')))]
  const nameMap = await resolveDisplayNames(allSenders, keyID)
  const sorted = deduped.sort((a, b) => a.createdAt - b.createdAt)

  console.log(`[LoadMessages] Returning ${sorted.length} top-level messages.`)

  return {
    messages: sorted,
    reactions: groupedReactions,
    nameMap,
    replyCounts,
    latestReplyTimes
  }
}
