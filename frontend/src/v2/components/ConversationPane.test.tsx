import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

afterEach(cleanup)

describe('ConversationPane realtime experience', () => {
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
    />)

    expect(screen.getByText('Online · Realtime private sync')).toBeInTheDocument()
    expect(screen.getByText(/is typing$/)).toBeInTheDocument()
    expect(screen.getByText('Delivered live · saving')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Write a private message'), { target: { value: 'hello' } })
    expect(onTyping).toHaveBeenCalledWith(true)
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
    />)

    fireEvent.click(getByRole('button', { name: 'Start voice call' }))
    expect(onCall).toHaveBeenCalledWith(bob, 'audio')
  })
})
