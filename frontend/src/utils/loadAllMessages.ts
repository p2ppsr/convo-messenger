import {
  LookupResolver,
  Utils,
  type WalletClient,
  type WalletProtocol
} from '@bsv/sdk'

import { decodeOutputs } from './decodeOutputs'
import { decryptMessageBatch } from './MessageDecryptor'
import { resolveDisplayNames } from './resolveDisplayNames'

export interface ThreadSummary {
  threadId: string
  displayNames: string[]
  recipientKeys: string[]
  lastTimestamp: number
  threadName?: string
}

export interface DecryptedMessage {
  threadId: string
  createdAt: number
  payload: {
    recipients: string[]
    content: string
    threadName?: string
    [key: string]: any
  } | null
}

interface LoadAllResult {
  threads: ThreadSummary[]
  directMessages: ThreadSummary[]
}

export const loadAllMessages = async (
  wallet: WalletClient,
  identityKey: string,
  protocolID: WalletProtocol,
  keyID: string
): Promise<LoadAllResult> => {
  console.log('[loadAllMessages] 🔄 Starting message load...')
  const resolver = new LookupResolver({
    networkPreset: window.location.hostname === 'localhost' ? 'local' : 'mainnet'
  })

  console.log('[loadAllMessages] 🔍 Querying ls_convo with type: findAll...')
  const response = await resolver.query({
    service: 'ls_convo',
    query: { type: 'findAll' }
  })

  if (response.type !== 'output-list') {
    console.error('[loadAllMessages] ❌ Unexpected response type:', response)
    throw new Error(`Unexpected response type: ${response.type}`)
  }

  console.log(`[loadAllMessages] ✅ Received ${response.outputs.length} outputs.`)

  const toDecode = response.outputs.map((o, index) => {
    const timestamp = parseInt(Utils.toUTF8(o.context ?? []))
    console.log(`  [Output ${index}] OutputIndex: ${o.outputIndex}, Timestamp: ${timestamp}`)
    return {
      beef: o.beef,
      outputIndex: o.outputIndex,
      timestamp
    }
  })

  const decoded = await decodeOutputs(toDecode)
  console.log(`[loadAllMessages] ✅ Decoded ${decoded.length} messages.`)

  const decrypted = await decryptMessageBatch(wallet, decoded, protocolID, keyID)
  console.log(`[loadAllMessages] 🔓 Decrypted ${decrypted.length} messages.`)

  const grouped: Record<string, ThreadSummary> = {}
  const directMessages: Record<string, ThreadSummary> = {}

  for (const [index, msg] of decrypted.entries()) {
    const { threadId, createdAt, payload } = msg

    if (!payload) {
      console.warn(`[loadAllMessages] [${index}] ⚠️ Skipped message with null payload.`)
      continue
    }

    const { content, name: threadName } = payload
const filteredRecipients = payload.recipients?.filter((k) => k !== identityKey) ?? []


    console.log(`\n[${index}] 📥 Processing message`)
    console.log(`  ThreadID: ${threadId}`)
    console.log(`  CreatedAt: ${new Date(createdAt).toISOString()}`)
    console.log(`  Content: ${content}`)
    // console.log(`  Recipients (raw):`, recipients)
    console.log(`  Recipients (filtered):`, filteredRecipients)
    console.log(`  ThreadName: ${threadName || '(none)'}`)

    const nameMap = await resolveDisplayNames(filteredRecipients, identityKey)
    const displayNames = Array.from(nameMap.values())

    const summary: ThreadSummary = {
      threadId,
      displayNames,
      recipientKeys: filteredRecipients,
      lastTimestamp: createdAt,
      threadName: threadName || ''
    }

    if (threadName) {
      console.log(`  ➕ Adding to group thread: ${threadName}`)
      const existing = grouped[threadId]
      if (!existing || existing.lastTimestamp < createdAt) {
        grouped[threadId] = summary
      }
    } else {
      const key = [...filteredRecipients, identityKey].sort().join('|')
      console.log(`  ➕ Adding to direct message key: ${key}`)
      const existing = directMessages[key]
      if (!existing || existing.lastTimestamp < createdAt) {
        directMessages[key] = summary
      }
    }
  }

  const threads = Object.values(grouped)
  const directs = Object.values(directMessages)

  console.log(`\n[loadAllMessages] ✅ Final Results:`)
  console.log(`  Threads (named): ${threads.length}`)
  threads.forEach((t, i) =>
    console.log(`    [${i}] "${t.threadName}" - ${t.displayNames.join(', ')}`)
  )

  console.log(`  DirectMessages (unnamed): ${directs.length}`)
  directs.forEach((d, i) =>
    console.log(`    [${i}] ${d.displayNames.join(', ')} (threadId: ${d.threadId})`)
  )

  return {
    threads,
    directMessages: directs
  }
}
