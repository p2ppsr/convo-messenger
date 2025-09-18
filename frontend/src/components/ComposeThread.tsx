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

/**
 * Props for ComposeThread dialog
 * - client: WalletClient used to sign/encrypt
 * - senderPublicKey: current user’s pubkey
 * - protocolID: namespace (ex: [2, 'convo'])
 * - keyID: which key derivation index to use
 * - onThreadCreated: callback fired after thread creation
 * - onClose: close the dialog
 * - open: whether dialog is visible (default true)
 */
interface ComposeThreadProps {
  client: WalletClient
  senderPublicKey: string
  protocolID: WalletProtocol
  keyID: string
  onThreadCreated: (
    threadId: string,
    recipientPublicKeys: string[],
    threadName: string
  ) => void
  onClose: () => void
  open?: boolean
}

/**
 * ComposeThread component
 * This is the modal dialog for creating a **new group conversation**.
 * Steps:
 *   1. User selects multiple identities (participants)
 *   2. Optionally enters a thread name
 *   3. Clicks "Create Thread" → calls createThread utility
 *   4. Parent component gets notified with thread info via onThreadCreated
 */
const ComposeThread: React.FC<ComposeThreadProps> = ({
  client,
  senderPublicKey,
  protocolID,
  keyID,
  onThreadCreated,
  onClose,
  open = true
}) => {
  // Store selected participants (as DisplayableIdentity objects)
  const [selectedIdentities, setSelectedIdentities] = useState<DisplayableIdentity[]>([])
  // Store thread name typed by user
  const [threadName, setThreadName] = useState('')
  // Whether we are currently creating the thread
  const [creating, setCreating] = useState(false)

  /**
   * Add a new identity when selected from IdentitySearchField
   * Avoid duplicates by checking identityKey first
   */
  const handleIdentitySelected = (identity: DisplayableIdentity) => {
    if (!selectedIdentities.some((id) => id.identityKey === identity.identityKey)) {
      setSelectedIdentities((prev) => [...prev, identity])
    }
  }

  /**
   * Remove identity from the participant list
   */
  const handleRemoveIdentity = (identityKey: string) => {
    setSelectedIdentities((prev) => prev.filter((id) => id.identityKey !== identityKey))
  }

  /**
   * Called when user clicks "Create Thread"
   * - Collects participant keys
   * - Uses createThread utility to establish thread on overlay
   * - Calls parent callback with new thread info
   */
  const handleCreate = async () => {
    if (selectedIdentities.length === 0) return

    // Collect only pubkeys from selected identities
    const recipientPublicKeys = selectedIdentities.map((id) => id.identityKey)
    // Fallback thread name if left blank
    const name = (threadName || 'Untitled Group').trim()

    setCreating(true)

    try {
      // Call helper to generate thread ID and send initial invite transaction
      const threadId = await createThread({
        client,
        senderPublicKey,
        recipientPublicKeys,
        threadName: name,
        protocolID,
        keyID
      })

      // Notify parent component that thread has been created
      onThreadCreated(threadId, recipientPublicKeys, name)
      // Close the dialog
      onClose()
    } catch (err) {
      console.error('[ComposeThread] Failed to create thread:', err)
    } finally {
      setCreating(false)
    }
  }

  /**
   * Render the dialog
   */
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Start a New Conversation</DialogTitle>

      <DialogContent>
        {/* Identity selection field */}
        <Box sx={{ mt: 2 }}>
          <IdentitySearchField
            onIdentitySelected={handleIdentitySelected}
            appName="Convo"
          />
        </Box>

        {/* List of selected participants with remove buttons */}
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

        {/* Input for thread name */}
        <TextField
          label="Thread Name"
          value={threadName}
          onChange={(e) => setThreadName(e.target.value)}
          fullWidth
          margin="normal"
          disabled={creating}
        />
      </DialogContent>

      {/* Action buttons */}
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
