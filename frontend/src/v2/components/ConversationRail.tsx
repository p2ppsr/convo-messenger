import { Archive, BellOff, Heart, Inbox, MessageCircle, Plus, Search, ShieldCheck, X } from 'lucide-react'
import type { ConversationSecret } from '../domain/types'

interface Props {
  conversations: ConversationSecret[]
  activeId: string | null
  pendingCount: number
  loading: boolean
  open: boolean
  onClose: () => void
  onSelect: (conversationId: string) => void
  onNew: () => void
  onOpenInvites: () => void
}

function initials(title: string): string {
  return title.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'C'
}

export function ConversationRail({ conversations, activeId, pendingCount, loading, open, onClose, onSelect, onNew, onOpenInvites }: Props) {
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
        <input type="search" placeholder="Search conversations" onInput={(event) => {
          const query = event.currentTarget.value.toLowerCase()
          event.currentTarget.closest('aside')?.querySelectorAll<HTMLElement>('[data-title]').forEach((item) => {
            item.hidden = !item.dataset.title?.includes(query)
          })
        }} />
      </label>

      <div className="conversation-list">
        {conversations.filter((item) => !item.preferences.archived).map((conversation) => {
          const epoch = conversation.epochs.find((item) => item.epoch === conversation.currentEpoch)
          return (
            <button
              key={conversation.conversationId}
              data-title={conversation.title.toLowerCase()}
              className={`conversation-item ${conversation.conversationId === activeId ? 'is-active' : ''}`}
              onClick={() => { onSelect(conversation.conversationId); onClose() }}
            >
              <span className="conversation-avatar">{initials(conversation.title)}</span>
              <span className="conversation-copy">
                <span className="conversation-title">{conversation.title}</span>
                <span className="conversation-meta"><ShieldCheck size={13} /> {epoch?.members.length ?? 0} privately linked</span>
              </span>
              <span className="conversation-flags">
                {conversation.preferences.favorite && <Heart size={13} fill="currentColor" />}
                {conversation.preferences.muted && <BellOff size={13} />}
              </span>
            </button>
          )
        })}
        {loading && conversations.length === 0 && (
          <div className="rail-empty rail-loading" role="status"><span className="spinner" /><p>Loading private conversations…</p><span>Opening your wallet-encrypted index.</span></div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="rail-empty"><ShieldCheck size={24} /><p>No conversations yet.</p><span>Create one without publishing its member list.</span></div>
        )}
      </div>
      {conversations.some((item) => item.preferences.archived) && (
        <div className="archived-note"><Archive size={14} /> Archived conversations are hidden</div>
      )}
    </aside>
  )
}
