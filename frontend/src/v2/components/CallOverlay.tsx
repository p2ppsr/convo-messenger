import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, Mic, MicOff, Phone, PhoneOff, ShieldCheck, Video, X } from 'lucide-react'
import type { CallSnapshot } from '../realtime/calling'

interface Props {
  call: CallSnapshot
  onAccept: () => Promise<void>
  onDecline: () => Promise<void>
  onHangup: () => Promise<void>
  onDismiss: () => void
  onToggleAudio: () => void
  onToggleVideo: () => void
}

function shortKey(key?: string): string {
  return key ? `${key.slice(0, 10)}…${key.slice(-8)}` : 'Metanet peer'
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

export function CallOverlay({ call, onAccept, onDecline, onHangup, onDismiss, onToggleAudio, onToggleVideo }: Props) {
  const [actionBusy, setActionBusy] = useState(false)
  if (call.status === 'idle') return null
  const active = call.status === 'active'
  const incoming = call.status === 'incoming'
  const finished = call.status === 'ended' || call.status === 'error'
  const video = call.media === 'video'
  const act = async (operation: () => Promise<void>) => {
    setActionBusy(true)
    try { await operation() } catch { /* The call manager exposes the failure in call state. */ } finally { setActionBusy(false) }
  }

  return (
    <div className={`call-layer ${active ? 'is-active' : ''}`} role="dialog" aria-modal="true" aria-label={incoming ? `Incoming ${call.media} call` : 'Secure call'}>
      <section className={`call-card ${video ? 'has-video' : 'audio-only'}`}>
        {active && video && <StreamMedia stream={call.remoteStream} video className="remote-video" />}
        {active && !video && <StreamMedia stream={call.remoteStream} video={false} />}
        {active && video && <div className="local-video-shell"><StreamMedia stream={call.localStream} video muted className="local-video" />{!call.videoEnabled && <CameraOff size={22} />}</div>}
        <div className="call-content">
          <div className="call-peer-avatar">{call.peerIdentityKey?.slice(2, 4).toUpperCase() ?? 'ME'}</div>
          <span className="call-eyebrow">{incoming ? 'Incoming secure call' : active ? 'Private peer-to-peer call' : call.status === 'error' ? 'Connection issue' : 'Secure call'}</span>
          <h2>{shortKey(call.peerIdentityKey)}</h2>
          <p>{call.message}</p>
          <div className={`call-auth-state ${call.authenticated ? 'verified' : ''}`}>
            <ShieldCheck size={15} />{call.authenticated ? 'Metanet identity authenticated' : 'BRC-103 authentication required before media starts'}
          </div>

          {incoming && <div className="incoming-call-actions">
            <button className="call-control decline" disabled={actionBusy} onClick={() => void act(onDecline)} aria-label="Decline call"><PhoneOff size={22} /><span>Decline</span></button>
            <button className="call-control accept" disabled={actionBusy} onClick={() => void act(onAccept)} aria-label={`Accept ${call.media} call`}>{video ? <Video size={22} /> : <Phone size={22} />}<span>Accept</span></button>
          </div>}

          {!incoming && !finished && <div className="active-call-actions">
            <button className={`call-control ${call.audioEnabled ? '' : 'is-off'}`} onClick={onToggleAudio} aria-label={call.audioEnabled ? 'Mute microphone' : 'Unmute microphone'}>{call.audioEnabled ? <Mic size={21} /> : <MicOff size={21} />}</button>
            {video && <button className={`call-control ${call.videoEnabled ? '' : 'is-off'}`} onClick={onToggleVideo} aria-label={call.videoEnabled ? 'Turn camera off' : 'Turn camera on'}>{call.videoEnabled ? <Camera size={21} /> : <CameraOff size={21} />}</button>}
            <button className="call-control decline" disabled={actionBusy} onClick={() => void act(onHangup)} aria-label="End call"><PhoneOff size={22} /></button>
          </div>}

          {finished && <button className="call-dismiss" onClick={onDismiss}><X size={17} /> Close</button>}
        </div>
        {active && !video && <div className="audio-rings"><i /><i /><i /></div>}
      </section>
    </div>
  )
}
