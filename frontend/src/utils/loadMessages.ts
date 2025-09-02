import { LookupResolver, type WalletInterface, type WalletProtocol, Utils } from '@bsv/sdk'
import { checkMessages } from './checkMessages'
import type { MessagePayloadWithMetadata } from '../types/types'

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
}: LoadMessagesOptions): Promise<MessagePayloadWithMetadata[]> {
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
    return []
  }

  if (response.type !== 'output-list' || !Array.isArray(response.outputs)) {
    console.warn('[LoadMessages] Unexpected overlay response type:', response.type)
    return []
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

  const sorted = messages.sort((a, b) => a.createdAt - b.createdAt)
  console.log(`[LoadMessages] Returning ${sorted.length} sorted messages.`)
  return sorted
}
