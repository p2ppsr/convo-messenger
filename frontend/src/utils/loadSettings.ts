import { listThreads, upsertThread, type ThreadRecord } from './threadStore'

export async function loadSettings(): Promise<string[]> {
  const threads = listThreads()
  return threads.map(t => t.id)
}

export async function addChat(threadId: string, opts?: Partial<Pick<ThreadRecord, 'name' | 'participants' | 'keyB64'>>) {
  const existing = listThreads()
  if (existing.some(t => t.id === threadId)) {
    return
  }

  upsertThread({
    id: threadId,
    name: opts?.name,
    participants: opts?.participants ?? undefined,
    keyB64: opts?.keyB64 ?? ''
  })
}
