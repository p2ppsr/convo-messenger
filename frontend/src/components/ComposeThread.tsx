import React, { useState } from 'react'
import {
  Box,
  Typography,
  TextField,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions
} from '@mui/material'
import { IdentitySearchField } from '@bsv/identity-react'
import type { DisplayableIdentity, WalletClient, WalletProtocol } from '@bsv/sdk'

import { createThread } from '../utils/createThread'

interface ComposeThreadProps {
  client: WalletClient
  senderPublicKey: string
  protocolID: WalletProtocol
  keyID: string
  onThreadCreated: (threadId: string, recipientPublicKeys: string[]) => void
  onClose: () => void
  open?: boolean
}

const ComposeThread: React.FC<ComposeThreadProps> = ({
  client,
  senderPublicKey,
  protocolID,
  keyID,
  onThreadCreated,
  onClose,
  open = true
}) => {
  const [selectedIdentities, setSelectedIdentities] = useState<DisplayableIdentity[]>([])
  const [threadName, setThreadName] = useState('')
  const [creating, setCreating] = useState(false)

  const handleIdentitySelected = (identity: DisplayableIdentity) => {
    if (!selectedIdentities.some((id) => id.identityKey === identity.identityKey)) {
      setSelectedIdentities((prev) => [...prev, identity])
    }
  }

  const handleRemoveIdentity = (identityKey: string) => {
    setSelectedIdentities((prev) => prev.filter((id) => id.identityKey !== identityKey))
  }

  const handleCreate = async () => {
    if (selectedIdentities.length === 0) return

    const recipientPublicKeys = selectedIdentities.map((id) => id.identityKey)
    const name = selectedIdentities.length > 1 ? threadName || 'Untitled Group' : ''

    setCreating(true)

    try {
      const threadId = await createThread({
        client,
        senderPublicKey,
        recipientPublicKeys,
        threadName: name,
        protocolID,
        keyID
      })

      onThreadCreated(threadId, recipientPublicKeys)
      onClose()
    } catch (err) {
      console.error('[ComposeThread] Failed to create thread:', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Start a New Conversation</DialogTitle>
      <DialogContent>
        <Box sx={{ mt: 2 }}>
          <IdentitySearchField
            onIdentitySelected={handleIdentitySelected}
            appName="Convo"
          />
        </Box>

        <Box sx={{ mt: 2 }}>
          {selectedIdentities.map((identity) => (
            <Box
              key={identity.identityKey}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                mb: 1,
                px: 1,
                py: 0.5,
                border: '1px solid #444',
                borderRadius: 1
              }}
            >
              <Typography variant="body2">
                {identity.name || identity.identityKey.slice(0, 10) + '...'}
              </Typography>
              <Button
                onClick={() => handleRemoveIdentity(identity.identityKey)}
                color="error"
                size="small"
              >
                Remove
              </Button>
            </Box>
          ))}
        </Box>

        {selectedIdentities.length > 1 && (
          <TextField
            label="Group Name"
            value={threadName}
            onChange={(e) => setThreadName(e.target.value)}
            fullWidth
            margin="normal"
            disabled={creating}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleCreate}
          disabled={creating || selectedIdentities.length === 0}
        >
          {creating ? 'Creating...' : 'Create Thread'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ComposeThread
