import { useMemo, useState } from 'react'
import { Archive, ArchiveRestore, BellOff, Hash, Heart, Inbox, SquarePen, Search, ShieldCheck, Video, X } from 'lucide-react'
import type { ConversationActivity } from '../storage/inbox'
import { displayMessageText } from '../domain/mentions'
import { identityName } from '../hooks/useIdentityProfiles'
import type { ConversationSecret } from '../domain/types'
import { conversationName, conversationSearchText, directPeer } from '../domain/presentation'
import type { IdentityProfileMap } from '../hooks/useIdentityProfiles'
import { IdentityAvatar } from './IdentityAvatar'
import type { MeetingRoomSnapshot } from '../realtime/meetingCalling'

interface Props {
  activity?: Record<string, ConversationActivity>
  conversations: ConversationSecret[]
  identityKey: string
  identityProfiles: IdentityProfileMap
  activeId: string | null
  pendingCount: number
  meetingRooms?: Record<string, MeetingRoomSnapshot>
  loading: boolean
  open: boolean
  onClose: () => void
  onSelect: (conversationId: string) => void
  onNew: () => void
  onOpenInvites: () => void
  onRestore: (conversation: ConversationSecret) => Promise<void>
}

function initials(title: string): string {
  return title.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'C'
}

export function ConversationRail(props: Props) {
  const { conversations, identityKey, identityProfiles, activeId, pendingCount, meetingRooms = {}, loading, open, onClose, onSelect, onNew, onOpenInvites } = props
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const cleanQuery = query.trim().toLocaleLowerCase()
  const activity = props.activity
  const unreadTotal = conversations.reduce((total, item) => total + (item.preferences.muted || item.preferences.archived !== showArchived ? 0 : activity?.[item.conversationId]?.unread ?? 0), 0)
  const filtered = useMemo(() => conversations.filter((conversation) => (
    conversation.preferences.archived === showArchived
    && (filter === 'all' || (activity?.[conversation.conversationId]?.unread ?? 0) > 0)
    && (!cleanQuery || conversationSearchText(conversation, identityKey, identityProfiles).includes(cleanQuery))
  )).sort((a, b) => Number(b.preferences.favorite) - Number(a.preferences.favorite) || (activity?.[b.conversationId]?.at ?? b.updatedAt) - (activity?.[a.conversationId]?.at ?? a.updatedAt)), [activity, filter, cleanQuery, conversations, identityKey, identityProfiles, showArchived])
  const directMessages = filtered.filter((conversation) => conversation.kind === 'direct')
  const groups = filtered.filter((conversation) => conversation.kind === 'group')
  const archivedCount = conversations.filter((conversation) => conversation.preferences.archived).length

  const section = (title: string, items: ConversationSecret[]) => items.length > 0 && (
    <section className="rail-section" aria-label={title}>
      <h2 className="rail-section-heading">{title}</h2>
      {items.map((conversation) => {
        const summary = activity?.[conversation.conversationId]
        const unread = summary?.unread ?? 0
        const peer = directPeer(conversation, identityKey)
        const displayName = conversationName(conversation, identityKey, identityProfiles)
        return (
          <div className="conversation-item-shell" key={conversation.conversationId}>
            <button
              className={`conversation-item ${conversation.conversationId === activeId ? 'is-active' : ''} ${unread ? 'has-unread' : ''}`}
              aria-current={conversation.conversationId === activeId ? 'page' : undefined}
              onClick={() => { onSelect(conversation.conversationId); onClose() }}
            >
              {conversation.kind === 'direct'
                ? <IdentityAvatar className="conversation-avatar" identityKey={peer} profiles={identityProfiles} fallback={initials(displayName)} />
                : <span className="conversation-avatar group-avatar"><Hash size={18} /></span>}
              <span className="conversation-copy">
                <span className="conversation-title">{displayName}</span>
                <span className="conversation-meta">{summary?.body ? displayMessageText(summary.body, identityProfiles) : null}</span>
              </span>
              <span className="conversation-flags">
                {unread > 0 && <b className="unread-badge" aria-label={`${unread} unread messages`}>{unread > 99 ? '99+' : unread}</b>}
                {meetingRooms[conversation.conversationId] && <span className="conversation-room-live" title="Meeting room live"><Video size={13} /> Live</span>}
                {conversation.preferences.favorite && <Heart size={13} fill="currentColor" />}
                {conversation.preferences.muted && <BellOff size={13} />}
              </span>
            </button>
            {showArchived && <button className="restore-conversation" onClick={() => void props.onRestore(conversation)} title="Restore conversation" aria-label={`Restore ${displayName}`}><ArchiveRestore size={15} /></button>}
          </div>
        )
      })}
    </section>
  )

  return (
    <aside className={`conversation-rail ${open ? 'is-open' : ''}`} aria-label="Conversations">
      <div className="rail-brand">
        <strong>convo<span className="brand-dot">.</span></strong>
        <div className="rail-header-actions">
          <button className="rail-action" onClick={onOpenInvites} aria-label={`Invitations${pendingCount > 0 ? `, ${pendingCount} pending` : ''}`} title="Invitations">
            <Inbox size={18} />{pendingCount > 0 && <b className="rail-action-badge" aria-hidden="true">{pendingCount > 99 ? '99+' : pendingCount}</b>}
          </button>
          <button className="rail-action rail-compose" disabled={loading} onClick={onNew} aria-label="New conversation" title="New conversation"><SquarePen size={18} /></button>
          <button className="rail-action rail-close" onClick={onClose} aria-label="Close conversations"><X size={20} /></button>
        </div>
      </div>

      <label className="rail-search" htmlFor="conversation-search">
        <Search size={17} />
        <input id="conversation-search" name="conversation-search" type="search" aria-label="Search conversations" value={query} placeholder={showArchived ? 'Search archived chats' : 'Search people and groups'} onChange={(event) => setQuery(event.target.value)} />
        {query && <button onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>}
      </label>

      <div className="rail-tabs" role="group" aria-label="Conversation filter"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')} aria-label="All conversations">All</button><button aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>Unread {unreadTotal > 0 && <b>{unreadTotal}</b>}</button></div>
      <div className="conversation-list">
        {section('Groups', groups)}
        {section('Direct messages', directMessages)}
        {loading && conversations.length === 0 && (
          <div className="rail-skeleton" aria-hidden="true">{[0, 1, 2, 3].map((row) => <div key={row}><i /><span><b /><small /></span></div>)}</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="rail-empty"><ShieldCheck size={24} /><p>{cleanQuery ? 'No matching conversations.' : showArchived ? 'No archived conversations.' : filter === 'unread' ? 'You’re all caught up.' : 'No conversations yet.'}</p><span>{cleanQuery ? 'Try a person, group, or identity key.' : showArchived ? 'Archived chats will appear here.' : 'Start a direct message or private group.'}</span></div>
        )}
      </div>
      <div className="rail-footer">
        <div className="rail-account"><IdentityAvatar className="account-avatar" identityKey={identityKey} profiles={identityProfiles} /><strong>{identityName(identityProfiles, identityKey)}</strong><i className="account-connected" aria-label="Wallet connected" title="Wallet connected" /></div>
        <button className={`rail-action archive-toggle ${showArchived ? 'is-active' : ''}`} onClick={() => { setShowArchived((current) => !current); setQuery('') }} aria-label={showArchived ? 'Back to conversations' : `Archived conversations${archivedCount ? `, ${archivedCount}` : ''}`} title={showArchived ? 'Back to conversations' : 'Archived conversations'} aria-pressed={showArchived}>
          <Archive size={17} />
        </button>
      </div>
    </aside>
  )
}
