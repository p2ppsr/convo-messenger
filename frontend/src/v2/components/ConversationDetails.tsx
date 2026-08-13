import { useEffect, useMemo, useRef, useState } from 'react'
import type { WalletInterface } from '@bsv/sdk'
import { Crown, LockKeyhole, ShieldCheck, UserMinus, X } from 'lucide-react'
import type { ConversationSecret } from '../domain/types'
import { identityInitials, identityName, type IdentityProfileMap } from '../hooks/useIdentityProfiles'
import type { RealtimePeer } from '../realtime/messaging'
import { IdentitySearch, type IdentityChoice } from './IdentitySearch'

interface Props {
  open: boolean
  busy: boolean
  identityKey: string
  wallet: WalletInterface
  secret: ConversationSecret
  onlinePeers: RealtimePeer[]
  identityProfiles: IdentityProfileMap
  onClose: () => void
  onSave: (title: string, members: string[], admins: string[]) => Promise<void>
}

export function ConversationDetails({ open, busy, identityKey, wallet, secret, onlinePeers, identityProfiles, onClose, onSave }: Props) {
  const epoch = useMemo(() => secret.epochs.find((item) => item.epoch === secret.currentEpoch)!, [secret])
  const [title, setTitle] = useState(secret.title)
  const [members, setMembers] = useState<string[]>(epoch.members)
  const [admins, setAdmins] = useState<string[]>(epoch.admins)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const canAdmin = epoch.admins.includes(identityKey)
  const onlineSet = new Set(onlinePeers.map((peer) => peer.identityKey))

  useEffect(() => {
    setTitle(secret.title)
    setMembers(epoch.members)
    setAdmins(epoch.admins)
    setError('')
  }, [epoch, secret.title])

  if (!open) return null
  const addMember = (identity: IdentityChoice) => setMembers((current) => current.includes(identity.identityKey) ? current : [...current, identity.identityKey])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card details-modal" role="dialog" aria-modal="true" aria-labelledby="details-title">
        <div className="modal-heading">
          <div className="modal-icon"><ShieldCheck size={21} /></div>
          <div><h2 id="details-title">Conversation security</h2><p>Epoch {epoch.epoch} · {members.length} privately linked members</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="modal-content">
          <label className="field-label">Private title</label>
          <input className="text-field" disabled={!canAdmin} value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} />
          <div className="field-heading"><label className="field-label">Members</label><span>{canAdmin ? 'Changes rotate the group key' : 'Administrators manage this group'}</span></div>
          {canAdmin && <div className="identity-search-shell"><IdentitySearch wallet={wallet} onSelect={addMember} /></div>}
          <div className="member-list">
            {members.map((member) => {
              const isSelf = member === identityKey
              const isAdmin = admins.includes(member)
              return (
                <div className="member-row" key={member}>
                  <span className="member-avatar">{isSelf ? 'You' : identityInitials(identityProfiles, member)}</span>
                  <span className="member-key"><strong>{isSelf ? 'You' : identityName(identityProfiles, member)}</strong><small><i className={`member-presence ${isSelf || onlineSet.has(member) ? 'online' : ''}`} />{isSelf || onlineSet.has(member) ? 'Online' : 'Offline'} · {isAdmin ? 'Administrator' : 'Member'}</small></span>
                  {canAdmin && <div className="member-controls">
                    <button className={`compact-button ${isAdmin ? 'is-active' : ''}`} disabled={isSelf} onClick={() => setAdmins((current) => isAdmin ? current.filter((item) => item !== member) : [...current, member])}><Crown size={14} /> Admin</button>
                    <button className="icon-button danger" disabled={isSelf} onClick={() => { setMembers((current) => current.filter((item) => item !== member)); setAdmins((current) => current.filter((item) => item !== member)) }} aria-label={`Remove ${identityName(identityProfiles, member)}`}><UserMinus size={16} /></button>
                  </div>}
                </div>
              )
            })}
          </div>
          <div className="privacy-callout"><LockKeyhole size={18} /><span>Saving a roster change creates a fresh random epoch key. Removed members cannot locate or decrypt new events.</span></div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose}>Close</button>{canAdmin && <button className="primary-button" disabled={busy} onClick={() => {
          setError('')
          if (submitting.current) return
          submitting.current = true
          void onSave(title, members, admins)
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not save changes'))
            .finally(() => { submitting.current = false })
        }}>{busy ? 'Securing changes…' : 'Save securely'}</button>}</div>
      </section>
    </div>
  )
}
