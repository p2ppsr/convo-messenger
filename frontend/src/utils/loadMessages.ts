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

  if (response.type !== 'output-list' || !Array.isArray(response.outputs)) {
    console.warn('[LoadMessages] Unexpected overlay response type:', response.type)
    return { messages: [], nameMap: new Map() }
  }

  console.log(`[LoadMessages] Retrieved ${response.outputs.length} outputs from overlay.`)

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

  const messages = await checkMessages({
    client,
    protocolID,
    keyID,
    lookupResults
  })

  console.log('[LoadMessages] Decrypted messages:', messages)

  // Collect all unique sender public keys
  const allSenders = [...new Set(
    messages
      .map(m => {
        try {
          // If already a string, return it
          if (typeof m.sender === 'string') return m.sender
          // If it's a Uint8Array or Buffer, convert to base64
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

  // Resolve display names
  const nameMap = await resolveDisplayNames(allSenders, keyID)
  console.log('[LoadMessages] Resolved nameMap:', Object.fromEntries(nameMap))


  const sorted = messages.sort((a, b) => a.createdAt - b.createdAt)
  console.log(`[LoadMessages] Returning ${sorted.length} sorted messages.`)
  return {
    messages: sorted,
    nameMap
  }
}
