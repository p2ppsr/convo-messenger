import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Archive, ArchiveRestore, AtSign, BellOff, ChevronDown, Hash, Heart, Inbox, MessageCircle, Plus, Search, ShieldCheck, Video, X } from 'lucide-react'
import type { ConversationActivity } from '../storage/inbox'
import { displayMessageText } from '../domain/mentions'
import { identityName } from '../hooks/useIdentityProfiles'
import type { ConversationSecret } from '../domain/types'
import { conversationName, conversationSearchText, currentMembers, directPeer } from '../domain/presentation'
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

  const section = (title: string, icon: ReactNode, items: ConversationSecret[]) => items.length > 0 && (
    <section className="rail-section" aria-label={title}>
      <div className="rail-section-heading"><span>{icon}{title}</span><b>{items.length}</b><ChevronDown size={14} /></div>
      {items.map((conversation) => {
        const summary = activity?.[conversation.conversationId]
        const unread = summary?.unread ?? 0
        const members = currentMembers(conversation)
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
                <span className="conversation-meta">{summary?.body ? displayMessageText(summary.body, identityProfiles) : conversation.kind === 'direct' ? <><AtSign size={12} /> Direct message</> : <><ShieldCheck size={12} /> {members.length} private members</>}</span>
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
        <div className="brand-mark"><MessageCircle size={22} strokeWidth={2.4} /></div>
        <div><strong>convo<span className="brand-dot">.</span></strong><span>Good conversations start here</span></div>
        <button className="icon-button rail-close" onClick={onClose} aria-label="Close conversations"><X size={20} /></button>
      </div>

      <div className="workspace-label"><span className="workspace-monogram"><MessageCircle size={17} /></span><span><strong>Your workspace</strong><small>Private by default</small></span><ShieldCheck size={17} /></div>
      <button className="new-conversation" disabled={loading} onClick={onNew}><Plus size={18} /> New conversation</button>
      <button className="inbox-button" onClick={onOpenInvites}>
        <span><Inbox size={18} /> Private invitations</span>
        {pendingCount > 0 && <b>{pendingCount}</b>}
      </button>

      <label className="rail-search" htmlFor="conversation-search">
        <Search size={17} />
        <input id="conversation-search" name="conversation-search" type="search" aria-label="Search conversations" value={query} placeholder={showArchived ? 'Search archived chats' : 'Search people and groups'} onChange={(event) => setQuery(event.target.value)} />
        {query && <button onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>}
      </label>

      <div className="rail-tabs" role="group" aria-label="Conversation filter"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All conversations</button><button aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>Unread {unreadTotal > 0 && <b>{unreadTotal}</b>}</button></div>
      <div className="conversation-list">
        {section('Groups', <Hash size={14} />, groups)}
        {section('Direct messages', <AtSign size={14} />, directMessages)}
        {loading && conversations.length === 0 && (
          <div className="rail-skeleton" aria-hidden="true">{[0, 1, 2, 3].map((row) => <div key={row}><i /><span><b /><small /></span></div>)}</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="rail-empty"><ShieldCheck size={24} /><p>{cleanQuery ? 'No matching conversations.' : showArchived ? 'No archived conversations.' : filter === 'unread' ? 'You’re all caught up.' : 'No conversations yet.'}</p><span>{cleanQuery ? 'Try a person, group, or identity key.' : showArchived ? 'Archived chats will appear here.' : 'Start a direct message or private group.'}</span></div>
        )}
      </div>
      <button className={`archive-toggle ${showArchived ? 'is-active' : ''}`} onClick={() => { setShowArchived((current) => !current); setQuery('') }}>
        <Archive size={15} /><span>{showArchived ? 'Back to conversations' : 'Archived'}</span>{archivedCount > 0 && <b>{archivedCount}</b>}
      </button>
      <div className="rail-account"><IdentityAvatar className="account-avatar" identityKey={identityKey} profiles={identityProfiles} /><span><strong>{identityName(identityProfiles, identityKey)}</strong><small><i /> Wallet connected</small></span><ShieldCheck size={17} /></div>
    </aside>
  )
}
