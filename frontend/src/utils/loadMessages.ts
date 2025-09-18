import { LookupResolver, type WalletInterface, type WalletProtocol, Utils } from '@bsv/sdk'
import { checkMessages } from './checkMessages'
import type { MessagePayloadWithMetadata } from '../types/types'
import { resolveDisplayNames } from './resolveDisplayNames'

/**
 * Options for loading messages from the overlay
 */
export interface LoadMessagesOptions {
  client: WalletInterface
  protocolID: WalletProtocol
  keyID: string
  topic: string              // Thread ID (used as overlay query value)
}

/**
 * OverlayOutput represents a single UTXO-like result from the overlay.
 * - beef: encoded transaction data
 * - outputIndex: which vout holds the PushDrop
 * - context: optional timestamp or metadata
 */
interface OverlayOutput {
  outputIndex: number
  beef: number[]
  context?: number[]
}

/**
 * loadMessages
 *
 * Purpose:
 *   Queries the overlay for all messages in a thread, then
 *   decodes + decrypts them into usable app objects.
 *
 * Flow:
 *   1. Query overlay for outputs by threadId.
 *   2. Parse timestamps from context.
 *   3. Decode + decrypt outputs via checkMessages().
 *   4. Collect sender pubkeys and resolve them to display names.
 *   5. Return sorted messages + nameMap.
 */
export async function loadMessages({
  client,
  protocolID,
  keyID,
  topic
}: LoadMessagesOptions): Promise<{
  messages: MessagePayloadWithMetadata[]
  nameMap: Map<string, string>
}> {
  console.log('\n[LoadMessages] --------------------------------------')
  console.log(`[LoadMessages] Starting message load for topic: ${topic}`)
  console.log('[LoadMessages] Protocol ID:', protocolID)
  console.log('[LoadMessages] Key ID:', keyID)

  // --- Step 1: Query overlay for all messages in a thread ---
  const resolver = new LookupResolver({
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  let response
  try {
    response = await resolver.query({
      service: 'ls_convo',
      query: {
        type: 'findByThreadId',
        value: {
          threadId: topic
        }
      }
    })

    console.log('[LoadMessages] Overlay query succeeded.')
    console.log('[LoadMessages] Raw overlay response:', response)
  } catch (err) {
    console.error('[LoadMessages] Overlay query failed:', err)
    return { messages: [], nameMap: new Map() }
  }

  // If overlay didn’t return the expected format, bail out
  if (response.type !== 'output-list' || !Array.isArray(response.outputs)) {
    console.warn('[LoadMessages] Unexpected overlay response type:', response.type)
    return { messages: [], nameMap: new Map() }
  }

  console.log(`[LoadMessages] Retrieved ${response.outputs.length} outputs from overlay.`)

  // --- Step 2: Extract and parse overlay results ---
  // Each output has a BEEF, an outputIndex, and an optional context (timestamp).
  const lookupResults = response.outputs.map((o: OverlayOutput, i: number) => {
    let timestamp = Date.now()
    try {
      if (o.context) {
        const decoded = Utils.toUTF8(o.context)
        const parsed = parseInt(decoded, 10)
        if (!isNaN(parsed)) timestamp = parsed
        console.log(`[LoadMessages] Output[${i}] parsed timestamp: ${parsed}`)
      }
    } catch (e) {
      console.warn(`[LoadMessages] Output[${i}] failed to parse timestamp. Using fallback.`)
    }

    return {
      beef: o.beef,
      outputIndex: o.outputIndex,
      timestamp
    }
  })

  console.log(`[LoadMessages] Decoding and decrypting ${lookupResults.length} outputs...`)

  // --- Step 3: Decode + decrypt via checkMessages ---
  const messages = await checkMessages({
    client,
    protocolID,
    keyID,
    lookupResults
  })

  console.log('[LoadMessages] Decrypted messages:', messages)

  // --- Step 4: Collect unique senders for display name lookup ---
  const allSenders = [...new Set(
    messages
      .map(m => {
        try {
          if (typeof m.sender === 'string') return m.sender
          if (m.sender instanceof Uint8Array || Array.isArray(m.sender)) {
            return Buffer.from(m.sender).toString('base64')
          }
          return ''
        } catch (err) {
          console.warn('[LoadMessages] Failed to encode sender key:', m.sender, err)
          return ''
        }
      })
      .filter(k => !!k)
  )]

  console.log('[LoadMessages] Unique senders:', allSenders)

  // --- Step 5: Resolve names for those senders (identity service lookup) ---
  const nameMap = await resolveDisplayNames(allSenders, keyID)
  console.log('[LoadMessages] Resolved nameMap:', Object.fromEntries(nameMap))

  // --- Step 6: Sort chronologically and return ---
  const sorted = messages.sort((a, b) => a.createdAt - b.createdAt)
  console.log(`[LoadMessages] Returning ${sorted.length} sorted messages.`)
  return {
    messages: sorted,
    nameMap
  }
}
