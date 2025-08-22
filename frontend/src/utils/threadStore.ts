// src/utils/threadStore.ts
// A tiny local, persistent index of threads for the UI and send/decrypt helpers.
// We deliberately keep it simple and use localStorage so the app works
// without a backend DB. The overlay remains the source of truth; this is a cache.
//
// Fields:
// - id           : stable thread id (hex string)
// - name?        : user-friendly display label (optional)
// - keyB64?      : base64-encoded 32-byte group key (LEGACY decrypt path —
//                  CurvePoint doesn’t need this for new messages, but we keep it
//                  so old attachments/messages can still be opened)
// - participants?: array of compressed secp256k1 pubkeys (02/03… hex) used by
//                  sendMessage() to select CurvePoint recipients if not provided.
//
// NOTE: We always read → mutate in memory → write. There’s no locking here;
// concurrent tabs could clobber each other. That’s fine for this demo app.

export type ThreadRecord = {
  id: string
  name?: string
  keyB64?: string
  participants?: string[]
}

const LS_KEY = 'convo:threads'

/** Safely read and parse our thread list from localStorage. */
function read(): ThreadRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ThreadRecord[]) : []
  } catch {
    // Corrupt or missing entry → treat as empty.
    return []
  }
}

/** Serialize the entire list back to localStorage. */
function write(list: ThreadRecord[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list))
  } catch {
    // ignore quota or serialization errors for this lightweight cache
  }
}

/** Return the whole cached list (no filtering/sorting here). */
export function listThreads(): ThreadRecord[] {
  return read()
}

/** Normalize recipient keys (lowercase, unique, truthy). */
function normalizeParticipants(arr?: string[]): string[] | undefined {
  if (!Array.isArray(arr)) return undefined
  const norm = arr
    .map(x => (typeof x === 'string' ? x.toLowerCase() : ''))
    .filter(Boolean)
  // de-dupe
  return Array.from(new Set(norm))
}

/**
 * Upsert a thread record by id with partial updates.
 * - Merges with any existing record instead of replacing it.
 * - Normalizes participants (lowercase, unique).
 */
export function upsertThread(patch: Partial<ThreadRecord> & { id: string }) {
  const all = read()
  const idx = all.findIndex(x => x.id === patch.id)
  const prev = idx >= 0 ? all[idx] : { id: patch.id }

  const next: ThreadRecord = {
    ...prev,
    ...patch,
    participants:
      patch.participants !== undefined
        ? normalizeParticipants(patch.participants)
        : prev.participants
  }

  if (idx >= 0) all[idx] = next
  else all.push(next)
  write(all)
}

/** Remove a thread by id (used when user leaves a chat, etc.). */
export function removeThread(threadId: string) {
  write(read().filter(t => t.id !== threadId))
}

/**
 * Return the legacy 32-byte thread key (as bytes) for a given id.
 * This is only used for decrypting older payloads (e.g., attachments that were
 * encrypted directly with AES-GCM). New CurvePoint messages do not require this.
 */
export function getThreadKey(threadId: string): Uint8Array | null {
  const rec = read().find(t => t.id === threadId)
  const b64 = rec?.keyB64
  if (!b64) return null
  try {
    const bin = atob(b64) // base64 → binary string
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return arr
  } catch {
    return null
  }
}

/**
 * Update (or set) only the key for a thread. Creates the thread shell if needed.
 * We store as base64 so it’s JSON-safe in localStorage.
 */
export function setThreadKey(threadId: string, key: Uint8Array) {
  const b64 = btoa(String.fromCharCode(...key))
  upsertThread({ id: threadId, keyB64: b64 })
}

/**
 * Return the participant identity keys for a thread.
 * sendMessage() uses these when it needs to derive the CurvePoint recipient list.
 * If missing, sendMessage() will error unless explicit recipients are provided.
 */
export function getThreadParticipants(threadId: string): string[] {
  const t = listThreads().find(x => x.id === threadId)
  return t?.participants ?? []
}

/** Set/replace participants for a thread (merge-safe). */
export function setThreadParticipants(id: string, participants: string[]) {
  upsertThread({ id, participants })
}
