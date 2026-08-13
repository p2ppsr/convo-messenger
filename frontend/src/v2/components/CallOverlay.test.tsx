import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CallOverlay } from './CallOverlay'

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
        audioEnabled: true,
        videoEnabled: false,
        authenticated: true,
        message: 'Wallet-authenticated peer-to-peer call',
      }}
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
})
