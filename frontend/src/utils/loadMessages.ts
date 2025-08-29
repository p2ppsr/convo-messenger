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
  console.log(`[Convo] Loading messages for topic: ${topic}`)

  const resolver = new LookupResolver({
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  let response
  try {
    response = await resolver.query({
      service: 'ls_convo',
      query: {
        type: 'findByTopic',
        topic
      }
    })

    console.log('[Convo] Lookup response:', response)
  } catch (err) {
    console.error('[Convo] Failed to query overlay:', err)
    return []
  }

  if (response.type !== 'output-list' || !Array.isArray(response.outputs)) {
    console.warn('[Convo] Unexpected overlay response type:', response.type)
    return []
  }

  // Parse each output
  const lookupResults = response.outputs.map((o: OverlayOutput) => {
    let timestamp = Date.now()
    try {
      if (o.context) {
        const decoded = Utils.toUTF8(o.context)
        const parsed = parseInt(decoded, 10)
        if (!isNaN(parsed)) timestamp = parsed
      }
    } catch (e) {
      console.warn('[Convo] Failed to parse context timestamp, using fallback.')
    }

    return {
      beef: o.beef,
      outputIndex: o.outputIndex,
      timestamp
    }
  })

  console.log(`[Convo] Decoding and decrypting ${lookupResults.length} outputs`)

  const messages = await checkMessages({
    client,
    protocolID,
    keyID,
    lookupResults
  })

  // Sort messages by createdAt (ascending)
  const sorted = messages.sort((a, b) => a.createdAt - b.createdAt)

  console.log(`[Convo] Returning ${sorted.length} sorted messages`)
  return sorted
}
