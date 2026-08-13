import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, Mic, MicOff, Phone, PhoneOff, ShieldCheck, Users, Video, X } from 'lucide-react'
import { identityInitials, identityName, type IdentityProfileMap } from '../hooks/useIdentityProfiles'
import type { CallParticipantSnapshot, CallSnapshot } from '../realtime/meetingCalling'

interface Props {
  call: CallSnapshot
  identityProfiles: IdentityProfileMap
  onAccept: () => Promise<void>
  onDecline: () => Promise<void>
  onHangup: () => Promise<void>
  onDismiss: () => void
  onToggleAudio: () => void
  onToggleVideo: () => void
}

function StreamMedia({ stream, video, muted = false, className }: { stream?: MediaStream; video: boolean; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element || !stream) return
    element.srcObject = stream
    void element.play().catch(() => undefined)
    return () => { element.srcObject = null }
  }, [stream])
  return video
    ? <video ref={ref} className={className} autoPlay playsInline muted={muted} />
    : <audio ref={ref} autoPlay muted={muted} />
}

function useIncomingRingtone(active: boolean, media?: 'audio' | 'video'): void {
  useEffect(() => {
    if (!active || !media || typeof window.AudioContext !== 'function') return
    const context = new AudioContext()
    const output = context.createGain()
    output.gain.value = 0.16
    output.connect(context.destination)
    const notes = media === 'video' ? [392, 523.25, 659.25, 783.99] : [523.25, 659.25, 783.99]
    const cadence = media === 'video' ? 2_500 : 3_100
    const ring = () => {
      void context.resume().catch(() => undefined)
      const start = context.currentTime + 0.02
      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator()
        const envelope = context.createGain()
        const noteStart = start + index * 0.17
        oscillator.type = media === 'video' ? 'sine' : 'triangle'
        oscillator.frequency.setValueAtTime(frequency, noteStart)
        envelope.gain.setValueAtTime(0.0001, noteStart)
        envelope.gain.exponentialRampToValueAtTime(0.7, noteStart + 0.025)
        envelope.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.14)
        oscillator.connect(envelope).connect(output)
        oscillator.start(noteStart)
        oscillator.stop(noteStart + 0.15)
      })
    }
    ring()
    const timer = window.setInterval(ring, cadence)
    return () => { window.clearInterval(timer); void context.close() }
  }, [active, media])
}

function participantStatus(participant: CallParticipantSnapshot): string {
  if (participant.status === 'active') return participant.authenticated ? 'Identity verified' : 'Connected'
  if (participant.status === 'authenticating') return 'Verifying identity…'
  if (participant.status === 'connecting') return 'Connecting…'
  if (participant.status === 'ringing') return 'Ringing…'
  if (participant.status === 'declined') return 'Declined'
  if (participant.status === 'unavailable') return 'Unavailable'
  return 'Invited'
}

export function CallOverlay({ call, identityProfiles, onAccept, onDecline, onHangup, onDismiss, onToggleAudio, onToggleVideo }: Props) {
  const [actionBusy, setActionBusy] = useState(false)
  const incoming = call.status === 'incoming'
  useIncomingRingtone(incoming, call.media)
  if (call.status === 'idle') return null

  const finished = call.status === 'ended' || call.status === 'error'
  const inMeeting = !incoming && !finished && Boolean(call.localStream)
  const video = call.media === 'video'
  const visibleParticipants = call.participants.filter((participant) => participant.status === 'active' || participant.status === 'authenticating' || participant.status === 'connecting')
  const connectedParticipants = call.participants.filter((participant) => participant.status === 'active' && participant.authenticated)
  const connectingParticipants = visibleParticipants.length - connectedParticipants.length
  const act = async (operation: () => Promise<void>) => {
    setActionBusy(true)
    try { await operation() } catch { /* The call manager exposes the failure in call state. */ } finally { setActionBusy(false) }
  }

  return (
    <div className={`call-layer ${inMeeting ? 'is-active' : ''}`} role="dialog" aria-modal="true" aria-label={incoming ? `Incoming ${call.media} ${call.isGroup ? 'meeting' : 'call'}` : 'Secure meeting'} data-ringtone={incoming ? call.media : undefined}>
      <section className={`call-card ${video ? 'has-video' : 'audio-only'} ${call.isGroup ? 'group-meeting' : 'direct-meeting'}`}>
        {inMeeting && <div className={`meeting-grid participant-count-${Math.min(visibleParticipants.length + 1, 8)}`}>
          <article className="meeting-tile local-participant">
            {video && call.videoEnabled && <StreamMedia stream={call.localStream} video muted className="meeting-video local-video" />}
            {(!video || !call.videoEnabled) && <div className="meeting-avatar self">YOU</div>}
            <div className="meeting-participant-label"><span>You</span><small><ShieldCheck size={12} /> This device</small></div>
            <div className="meeting-media-state">{!call.audioEnabled && <MicOff size={15} />}{video && !call.videoEnabled && <CameraOff size={15} />}</div>
          </article>
          {visibleParticipants.map((participant) => <article className={`meeting-tile participant-${participant.status}`} key={participant.identityKey}>
            {video && participant.stream && participant.videoEnabled && <StreamMedia stream={participant.stream} video className="meeting-video" />}
            {!video && participant.stream && <StreamMedia stream={participant.stream} video={false} />}
            {(!video || !participant.stream || !participant.videoEnabled) && <div className="meeting-avatar">{identityInitials(identityProfiles, participant.identityKey)}</div>}
            <div className="meeting-participant-label"><span>{identityName(identityProfiles, participant.identityKey, participant.status === 'invited' || participant.status === 'ringing' ? 'Invited member' : 'Metanet peer')}</span><small className={participant.authenticated ? 'verified' : ''}>{participant.authenticated && <ShieldCheck size={12} />}{participantStatus(participant)}</small></div>
            <div className="meeting-media-state">{!participant.audioEnabled && <MicOff size={15} />}{video && !participant.videoEnabled && <CameraOff size={15} />}</div>
          </article>)}
        </div>}

        <div className={`call-content ${inMeeting ? 'meeting-chrome' : ''}`}>
          {!inMeeting && <div className="call-peer-avatar">{call.isGroup ? <Users size={30} /> : identityInitials(identityProfiles, call.peerIdentityKey)}</div>}
          <span className="call-eyebrow">{incoming ? `Incoming private ${call.isGroup ? 'meeting' : 'call'}` : inMeeting ? 'Convo private meeting' : call.status === 'error' ? 'Connection issue' : 'Secure meeting'}</span>
          <h2>{call.isGroup ? `${video ? 'Video' : 'Audio'} meeting` : identityName(identityProfiles, call.peerIdentityKey)}</h2>
          <p>{call.message}</p>
          <div className={`call-auth-state ${call.authenticated ? 'verified' : ''}`}>
            <ShieldCheck size={15} />{call.authenticated ? 'Participant identities authenticated' : 'Media stays blocked per peer until BRC-103 verification'}
          </div>
          {call.isGroup && !inMeeting && <div className="incoming-participant-count"><Users size={15} /> {call.participants.length + 1} invited participants</div>}
          {call.isGroup && incoming && <div className="incoming-participant-preview">{call.participants.slice(0, 4).map((participant) => <span key={participant.identityKey}><i>{identityInitials(identityProfiles, participant.identityKey)}</i>{identityName(identityProfiles, participant.identityKey, participant.identityKey === call.peerIdentityKey ? 'Metanet caller' : 'Invited member')}</span>)}</div>}

          {incoming && <div className="incoming-call-actions">
            <button className="call-control decline" disabled={actionBusy} onClick={() => void act(onDecline)} aria-label="Decline meeting"><PhoneOff size={22} /><span>Decline</span></button>
            <button className="call-control accept" disabled={actionBusy} onClick={() => void act(onAccept)} aria-label={`Join ${call.media} meeting`}>{video ? <Video size={22} /> : <Phone size={22} />}<span>Join</span></button>
          </div>}

          {inMeeting && <div className="meeting-toolbar">
            <span className="meeting-count"><Users size={15} /> {call.isGroup
              ? <>{connectedParticipants.length === 0 ? 'Just you · room open' : `${connectedParticipants.length + 1} connected`}{connectingParticipants > 0 ? ` · ${connectingParticipants} connecting` : ''}</>
              : connectedParticipants.length > 0 ? '2 connected' : 'Connecting…'}</span>
            <div className="active-call-actions">
              <button className={`call-control ${call.audioEnabled ? '' : 'is-off'}`} onClick={onToggleAudio} aria-label={call.audioEnabled ? 'Mute microphone' : 'Unmute microphone'}>{call.audioEnabled ? <Mic size={21} /> : <MicOff size={21} />}</button>
              {video && <button className={`call-control ${call.videoEnabled ? '' : 'is-off'}`} onClick={onToggleVideo} aria-label={call.videoEnabled ? 'Turn camera off' : 'Turn camera on'}>{call.videoEnabled ? <Camera size={21} /> : <CameraOff size={21} />}</button>}
              <button className="call-control decline leave-meeting" disabled={actionBusy} onClick={() => void act(onHangup)} aria-label="Leave meeting"><PhoneOff size={22} /></button>
            </div>
            <span className="meeting-security"><ShieldCheck size={14} /> Encrypted</span>
          </div>}

          {!incoming && !inMeeting && !finished && <div className="active-call-actions">
            <button className={`call-control ${call.audioEnabled ? '' : 'is-off'}`} onClick={onToggleAudio} aria-label={call.audioEnabled ? 'Mute microphone' : 'Unmute microphone'}>{call.audioEnabled ? <Mic size={21} /> : <MicOff size={21} />}</button>
            {video && <button className={`call-control ${call.videoEnabled ? '' : 'is-off'}`} onClick={onToggleVideo} aria-label={call.videoEnabled ? 'Turn camera off' : 'Turn camera on'}>{call.videoEnabled ? <Camera size={21} /> : <CameraOff size={21} />}</button>}
            <button className="call-control decline" disabled={actionBusy} onClick={() => void act(onHangup)} aria-label="Leave meeting"><PhoneOff size={22} /></button>
          </div>}

          {finished && <button className="call-dismiss" onClick={onDismiss}><X size={17} /> Close</button>}
        </div>
        {!inMeeting && !video && <div className="audio-rings"><i /><i /><i /></div>}
      </section>
    </div>
  )
}
