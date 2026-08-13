import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Archive, ArchiveRestore, AtSign, BellOff, ChevronDown, Hash, Heart, Inbox, MessageCircle, Plus, Search, ShieldCheck, X } from 'lucide-react'
import type { ConversationSecret } from '../domain/types'
import { conversationName, conversationSearchText, currentMembers, directPeer } from '../domain/presentation'
import type { IdentityProfileMap } from '../hooks/useIdentityProfiles'
import { IdentityAvatar } from './IdentityAvatar'

interface Props {
  conversations: ConversationSecret[]
  identityKey: string
  identityProfiles: IdentityProfileMap
  activeId: string | null
  pendingCount: number
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
  const { conversations, identityKey, identityProfiles, activeId, pendingCount, loading, open, onClose, onSelect, onNew, onOpenInvites } = props
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const cleanQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(() => conversations.filter((conversation) => (
    conversation.preferences.archived === showArchived
    && (!cleanQuery || conversationSearchText(conversation, identityKey, identityProfiles).includes(cleanQuery))
  )), [cleanQuery, conversations, identityKey, identityProfiles, showArchived])
  const directMessages = filtered.filter((conversation) => conversation.kind === 'direct')
  const groups = filtered.filter((conversation) => conversation.kind === 'group')
  const archivedCount = conversations.filter((conversation) => conversation.preferences.archived).length

  const section = (title: string, icon: ReactNode, items: ConversationSecret[]) => items.length > 0 && (
    <section className="rail-section" aria-label={title}>
      <div className="rail-section-heading"><span>{icon}{title}</span><b>{items.length}</b><ChevronDown size={14} /></div>
      {items.map((conversation) => {
        const members = currentMembers(conversation)
        const peer = directPeer(conversation, identityKey)
        const displayName = conversationName(conversation, identityKey, identityProfiles)
        return (
          <div className="conversation-item-shell" key={conversation.conversationId}>
            <button
              className={`conversation-item ${conversation.conversationId === activeId ? 'is-active' : ''}`}
              onClick={() => { onSelect(conversation.conversationId); onClose() }}
            >
              {conversation.kind === 'direct'
                ? <IdentityAvatar className="conversation-avatar" identityKey={peer} profiles={identityProfiles} fallback={initials(displayName)} />
                : <span className="conversation-avatar group-avatar"><Hash size={18} /></span>}
              <span className="conversation-copy">
                <span className="conversation-title">{displayName}</span>
                <span className="conversation-meta">{conversation.kind === 'direct' ? <><AtSign size={12} /> Direct message</> : <><ShieldCheck size={12} /> {members.length} private members</>}</span>
              </span>
              <span className="conversation-flags">
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
        <div><strong>Convo</strong><span>Private messenger</span></div>
        <button className="icon-button rail-close" onClick={onClose} aria-label="Close conversations"><X size={20} /></button>
      </div>

      <button className="new-conversation" disabled={loading} onClick={onNew}><Plus size={18} /> New conversation</button>
      <button className="inbox-button" onClick={onOpenInvites}>
        <span><Inbox size={18} /> Private invitations</span>
        {pendingCount > 0 && <b>{pendingCount}</b>}
      </button>

      <label className="rail-search">
        <Search size={17} />
        <input type="search" value={query} placeholder={showArchived ? 'Search archived chats' : 'Search people and groups'} onChange={(event) => setQuery(event.target.value)} />
        {query && <button onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>}
      </label>

      <div className="conversation-list">
        {section('Direct messages', <AtSign size={14} />, directMessages)}
        {section('Groups', <Hash size={14} />, groups)}
        {loading && conversations.length === 0 && (
          <div className="rail-empty rail-loading" role="status"><span className="spinner" /><p>Loading private conversations…</p><span>Opening your wallet-encrypted index.</span></div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="rail-empty"><ShieldCheck size={24} /><p>{cleanQuery ? 'No matching conversations.' : showArchived ? 'No archived conversations.' : 'No conversations yet.'}</p><span>{cleanQuery ? 'Try a person, group, or identity key.' : showArchived ? 'Archived chats will appear here.' : 'Start a direct message or private group.'}</span></div>
        )}
      </div>
      <button className={`archive-toggle ${showArchived ? 'is-active' : ''}`} onClick={() => { setShowArchived((current) => !current); setQuery('') }}>
        <Archive size={15} /><span>{showArchived ? 'Back to conversations' : 'Archived'}</span>{archivedCount > 0 && <b>{archivedCount}</b>}
      </button>
    </aside>
  )
}
