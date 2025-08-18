import { useEffect, useMemo, useRef, useState } from 'react'
import sendMessage from '../utils/sendMessage'
import type { OutboundMessageBody } from '../utils/sendMessage'
import type { ChatMessage } from '../utils/checkMessages'

type Props = {
  threadId: string
  myIdentityKeyHex: string
  threadKey: Uint8Array
  messages: ChatMessage[]
  onSent: (m: ChatMessage) => void
}

export default function Chat({
  threadId,
  myIdentityKeyHex,
  threadKey,
  messages,
  onSent
}: Props) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  const canSend = useMemo(() => text.trim().length > 0 && !sending, [text, sending])

  useEffect(() => {
    // Auto-scroll to bottom when messages change
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return

    const body: OutboundMessageBody = { text: trimmed }

    const optimistic: ChatMessage = { text: trimmed, authorId: myIdentityKeyHex }
    onSent(optimistic)
    setText('')
    setSending(true)

    try {
      await sendMessage({
        threadId,
        senderIdentityKeyHex: myIdentityKeyHex,
        threadKey,
        body
      })
    } catch (e) {
      console.error('[Chat] send failed', e)
      // TODO: Show a toast or mark last optimistic message as failed for retry
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        ref={listRef}
        style={{ flex: 1, overflow: 'auto', paddingBottom: 8 }}
      >
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <strong>{m.authorId === myIdentityKeyHex ? 'Me' : m.authorId}</strong>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          style={{ flex: 1, resize: 'vertical' }}
          placeholder="Type a message…"
          disabled={sending}
          onKeyDown={(e) => {
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
