import { useEffect, useRef, useState } from 'react'
import type { WalletInterface } from '@bsv/sdk'
import { Check, LockKeyhole, Users, X } from 'lucide-react'
import { IdentitySearch, type IdentityChoice } from './IdentitySearch'

interface Props {
  open: boolean
  busy: boolean
  wallet: WalletInterface
  onClose: () => void
  onCreate: (title: string, members: string[]) => Promise<void>
}

function shortKey(key: string): string {
  return `${key.slice(0, 10)}…${key.slice(-8)}`
}

export function NewConversationDialog({ open, busy, wallet, onClose, onCreate }: Props) {
  const [title, setTitle] = useState('')
  const [members, setMembers] = useState<IdentityChoice[]>([])
  const [error, setError] = useState('')
  const submitting = useRef(false)

  useEffect(() => {
    if (!open) { setTitle(''); setMembers([]); setError('') }
  }, [open])

  if (!open) return null

  const addMember = (identity: IdentityChoice) => {
    setMembers((current) => current.some((member) => member.identityKey === identity.identityKey) ? current : [...current, identity])
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title">
        <div className="modal-heading">
          <div className="modal-icon"><Users size={21} /></div>
          <div><h2 id="new-conversation-title">Start a private conversation</h2><p>Invitations and membership stay encrypted.</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="modal-content">
          <label className="field-label" htmlFor="new-conversation-name">Conversation name <span>optional for direct messages</span></label>
          <input id="new-conversation-name" name="conversation-name" className="text-field" value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} placeholder="Design circle" autoFocus />
          <label className="field-label">Add people</label>
          <div className="identity-search-shell"><IdentitySearch wallet={wallet} onSelect={addMember} /></div>
          <div className="selected-members">
            {members.map((member) => (
              <div className="member-chip" key={member.identityKey}>
                <span><Check size={14} /> {member.name || shortKey(member.identityKey)}</span>
                <button onClick={() => setMembers((current) => current.filter((item) => item.identityKey !== member.identityKey))} aria-label={`Remove ${member.name || 'member'}`}><X size={14} /></button>
              </div>
            ))}
            {members.length === 0 && <p className="field-hint">Search by identity name, then select at least one person.</p>}
          </div>
          <div className="privacy-callout"><LockKeyhole size={18} /><span><strong>Private by construction.</strong> The public overlay receives encrypted events at secret-derived locations—not this roster.</span></div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || members.length === 0} onClick={() => {
          setError('')
          if (submitting.current) return
          submitting.current = true
          void onCreate(title, members.map((member) => member.identityKey))
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not create conversation'))
            .finally(() => { submitting.current = false })
        }}>{busy ? 'Creating…' : 'Create securely'}</button></div>
      </section>
    </div>
  )
}
