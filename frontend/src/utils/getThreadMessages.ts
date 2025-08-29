import type { MessagePayloadWithMetadata } from '../types/types'

/**
 * Filters and sorts messages for a specific thread.
 *
 * @param threadId - The thread to load
 * @param allMessages - All decrypted messages
 * @returns Messages in the thread, sorted oldest to newest
 */
export function getThreadMessages(
  threadId: string,
  allMessages: MessagePayloadWithMetadata[]
): MessagePayloadWithMetadata[] {
  const filtered = allMessages.filter(msg => msg.threadId === threadId)

  console.log(`[Convo] Found ${filtered.length} messages for thread ${threadId}`)

  const sorted = filtered.sort((a, b) => a.createdAt - b.createdAt)

  for (const msg of sorted) {
    console.log(`[Convo] [${new Date(msg.createdAt).toLocaleString()}] ${msg.sender}: ${msg.content}`)
  }

  return sorted
}
