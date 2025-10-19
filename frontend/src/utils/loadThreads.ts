import type { MessagePayloadWithMetadata } from '../types/types'

export interface ThreadSummary {
  threadId: string
  lastMessage: string
  sender: string
  createdAt: number
  messageCount: number
}

/**
 * Groups and summarizes threads from decrypted messages.
 *
 * @param messages - All decrypted messages (e.g. from checkMessages)
 * @returns Thread summaries with most recent message info
 */
export function loadThreads(
  messages: MessagePayloadWithMetadata[]
): ThreadSummary[] {
  const threadMap = new Map<string, MessagePayloadWithMetadata[]>()

  // console.log(`[Convo] Grouping ${messages.length} messages by thread`)

  // Group messages by threadId
  for (const msg of messages) {
    if (!threadMap.has(msg.threadId)) {
      threadMap.set(msg.threadId, [])
    }
    threadMap.get(msg.threadId)!.push(msg)
  }

  const summaries: ThreadSummary[] = []

  for (const [threadId, msgs] of threadMap.entries()) {
    // Sort by createdAt descending
    const sorted = msgs.sort((a, b) => b.createdAt - a.createdAt)
    const latest = sorted[0]

    summaries.push({
      threadId,
      lastMessage: latest.content,
      sender: latest.sender,
      createdAt: latest.createdAt,
      messageCount: msgs.length
    })

    // console.log(`[Convo] Thread ${threadId}: ${msgs.length} messages. Latest: "${latest.content}"`)
  }

  // Sort threads by latest message timestamp
  return summaries.sort((a, b) => b.createdAt - a.createdAt)
}
