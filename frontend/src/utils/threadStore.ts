export type ThreadRecord = {
  id: string
  name?: string
  keyB64: string
  participants?: string[]
}

const LS_KEY = 'convo:threads'

function read(): ThreadRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

function write(list: ThreadRecord[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}

export function listThreads(): ThreadRecord[] {
  return read()
}

export function upsertThread(t: ThreadRecord) {
  const all = read()
  const idx = all.findIndex(x => x.id === t.id)
  if (idx >= 0) all[idx] = t
  else all.push(t)
  write(all)
}

export function removeThread(threadId: string) {
  write(read().filter(t => t.id !== threadId))
}

export function getThreadKey(threadId: string): Uint8Array | undefined {
  const rec = read().find(t => t.id === threadId)
  if (!rec) return undefined
  try {
    const bin = atob(rec.keyB64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return arr
  } catch {
    return undefined
  }
}

export function setThreadKey(threadId: string, key: Uint8Array) {
  const all = read()
  const idx = all.findIndex(x => x.id === threadId)
  if (idx < 0) throw new Error(`Thread not found: ${threadId}`)
  const b64 = btoa(String.fromCharCode(...key))
  all[idx] = { ...all[idx], keyB64: b64 }
  write(all)
}
