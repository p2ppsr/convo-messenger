/**
 * Chat.tsx
 *
 * Simple chat window for a single thread.
 * - Renders a scrollable message list
 * - Lets me type and send a new message
 * - Performs an optimistic update so my message appears instantly
 * - Hands actual delivery off to sendMessage(), which encrypts & posts on-chain
 *
 * Notes:
 * - threadKey is the per-thread symmetric key; sendMessage() uses it to encrypt.
 * - myIdentityKeyHex is my identity pubkey (compressed secp256k1 hex).
 * - messages are already decrypted upstream (checkMessages).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import sendMessage from '../utils/sendMessage'
import type { OutboundMessageBody } from '../utils/sendMessage'
import type { ChatMessage } from '../utils/checkMessages'

type Props = {
  /** Which thread I’m chatting in */
  threadId: string
  /** My identity public key (used for optimistic author label + sendMessage) */
  myIdentityKeyHex: string
  /** 32-byte symmetric key for this thread (used by sendMessage to encrypt) */
  threadKey: Uint8Array
  /** Decrypted messages for this thread (rendered read-only here) */
  messages: ChatMessage[]
  /**
   * Callback so the parent can append my message optimistically to the buffer
   * (the parent owns the message list state).
   */
  onSent: (m: ChatMessage) => void
}

export default function Chat({
  threadId,
  myIdentityKeyHex,
  threadKey,
  messages,
  onSent
}: Props) {
  /** Controlled textarea value for my outgoing message */
  const [text, setText] = useState('')
  /** While a send is in flight I disable the input/button */
  const [sending, setSending] = useState(false)
  /** I keep a ref to the scroll container so I can auto-scroll on new messages */
  const listRef = useRef<HTMLDivElement | null>(null)

  /**
   * Only allow send if there’s non-whitespace content AND nothing is currently sending.
   * I memoize this so the handler closures aren’t re-created for every keystroke.
   */
  const canSend = useMemo(
    () => text.trim().length > 0 && !sending,
    [text, sending]
  )

  /**
   * Whenever messages change, I jump the scroll position to the bottom so the
   * newest content is visible without manual scrolling.
   */
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  /**
   * Submit handler:
   * 1) Validate input
   * 2) Build the message body payload
   * 3) Do an optimistic append via onSent() so the UI feels instant
   * 4) Call sendMessage() to actually encrypt + post the message
   * 5) If it fails, I log for now (could mark the optimistic bubble as failed for retry)
   */
  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return

    // What actually travels over the wire (after encryption inside sendMessage)
    const body: OutboundMessageBody = { text: trimmed }

    // Optimistic message shape used by the UI buffer
    const optimistic: ChatMessage = { text: trimmed, authorId: myIdentityKeyHex }

    // Push to the parent’s buffer immediately so the message shows up right away
    onSent(optimistic)

    // Clear the composer + flip the loading state
    setText('')
    setSending(true)

    try {
      await sendMessage({
        threadId,
        senderIdentityKeyHex: myIdentityKeyHex,
        threadKey, // used by sendMessage() to encrypt with AES-GCM
        body
      })
      // If this succeeds, nothing else to do—the poller will pick up the real one too.
      // (Optionally reconcile optimistic vs confirmed here if you want delivery status.)
    } catch (e) {
      console.error('[Chat] send failed', e)
      // TODO: surface a toast or mark the optimistic bubble as “failed” with a retry button.
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Scrollable message list */}
      <div
        ref={listRef}
        style={{ flex: 1, overflow: 'auto', paddingBottom: 8 }}
      >
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            {/* Show “Me” for my messages; otherwise show the sender’s identity key */}
            <strong>{m.authorId === myIdentityKeyHex ? 'Me' : m.authorId}</strong>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          style={{ flex: 1, resize: 'vertical' }}
          placeholder="Type a message…"
          disabled={sending}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter inserts a newline
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) submit()
            }
          }}
        />
        <button
          onClick={submit}
          disabled={!canSend}
          aria-busy={sending}
          aria-label="Send message"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
