import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, Reply, AtSign, CheckCheck, Download, FileLock2, Info, LockKeyhole, Menu, Mic, MoreHorizontal, Paperclip, Phone, Search, Send, ShieldCheck, SmilePlus, Square, Trash2, Video, X } from 'lucide-react'
import type { ConversationSecret, ConversationView, MaterializedMessage, MessageDeliveryState } from '../domain/types'
import { identityInitials, identityName, type IdentityProfileMap } from '../hooks/useIdentityProfiles'
import { conversationName } from '../domain/presentation'
import { activeMentionDraft, displayMessageText, insertMention, mentionedIdentities, type MentionDraft } from '../domain/mentions'
import { isInlineAudio, isInlineImage, MAX_ATTACHMENT_BYTES } from '../domain/attachmentValidation'
import { MAX_MEETING_PARTICIPANTS, type MeetingRoomSnapshot } from '../realtime/meetingCalling'
import type { CallMedia, RealtimePeer, TypingPeer } from '../realtime/messaging'
import { MessageText } from './MessageText'
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
  meetingRoom: MeetingRoomSnapshot | null
  onOpenRail: () => void
  onOpenDetails: () => void
  onLoadHistory: () => Promise<void>
  onTyping: (active: boolean) => void
  onCall: (identityKeys: string[], media: CallMedia) => Promise<void>
  onJoinMeetingRoom: () => Promise<void>
  onRead?: (through: number) => void
  onSend: (body: string, files: File[], replyTo?: string) => Promise<void>
  onEdit: (messageId: string, body: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
  onReact: (messageId: string, emoji: string) => Promise<void>
  onOpenAttachment: (message: MaterializedMessage, attachmentIndex: number) => Promise<Blob>
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
  const [replying, setReplying] = useState<MaterializedMessage | null>(null)
  const [reactionPicker, setReactionPicker] = useState<string | null>(null)
  const [newMessages, setNewMessages] = useState(false)
  const [sendError, setSendError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const historyRequest = useRef<string | null>(null)
  const historyAnchor = useRef<{ id: string; height: number; top: number } | null>(null)
  const submitting = useRef(false)
  const atBottom = useRef(true)
  const drafts = useRef(new Map<string, { body: string; files: File[]; reply: MaterializedMessage | null }>())
  const draftConversationId = useRef(secret?.conversationId)
  const currentDraft = useRef({ id: secret?.conversationId, body: draft, files, reply: replying })
  currentDraft.current = { id: secret?.conversationId, body: draft, files, reply: replying }
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
    if (draftConversationId.current) drafts.current.set(draftConversationId.current, { body: currentDraft.current.body, files: currentDraft.current.files, reply: currentDraft.current.reply })
    draftConversationId.current = secret?.conversationId
    const saved = secret ? drafts.current.get(secret.conversationId) : undefined
    setDraft(saved?.body ?? ''); setFiles(saved?.files ?? []); setReplying(saved?.reply ?? null)
    setHistoryLoading(false); setHistoryError(false); historyRequest.current = null; historyAnchor.current = null
    setNewMessages(false); setSendError(''); setReactionPicker(null); atBottom.current = true
     setEditing(null); setCallMenu(null); setSelectedCallMembers([]); setSearchOpen(false); setSearchQuery(''); setMentionDraft(null); setRecordingError('')
    return () => {
      onTyping(false)
      discardRecording.current = true
      if (recorder.current?.state !== 'inactive') recorder.current?.stop()
      recordingStream.current?.getTracks().forEach((track) => track.stop())
    }
  // The draft belongs to the conversation, independently of callback identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret?.conversationId])
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
    if (atBottom.current) {
      element.scrollTop = element.scrollHeight
      setNewMessages(false)
      if (document.visibilityState === 'visible') props.onRead?.(view?.messages.at(-1)?.createdAt ?? 0)
    } else setNewMessages(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.messages.at(-1)?.id, secret?.conversationId])

  const loadEarlier = async () => {
    if (!secret || loading || historyRequest.current === secret.conversationId) return
    const id = secret.conversationId
    historyRequest.current = id
    setHistoryLoading(true); setHistoryError(false)
    const element = timeline.current
    if (element) historyAnchor.current = { id, height: element.scrollHeight, top: element.scrollTop }
    try { await props.onLoadHistory() }
    catch { if (historyRequest.current === id) { historyAnchor.current = null; setHistoryError(true) } }
    finally {
      if (historyRequest.current === id) { historyRequest.current = null; setHistoryLoading(false) }
    }
  }
  useLayoutEffect(() => {
    const anchor = historyAnchor.current
    const element = timeline.current
    if (anchor && element && anchor.id === secret?.conversationId) {
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height
      historyAnchor.current = null
    }
  }, [view, secret?.conversationId])
  useEffect(() => {
    const element = timeline.current
    if (!loading && !historyLoading && !historyError && !view?.historyLoadFailed && view?.hasMoreHistory
      && element && element.scrollHeight <= element.clientHeight) void loadEarlier()
  // The view controls pagination; callback identity must not start another request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, loading, historyLoading, historyError])

  useEffect(() => {
    const input = composerInput.current
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(180, Math.max(44, input.scrollHeight))}px` }
  }, [draft])

  if (!secret) {
    return (
      <main className="conversation-pane empty-pane">
        <button className="icon-button mobile-menu" onClick={props.onOpenRail} aria-label="Open conversations"><Menu size={21} /></button>
        {loading
          ? <div className="empty-hero" role="status"><span className="wallet-spinner" /><h1>Loading your conversations…</h1><p>Getting your workspace ready.</p></div>
          : <div className="empty-hero"><div className="hero-lock"><LockKeyhole size={34} /></div><span className="eyebrow">Your team. Your conversations.</span><h1>A little closer.<br />A lot more private.</h1><p>A focused home for the conversations that move your day forward. Start with a teammate or bring your group together.</p><div className="security-pills"><span><ShieldCheck size={15} /> End-to-end encrypted</span><span><FileLock2 size={15} /> Wallet-private keys</span></div></div>}
      </main>
    )
  }

  const members = view?.members ?? secret.epochs.find((epoch) => epoch.epoch === secret.currentEpoch)?.members ?? []
  const otherMembers = members.filter((member) => member !== identityKey)
  const onlineSet = new Set(onlinePeers.map((peer) => peer.identityKey))
  const directPeer = secret.kind === 'direct' && otherMembers.length === 1 ? otherMembers[0] : null
  const displayTitle = secret.kind === 'group' ? (view?.title ?? secret.title) : conversationName(secret, identityKey, props.identityProfiles)
  const beginCall = (media: CallMedia) => {
    if (directPeer) void props.onCall([directPeer], media)
    else {
      setSelectedCallMembers([...otherMembers]
        .sort((left, right) => Number(onlineSet.has(right)) - Number(onlineSet.has(left)))
        .slice(0, MAX_MEETING_PARTICIPANTS - 1))
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

  const addFiles = (incoming: File[]) => {
    if (files.length + incoming.length > 20 || incoming.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      setSendError('Choose up to 20 attachments, each smaller than 25 MB.')
      return
    }
    setFiles((current) => [...current, ...incoming])
    setSendError('')
  }
  const submit = async () => {
    if ((!draft.trim() && files.length === 0) || busy || isRecording || submitting.current) return
    submitting.current = true
    setSendError('')
    const sent = { id: secret.conversationId, body: draft, files, reply: replying }
    onTyping(false)
    try {
      if (replying) await props.onSend(draft, files, replying.id)
      else await props.onSend(draft, files)
      if (currentDraft.current.id === sent.id && currentDraft.current.body === sent.body && currentDraft.current.files === sent.files) {
        setDraft(''); setFiles([]); setReplying(null)
        drafts.current.delete(sent.id)
        atBottom.current = true
        requestAnimationFrame(() => composerInput.current?.focus())
      } else if (currentDraft.current.id !== sent.id) {
        const saved = drafts.current.get(sent.id)
        if (saved?.body === sent.body && saved.files === sent.files) drafts.current.delete(sent.id)
      }
    } catch {
      if (currentDraft.current.id === sent.id) setSendError('Message was not queued. Your draft is here; try sending again.')
    } finally { submitting.current = false }
  }
  const jumpToLatest = () => {
    if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight
    atBottom.current = true
    setNewMessages(false)
    props.onRead?.(view?.messages.at(-1)?.createdAt ?? 0)
  }


  return (
    <main className={`conversation-pane ${secret.kind}-conversation`}>
      <header className="conversation-header">
        <button className="icon-button mobile-menu" onClick={props.onOpenRail} aria-label="Open conversations"><Menu size={21} /></button>
        {directPeer
          ? <IdentityAvatar className="header-avatar" identityKey={directPeer} profiles={props.identityProfiles} fallback={displayTitle.slice(0, 2).toUpperCase()} />
          : <div className="header-avatar">{displayTitle.slice(0, 2).toUpperCase()}</div>}
        <div className="header-copy"><h1>{displayTitle}</h1><span className={`presence ${liveState}`}><i />{liveState === 'live' ? (directPeer ? `${onlineSet.has(directPeer) ? 'Online' : 'Offline'} · Realtime private sync` : `${onlinePeers.length + 1} of ${members.length} online · Realtime private sync`) : liveState === 'fallback' ? 'Secure reconciliation fallback' : 'Connecting realtime sync'}</span></div>
        <div className="header-call-actions">
          <button className="header-call" disabled={props.callActive || Boolean(props.meetingRoom) || liveState !== 'live' || Boolean(directPeer && onlinePeers.length === 0)} onClick={() => beginCall('audio')} aria-label={directPeer ? 'Start voice call' : 'Open group audio meeting room'} title={directPeer && onlinePeers.length === 0 ? 'This person is offline' : props.meetingRoom ? 'A meeting room is already open' : directPeer ? 'Start voice call' : 'Open an audio room now'}><Phone size={17} /></button>
          <button className="header-call" disabled={props.callActive || Boolean(props.meetingRoom) || liveState !== 'live' || Boolean(directPeer && onlinePeers.length === 0)} onClick={() => beginCall('video')} aria-label={directPeer ? 'Start video call' : 'Open group video meeting room'} title={directPeer && onlinePeers.length === 0 ? 'This person is offline' : props.meetingRoom ? 'A meeting room is already open' : directPeer ? 'Start video call' : 'Open a video room now'}><Video size={18} /></button>
          {callMenu && <div className="call-member-menu" role="dialog" aria-label={`Choose participants for ${callMenu} meeting`}>
            <div><span><strong>{callMenu === 'video' ? 'Video' : 'Audio'} meeting</strong><small>Select up to {MAX_MEETING_PARTICIPANTS - 1} people</small></span><button onClick={() => setCallMenu(null)} aria-label="Close call menu"><X size={15} /></button></div>
            {otherMembers.map((member) => {
              const online = onlineSet.has(member)
              const selected = selectedCallMembers.includes(member)
              const atCapacity = selectedCallMembers.length >= MAX_MEETING_PARTICIPANTS - 1
              return <button className={`call-member ${selected ? 'selected' : ''}`} key={member} disabled={!selected && atCapacity} onClick={() => setSelectedCallMembers((current) => selected ? current.filter((identityKey) => identityKey !== member) : [...current, member])}><i className={online ? 'online' : ''} /><span><strong>{identityName(props.identityProfiles, member)}</strong><small>{online ? (selected ? 'Can join this room' : 'Online now') : selected ? 'Can join when online' : 'Offline · still selectable'}</small></span><b aria-hidden="true">{selected ? '✓' : ''}</b></button>
            })}
            <button className="call-menu-start" disabled={selectedCallMembers.length === 0} onClick={() => { const selected = selectedCallMembers; setCallMenu(null); void props.onCall(selected, callMenu) }}>{callMenu === 'video' ? <Video size={16} /> : <Phone size={16} />} Open room <span>{selectedCallMembers.length + 1}</span></button>
          </div>}
        </div>
        <button className={`header-call ${searchOpen ? 'is-active' : ''}`} onClick={() => { setSearchOpen((current) => !current); if (searchOpen) setSearchQuery('') }} aria-label="Search this conversation" title="Search this conversation"><Search size={18} /></button>
        <button className="header-details" onClick={props.onOpenDetails}><Info size={18} /><span>Details</span></button>
      </header>

      {(props.meetingRoom || searchOpen) && <div className="conversation-tools">
        {props.meetingRoom && <div className="meeting-room-banner" role="status"><span className="meeting-room-pulse"><Video size={17} /></span><span><strong>{identityName(props.identityProfiles, props.meetingRoom.hostIdentityKey)} opened a {props.meetingRoom.media} room</strong><small>Join now · media starts only after you approve access</small></span><button onClick={() => void props.onJoinMeetingRoom()}>{props.meetingRoom.media === 'video' ? <Video size={16} /> : <Phone size={16} />} Join room</button></div>}
        {searchOpen && <label className="message-search" htmlFor="message-search"><Search size={16} /><input id="message-search" name="message-search" autoFocus type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search decrypted messages" /><span>{cleanSearch ? `${visibleMessages.length} result${visibleMessages.length === 1 ? '' : 's'}` : 'On this device'}</span><button onClick={() => { setSearchOpen(false); setSearchQuery('') }} aria-label="Close message search"><X size={15} /></button></label>}
      </div>}
      <div className="message-timeline" ref={timeline} role="log" aria-label="Messages" onScroll={() => {
        const element = timeline.current
        if (!element) return
        if (element.scrollTop < 80 && view?.hasMoreHistory && !view.historyLoadFailed && !historyError && !cleanSearch) void loadEarlier()
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        if (atBottom.current) { setNewMessages(false); if (document.visibilityState === 'visible') props.onRead?.(view?.messages.at(-1)?.createdAt ?? 0) }
      }}>
        {loading && <div className="timeline-state" role="status"><span className="spinner" /> Loading messages…</div>}
        {!loading && historyLoading && <div className="history-status" role="status">Loading earlier messages…</div>}
        {!loading && !historyLoading && (historyError || view?.historyLoadFailed) && <div className="history-status">Some messages couldn’t load. <button onClick={() => void loadEarlier()}>Try again</button></div>}
        {!loading && !historyLoading && !historyError && !view?.historyLoadFailed && view?.hasMoreHistory && <button className="history-more" onClick={() => void loadEarlier()}>Earlier messages</button>}
        {!loading && !historyLoading && !historyError && !view?.historyLoadFailed && !view?.hasMoreHistory && view?.messages.length === 0 && <div className="timeline-empty"><ShieldCheck size={27} /><h2>This conversation is ready</h2><p>Send the first end-to-end encrypted message.</p></div>}
        {!loading && cleanSearch && visibleMessages.length === 0 && <div className="timeline-empty search-empty"><Search size={27} /><h2>No matching messages</h2><p>Search checks decrypted text, people, and attachment names locally.</p></div>}
        {visibleMessages.map((message, index) => {
          const previous = visibleMessages[index - 1]
          const day = new Date(message.createdAt).toDateString()
          const newDay = !previous || new Date(previous.createdAt).toDateString() !== day
          const grouped = !newDay && previous?.sender === message.sender && message.createdAt - previous.createdAt < 300_000
          const parent = message.replyTo ? view?.messages.find((candidate) => candidate.id === message.replyTo) : undefined
          const mine = message.sender === identityKey
          const isEditing = editing === message.id
          const mentionsMe = mentionedIdentities(message.body).includes(identityKey)
          return (
            <Fragment key={message.id}>
            {newDay && <div className="day-divider"><span>{day === new Date().toDateString() ? 'Today' : new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }).format(message.createdAt)}</span></div>}
            <article id={`message-${message.id}`} className={`message-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''} ${mentionsMe ? 'mentions-me' : ''}`}>
              {(!mine || secret.kind === 'group') && <IdentityAvatar className="message-sender-avatar" identityKey={message.sender} profiles={props.identityProfiles} />}
              <div className="message-stack">
                <div className="message-meta"><span>{mine ? 'You' : identityName(props.identityProfiles, message.sender)}</span><time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()}>{formatTime(message.createdAt)}</time>{message.edited && <em>edited</em>}{mentionsMe && <em className="mentioned-you"><AtSign size={10} /> Mentioned you</em>}</div>
                <div className="message-bubble">
                  {message.replyTo && <button className="quoted-message" onClick={() => { setSearchQuery(''); if (!parent && view?.hasMoreHistory) void loadEarlier(); else requestAnimationFrame(() => document.getElementById(`message-${message.replyTo}`)?.scrollIntoView({ block: 'center' })) }}><Reply size={14} /><span><strong>{parent ? identityName(props.identityProfiles, parent.sender) : 'Earlier message'}</strong><small>{parent ? displayMessageText(parent.body || 'Attachment', props.identityProfiles) : 'View earlier message'}</small></span></button>}
                  {isEditing ? <div className="edit-form"><textarea id={`edit-message-${message.id}`} name="edited-message" aria-label="Edit message" value={editBody} onChange={(event) => setEditBody(event.target.value)} autoFocus /><div><button className="text-button" onClick={() => setEditing(null)}>Cancel</button><button className="compact-button is-active" onClick={() => void props.onEdit(message.id, editBody).then(() => setEditing(null))}>Save</button></div></div> : <MessageText body={message.body} profiles={props.identityProfiles} />}
                  {message.attachments.map((attachment, index) => isInlineImage(attachment) || isInlineAudio(attachment)
                    ? <EncryptedMediaAttachment attachment={attachment} message={message} index={index} media={isInlineImage(attachment) ? 'image' : 'audio'} onOpen={props.onOpenAttachment} key={attachment.id} />
                    : <button className="attachment-card" key={attachment.id} onClick={() => void props.onDownload(message, index)}><FileLock2 size={19} /><span><strong>{attachment.name}</strong><small>{Math.max(1, Math.round(attachment.size / 1024))} KB · CurvePoint encrypted</small></span><Download size={16} /></button>)}
                </div>
                {message.reactions.length > 0 && <div className="reaction-list">{[...new Set(message.reactions.map((reaction) => reaction.emoji))].map((emoji) => <button key={emoji} aria-pressed={message.reactions.some((reaction) => reaction.sender === identityKey && reaction.emoji === emoji)} onClick={() => void props.onReact(message.id, emoji)}>{emoji} {message.reactions.filter((reaction) => reaction.emoji === emoji).length}</button>)}</div>}
                <div className="message-actions">
                  <button onClick={() => { setReplying(message); composerInput.current?.focus() }} aria-label="Reply to message"><Reply size={14} /> Reply</button>
                  <button onClick={() => setReactionPicker(reactionPicker === message.id ? null : message.id)} aria-label="React" aria-expanded={reactionPicker === message.id}><SmilePlus size={14} /> React</button>
                  {reactionPicker === message.id && <div className="reaction-picker" role="group" aria-label="Choose a reaction">{['👍', '❤️', '😂', '🎉', '👀', '✅'].map((emoji) => <button key={emoji} aria-label={`React ${emoji}`} onClick={() => { setReactionPicker(null); void props.onReact(message.id, emoji) }}>{emoji}</button>)}</div>}
                  {mine && !isEditing && <button onClick={() => { setEditing(message.id); setEditBody(message.body) }}><MoreHorizontal size={14} /> Edit</button>}
                  {mine && <button className="danger-text" onClick={() => window.confirm('Delete this message for everyone in the current conversation history?') && void props.onDelete(message.id)}><Trash2 size={14} /> Delete</button>}
                </div>
                {mine && deliveryStates[message.id] && <div className={`delivery-state ${deliveryStates[message.id]}`}><CheckCheck size={12} />{deliveryStates[message.id] === 'sending' ? 'Sending…' : deliveryStates[message.id] === 'live' ? 'Forwarded · saving history' : deliveryStates[message.id] === 'retrying' ? 'Saved locally · retrying' : 'History saved'}</div>}
              </div>
            </article>
            </Fragment>
          )
        })}
      </div>

      <footer className="composer-shell" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)) }}>
        {newMessages && <button className="jump-latest" onClick={jumpToLatest}><ArrowDown size={15} /> New messages · jump to latest</button>}
        {replying && <div className="reply-draft"><Reply size={17} /><span><strong>Replying to {identityName(props.identityProfiles, replying.sender)}</strong><small>{displayMessageText(replying.body || 'Attachment', props.identityProfiles)}</small></span><button className="icon-button" onClick={() => setReplying(null)} aria-label="Cancel reply"><X size={16} /></button></div>}
        {sendError && <div className="composer-error" role="alert">{sendError}</div>}
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
          <input id="message-attachments" name="message-attachments" ref={fileInput} type="file" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = '' }} />
          <button className="icon-button attach-button" onClick={() => fileInput.current?.click()} aria-label="Attach encrypted files"><Paperclip size={20} /></button>
          <button className={`icon-button record-button ${isRecording ? 'recording' : ''}`} disabled={isRecording || busy} onClick={() => void startRecording()} aria-label="Record a private voice message" title="Record a private voice message"><Mic size={19} /></button>
          <textarea id="message-composer" name="message" aria-label={`Message ${displayTitle}`} ref={composerInput} onPaste={(event) => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); addFiles(pasted) } }} value={draft} maxLength={20_000} onChange={(event) => { setDraft(event.target.value); setMentionDraft(activeMentionDraft(event.target.value, event.target.selectionStart)); setMentionSelection(0); onTyping(event.target.value.trim().length > 0) }} onClick={(event) => setMentionDraft(activeMentionDraft(event.currentTarget.value, event.currentTarget.selectionStart))} onBlur={() => { onTyping(false); setTimeout(() => setMentionDraft(null), 100) }} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Escape') { setReplying(null); setMentionDraft(null); return }
            if (mentionDraft && mentionCandidates.length > 0) {
              if (event.key === 'ArrowDown') { event.preventDefault(); setMentionSelection((current) => (current + 1) % mentionCandidates.length); return }
              if (event.key === 'ArrowUp') { event.preventDefault(); setMentionSelection((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length); return }
              if (event.key === 'Escape') { event.preventDefault(); setMentionDraft(null); return }
              if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); chooseMention(mentionCandidates[mentionSelection] ?? mentionCandidates[0]); return }
            }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
          }} placeholder={`Message ${displayTitle} · @ to mention`} rows={1} />
          <button className="send-button" disabled={busy || isRecording || (!draft.trim() && files.length === 0)} onClick={() => void submit()} aria-label="Send message"><Send size={19} /></button>
          </div>
        </div>
        <div className="composer-note"><LockKeyhole size={12} /> Encrypted before leaving this device <span>Enter to send · Shift + Enter for a new line</span></div>
      </footer>
    </main>
  )
}
