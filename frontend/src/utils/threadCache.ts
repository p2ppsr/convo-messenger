// src/utils/threadCache.ts

export interface CachedThreadSummary {
  threadId: string
  threadName?: string        // ✅ now optional
  recipientKeys: string[]
  displayNames: string[]
  lastTimestamp: number
  isGroup: boolean
}

const threadCache = new Map<string, CachedThreadSummary>()

export function addThreadSummary(summary: CachedThreadSummary) {
  const existing = threadCache.get(summary.threadId)
  if (existing) {
    // Ignore sub-second timestamp differences
    const diff = Math.abs(existing.lastTimestamp - summary.lastTimestamp)
    if (
      diff < 1000 && // within 1s difference, skip
      existing.threadName === summary.threadName &&
      JSON.stringify(existing.recipientKeys) === JSON.stringify(summary.recipientKeys) &&
      JSON.stringify(existing.displayNames) === JSON.stringify(summary.displayNames)
    ) {
      return // no meaningful change
    }
  }

  console.log('[ThreadCache] Saved summary for', summary.threadId)
  threadCache.set(summary.threadId, summary)
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
