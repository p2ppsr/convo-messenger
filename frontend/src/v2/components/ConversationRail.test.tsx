import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSecret } from '../domain/types'
import { ConversationRail } from './ConversationRail'

const identity = '02' + '11'.repeat(32)
const bob = '03' + '22'.repeat(32)
const conversation: ConversationSecret = {
  v: 2, conversationId: 'aa'.repeat(32), kind: 'group', title: 'Private design circle', currentEpoch: 1,
  epochs: [{ epoch: 1, rootKey: 'root', members: [identity], admins: [identity], activatedAt: 1 }],
  createdAt: 1, updatedAt: 1, preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
}

afterEach(cleanup)

describe('conversation rail', () => {
  it('presents private state and supports selecting and filtering', () => {
    const onSelect = vi.fn()
    render(<ConversationRail conversations={[conversation]} identityKey={identity} identityProfiles={{}} activeId={null} pendingCount={2} loading={false} open onClose={() => undefined} onSelect={onSelect} onNew={() => undefined} onOpenInvites={() => undefined} onRestore={vi.fn(async () => undefined)} />)
    expect(screen.getByText('Private design circle')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Private design circle'))
    expect(onSelect).toHaveBeenCalledWith(conversation.conversationId)
    fireEvent.change(screen.getByPlaceholderText('Search people and groups'), { target: { value: 'missing' } })
    expect(screen.queryByText('Private design circle')).not.toBeInTheDocument()
    expect(screen.getByText('No matching conversations.')).toBeInTheDocument()
  })

  it('shows an explicit wallet-index loading state before declaring the account empty', () => {
    render(<ConversationRail conversations={[]} identityKey={identity} identityProfiles={{}} activeId={null} pendingCount={0} loading open onClose={() => undefined} onSelect={() => undefined} onNew={() => undefined} onOpenInvites={() => undefined} onRestore={vi.fn(async () => undefined)} />)
    expect(screen.getByText('Loading private conversations…')).toBeInTheDocument()
    expect(screen.queryByText('No conversations yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeDisabled()
  })

  it('labels direct messages from identity profiles and keeps archived chats out of the default list', () => {
    const archived = { ...conversation, conversationId: 'bb'.repeat(32), title: 'Old group', preferences: { ...conversation.preferences, archived: true } }
    const direct: ConversationSecret = { ...conversation, conversationId: 'cc'.repeat(32), kind: 'direct', title: 'Direct message', epochs: [{ ...conversation.epochs[0], members: [identity, bob] }] }
    const onRestore = vi.fn(async () => undefined)
    render(<ConversationRail conversations={[direct, archived]} identityKey={identity} identityProfiles={{ [bob]: { identityKey: bob, name: 'Bob Builder' } }} activeId={null} pendingCount={0} loading={false} open onClose={() => undefined} onSelect={() => undefined} onNew={() => undefined} onOpenInvites={() => undefined} onRestore={onRestore} />)
    expect(screen.getByText('Direct messages')).toBeInTheDocument()
    expect(screen.getByText('Bob Builder')).toBeInTheDocument()
    expect(screen.queryByText('Old group')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Archived/ }))
    expect(screen.getByText('Old group')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore Old group' }))
    expect(onRestore).toHaveBeenCalledWith(archived)
  })
})
