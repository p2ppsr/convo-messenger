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

import { IdentitySearchField } from '@bsv/identity-react'
import type { DisplayableIdentity } from '@bsv/sdk'

import { randomKey32 } from './utils/wallet'
import { createThreadAndInvite } from './utils/createThread'
import { syncThreadsFromOverlay } from './utils/syncThreads'

export default function App() {
  const [myIdentityKeyHex, setMyIdentityKeyHex] = useState<string>('')
  const [threads, setThreads] = useState<ThreadRecord[]>(listThreads())
  const [activeThreadId, setActiveThreadId] = useState<string>(() => threads[0]?.id ?? '')
  const [buffers, setBuffers] = useState<Record<string, ChatMessage[]>>({})
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({})

  // Fetch my identity from wallet (or env fallback inside getIdentityKeyHex)
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

  // Ensure there is an active thread selected when list changes
  useEffect(() => {
    if (threads.length && !activeThreadId) setActiveThreadId(threads[0].id)
  }, [threads, activeThreadId])

  // Poll overlay for new messages across all threads
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const ids = threads.map(t => t.id)
        if (ids.length === 0) return

        const keyMap: Record<string, Uint8Array> = {}
        for (const t of threads) {
          const k = getThreadKey(t.id)
          if (k && k.length === 32) keyMap[t.id] = k
        }

        const map = await checkMessages(ids, lastSeen, keyMap, 200)
        if (!alive || map.size === 0) return

        setBuffers(prev => {
          const next = { ...prev }
          map.forEach((msgs, threadId) => {
            next[threadId] = [...(next[threadId] ?? []), ...msgs]
          })
          return next
        })
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
    tick()
    return () => { alive = false; clearInterval(id) }
  }, [threads, lastSeen])

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

  const activeThread = threads.find(t => t.id === activeThreadId)
  const activeKey = activeThread ? getThreadKey(activeThread.id) : undefined
  const activeMessages = buffers[activeThreadId] ?? []

  const onSend = async (msg: ChatMessage) => {
    if (!activeThread || !activeKey || !myIdentityKeyHex) {
      console.error('[Convo] No active thread/key or my identity unknown')
      return
    }
    const body: OutboundMessageBody = { text: msg.text }

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
        threadKey: activeKey,
        body
      })
    } catch (e) {
      console.error('[Convo] send failed', e)
      // TODO: Retry UI
    }
  }

  return (
    <div className="app-shell">
      <aside className="left-pane">
        <h3>Convo-Messenger</h3>

        <NewChatPanel
          myIdentityKeyHex={myIdentityKeyHex}
          onCreated={(rec) => {
            // keep local index so UI is instant
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
        {activeThread && activeKey && myIdentityKeyHex ? (
          <Chat
            threadId={activeThread.id}
            myIdentityKeyHex={myIdentityKeyHex}
            threadKey={activeKey}
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

/* ---------------- New Chat Panel ---------------- */

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

  // Deterministic 1:1 thread id (same both sides, no identity ordering leak)
  const computeOneToOneThreadId = async (a: string, b: string): Promise<string> => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort()
    const seed = `convo|${x}|${y}`
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // Random thread id for titled chats
  const randomThreadId = (): string => {
    const rnd = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(rnd).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  const createPrivate = async () => {
    if (!recipient?.identityKey || !myIdentityKeyHex) return
    setBusy(true)
    try {
      const threadId = await computeOneToOneThreadId(myIdentityKeyHex, recipient.identityKey)
      const key = randomKey32()

      await createThreadAndInvite({
        threadId,
        title: recipient.name || recipient.identityKey,
        groupKey: key,
        members: [
          { identityKeyHex: myIdentityKeyHex },
          { identityKeyHex: recipient.identityKey }
        ]
      })

      // Persist locally so the UI is instant
      onCreated({
        id: threadId,
        name: recipient.name || recipient.identityKey,
        keyB64: btoa(String.fromCharCode(...key))
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

  const createTitled = async () => {
    if (!title.trim() || !myIdentityKeyHex) return
    setBusy(true)
    try {
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
        keyB64: btoa(String.fromCharCode(...key))
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
