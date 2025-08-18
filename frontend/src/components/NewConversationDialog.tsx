import { useState } from 'react'
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Button, Chip, Box, Typography
} from '@mui/material'
import { IdentitySearchField } from '@bsv/identity-react'
import type { DisplayableIdentity } from '@bsv/sdk'

import { addChat } from '../utils/loadSettings'

type Props = {
  open: boolean
  close: () => void
}

export default function NewConversationDialog({ open, close }: Props) {
  const [participants, setParticipants] = useState<DisplayableIdentity[]>([])

  const addParticipant = (id: DisplayableIdentity) => {
    // de-dupe by identityKey
    setParticipants(prev => prev.find(p => p.identityKey === id.identityKey)
      ? prev
      : [...prev, id])
  }

  const removeParticipant = (identityKey: string) => {
    setParticipants(prev => prev.filter(p => p.identityKey !== identityKey))
  }

  const handleCreate = async () => {
    try {
      for (const p of participants) {
        await addChat(p.identityKey)
      }
      close()
      setParticipants([])
    } catch (e) {
      console.error('[NewConversationDialog] create failed', e)
    }
  }

  return (
    <Dialog open={open} onClose={close} PaperProps={{ sx: { minWidth: 500, maxWidth: '90vw' } }}>
      <DialogTitle>New Conversation</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          Search for people by name, handle, or email. Select 1 for a private chat, or add multiple for a group chat.
        </Typography>

        {/* Identity search */}
        <IdentitySearchField
          onIdentitySelected={addParticipant}
          appName="ConvoMessenger"
        />

        {participants.length > 0 && (
          <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {participants.map(p => (
              <Chip
                key={p.identityKey}
                label={p.name ?? p.identityKey}
                onDelete={() => removeParticipant(p.identityKey)}
                variant="outlined"
              />
            ))}
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleCreate}
          disabled={participants.length === 0}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  )
}
