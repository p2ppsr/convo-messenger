import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallOverlay } from './CallOverlay'

afterEach(cleanup)

describe('CallOverlay', () => {
  it('attaches remote audio during an authenticated voice call', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const remoteStream = { getTracks: () => [] } as unknown as MediaStream
    const { container } = render(<CallOverlay
      call={{
        status: 'active',
        media: 'audio',
        peerIdentityKey: `02${'11'.repeat(32)}`,
        remoteStream,
        localStream: { getTracks: () => [] } as unknown as MediaStream,
        audioEnabled: true,
        videoEnabled: false,
        authenticated: true,
        message: 'Wallet-authenticated peer-to-peer call',
        isGroup: false,
        participants: [{
          identityKey: `02${'11'.repeat(32)}`,
          status: 'active',
          stream: remoteStream,
          authenticated: true,
          audioEnabled: true,
          videoEnabled: false,
        }],
      }}
      identityProfiles={{}}
      onAccept={vi.fn()}
      onDecline={vi.fn()}
      onHangup={vi.fn()}
      onDismiss={vi.fn()}
      onToggleAudio={vi.fn()}
      onToggleVideo={vi.fn()}
    />)

    expect(container.querySelector('audio')).toBeInTheDocument()
    expect(container.querySelector('audio')?.srcObject).toBe(remoteStream)
  })

  it('renders resolved names and selects the custom video ringtone for an incoming group meeting', () => {
    const peer = `02${'22'.repeat(32)}`
    render(<CallOverlay
      call={{
        status: 'incoming', media: 'video', peerIdentityKey: peer,
        audioEnabled: true, videoEnabled: true, authenticated: false,
        message: 'Incoming group video meeting', isGroup: true,
        participants: [{ identityKey: peer, status: 'ringing', authenticated: false, audioEnabled: true, videoEnabled: true }],
      }}
      identityProfiles={{ [peer]: { identityKey: peer, name: 'Jordan Rivera' } }}
      onAccept={vi.fn()} onDecline={vi.fn()} onHangup={vi.fn()} onDismiss={vi.fn()} onToggleAudio={vi.fn()} onToggleVideo={vi.fn()}
    />)

    expect(screen.getByRole('dialog')).toHaveAttribute('data-ringtone', 'video')
    expect(screen.getByText('Jordan Rivera')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Join video meeting' })).toBeInTheDocument()
  })
})
