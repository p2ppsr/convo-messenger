import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSecret, ConversationView } from '../domain/types'
import { ConversationPane } from './ConversationPane'

const alice = `02${'11'.repeat(32)}`
const bob = `03${'22'.repeat(32)}`
const messageId = 'aa'.repeat(32)
const secret: ConversationSecret = {
  v: 2,
  conversationId: 'bb'.repeat(32),
  kind: 'direct',
  title: 'Realtime pair',
  currentEpoch: 1,
  epochs: [{ epoch: 1, rootKey: 'root', members: [alice, bob], admins: [alice], activatedAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
  preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
}
const view: ConversationView = {
  title: secret.title,
  members: [alice, bob],
  admins: [alice],
  messages: [{
    id: messageId,
    sender: alice,
    body: 'Visible immediately',
    createdAt: Date.now(),
    epoch: 1,
    attachments: [],
    reactions: [],
    edited: false,
  }],
  partial: false,
  loadedPages: 1,
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ConversationPane realtime experience', () => {
  it('records locally, lets the user review audio, and only sends after confirmation', async () => {
    const stopTrack = vi.fn()
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }))
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    class FakeMediaRecorder {
      static isTypeSupported(type: string) { return type.startsWith('audio/webm') }
      state: RecordingState = 'inactive'
      mimeType = 'audio/webm;codecs=opus'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onstop: (() => void) | null = null
      constructor() {}
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob([Uint8Array.from([1, 2, 3])], { type: 'audio/webm' }) } as BlobEvent)
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:recording-preview' }
      static revokeObjectURL() {}
    })
    const onSend = vi.fn(async (body: string, files: File[]) => { void body; void files })
    render(<ConversationPane
      identityKey={alice} secret={secret} view={view} loading={false} busy={false} liveState="live"
      onlinePeers={[]} typingPeers={[]} deliveryStates={{}} identityProfiles={{}} callActive={false}
      onOpenRail={vi.fn()} onOpenDetails={vi.fn()} onLoadHistory={vi.fn(async () => undefined)} onTyping={vi.fn()}
      onCall={vi.fn(async () => undefined)} onSend={onSend} onEdit={vi.fn(async () => undefined)}
      onDelete={vi.fn(async () => undefined)} onReact={vi.fn(async () => undefined)}
      onDownload={vi.fn(async () => undefined)} onOpenAttachment={vi.fn(async () => new Blob())}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Record a private voice message' }))
    await screen.findByText('Recording voice')
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Stop & review/ }))
    await screen.findByText('Review recording')
    expect(screen.getByLabelText('Review voice recording')).toHaveAttribute('src', 'blob:recording-preview')
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    const sentFiles = onSend.mock.calls[0][1]
    expect(sentFiles).toHaveLength(1)
    expect(sentFiles[0].type).toBe('audio/webm')
    expect(stopTrack).toHaveBeenCalled()
  })

  it('shows presence, typing, and the live-to-durable message state', () => {
    const onTyping = vi.fn()
    render(<ConversationPane
      identityKey={alice}
      secret={secret}
      view={view}
      loading={false}
      busy={false}
      liveState="live"
      onlinePeers={[{ identityKey: bob, lastSeen: Date.now() }]}
      typingPeers={[{ identityKey: bob, lastSeen: Date.now(), expiresAt: Date.now() + 5_000 }]}
      deliveryStates={{ [messageId]: 'live' }}
      identityProfiles={{ [bob]: { identityKey: bob, name: 'Bob Builder' } }}
      callActive={false}
      onOpenRail={vi.fn()}
      onOpenDetails={vi.fn()}
      onLoadHistory={vi.fn(async () => undefined)}
      onTyping={onTyping}
      onCall={vi.fn(async () => undefined)}
      onSend={vi.fn(async () => undefined)}
      onEdit={vi.fn(async () => undefined)}
      onDelete={vi.fn(async () => undefined)}
      onReact={vi.fn(async () => undefined)}
      onDownload={vi.fn(async () => undefined)}
      onOpenAttachment={vi.fn(async () => new Blob())}
    />)

    expect(screen.getByText('Online · Realtime private sync')).toBeInTheDocument()
    expect(screen.getByText('Bob Builder is typing')).toBeInTheDocument()
    expect(screen.getByText('Delivered live · saving')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/Message Bob Builder/), { target: { value: 'hello' } })
    expect(onTyping).toHaveBeenCalledWith(true)
  })

  it('inserts identity-key mentions, renders them by profile, and searches decrypted messages', () => {
    const onSend = vi.fn(async () => undefined)
    render(<ConversationPane
      identityKey={alice}
      secret={secret}
      view={{ ...view, messages: [{ ...view.messages[0], sender: bob, body: `hello @<${alice}>` }] }}
      loading={false}
      busy={false}
      liveState="live"
      onlinePeers={[{ identityKey: bob, lastSeen: Date.now() }]}
      typingPeers={[]}
      deliveryStates={{}}
      identityProfiles={{ [alice]: { identityKey: alice, name: 'Alice Admin' }, [bob]: { identityKey: bob, name: 'Bob Builder' } }}
      callActive={false}
      onOpenRail={vi.fn()}
      onOpenDetails={vi.fn()}
      onLoadHistory={vi.fn(async () => undefined)}
      onTyping={vi.fn()}
      onCall={vi.fn(async () => undefined)}
      onSend={onSend}
      onEdit={vi.fn(async () => undefined)}
      onDelete={vi.fn(async () => undefined)}
      onReact={vi.fn(async () => undefined)}
      onDownload={vi.fn(async () => undefined)}
      onOpenAttachment={vi.fn(async () => new Blob())}
    />)

    expect(screen.getByText('Alice Admin')).toBeInTheDocument()
    expect(screen.getByText('Mentioned you')).toBeInTheDocument()
    const composer = screen.getByPlaceholderText(/Message Bob Builder/)
    fireEvent.change(composer, { target: { value: '@<bo', selectionStart: 4 } })
    expect(screen.getByRole('listbox', { name: 'Mention a conversation member' })).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('option', { name: /Bob Builder/ }))
    expect(composer).toHaveValue(`@<${bob}> `)
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(`@<${bob}> `, [])

    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }))
    fireEvent.change(screen.getByPlaceholderText('Search decrypted messages'), { target: { value: 'Alice Admin' } })
    expect(screen.getByText('1 result')).toBeInTheDocument()
  })

  it('only enables direct calls while the peer is online', () => {
    const onCall = vi.fn(async () => undefined)
    const { getByRole, getByText, rerender } = render(<ConversationPane
      identityKey={alice}
      secret={secret}
      view={view}
      loading={false}
      busy={false}
      liveState="live"
      onlinePeers={[]}
      typingPeers={[]}
      deliveryStates={{}}
      identityProfiles={{}}
      callActive={false}
      onOpenRail={vi.fn()}
      onOpenDetails={vi.fn()}
      onLoadHistory={vi.fn(async () => undefined)}
      onTyping={vi.fn()}
      onCall={onCall}
      onSend={vi.fn(async () => undefined)}
      onEdit={vi.fn(async () => undefined)}
      onDelete={vi.fn(async () => undefined)}
      onReact={vi.fn(async () => undefined)}
      onDownload={vi.fn(async () => undefined)}
      onOpenAttachment={vi.fn(async () => new Blob())}
    />)

    expect(getByText('Offline · Realtime private sync')).toBeInTheDocument()
    expect(getByRole('button', { name: 'Start voice call' })).toBeDisabled()

    rerender(<ConversationPane
      identityKey={alice}
      secret={secret}
      view={view}
      loading={false}
      busy={false}
      liveState="live"
      onlinePeers={[{ identityKey: bob, lastSeen: Date.now() }]}
      typingPeers={[]}
      deliveryStates={{}}
      identityProfiles={{}}
      callActive={false}
      onOpenRail={vi.fn()}
      onOpenDetails={vi.fn()}
      onLoadHistory={vi.fn(async () => undefined)}
      onTyping={vi.fn()}
      onCall={onCall}
      onSend={vi.fn(async () => undefined)}
      onEdit={vi.fn(async () => undefined)}
      onDelete={vi.fn(async () => undefined)}
      onReact={vi.fn(async () => undefined)}
      onDownload={vi.fn(async () => undefined)}
      onOpenAttachment={vi.fn(async () => new Blob())}
    />)

    fireEvent.click(getByRole('button', { name: 'Start voice call' }))
    expect(onCall).toHaveBeenCalledWith([bob], 'audio')
  })
})
