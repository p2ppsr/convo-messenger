import { useEffect, useRef, useState } from 'react'
import { ArrowDown, CheckCheck, Download, FileLock2, Info, LockKeyhole, Menu, MoreHorizontal, Paperclip, Send, ShieldCheck, SmilePlus, Trash2 } from 'lucide-react'
import type { ConversationSecret, ConversationView, MaterializedMessage, MessageDeliveryState } from '../domain/types'
import type { RealtimePeer, TypingPeer } from '../realtime/messaging'

interface Props {
  identityKey: string
  secret: ConversationSecret | null
  view: ConversationView | null
  loading: boolean
  busy: boolean
  liveState: 'connecting' | 'live' | 'fallback'
  onlinePeers: RealtimePeer[]
  typingPeers: TypingPeer[]
  deliveryStates: Record<string, MessageDeliveryState>
  onOpenRail: () => void
  onOpenDetails: () => void
  onLoadHistory: () => Promise<void>
  onTyping: (active: boolean) => void
  onSend: (body: string, files: File[]) => Promise<void>
  onEdit: (messageId: string, body: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
  onReact: (messageId: string, emoji: string) => Promise<void>
  onDownload: (message: MaterializedMessage, attachmentIndex: number) => Promise<void>
}

function shortKey(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-6)}`
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
}

export function ConversationPane(props: Props) {
  const { identityKey, secret, view, loading, busy, liveState, onlinePeers, typingPeers, deliveryStates, onTyping } = props
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const timeline = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraft(''); setFiles([]); setEditing(null)
    return () => onTyping(false)
  }, [secret?.conversationId, onTyping])
  useEffect(() => {
    const element = timeline.current
    if (!element) return
    if (typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight })
    else element.scrollTop = element.scrollHeight
  }, [view?.messages.length, secret?.conversationId])

  if (!secret) {
    return (
      <main className="conversation-pane empty-pane">
        <button className="icon-button mobile-menu" onClick={props.onOpenRail} aria-label="Open conversations"><Menu size={21} /></button>
        <div className="empty-hero"><div className="hero-lock"><LockKeyhole size={34} /></div><span className="eyebrow">Convo protocol v2</span><h1>Group chat without a public group.</h1><p>Conversation locators, member lists, titles, and messages stay secret. Pick a conversation or create a new one.</p><div className="security-pills"><span><ShieldCheck size={15} /> End-to-end encrypted</span><span><FileLock2 size={15} /> Wallet-private keys</span></div></div>
      </main>
    )
  }

  const submit = async () => {
    if ((!draft.trim() && files.length === 0) || busy) return
    const currentDraft = draft
    const currentFiles = files
    setDraft('')
    setFiles([])
    onTyping(false)
    try { await props.onSend(currentDraft, currentFiles) } catch { setDraft(currentDraft); setFiles(currentFiles) }
  }

  return (
    <main className="conversation-pane">
      <header className="conversation-header">
        <button className="icon-button mobile-menu" onClick={props.onOpenRail} aria-label="Open conversations"><Menu size={21} /></button>
        <div className="header-avatar">{secret.title.slice(0, 2).toUpperCase()}</div>
        <div className="header-copy"><h1>{view?.title || secret.title}</h1><span className={`presence ${liveState}`}><i />{liveState === 'live' ? `${onlinePeers.length > 0 ? `${onlinePeers.length + 1} active · ` : ''}Realtime private sync` : liveState === 'fallback' ? 'Secure reconciliation fallback' : 'Connecting realtime sync'}</span></div>
        <button className="header-details" onClick={props.onOpenDetails}><Info size={18} /><span>Details</span></button>
      </header>

      {view?.partial && <button className="history-banner" onClick={() => void props.onLoadHistory()}><ArrowDown size={16} /> Older encrypted pages are available. Load full history.</button>}
      <div className="message-timeline" ref={timeline} aria-live="polite">
        {loading && <div className="timeline-state"><span className="spinner" /> Opening encrypted pages…</div>}
        {!loading && view?.messages.length === 0 && <div className="timeline-empty"><ShieldCheck size={27} /><h2>This conversation is ready</h2><p>Send the first end-to-end encrypted message.</p></div>}
        {view?.messages.map((message) => {
          const mine = message.sender === identityKey
          const isEditing = editing === message.id
          return (
            <article className={`message-row ${mine ? 'mine' : ''}`} key={message.id}>
              {!mine && <div className="message-sender-avatar">{message.sender.slice(2, 4).toUpperCase()}</div>}
              <div className="message-stack">
                <div className="message-meta"><span>{mine ? 'You' : shortKey(message.sender)}</span><time>{formatTime(message.createdAt)}</time>{message.edited && <em>edited</em>}</div>
                <div className="message-bubble">
                  {isEditing ? <div className="edit-form"><textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} autoFocus /><div><button className="text-button" onClick={() => setEditing(null)}>Cancel</button><button className="compact-button is-active" onClick={() => void props.onEdit(message.id, editBody).then(() => setEditing(null))}>Save</button></div></div> : <p>{message.body}</p>}
                  {message.attachments.map((attachment, index) => <button className="attachment-card" key={attachment.id} onClick={() => void props.onDownload(message, index)}><FileLock2 size={19} /><span><strong>{attachment.name}</strong><small>{Math.max(1, Math.round(attachment.size / 1024))} KB · encrypted</small></span><Download size={16} /></button>)}
                </div>
                {message.reactions.length > 0 && <div className="reaction-list">{[...new Set(message.reactions.map((reaction) => reaction.emoji))].map((emoji) => <button key={emoji} onClick={() => void props.onReact(message.id, emoji)}>{emoji} {message.reactions.filter((reaction) => reaction.emoji === emoji).length}</button>)}</div>}
                <div className="message-actions">
                  <button onClick={() => void props.onReact(message.id, '👍')} aria-label="React"><SmilePlus size={14} /> React</button>
                  {mine && !isEditing && <button onClick={() => { setEditing(message.id); setEditBody(message.body) }}><MoreHorizontal size={14} /> Edit</button>}
                  {mine && <button className="danger-text" onClick={() => window.confirm('Delete this message for everyone in the current conversation history?') && void props.onDelete(message.id)}><Trash2 size={14} /> Delete</button>}
                </div>
                {mine && deliveryStates[message.id] && <div className={`delivery-state ${deliveryStates[message.id]}`}><CheckCheck size={12} />{deliveryStates[message.id] === 'sending' ? 'Sending live…' : deliveryStates[message.id] === 'live' ? 'Delivered live · saving' : deliveryStates[message.id] === 'retrying' ? 'Saved locally · retrying' : 'Saved on-chain'}</div>}
              </div>
            </article>
          )
        })}
      </div>

      <footer className="composer-shell">
        <div className={`typing-indicator ${typingPeers.length > 0 ? 'visible' : ''}`} aria-live="polite">
          <span className="typing-avatars">{typingPeers.slice(0, 3).map((peer) => <i key={peer.identityKey}>{peer.identityKey.slice(2, 4).toUpperCase()}</i>)}</span>
          <span>{typingPeers.length === 1 ? `${shortKey(typingPeers[0].identityKey)} is typing` : typingPeers.length === 2 ? 'Two people are typing' : typingPeers.length > 2 ? `${typingPeers.length} people are typing` : ''}</span>
          {typingPeers.length > 0 && <b><i /><i /><i /></b>}
        </div>
        {files.length > 0 && <div className="file-queue">{files.map((file) => <span key={`${file.name}:${file.size}`}><FileLock2 size={14} />{file.name}<button onClick={() => setFiles((current) => current.filter((item) => item !== file))}>×</button></span>)}</div>}
        <div className="composer">
          <input ref={fileInput} type="file" multiple hidden onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
          <button className="icon-button attach-button" onClick={() => fileInput.current?.click()} aria-label="Attach encrypted files"><Paperclip size={20} /></button>
          <textarea value={draft} maxLength={20_000} onChange={(event) => { setDraft(event.target.value); onTyping(event.target.value.trim().length > 0) }} onBlur={() => onTyping(false)} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
          }} placeholder="Write a private message" rows={1} />
          <button className="send-button" disabled={busy || (!draft.trim() && files.length === 0)} onClick={() => void submit()} aria-label="Send message"><Send size={19} /></button>
        </div>
        <div className="composer-note"><LockKeyhole size={12} /> Encrypted before leaving this device <span><CheckCheck size={12} /> Durable outbox</span></div>
      </footer>
    </main>
  )
}
