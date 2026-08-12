import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationSecret } from '../domain/types'
import { ConversationRail } from './ConversationRail'

const identity = '02' + '11'.repeat(32)
const conversation: ConversationSecret = {
  v: 2, conversationId: 'aa'.repeat(32), kind: 'group', title: 'Private design circle', currentEpoch: 1,
  epochs: [{ epoch: 1, rootKey: 'root', members: [identity], admins: [identity], activatedAt: 1 }],
  createdAt: 1, updatedAt: 1, preferences: { archived: false, favorite: false, muted: false, lastReadAt: 0 },
}

describe('conversation rail', () => {
  it('presents private state and supports selecting and filtering', () => {
    const onSelect = vi.fn()
    render(<ConversationRail conversations={[conversation]} activeId={null} pendingCount={2} open onClose={() => undefined} onSelect={onSelect} onNew={() => undefined} onOpenInvites={() => undefined} />)
    expect(screen.getByText('Private design circle')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Private design circle'))
    expect(onSelect).toHaveBeenCalledWith(conversation.conversationId)
    fireEvent.input(screen.getByPlaceholderText('Search conversations'), { target: { value: 'missing' } })
    expect(screen.getByText('Private design circle').closest('button')).not.toBeVisible()
  })
})
