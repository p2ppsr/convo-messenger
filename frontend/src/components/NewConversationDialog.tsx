/**
 * NewConversationDialog.tsx
 *
 * This is the modal I use to spin up a brand-new conversation.
 * - I can select one participant for a private 1:1, or multiple for a group chat.
 * - For 1:1, I derive a deterministic threadId from our identity keys so both sides pick the same id.
 * - For groups, I generate a random threadId.
 * - I mint a fresh 32-byte groupKey, encrypt/announce memberships on the overlay (createThreadAndInvite),
 *   then persist the thread locally and stash the raw key in threadStore so decrypt works right away.
 */

import { useState } from 'react'
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Button, Chip, Box, Typography, TextField, Stack
} from '@mui/material'
import { IdentitySearchField } from '@bsv/identity-react'
import type { DisplayableIdentity } from '@bsv/sdk'

import { randomKey32 } from '../utils/wallet'
import { createThreadAndInvite } from '../utils/createThread'
import { setThreadKey, type ThreadRecord } from '../utils/threadStore'

type Props = {
  open: boolean            // parent shows/hides this dialog
  close: () => void        // parent close handler
  /** caller already fetched this from wallet */
  myIdentityKeyHex: string // my wallet identity pubkey (compressed hex)
  /** persist local thread and update UI (like in App/NewChatPanel) */
  onCreated: (rec: ThreadRecord) => void
}

export default function NewConversationDialog({ open, close, myIdentityKeyHex, onCreated }: Props) {
  /** People I’ve added via IdentitySearchField (no duplicates by identityKey). */
  const [participants, setParticipants] = useState<DisplayableIdentity[]>([])
  /** Optional custom name for group chats (ignored for 1:1). */
  const [title, setTitle] = useState<string>('')
  /** I disable UI while I’m creating the thread to avoid double-submits. */
  const [busy, setBusy] = useState(false)

  /** Add a participant only if not already present (de-dupe by identityKey). */
  const addParticipant = (id: DisplayableIdentity) => {
    setParticipants(prev =>
      prev.some(p => p.identityKey === id.identityKey) ? prev : [...prev, id]
    )
  }

  /** Remove one selected participant by identityKey. */
  const removeParticipant = (identityKey: string) => {
    setParticipants(prev => prev.filter(p => p.identityKey !== identityKey))
  }

  /** Reset local state and close the modal. */
  const resetAndClose = () => {
    setParticipants([])
    setTitle('')
    close()
  }

  /**
   * Deterministic 1:1 thread id.
   * I sort our keys so the order never matters (prevents identity ordering leaks),
   * then hash "convo|<a>|<b>" with SHA-256 and hex-encode the result.
   * Both sides will compute the exact same id.
   */
  const computeOneToOneThreadId = async (a: string, b: string): Promise<string> => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort()
    const seed = `convo|${x}|${y}`
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Random thread id for group chats.
   * I just hex-encode 16 random bytes (128-bit).
   */
  const randomThreadId = (): string => {
    const rnd = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(rnd).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Create the conversation:
   * 1) Decide if this is 1:1 or group and compute an id.
   * 2) Build a friendly name (for 1:1 I use the other person’s name; for groups I use the provided title or a list).
   * 3) Generate a fresh 32-byte groupKey.
   * 4) Call createThreadAndInvite to write the control record + member keyboxes to the overlay.
   * 5) Persist thread locally and stash the raw key in threadStore so decrypt works immediately.
   */
  const handleCreate = async () => {
    if (!myIdentityKeyHex) return
    if (participants.length === 0) return

    setBusy(true)
    try {
      // Participant list = me + selected. I also de-dupe just in case.
      const memberKeys = Array.from(
        new Set([myIdentityKeyHex, ...participants.map(p => p.identityKey)])
      )

      const isOneToOne = participants.length === 1
      const threadId = isOneToOne
        ? await computeOneToOneThreadId(myIdentityKeyHex, participants[0].identityKey)
        : randomThreadId()

      // Friendly thread name:
      // - 1:1 -> use other party’s display name (fallback to their key)
      // - group -> explicit title if given, otherwise join names/short keys
      const computedName = isOneToOne
        ? (participants[0].name || participants[0].identityKey)
        : (title.trim() || participants.map(p => p.name || p.identityKey.slice(0, 10)).join(', '))

      // Fresh symmetric key for this thread’s messages/attachments
      const groupKey = randomKey32()

      // Write thread + membership control record on overlay (creates keyboxes for each member)
      await createThreadAndInvite({
        threadId,
        title: computedName,
        groupKey,
        members: memberKeys.map(k => ({ identityKeyHex: k }))
      })

      // Persist locally so my UI updates instantly (and I can decrypt right away)
      onCreated({
        id: threadId,
        name: computedName,
        keyB64: btoa(String.fromCharCode(...groupKey))
      })
      setThreadKey(threadId, groupKey)

      // Close and clean up UI state
      resetAndClose()
    } catch (e) {
      console.error('[NewConversationDialog] create failed', e)
      // TODO: toast/snackbar if I want user feedback on failure
    } finally {
      setBusy(false)
    }
  }

  /** Enable the Create button only when there’s at least one participant and I’m not mid-request. */
  const canCreate = participants.length > 0 && !busy

  return (
    <Dialog open={open} onClose={busy ? undefined : close} PaperProps={{ sx: { minWidth: 520, maxWidth: '90vw' } }}>
      <DialogTitle>New Conversation</DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2">
            Search for people by name, handle, or email. Select one for a private chat, or add multiple for a group chat.
          </Typography>

          {/* Identity picker (talks to Identity service; returns DisplayableIdentity objects) */}
          <IdentitySearchField
            onIdentitySelected={addParticipant}
            appName="ConvoMessenger"
          />

          {/* Only show a title input when it’s a group */}
          {participants.length > 1 && (
            <TextField
              label="Thread title (optional)"
              placeholder="Project Alpha"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
              size="small"
            />
          )}

          {/* Visual list of who I’ve added; allow removal when not busy */}
          {participants.length > 0 && (
            <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {participants.map(p => (
                <Chip
                  key={p.identityKey}
                  label={p.name ?? p.identityKey}
                  onDelete={busy ? undefined : () => removeParticipant(p.identityKey)}
                  variant="outlined"
                />
              ))}
            </Box>
          )}
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={handleCreate} disabled={!canCreate}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
