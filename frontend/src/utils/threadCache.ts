// src/utils/threadCache.ts

export interface CachedThreadSummary {
  threadId: string
  threadName: string
  recipientKeys: string[]
  displayNames: string[]
  lastTimestamp: number
  isGroup: boolean
}

const threadCache = new Map<string, CachedThreadSummary>()

export function addThreadSummary(summary: CachedThreadSummary) {
  threadCache.set(summary.threadId, summary)
  console.log(`[ThreadCache] Saved summary for ${summary.threadId}`)
}

export function getThreadSummary(threadId: string) {
  return threadCache.get(threadId)
}

export function hasThreadSummary(threadId: string) {
  return threadCache.has(threadId)
}

export function getAllThreadSummaries() {
  return Array.from(threadCache.values())
}

export function clearThreadCache() {
  threadCache.clear()
  console.log('[ThreadCache] Cleared')
}
