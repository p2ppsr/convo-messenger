import React, { useState } from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  TextField
} from '@mui/material'
import { IdentitySearchField } from '@bsv/identity-react'
import {
  DisplayableIdentity,
  WalletClient,
  WalletProtocol
} from '@bsv/sdk'

import { sendMessage } from '../utils/sendMessage'

interface ComposeDirectMessageProps {
  open: boolean
  onClose: () => void
  onCreate: (threadId: string) => void
  client: WalletClient
  senderPublicKey: string
  protocolID: WalletProtocol
  keyID: string
}

const ComposeDirectMessage: React.FC<ComposeDirectMessageProps> = ({
  open,
  onClose,
  onCreate,
  client,
  senderPublicKey,
  protocolID,
  keyID
}) => {
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    if (!selectedIdentity?.identityKey || !message) return

    setSending(true)

    try {
      const keys = [senderPublicKey, selectedIdentity.identityKey].sort()
      const threadId = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(keys.join('|'))
      )
      const threadIdHex = Array.from(new Uint8Array(threadId))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      await sendMessage({
        client,
        senderPublicKey,
        threadId: threadIdHex,
        content: message,
        recipients: [selectedIdentity.identityKey],
        protocolID,
        keyID
      })

      onCreate(threadIdHex)
      setSelectedIdentity(null)
      setMessage('')
      onClose()
    } catch (err) {
      console.error('[ComposeDirectMessage] Failed to send message:', err)
      alert('Failed to send message. See console for details.')
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New 1-on-1 Message</DialogTitle>
      <DialogContent>
        <Box sx={{ my: 2 }}>
          <IdentitySearchField
            appName="Convo Messenger"
            onIdentitySelected={setSelectedIdentity}
          />
        </Box>

        {selectedIdentity && (
          <Box sx={{ mt: 2, p: 1, backgroundColor: '#f5f5f5', borderRadius: 1 }}>
            <Typography variant="subtitle1">{selectedIdentity.name}</Typography>
            <Typography variant="body2" color="text.secondary">
              {selectedIdentity.identityKey}
            </Typography>

            <TextField
              label="Message"
              fullWidth
              multiline
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              sx={{ mt: 2 }}
            />
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={sending}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSend}
          disabled={!selectedIdentity?.identityKey || !message || sending}
        >
          Send
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ComposeDirectMessage
