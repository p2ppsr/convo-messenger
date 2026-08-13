import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, AtSign, CheckCheck, Download, FileLock2, Info, LockKeyhole, Menu, Mic, MoreHorizontal, Paperclip, Phone, Search, Send, ShieldCheck, SmilePlus, Square, Trash2, Video, X } from 'lucide-react'
import type { ConversationSecret, ConversationView, MaterializedMessage, MessageDeliveryState } from '../domain/types'
import { identityInitials, identityName, type IdentityProfileMap } from '../hooks/useIdentityProfiles'
import { conversationName } from '../domain/presentation'
import { activeMentionDraft, displayMessageText, insertMention, mentionedIdentities, MENTION_PATTERN, type MentionDraft } from '../domain/mentions'
import { isInlineAudio, isInlineImage, MAX_ATTACHMENT_BYTES } from '../domain/attachmentValidation'
import { MAX_MEETING_PARTICIPANTS } from '../realtime/meetingCalling'
import type { CallMedia, RealtimePeer, TypingPeer } from '../realtime/messaging'
import { IdentityAvatar } from './IdentityAvatar'
import { EncryptedMediaAttachment } from './EncryptedImageAttachment'

const MAX_RECORDING_SECONDS = 10 * 60

function preferredRecordingType(): string {
  for (const type of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

function voiceRecordingName(type: string): string {
  const extension = type.startsWith('audio/mp4') ? 'm4a' : 'webm'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `Voice recording ${timestamp}.${extension}`
}

function AudioDraft({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return <div className="audio-draft"><span><Mic size={15} /><strong>Review recording</strong><small>{file.name}</small></span>{url && <audio controls src={url} preload="metadata" aria-label="Review voice recording" />}<button onClick={onRemove} aria-label="Discard voice recording"><X size={15} /> Discard</button></div>
}

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
  onOpenAttachment: (message: MaterializedMessage, attachmentIndex: number) => Promise<Blob>
  onDownload: (message: MaterializedMessage, attachmentIndex: number) => Promise<void>
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
}

function messageBody(body: string, profiles: IdentityProfileMap): ReactNode[] {
  const output: ReactNode[] = []
  let cursor = 0
  for (const match of body.matchAll(new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags))) {
    const start = match.index
    if (start > cursor) output.push(body.slice(cursor, start))
    const identityKey = match[1]
    output.push(<span className="message-mention" title={identityKey} key={`${start}:${identityKey}`}><AtSign size={13} />{identityName(profiles, identityKey)}</span>)
    cursor = start + match[0].length
  }
  if (cursor < body.length) output.push(body.slice(cursor))
  return output
}

export function ConversationPane(props: Props) {
  const { identityKey, secret, view, loading, busy, liveState, onlinePeers, typingPeers, deliveryStates, onTyping } = props
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [callMenu, setCallMenu] = useState<CallMedia | null>(null)
  const [selectedCallMembers, setSelectedCallMembers] = useState<string[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [mentionDraft, setMentionDraft] = useState<MentionDraft | null>(null)
  const [mentionSelection, setMentionSelection] = useState(0)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [recordingError, setRecordingError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const recordingStream = useRef<MediaStream | null>(null)
  const recordingChunks = useRef<Blob[]>([])
  const discardRecording = useRef(false)

  const stopRecording = (discard = false) => {
    discardRecording.current = discard
    if (recorder.current?.state !== 'inactive') recorder.current?.stop()
    recordingStream.current?.getTracks().forEach((track) => track.stop())
    recordingStream.current = null
  }

  const startRecording = async () => {
    setRecordingError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setRecordingError('Audio recording is not supported by this browser.')
      return
    }
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const preferredType = preferredRecordingType()
      const next = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined)
      recordingStream.current = stream
      recordingChunks.current = []
      discardRecording.current = false
      next.ondataavailable = (event) => { if (event.data.size) recordingChunks.current.push(event.data) }
      next.onerror = () => setRecordingError('The recording stopped unexpectedly.')
      next.onstop = () => {
        const mimeType = (next.mimeType || preferredType || 'audio/webm').split(';')[0]
        const blob = new Blob(recordingChunks.current, { type: mimeType })
        if (!discardRecording.current && blob.size > 0 && blob.size <= MAX_ATTACHMENT_BYTES) {
          setFiles((current) => [...current, new File([blob], voiceRecordingName(mimeType), { type: mimeType })])
        } else if (!discardRecording.current && blob.size > MAX_ATTACHMENT_BYTES) {
          setRecordingError('Recording exceeded the 25 MB attachment limit.')
        }
        recorder.current = null
        recordingChunks.current = []
        setIsRecording(false)
        setRecordingSeconds(0)
      }
      recorder.current = next
      next.start(1_000)
      setIsRecording(true)
      setRecordingSeconds(0)
    } catch (reason) {
      stream?.getTracks().forEach((track) => track.stop())
      setRecordingError(reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? 'Microphone access was not allowed.'
        : 'Could not start audio recording.')
    }
  }

  useEffect(() => {
    setDraft(''); setFiles([]); setEditing(null); setCallMenu(null); setSelectedCallMembers([]); setSearchOpen(false); setSearchQuery(''); setMentionDraft(null); setRecordingError('')
    return () => {
      onTyping(false)
      discardRecording.current = true
      if (recorder.current?.state !== 'inactive') recorder.current?.stop()
      recordingStream.current?.getTracks().forEach((track) => track.stop())
    }
  }, [secret?.conversationId, onTyping])
  useEffect(() => {
    if (!isRecording) return
    const timer = window.setInterval(() => setRecordingSeconds((seconds) => {
      if (seconds + 1 >= MAX_RECORDING_SECONDS) {
        if (recorder.current?.state !== 'inactive') recorder.current?.stop()
        recordingStream.current?.getTracks().forEach((track) => track.stop())
        recordingStream.current = null
      }
      return seconds + 1
    }), 1_000)
    return () => window.clearInterval(timer)
  }, [isRecording])
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
        {loading
          ? <div className="empty-hero" role="status"><span className="wallet-spinner" /><span className="eyebrow">Wallet-private index</span><h1>Loading your conversations…</h1><p>Decrypting group titles and membership locally. Nothing in the public overlay reveals your roster.</p></div>
          : <div className="empty-hero"><div className="hero-lock"><LockKeyhole size={34} /></div><span className="eyebrow">Convo protocol v2</span><h1>Group chat without a public group.</h1><p>Conversation locators, member lists, titles, and messages stay secret. Pick a conversation or create a new one.</p><div className="security-pills"><span><ShieldCheck size={15} /> End-to-end encrypted</span><span><FileLock2 size={15} /> Wallet-private keys</span></div></div>}
      </main>
    )
  }

  const members = view?.members ?? secret.epochs.find((epoch) => epoch.epoch === secret.currentEpoch)?.members ?? []
  const otherMembers = members.filter((member) => member !== identityKey)
  const onlineSet = new Set(onlinePeers.map((peer) => peer.identityKey))
  const directPeer = otherMembers.length === 1 ? otherMembers[0] : null
  const displayTitle = conversationName(secret, identityKey, props.identityProfiles)
  const beginCall = (media: CallMedia) => {
    if (directPeer) void props.onCall([directPeer], media)
    else {
      setSelectedCallMembers(otherMembers.filter((member) => onlineSet.has(member)).slice(0, MAX_MEETING_PARTICIPANTS - 1))
      setCallMenu(media)
    }
  }

  const mentionCandidates = mentionDraft
    ? members.filter((member) => member !== identityKey).filter((member) => {
      const searchable = `${identityName(props.identityProfiles, member)} ${member}`.toLocaleLowerCase()
      return !mentionDraft.query || searchable.includes(mentionDraft.query)
    }).slice(0, 8)
    : []
  const cleanSearch = searchQuery.trim().toLocaleLowerCase()
  const visibleMessages = !cleanSearch ? (view?.messages ?? []) : (view?.messages ?? []).filter((message) => (
    displayMessageText(message.body, props.identityProfiles).toLocaleLowerCase().includes(cleanSearch)
    || identityName(props.identityProfiles, message.sender).toLocaleLowerCase().includes(cleanSearch)
    || message.attachments.some((attachment) => attachment.name.toLocaleLowerCase().includes(cleanSearch))
  ))

  const chooseMention = (member: string) => {
    if (!mentionDraft) return
    const insertion = insertMention(draft, mentionDraft, member)
    setDraft(insertion.value)
    setMentionDraft(null)
    setMentionSelection(0)
    requestAnimationFrame(() => {
      composerInput.current?.focus()
      composerInput.current?.setSelectionRange(insertion.cursor, insertion.cursor)
    })
  }

  const submit = async () => {
    if ((!draft.trim() && files.length === 0) || busy || isRecording) return
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
        {directPeer
          ? <IdentityAvatar className="header-avatar" identityKey={directPeer} profiles={props.identityProfiles} fallback={displayTitle.slice(0, 2).toUpperCase()} />
          : <div className="header-avatar">{displayTitle.slice(0, 2).toUpperCase()}</div>}
        <div className="header-copy"><h1>{displayTitle}</h1><span className={`presence ${liveState}`}><i />{liveState === 'live' ? (directPeer ? `${onlineSet.has(directPeer) ? 'Online' : 'Offline'} · Realtime private sync` : `${onlinePeers.length + 1} of ${members.length} online · Realtime private sync`) : liveState === 'fallback' ? 'Secure reconciliation fallback' : 'Connecting realtime sync'}</span></div>
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
        <button className={`header-call ${searchOpen ? 'is-active' : ''}`} onClick={() => { setSearchOpen((current) => !current); if (searchOpen) setSearchQuery('') }} aria-label="Search this conversation" title="Search this conversation"><Search size={18} /></button>
        <button className="header-details" onClick={props.onOpenDetails}><Info size={18} /><span>Details</span></button>
      </header>

      {(searchOpen || view?.partial) && <div className="conversation-tools">
        {searchOpen && <label className="message-search"><Search size={16} /><input autoFocus type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search decrypted messages" /><span>{cleanSearch ? `${visibleMessages.length} result${visibleMessages.length === 1 ? '' : 's'}` : 'On this device'}</span><button onClick={() => { setSearchOpen(false); setSearchQuery('') }} aria-label="Close message search"><X size={15} /></button></label>}
        {view?.partial && <button className="history-banner" onClick={() => void props.onLoadHistory()}><ArrowDown size={16} /> Older encrypted events are available. Load full history.</button>}
      </div>}
      <div className="message-timeline" ref={timeline} aria-live="polite">
        {loading && <div className="timeline-state"><span className="spinner" /> Opening encrypted history…</div>}
        {!loading && view?.messages.length === 0 && <div className="timeline-empty"><ShieldCheck size={27} /><h2>This conversation is ready</h2><p>Send the first end-to-end encrypted message.</p></div>}
        {!loading && cleanSearch && visibleMessages.length === 0 && <div className="timeline-empty search-empty"><Search size={27} /><h2>No matching messages</h2><p>Search checks decrypted text, people, and attachment names locally.</p></div>}
        {visibleMessages.map((message) => {
          const mine = message.sender === identityKey
          const isEditing = editing === message.id
          const mentionsMe = mentionedIdentities(message.body).includes(identityKey)
          return (
            <article className={`message-row ${mine ? 'mine' : ''} ${mentionsMe ? 'mentions-me' : ''}`} key={message.id}>
              {!mine && <IdentityAvatar className="message-sender-avatar" identityKey={message.sender} profiles={props.identityProfiles} />}
              <div className="message-stack">
                <div className="message-meta"><span>{mine ? 'You' : identityName(props.identityProfiles, message.sender)}</span><time>{formatTime(message.createdAt)}</time>{message.edited && <em>edited</em>}{mentionsMe && <em className="mentioned-you"><AtSign size={10} /> Mentioned you</em>}</div>
                <div className="message-bubble">
                  {isEditing ? <div className="edit-form"><textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} autoFocus /><div><button className="text-button" onClick={() => setEditing(null)}>Cancel</button><button className="compact-button is-active" onClick={() => void props.onEdit(message.id, editBody).then(() => setEditing(null))}>Save</button></div></div> : <p>{messageBody(message.body, props.identityProfiles)}</p>}
                  {message.attachments.map((attachment, index) => isInlineImage(attachment) || isInlineAudio(attachment)
                    ? <EncryptedMediaAttachment attachment={attachment} message={message} index={index} media={isInlineImage(attachment) ? 'image' : 'audio'} onOpen={props.onOpenAttachment} key={attachment.id} />
                    : <button className="attachment-card" key={attachment.id} onClick={() => void props.onDownload(message, index)}><FileLock2 size={19} /><span><strong>{attachment.name}</strong><small>{Math.max(1, Math.round(attachment.size / 1024))} KB · CurvePoint encrypted</small></span><Download size={16} /></button>)}
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
        {files.some((file) => file.type.startsWith('audio/')) && <div className="audio-draft-list">{files.filter((file) => file.type.startsWith('audio/')).map((file) => <AudioDraft file={file} onRemove={() => setFiles((current) => current.filter((item) => item !== file))} key={`${file.name}:${file.lastModified}`} />)}</div>}
        {files.some((file) => !file.type.startsWith('audio/')) && <div className="file-queue">{files.filter((file) => !file.type.startsWith('audio/')).map((file) => <span key={`${file.name}:${file.size}`}><FileLock2 size={14} />{file.name}<button onClick={() => setFiles((current) => current.filter((item) => item !== file))}>×</button></span>)}</div>}
        {isRecording && <div className="recording-strip" role="status"><i /><span><strong>Recording voice</strong><small>{Math.floor(recordingSeconds / 60)}:{String(recordingSeconds % 60).padStart(2, '0')} · stays on this device</small></span><button onClick={() => stopRecording(true)}>Cancel</button><button className="stop-recording" onClick={() => stopRecording()}><Square size={11} /> Stop & review</button></div>}
        {recordingError && <div className="composer-error" role="alert"><span>{recordingError}</span><button onClick={() => setRecordingError('')}>Dismiss</button></div>}
        <div className="composer-wrap">
          {mentionDraft && <div className="mention-picker" role="listbox" aria-label="Mention a conversation member">
            <div><AtSign size={14} /><span><strong>Mention someone</strong><small>Identity-verified members of this chat</small></span></div>
            {mentionCandidates.map((member, index) => <button role="option" aria-selected={index === mentionSelection} className={index === mentionSelection ? 'selected' : ''} key={member} onMouseDown={(event) => { event.preventDefault(); chooseMention(member) }}><IdentityAvatar className="mention-avatar" identityKey={member} profiles={props.identityProfiles} /><span><strong>{identityName(props.identityProfiles, member)}</strong><small>{member.slice(0, 14)}…{member.slice(-8)}</small></span></button>)}
            {mentionCandidates.length === 0 && <p>No current member matches “{mentionDraft.query}”.</p>}
          </div>}
          <div className="composer">
          <input ref={fileInput} type="file" multiple hidden onChange={(event) => { setFiles((current) => [...current, ...Array.from(event.target.files ?? [])]); event.currentTarget.value = '' }} />
          <button className="icon-button attach-button" onClick={() => fileInput.current?.click()} aria-label="Attach encrypted files"><Paperclip size={20} /></button>
          <button className={`icon-button record-button ${isRecording ? 'recording' : ''}`} disabled={isRecording || busy} onClick={() => void startRecording()} aria-label="Record a private voice message" title="Record a private voice message"><Mic size={19} /></button>
          <textarea ref={composerInput} value={draft} maxLength={20_000} onChange={(event) => { setDraft(event.target.value); setMentionDraft(activeMentionDraft(event.target.value, event.target.selectionStart)); setMentionSelection(0); onTyping(event.target.value.trim().length > 0) }} onClick={(event) => setMentionDraft(activeMentionDraft(event.currentTarget.value, event.currentTarget.selectionStart))} onBlur={() => { onTyping(false); setTimeout(() => setMentionDraft(null), 100) }} onKeyDown={(event) => {
            if (mentionDraft && mentionCandidates.length > 0) {
              if (event.key === 'ArrowDown') { event.preventDefault(); setMentionSelection((current) => (current + 1) % mentionCandidates.length); return }
              if (event.key === 'ArrowUp') { event.preventDefault(); setMentionSelection((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length); return }
              if (event.key === 'Escape') { event.preventDefault(); setMentionDraft(null); return }
              if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); chooseMention(mentionCandidates[mentionSelection] ?? mentionCandidates[0]); return }
            }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
          }} placeholder={`Message ${displayTitle} · type @< to mention`} rows={1} />
          <button className="send-button" disabled={busy || isRecording || (!draft.trim() && files.length === 0)} onClick={() => void submit()} aria-label="Send message"><Send size={19} /></button>
          </div>
        </div>
        <div className="composer-note"><LockKeyhole size={12} /> Encrypted before leaving this device <span><CheckCheck size={12} /> Durable outbox</span></div>
      </footer>
    </main>
  )
}
