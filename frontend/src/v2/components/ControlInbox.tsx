import { Inbox, LockKeyhole, ShieldCheck, UserRoundPlus, X } from 'lucide-react'
import type { PendingInvite, PendingMembershipUpdate } from '../realtime/messaging'
import { identityName, type IdentityProfileMap } from '../hooks/useIdentityProfiles'

interface Props {
  open: boolean
  busy: boolean
  invites: PendingInvite[]
  updates: PendingMembershipUpdate[]
  identityProfiles: IdentityProfileMap
  onClose: () => void
  onAcceptInvite: (invite: PendingInvite) => Promise<void>
  onDeclineInvite: (invite: PendingInvite) => Promise<void>
  onAcceptUpdate: (update: PendingMembershipUpdate) => Promise<void>
}

export function ControlInbox({ open, busy, invites, updates, identityProfiles, onClose, onAcceptInvite, onDeclineInvite, onAcceptUpdate }: Props) {
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card inbox-modal" role="dialog" aria-modal="true" aria-labelledby="private-inbox-title">
        <div className="modal-heading">
          <div className="modal-icon"><Inbox size={21} /></div>
          <div><h2 id="private-inbox-title">Private invitations</h2><p>Only your wallet can open these membership envelopes.</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="modal-content inbox-list">
          {invites.map((pending) => (
            <article className="inbox-card" key={pending.messageId}>
              <div className="inbox-card-icon"><UserRoundPlus size={20} /></div>
              <div className="inbox-card-copy"><h3>{pending.invite.title}</h3><p>From {identityName(identityProfiles, pending.sender)} · {pending.invite.members.length} members</p><span><LockKeyhole size={13} /> Epoch {pending.invite.epoch} key sealed with CurvePoint</span></div>
              <div className="inbox-card-actions"><button className="secondary-button" disabled={busy} onClick={() => void onDeclineInvite(pending).catch(() => undefined)}>Decline</button><button className="primary-button" disabled={busy} onClick={() => void onAcceptInvite(pending).catch(() => undefined)}>Accept</button></div>
            </article>
          ))}
          {updates.map((pending) => (
            <article className="inbox-card" key={pending.messageId}>
              <div className="inbox-card-icon"><ShieldCheck size={20} /></div>
              <div className="inbox-card-copy"><h3>{pending.update.title}</h3><p>Membership changed · {pending.update.members.length} current members</p><span><LockKeyhole size={13} /> Rotate to private epoch {pending.update.epoch}</span></div>
              <div className="inbox-card-actions"><button className="primary-button" disabled={busy} onClick={() => void onAcceptUpdate(pending).catch(() => undefined)}>Apply update</button></div>
            </article>
          ))}
          {invites.length === 0 && updates.length === 0 && <div className="modal-empty"><ShieldCheck size={28} /><h3>You’re caught up</h3><p>New encrypted invitations and membership rotations will appear here.</p></div>}
        </div>
      </section>
    </div>
  )
}
