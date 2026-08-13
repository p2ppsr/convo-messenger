import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, LockKeyhole, RefreshCw, ShieldCheck, WifiOff, X } from 'lucide-react'
import { ConversationPane } from './v2/components/ConversationPane'
import { ConversationRail } from './v2/components/ConversationRail'
import { ControlInbox } from './v2/components/ControlInbox'
import { CallOverlay } from './v2/components/CallOverlay'
import { applyConversationEvent } from './v2/domain/materialize'
import type { ConversationEvent, ConversationSecret, ConversationView, MaterializedMessage, MessageDeliveryState } from './v2/domain/types'
import type { PendingInvite, PendingMembershipUpdate, RealtimePeer, TypingPeer } from './v2/realtime/messaging'
import { idleCallSnapshot, type CallSnapshot, type MeetingRoomSnapshot } from './v2/realtime/meetingCalling'
import { AttachmentService } from './v2/services/attachments'
import { ConversationService } from './v2/services/conversationService'
import { useWalletSession } from './v2/hooks/useWalletSession'
import { useIdentityProfiles } from './v2/hooks/useIdentityProfiles'

const NewConversationDialog = lazy(async () => {
  const module = await import('./v2/components/NewConversationDialog')
  return { default: module.NewConversationDialog }
})
const ConversationDetails = lazy(async () => {
  const module = await import('./v2/components/ConversationDetails')
  return { default: module.ConversationDetails }
})

function sameMembers(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
}

function currentEpoch(secret: ConversationSecret) {
  const epoch = secret.epochs.find((item) => item.epoch === secret.currentEpoch)
  if (!epoch) throw new Error('Current conversation key is unavailable')
  return epoch
}

function App() {
  const { session, retry } = useWalletSession()
  const [conversations, setConversations] = useState<ConversationSecret[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [view, setView] = useState<ConversationView | null>(null)
  const [invites, setInvites] = useState<PendingInvite[]>([])
  const [updates, setUpdates] = useState<PendingMembershipUpdate[]>([])
  const [railOpen, setRailOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [liveState, setLiveState] = useState<'connecting' | 'live' | 'fallback'>('connecting')
  const [onlinePeers, setOnlinePeers] = useState<RealtimePeer[]>([])
  const [typingPeers, setTypingPeers] = useState<TypingPeer[]>([])
  const [deliveryStates, setDeliveryStates] = useState<Record<string, MessageDeliveryState>>({})
  const [call, setCall] = useState<CallSnapshot>(idleCallSnapshot)
  const [meetingRoom, setMeetingRoom] = useState<MeetingRoomSnapshot | null>(null)
  const liveEventsRef = useRef(new Map<string, ConversationEvent>())

  const service = useMemo(() => session.status === 'ready'
    ? new ConversationService(session.client, session.identityKey)
    : null, [session])
  const attachments = useMemo(() => session.status === 'ready' ? new AttachmentService(session.client) : null, [session])
  const activeSecret = conversations.find((conversation) => conversation.conversationId === activeId) ?? null
  const activeSecretRef = useRef(activeSecret)
  activeSecretRef.current = activeSecret
  const activeEpoch = activeSecret?.currentEpoch ?? null
  const identityKeys = useMemo(() => {
    const explicitRoster = activeSecret?.epochs.find((epoch) => epoch.epoch === activeSecret.currentEpoch)?.members ?? []
    const directPeers = conversations.filter((conversation) => conversation.kind === 'direct')
      .flatMap((conversation) => conversation.epochs.find((epoch) => epoch.epoch === conversation.currentEpoch)?.members ?? [])
    return [...new Set([
      ...(session.status === 'ready' ? [session.identityKey] : []),
      ...explicitRoster,
      ...directPeers,
      ...(view?.messages.map((message) => message.sender) ?? []),
      ...onlinePeers.map((peer) => peer.identityKey),
      ...typingPeers.map((peer) => peer.identityKey),
      ...(call.peerIdentityKey ? [call.peerIdentityKey] : []),
      ...call.participants.filter((participant) => participant.status === 'connecting' || participant.status === 'authenticating' || participant.status === 'active').map((participant) => participant.identityKey),
      ...(meetingRoom?.memberIdentityKeys ?? []),
      ...invites.map((invite) => invite.sender),
      ...updates.map((update) => update.sender),
    ])]
  }, [activeSecret, call.participants, call.peerIdentityKey, conversations, invites, meetingRoom?.memberIdentityKeys, onlinePeers, session, typingPeers, updates, view?.messages])
  const identityProfiles = useIdentityProfiles(session.status === 'ready' ? session.client : undefined, identityKeys)

  const refreshIndex = useCallback(async () => {
    if (!service) return []
    const latest = await service.list()
    setConversations(latest)
    setActiveId((current) => current && latest.some((item) => item.conversationId === current)
      ? current
      : (latest.find((item) => !item.preferences.archived)?.conversationId ?? null))
    return latest
  }, [service])

  const refreshControl = useCallback(async () => {
    if (!service) return
    const pending = await service.pendingControl()
    setInvites(pending.invites)
    setUpdates(pending.updates)
  }, [service])

  const reloadActive = useCallback(async (secret: ConversationSecret, tailPages = 3) => {
    if (!service) return
    let nextView = await service.load(secret, tailPages)
    for (const event of [...liveEventsRef.current.values()]
      .filter((candidate) => candidate.conversationId === secret.conversationId)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      nextView = applyConversationEvent(nextView, secret, event)
    }
    setView(nextView)
  }, [service])
  const publishTyping = useCallback((active: boolean) => service?.publishTyping(active), [service])

  const runBusy = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    setBusy(true)
    setError('')
    try {
      return await operation()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The secure operation could not be completed'
      setError(message)
      throw reason
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    const onlineListener = () => setOnline(true)
    const offlineListener = () => setOnline(false)
    window.addEventListener('online', onlineListener)
    window.addEventListener('offline', offlineListener)
    return () => { window.removeEventListener('online', onlineListener); window.removeEventListener('offline', offlineListener) }
  }, [])

  useEffect(() => {
    if (!service) return
    let cancelled = false
    let retrying = false
    setLoading(true)
    const synchronize = async () => {
      if (retrying) return
      retrying = true
      try {
        const results = await Promise.allSettled([service.flushOutbox(), service.flushControlOutbox()])
        const latest = await refreshIndex()
        await refreshControl().catch(() => undefined)
        if (cancelled) return
        const rejection = results.find((result) => result.status === 'rejected')
        if (rejection?.status === 'rejected') setError(rejection.reason instanceof Error ? rejection.reason.message : 'Secure sync needs a retry')
        else {
          const pending = latest.reduce((count, conversation) => count + (conversation.pendingControl?.length ?? 0), 0)
          if (pending > 0) setError(`${pending} encrypted control message${pending === 1 ? '' : 's'} will retry automatically.`)
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Secure sync needs a retry')
      } finally {
        retrying = false
        if (!cancelled) setLoading(false)
      }
    }
    void synchronize()
    const timer = setInterval(() => { void synchronize() }, 60_000)
    return () => { cancelled = true; clearInterval(timer); void service.closeLive() }
  }, [refreshControl, refreshIndex, service])

  useEffect(() => {
    const sessionSecret = activeSecretRef.current
    if (!service || !activeId || activeEpoch === null || !sessionSecret || sessionSecret.conversationId !== activeId) {
      liveEventsRef.current.clear()
      setView(null); setOnlinePeers([]); setTypingPeers([]); setCall(idleCallSnapshot()); setMeetingRoom(null)
      return
    }
    let cancelled = false
    liveEventsRef.current.clear()
    setLoading(true)
    setLiveState('connecting')
    setOnlinePeers([])
    setTypingPeers([])
    setDeliveryStates({})
    setCall(idleCallSnapshot())
    setMeetingRoom(null)
    void reloadActive(sessionSecret).then(async () => {
      if (cancelled) return
      setLoading(false)
      await service.openLive(sessionSecret, {
        onSync: async () => { if (!cancelled) await reloadActive(sessionSecret) },
        onState: (state) => { if (!cancelled) setLiveState(state) },
        onEvent: (event) => {
          if (cancelled) return
          liveEventsRef.current.set(event.id, event)
          if (liveEventsRef.current.size > 1_000) liveEventsRef.current.delete(liveEventsRef.current.keys().next().value!)
          setView((current) => current ? applyConversationEvent(current, sessionSecret, event) : current)
        },
        onDelivery: (eventId, state) => {
          if (!cancelled) setDeliveryStates((current) => {
            const rank: Record<MessageDeliveryState, number> = { sending: 0, live: 1, retrying: 2, saved: 3 }
            if (current[eventId] && rank[current[eventId]] > rank[state]) return current
            return { ...current, [eventId]: state }
          })
        },
        onPeersChange: (peers) => { if (!cancelled) setOnlinePeers(peers) },
        onTypingChange: (peers) => { if (!cancelled) setTypingPeers(peers) },
        onCallChange: (nextCall) => { if (!cancelled) setCall(nextCall) },
        onRoomChange: (nextRoom) => { if (!cancelled) setMeetingRoom(nextRoom) },
      })
    }).catch((reason: unknown) => {
      if (!cancelled) { setError(reason instanceof Error ? reason.message : 'Could not open this conversation'); setLoading(false); setLiveState('fallback') }
    })
    return () => { cancelled = true; void service.closeLive() }
  }, [activeEpoch, activeId, reloadActive, service])

  if (session.status !== 'ready') {
    return (
      <main className="wallet-gate">
        <div className="ambient-orb orb-one" /><div className="ambient-orb orb-two" />
        <section className="wallet-card">
          <div className="wallet-brand"><div className="brand-mark large"><LockKeyhole size={28} /></div><span>CONVO</span></div>
          {session.status === 'connecting' ? <><span className="wallet-spinner" /><h1>Opening your private inbox</h1><p>{session.message}</p><div className="wallet-steps"><span className="is-active"><i />Wallet session</span><span><i />Private keys</span><span><i />Conversations</span></div></> : <><div className="gate-alert"><AlertTriangle size={27} /></div><h1>Metanet Client is required</h1><p>{session.message}</p><button className="primary-button gate-button" onClick={retry}><RefreshCw size={17} /> Try again</button><span className="gate-assurance"><ShieldCheck size={15} /> Convo cannot read messages without your wallet’s approval.</span></>}
        </section>
      </main>
    )
  }

  const afterMutation = async (secret?: ConversationSecret) => {
    const latest = await refreshIndex()
    const target = secret ? latest.find((item) => item.conversationId === secret.conversationId) : latest.find((item) => item.conversationId === activeId)
    if (target) await reloadActive(target)
  }

  return (
    <div className="app-shell">
      {!online && <div className="offline-banner"><WifiOff size={15} /> Offline. New messages remain encrypted in the durable outbox until connectivity returns.</div>}
      {error && <div className="error-banner" role="alert"><AlertTriangle size={16} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}
      <div className="app-grid">
        <ConversationRail conversations={conversations} identityKey={session.identityKey} identityProfiles={identityProfiles} activeId={activeId} pendingCount={invites.length + updates.length} loading={loading && conversations.length === 0} open={railOpen} onClose={() => setRailOpen(false)} onSelect={setActiveId} onNew={() => setNewOpen(true)} onOpenInvites={() => setInboxOpen(true)} onRestore={(conversation) => runBusy(async () => { if (service) { await service.setPreferences(conversation, { archived: false }); await refreshIndex() } })} />
        {railOpen && <button className="rail-scrim" aria-label="Close conversations" onClick={() => setRailOpen(false)} />}
        <ConversationPane
          identityKey={session.identityKey}
          secret={activeSecret}
          view={view}
          loading={loading}
          busy={busy}
          liveState={liveState}
          onlinePeers={onlinePeers}
          typingPeers={typingPeers}
          deliveryStates={deliveryStates}
          identityProfiles={identityProfiles}
          callActive={call.status !== 'idle' && call.status !== 'ended' && call.status !== 'error'}
          meetingRoom={meetingRoom}
          onOpenRail={() => setRailOpen(true)}
          onOpenDetails={() => setDetailsOpen(true)}
          onLoadHistory={() => activeSecret ? runBusy(() => reloadActive(activeSecret, Number.MAX_SAFE_INTEGER)) : Promise.resolve()}
          onTyping={publishTyping}
          onCall={async (peers, media) => {
            if (!service) return
            setError('')
            try { await service.startCall(peers, media) }
            catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start the meeting'); throw reason }
          }}
          onJoinMeetingRoom={async () => {
            if (!service) return
            setError('')
            try { await service.joinMeetingRoom() }
            catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not join the meeting room'); throw reason }
          }}
          onSend={(body, files) => runBusy(async () => {
            if (!service || !activeSecret || !attachments) return
            const epoch = currentEpoch(activeSecret)
            const uploaded = files.length ? await attachments.upload(files, activeSecret.conversationId, epoch) : undefined
            await service.sendMessage(activeSecret, body, uploaded)
            await afterMutation(activeSecret)
          })}
          onEdit={(messageId, body) => runBusy(async () => { if (service && activeSecret) { await service.editMessage(activeSecret, messageId, body); await afterMutation(activeSecret) } })}
          onDelete={(messageId) => runBusy(async () => { if (service && activeSecret) { await service.deleteMessage(activeSecret, messageId); await afterMutation(activeSecret) } })}
          onReact={(messageId, emoji) => runBusy(async () => {
            if (!service || !activeSecret) return
            const removed = view?.messages.find((item) => item.id === messageId)?.reactions.some((reaction) => reaction.sender === session.identityKey && reaction.emoji === emoji) ?? false
            await service.react(activeSecret, messageId, emoji, removed)
            await afterMutation(activeSecret)
          })}
          onOpenAttachment={async (message: MaterializedMessage, attachmentIndex) => {
            if (!attachments || !activeSecret) throw new Error('Attachment service is unavailable')
            const reference = message.attachments[attachmentIndex]
            const epoch = activeSecret.epochs.find((item) => item.epoch === message.epoch)
            if (!reference || !epoch || !message.attachmentKey) throw new Error('Attachment key is unavailable')
            return await attachments.download(reference, message.attachmentKey, activeSecret.conversationId, epoch)
          }}
          onDownload={(message: MaterializedMessage, attachmentIndex) => runBusy(async () => {
            if (!attachments || !activeSecret) return
            const reference = message.attachments[attachmentIndex]
            const epoch = activeSecret.epochs.find((item) => item.epoch === message.epoch)
            if (!reference || !epoch || !message.attachmentKey) throw new Error('Attachment key is unavailable')
            const blob = await attachments.download(reference, message.attachmentKey, activeSecret.conversationId, epoch)
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url; anchor.download = reference.name; anchor.click()
            setTimeout(() => URL.revokeObjectURL(url), 1_000)
          })}
        />
      </div>

      <CallOverlay
        call={call}
        identityProfiles={identityProfiles}
        onAccept={async () => { if (service) await service.acceptCall() }}
        onDecline={async () => { if (service) await service.declineCall() }}
        onHangup={async () => { if (service) await service.hangupCall() }}
        onDismiss={() => service?.dismissCall()}
        onToggleAudio={() => service?.toggleCallAudio()}
        onToggleVideo={() => service?.toggleCallVideo()}
      />

      {newOpen && <Suspense fallback={<div className="modal-backdrop"><span className="spinner" /></div>}><NewConversationDialog open busy={busy} wallet={session.client} onClose={() => setNewOpen(false)} onCreate={(title, members) => runBusy(async () => {
        if (!service) return
        const created = await service.create(title, members)
        await refreshIndex(); setActiveId(created.conversationId); setNewOpen(false)
        if (created.pendingControl?.length) setError(`${created.pendingControl.length} encrypted invitation${created.pendingControl.length === 1 ? '' : 's'} will retry automatically.`)
      })} /></Suspense>}
      <ControlInbox open={inboxOpen} busy={busy} invites={invites} updates={updates} identityProfiles={identityProfiles} onClose={() => setInboxOpen(false)} onAcceptInvite={(pending) => runBusy(async () => {
        if (!service) return
        const accepted = await service.acceptInvite(pending); await refreshControl(); await refreshIndex(); setActiveId(accepted.conversationId)
      })} onDeclineInvite={(pending) => runBusy(async () => { if (service) { await service.declineInvite(pending); await refreshControl() } })} onAcceptUpdate={(pending) => runBusy(async () => {
        if (!service) return
        const accepted = await service.acceptMembershipUpdate(pending); await refreshControl(); await afterMutation(accepted)
      })} />
      {activeSecret && detailsOpen && <Suspense fallback={<div className="modal-backdrop"><span className="spinner" /></div>}><ConversationDetails open busy={busy} identityKey={session.identityKey} wallet={session.client} secret={activeSecret} onlinePeers={onlinePeers} identityProfiles={identityProfiles} onClose={() => setDetailsOpen(false)} onSave={(title, members, admins) => runBusy(async () => {
        if (!service) return
        let updated = activeSecret
        if (title.trim() !== activeSecret.title) updated = await service.rename(updated, title)
        const epoch = currentEpoch(updated)
        if (!sameMembers(members, epoch.members) || !sameMembers(admins, epoch.admins)) updated = await service.changeMembership(updated, members, admins)
        await afterMutation(updated); setDetailsOpen(false)
        if (updated.pendingControl?.length) setError(`${updated.pendingControl.length} encrypted membership update${updated.pendingControl.length === 1 ? '' : 's'} will retry automatically.`)
      })} onSetPreferences={(patch) => runBusy(async () => {
        if (!service) return
        await service.setPreferences(activeSecret, patch)
        const latest = await refreshIndex()
        if (patch.archived) setActiveId(latest.find((conversation) => !conversation.preferences.archived && conversation.conversationId !== activeSecret.conversationId)?.conversationId ?? null)
      })} /></Suspense>}
    </div>
  )
}

export default App
