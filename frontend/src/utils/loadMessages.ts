import { LookupResolver, type WalletInterface, type WalletProtocol, Utils } from '@bsv/sdk'
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
    return { messages: [], reactions: {}, nameMap: new Map() }
  }

  if (response.type !== 'output-list' || !Array.isArray(response.outputs)) {
    console.warn('[LoadMessages] Unexpected overlay response type:', response.type)
    return { messages: [], reactions: {}, nameMap: new Map() }
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

  // Filter + dedupe messages
  const filtered = rawMessages.filter(m => m.threadId === topic)
  const deduped = Array.from(
    new Map(filtered.map(m => [m.uniqueID ?? `${m.txid}-${m.vout}`, m])).values()
  )

  // --- Group reactions by their target message (txid:vout) ---
  const groupedReactions: Record<string, any[]> = {}
  for (const r of rawReactions) {
    const key = `${r.messageTxid}:${r.messageVout}`
    if (!groupedReactions[key]) groupedReactions[key] = []
    groupedReactions[key].push(r)
  }

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

  const nameMap = await resolveDisplayNames(allSenders, keyID)

  const sorted = deduped.sort((a, b) => a.createdAt - b.createdAt)
  console.log(`[LoadMessages] Returning ${sorted.length} messages with grouped reactions.`)

  return {
    messages: sorted,
    reactions: groupedReactions,
    nameMap
  }
}
