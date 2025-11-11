// src/cache/messageCache.ts

export interface CachedMessage {
  threadId: string
  uniqueID: string
  payload: any
  createdAt: number
  filePreviews?: Record<
    string,
    string | { type: 'audio' | 'video'; url: string } | null
  >
}

const messageCache = new Map<string, CachedMessage>()

export function addToCache(msg: CachedMessage) {
  if (!msg.uniqueID) {
    console.warn("⚠️ addToCache() called without uniqueID:", msg);
    return;
  }

  console.log(
    `%c[Cache] ADD → key=${msg.uniqueID} threadId=${msg.threadId}`,
    "color: #22aa22"
  );

  messageCache.set(msg.uniqueID, msg);
}

export function getFromCache(uniqueID?: string) {
  if (!uniqueID) return undefined;

  const hit = messageCache.get(uniqueID);

  console.log(
    `%c[Cache] GET → key=${uniqueID} hit=${hit ? "✅ YES" : "❌ NO"}`,
    hit ? "color:#33bb33" : "color:#bb3333"
  );

  return hit;
}

export function hasCached(uniqueID: string): boolean {
  return messageCache.has(uniqueID)
}

export function getMessagesForThread(threadId: string) {
  const results = [...messageCache.values()].filter((m) => m.threadId === threadId);

  console.log(
    `%c[Cache] THREAD → messages for threadId=${threadId}: ${results.length}`,
    "color:#2299ff"
  );

  return results;
}

export function clearCache() {
  console.warn("%c[Cache] CLEAR (logout or identity change)", "color:#ffaa00")
  messageCache.clear();
}

export function updateCacheWithPreviews(uniqueID: string, previews: CachedMessage["filePreviews"]) {
  const existing = messageCache.get(uniqueID);
  if (!existing) {
    console.warn(`[Cache] updateCacheWithPreviews called for missing key=${uniqueID}`);
    return;
  }

  console.log(
    `%c[Cache] UPDATE PREVIEWS → key=${uniqueID}`,
    "color:#ffaa55"
  );

  messageCache.set(uniqueID, {
    ...existing,
    filePreviews: {
      ...existing.filePreviews,
      ...previews,
    },
  });
}
