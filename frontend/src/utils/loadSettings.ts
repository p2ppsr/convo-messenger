import { listThreads, upsertThread, type ThreadRecord } from './threadStore'

/**
 * loadSettings()
 * ----------------
 * Right now “settings” for the app are essentially the list of known thread IDs
 * we’ve cached in local storage (threadStore). This is used by the UI to
 * bootstrap the left-hand thread list without having to hit the overlay first.
 *
 * Note: This function is `async` for call-site symmetry (most loaders are async),
 * but today it returns immediately from local state.
 */
export async function loadSettings(): Promise<string[]> {
  const threads = listThreads()
  return threads.map(t => t.id)
}

/**
 * addChat(threadId, opts?)
 * ------------------------
 * Lightweight helper to register a thread locally if it isn't already present.
 * This lets the UI show a thread immediately (optimistic UX) while the overlay
 * control record and membership sync happen in the background.
 *
 * - `threadId` : canonical hex id for the conversation.
 * - `opts.name`: optional display name (for 1:1 it’s usually the counterparty’s
 *                display name; for groups it’s the title).
 * - `opts.participants`: optional list of members for display (not authoritative).
 * - `opts.keyB64`: optional legacy per-thread symmetric key (base64). We keep
 *                  this so we can still decrypt old AES-GCM attachments if needed.
 *
 * If a thread with the same id already exists in local storage we do nothing.
 * (Avoids stomping any newer metadata like a later title.)
 */
export async function addChat(
  threadId: string,
  opts?: Partial<Pick<ThreadRecord, 'name' | 'participants' | 'keyB64'>>
) {
  const existing = listThreads()
  if (existing.some(t => t.id === threadId)) {
    // Already indexed locally — bail out silently.
    return
  }

  upsertThread({
    id: threadId,
    name: opts?.name,                          // optional label for the UI
    participants: opts?.participants ?? undefined,
    // Keep keyB64 optional: with CurvePoint we usually won't have/need this,
    // but older threads or attachments might still rely on it.
    keyB64: opts?.keyB64 ?? ''
  })
}
