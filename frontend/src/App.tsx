// src/App.tsx
//
// Top-level UI for Convo-Messenger.
// - bootstraps my identity (wallet or env fallback)
// - lists local threads (stored in localStorage)
// - polls overlay for new messages (CurvePoint-based decrypt in checkMessages)
// - lets me send messages (sendMessage handles CurvePoint encrypt + post)
// - creates new 1:1 or titled threads (createThreadAndInvite)
// - performs a one-time sync to discover remote threads I’m a member of
//
// Notes on keys:
// * Messages no longer require a per-thread symmetric key because we use CurvePoint
//   to encrypt each message to all recipients. However, we still keep a per-thread
//   32-byte key locally for (a) legacy decrypt paths and (b) encrypted attachments.

import { useEffect, useState } from 'react'
import checkMessages, { type ChatMessage } from './utils/checkMessages'
import sendMessage, { type OutboundMessageBody } from './utils/sendMessage'
import { getIdentityKeyHex } from './utils/getMyId'
import {
  listThreads,
  getThreadKey,
  setThreadKey,
  upsertThread,
  type ThreadRecord
} from './utils/threadStore'
import Chat from './components/Chat'
import './App.scss'

// People search UI (BSV identity)
import { IdentitySearchField } from '@bsv/identity-react'
import type { DisplayableIdentity } from '@bsv/sdk'

// Key + thread creation utilities
import { randomKey32 } from './utils/wallet'
import { createThreadAndInvite } from './utils/createThread'
import { syncThreadsFromOverlay } from './utils/syncThreads'

export default function App() {
  // My identity (02/03… hex). We fetch it once from wallet or env fallback.
  const [myIdentityKeyHex, setMyIdentityKeyHex] = useState<string>('')

  // Local list of threads (persisted in localStorage via threadStore).
  const [threads, setThreads] = useState<ThreadRecord[]>(listThreads())

  // Which thread is open in the right pane.
  const [activeThreadId, setActiveThreadId] = useState<string>(() => threads[0]?.id ?? '')

  // Per-thread message buffers we’ve shown in the UI (append-only in this component).
  const [buffers, setBuffers] = useState<Record<string, ChatMessage[]>>({})

  // Per-thread watermark so we only pull new messages after a given time.
  // checkMessages already filters based on this.
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({})

  /* ---------------- Boot my identity ---------------- */

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const k = await getIdentityKeyHex()
        if (alive) setMyIdentityKeyHex(k)
      } catch (e) {
        console.error('[Convo] identity error:', e)
      }
    })()
    return () => { alive = false }
  }, [])

  /* ---------------- Keep an active thread selected ---------------- */

  useEffect(() => {
    // If we loaded threads and nothing is selected, pick the first one.
    if (threads.length && !activeThreadId) setActiveThreadId(threads[0].id)
  }, [threads, activeThreadId])

  /* ---------------- Poll the overlay for new messages ---------------- */

  useEffect(() => {
    let alive = true

    // Every tick: ask overlay for latest messages (per thread), decrypt via CurvePoint, update buffers.
    const tick = async () => {
      try {
        const ids = threads.map(t => t.id)
        if (ids.length === 0) return

        // checkMessages(threadIds, lastSeen, limit?)
        const map = await checkMessages(ids, lastSeen, 200)
        if (!alive || map.size === 0) return

        // 1) Append new messages into our local buffers (by threadId).
        setBuffers(prev => {
          const next = { ...prev }
          map.forEach((msgs, threadId) => {
            next[threadId] = [...(next[threadId] ?? []), ...msgs]
          })
          return next
        })

        // 2) Bump lastSeen for those threads to "now" (simple watermark).
        setLastSeen(prev => {
          const next = { ...prev }
          map.forEach((_msgs, threadId) => {
            next[threadId] = Date.now()
          })
          return next
        })
      } catch (e) {
        console.error('[Convo] poll error', e)
      }
    }

    const id = setInterval(tick, 3000)
    void tick() // fire immediately, then every 3s
    return () => { alive = false; clearInterval(id) }
  }, [threads, lastSeen])

  /* ---------------- One-time overlay sync for threads ----------------
     - Finds remote threads where I'm a member
     - Fetches + decrypts the group key envelope (CurvePoint) or legacy box
     - Adds to local threadStore so UI can show them.
  -------------------------------------------------------------------- */

  useEffect(() => {
    if (!myIdentityKeyHex) return
    let alive = true
    ;(async () => {
      try {
        await syncThreadsFromOverlay()
        if (alive) setThreads(listThreads()) // refresh local thread list
      } catch (e) {
        console.error('[Convo] syncThreadsFromOverlay failed', e)
      }
    })()
    return () => { alive = false }
  }, [myIdentityKeyHex])

  /* ---------------- Derived data for the right pane ---------------- */

  const activeThread = threads.find(t => t.id === activeThreadId)
  // We still retrieve the per-thread key (kept for legacy + attachments).
  const activeKey = activeThread ? getThreadKey(activeThread.id) : undefined
  const activeMessages = buffers[activeThreadId] ?? []

  /* ---------------- Send handler (optimistic) ----------------
     - push optimistic message to buffer
     - sendMessage handles CurvePoint encrypt + post
     - on failure, we could mark the optimistic row as failed (TODO)
     - IMPORTANT: pass recipients from threadStore so sendMessage can seal
                  with CurvePoint immediately (fixes "No recipients found" errors).
  ------------------------------------------------------------ */

  const onSend = async (msg: ChatMessage) => {
    if (!activeThread || !myIdentityKeyHex) {
      console.error('[Convo] No active thread or my identity unknown')
      return
    }
    // attachments may still rely on the 32-byte per-thread key
    if (!activeKey) {
      console.warn('[Convo] No per-thread key found (attachments/legacy decrypt may fail)')
    }

    const body: OutboundMessageBody = { text: msg.text }

    // Optimistic append in the open thread
    setBuffers(prev => ({
      ...prev,
      [activeThread.id]: [
        ...(prev[activeThread.id] ?? []),
        { ...msg, authorId: myIdentityKeyHex }
      ]
    }))

    try {
      await sendMessage({
        threadId: activeThread.id,
        senderIdentityKeyHex: myIdentityKeyHex,
        threadKey: activeKey ?? undefined, // not used for CurvePoint messages; kept for attachments
        body,
        // 🔑 Critical: include recipients so sendMessage has them immediately.
        // (syncThreadsFromOverlay will also store these, but passing here avoids timing issues.)
        recipients: activeThread.participants ?? []
      })
    } catch (e) {
      console.error('[Convo] send failed', e)
      // TODO: mark the last optimistic message as failed and allow retry
    }
  }

  /* ---------------- Render ---------------- */

  return (
    <div className="app-shell">
      <aside className="left-pane">
        <h3>Convo-Messenger</h3>

        <NewChatPanel
          myIdentityKeyHex={myIdentityKeyHex}
          onCreated={(rec) => {
            // Keep a local index so the UI updates instantly.
            upsertThread(rec)
            const next = listThreads()
            setThreads(next)
            setActiveThreadId(rec.id)
          }}
        />

        <ul className="thread-list">
          {threads.map(t => (
            <li key={t.id}>
              <button
                className={t.id === activeThreadId ? 'thread-btn active' : 'thread-btn'}
                onClick={() => setActiveThreadId(t.id)}
                title={t.id}
              >
                {t.name || t.id}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="right-pane">
        {activeThread && myIdentityKeyHex ? (
          <Chat
            threadId={activeThread.id}
            myIdentityKeyHex={myIdentityKeyHex}
            threadKey={activeKey ?? new Uint8Array()} // safe default; not used for CurvePoint
            messages={activeMessages}
            onSent={onSend}
          />
        ) : (
          <div style={{ padding: '24px' }}>
            {myIdentityKeyHex
              ? 'Select or create a thread to start chatting.'
              : 'Connecting to your wallet…'}
          </div>
        )}
      </main>
    </div>
  )
}

/* =======================================================================
   New Chat Panel
   - Lets me create either a 1:1 (deterministic id) or a titled thread (random id)
   - We still generate and store a per-thread 32-byte key locally:
     * legacy decrypt
     * encrypted attachments
   - createThreadAndInvite seals the key in a CurvePoint envelope to all recipients.
   - IMPORTANT: persist `participants` so sendMessage has recipients.
   ======================================================================= */

function NewChatPanel({
  myIdentityKeyHex,
  onCreated
}: {
  myIdentityKeyHex: string
  onCreated: (rec: ThreadRecord) => void
}) {
  const [title, setTitle] = useState('')
  const [recipient, setRecipient] = useState<DisplayableIdentity | null>(null)
  const [busy, setBusy] = useState(false)

  // Deterministic 1:1 thread id (both sides compute the same value; prevents ordering leaks)
  const computeOneToOneThreadId = async (a: string, b: string): Promise<string> => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort()
    const seed = `convo|${x}|${y}`
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // Random 128-bit id for titled group chats
  const randomThreadId = (): string => {
    const rnd = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(rnd).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // Create a private 1:1 chat with deterministic id
  const createPrivate = async () => {
    if (!recipient?.identityKey || !myIdentityKeyHex) return
    setBusy(true)
    try {
      const them = recipient.identityKey.toLowerCase()
      const me = myIdentityKeyHex.toLowerCase()
      const threadId = await computeOneToOneThreadId(me, them)

      // Even though CurvePoint encrypts messages per-send, we still keep a per-thread key
      // for attachments + legacy decrypt paths.
      const key = randomKey32()

      await createThreadAndInvite({
        threadId,
        title: recipient.name || recipient.identityKey, // store a friendly name if available
        groupKey: key,
        members: [
          { identityKeyHex: myIdentityKeyHex },
          { identityKeyHex: recipient.identityKey }
        ]
      })

      // Persist locally so the UI shows the new thread immediately
      onCreated({
        id: threadId,
        name: recipient.name || recipient.identityKey,
        keyB64: btoa(String.fromCharCode(...key)),
        // 🔑 Critical: store participants so sendMessage can seal to them.
        participants: [me, them]
      })
      setThreadKey(threadId, key)
      setRecipient(null)
    } catch (e) {
      console.error('[Convo] createPrivate failed', e)
      alert('Failed to create private chat')
    } finally {
      setBusy(false)
    }
  }

  // Create a titled thread with a random id (acts like a group room)
  const createTitled = async () => {
    if (!title.trim() || !myIdentityKeyHex) return
    setBusy(true)
    try {
      const me = myIdentityKeyHex.toLowerCase()
      const threadId = randomThreadId()
      const key = randomKey32()

      await createThreadAndInvite({
        threadId,
        title: title.trim(),
        groupKey: key,
        members: [{ identityKeyHex: myIdentityKeyHex }]
      })

      onCreated({
        id: threadId,
        name: title.trim(),
        keyB64: btoa(String.fromCharCode(...key)),
        participants: [me] // you can add more later when inviting others
      })
      setThreadKey(threadId, key)
      setTitle('')
    } catch (e) {
      console.error('[Convo] createTitled failed', e)
      alert('Failed to create thread')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="new-chat-card">
      <div className="section">
        <label className="label">Start private chat</label>
        <IdentitySearchField appName="ConvoMessenger" onIdentitySelected={setRecipient} />
        <button
          className="primary-btn"
          onClick={createPrivate}
          disabled={!recipient || !myIdentityKeyHex || busy}
          style={{ marginTop: 8 }}
        >
          {busy ? 'Working…' : 'Create 1:1'}
        </button>
      </div>

      <div className="divider" />

      <div className="section">
        <label className="label">Start titled thread</label>
        <input
          className="text-input"
          placeholder="Thread title"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
        <button
          className="secondary-btn"
          onClick={createTitled}
          disabled={!title.trim() || !myIdentityKeyHex || busy}
          style={{ marginTop: 8 }}
        >
          {busy ? 'Working…' : 'Create'}
        </button>
      </div>
    </div>
  )
}
