import { useEffect, useRef, useState } from 'react'
import { ArrowDown, CheckCheck, Download, FileLock2, Info, LockKeyhole, Menu, MoreHorizontal, Paperclip, Phone, Send, ShieldCheck, SmilePlus, Trash2, Video, X } from 'lucide-react'
import type { ConversationSecret, ConversationView, MaterializedMessage, MessageDeliveryState } from '../domain/types'
import { identityInitials, identityName, type IdentityProfileMap } from '../hooks/useIdentityProfiles'
import { MAX_MEETING_PARTICIPANTS } from '../realtime/meetingCalling'
import type { CallMedia, RealtimePeer, TypingPeer } from '../realtime/messaging'

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
  identityProfiles: IdentityProfileMap
  callActive: boolean
  onOpenRail: () => void
  onOpenDetails: () => void
  onLoadHistory: () => Promise<void>
  onTyping: (active: boolean) => void
  onCall: (identityKeys: string[], media: CallMedia) => Promise<void>
  onSend: (body: string, files: File[]) => Promise<void>
  onEdit: (messageId: string, body: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
  onReact: (messageId: string, emoji: string) => Promise<void>
  onDownload: (message: MaterializedMessage, attachmentIndex: number) => Promise<void>
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
  const [callMenu, setCallMenu] = useState<CallMedia | null>(null)
  const [selectedCallMembers, setSelectedCallMembers] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const timeline = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraft(''); setFiles([]); setEditing(null); setCallMenu(null); setSelectedCallMembers([])
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

  const members = view?.members ?? secret.epochs.find((epoch) => epoch.epoch === secret.currentEpoch)?.members ?? []
  const otherMembers = members.filter((member) => member !== identityKey)
  const onlineSet = new Set(onlinePeers.map((peer) => peer.identityKey))
  const directPeer = otherMembers.length === 1 ? otherMembers[0] : null
  const beginCall = (media: CallMedia) => {
    if (directPeer) void props.onCall([directPeer], media)
    else {
      setSelectedCallMembers(otherMembers.filter((member) => onlineSet.has(member)).slice(0, MAX_MEETING_PARTICIPANTS - 1))
      setCallMenu(media)
    }
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
        <div className="header-copy"><h1>{view?.title || secret.title}</h1><span className={`presence ${liveState}`}><i />{liveState === 'live' ? (directPeer ? `${onlineSet.has(directPeer) ? 'Online' : 'Offline'} · Realtime private sync` : `${onlinePeers.length + 1} of ${members.length} online · Realtime private sync`) : liveState === 'fallback' ? 'Secure reconciliation fallback' : 'Connecting realtime sync'}</span></div>
        <div className="header-call-actions">
          <button className="header-call" disabled={props.callActive || liveState !== 'live' || onlinePeers.length === 0} onClick={() => beginCall('audio')} aria-label={directPeer ? 'Start voice call' : 'Start group audio meeting'} title={onlinePeers.length === 0 ? 'No other members are online' : directPeer ? 'Start voice call' : 'Start group audio meeting'}><Phone size={17} /></button>
          <button className="header-call" disabled={props.callActive || liveState !== 'live' || onlinePeers.length === 0} onClick={() => beginCall('video')} aria-label={directPeer ? 'Start video call' : 'Start group video meeting'} title={onlinePeers.length === 0 ? 'No other members are online' : directPeer ? 'Start video call' : 'Start group video meeting'}><Video size={18} /></button>
          {callMenu && <div className="call-member-menu" role="dialog" aria-label={`Choose participants for ${callMenu} meeting`}>
            <div><span><strong>{callMenu === 'video' ? 'Video' : 'Audio'} meeting</strong><small>Select up to {MAX_MEETING_PARTICIPANTS - 1} people</small></span><button onClick={() => setCallMenu(null)} aria-label="Close call menu"><X size={15} /></button></div>
            {otherMembers.filter((member) => onlineSet.has(member)).map((member) => {
              const online = true
              const selected = selectedCallMembers.includes(member)
              const atCapacity = selectedCallMembers.length >= MAX_MEETING_PARTICIPANTS - 1
              return <button className={`call-member ${selected ? 'selected' : ''}`} key={member} disabled={!online || (!selected && atCapacity)} onClick={() => setSelectedCallMembers((current) => selected ? current.filter((identityKey) => identityKey !== member) : [...current, member])}><i className={online ? 'online' : ''} /><span><strong>{identityName(props.identityProfiles, member)}</strong><small>{online ? (selected ? 'Included in meeting' : 'Online now') : 'Offline'}</small></span><b aria-hidden="true">{selected ? '✓' : ''}</b></button>
            })}
            <button className="call-menu-start" disabled={selectedCallMembers.length === 0} onClick={() => { const selected = selectedCallMembers; setCallMenu(null); void props.onCall(selected, callMenu) }}>{callMenu === 'video' ? <Video size={16} /> : <Phone size={16} />} Start meeting <span>{selectedCallMembers.length + 1}</span></button>
          </div>}
        </div>
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
              {!mine && <div className="message-sender-avatar">{identityInitials(props.identityProfiles, message.sender)}</div>}
              <div className="message-stack">
                <div className="message-meta"><span>{mine ? 'You' : identityName(props.identityProfiles, message.sender)}</span><time>{formatTime(message.createdAt)}</time>{message.edited && <em>edited</em>}</div>
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
          <span className="typing-avatars">{typingPeers.slice(0, 3).map((peer) => <i key={peer.identityKey}>{identityInitials(props.identityProfiles, peer.identityKey)}</i>)}</span>
          <span>{typingPeers.length === 1 ? `${identityName(props.identityProfiles, typingPeers[0].identityKey)} is typing` : typingPeers.length === 2 ? 'Two people are typing' : typingPeers.length > 2 ? `${typingPeers.length} people are typing` : ''}</span>
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
