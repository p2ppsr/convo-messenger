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
  onCreate: (threadId: string, allRecipients: string[]) => void
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
  const [manualKey, setManualKey] = useState<string>('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  const identityKey = selectedIdentity?.identityKey || manualKey.trim() || null

  const handleSend = async () => {
    if (!identityKey || !message) return

    setSending(true)

    try {
      const keys = [senderPublicKey, identityKey].sort()
      const threadId = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(keys.join('|'))
      )
      const threadIdHex = Array.from(new Uint8Array(threadId))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      const allRecipients = Array.from(new Set([identityKey, senderPublicKey]))

      await sendMessage({
        client,
        senderPublicKey,
        threadId: threadIdHex,
        content: message,
        recipients: allRecipients,
        protocolID,
        keyID
      })

      onCreate(threadIdHex, allRecipients)
      setSelectedIdentity(null)
      setManualKey('')
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
      <DialogTitle sx={{ backgroundColor: '#222', color: 'white' }}>
        New 1-on-1 Message
      </DialogTitle>

      <DialogContent sx={{ backgroundColor: '#333', color: 'white' }}>
        <Box sx={{ my: 2 }}>
          <IdentitySearchField
            appName="Convo Messenger"
            onIdentitySelected={setSelectedIdentity}
          />
          <Typography variant="body2" sx={{ mt: 1, color: 'gray' }}>
            or paste an identity key manually:
          </Typography>
          <TextField
            label="Identity Key"
            fullWidth
            value={manualKey}
            onChange={(e) => setManualKey(e.target.value)}
            sx={{
              mt: 1,
              '& label': { color: 'white' },
              '& .MuiOutlinedInput-root': {
                color: 'white',
                '& fieldset': { borderColor: 'gray' },
                '&:hover fieldset': { borderColor: 'white' },
                '&.Mui-focused fieldset': { borderColor: 'white' },
              }
            }}
          />
        </Box>

        {identityKey && (
          <Box
            sx={{
              mt: 2,
              p: 2,
              borderRadius: 2,
              backgroundColor: '#444',
              color: 'white'
            }}
          >
            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
              <strong>Recipient Key:</strong><br />
              {identityKey}
            </Typography>

            <TextField
              label="Message"
              fullWidth
              multiline
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              sx={{
                mt: 2,
                '& label': { color: 'white' },
                '& .MuiOutlinedInput-root': {
                  color: 'white',
                  '& fieldset': {
                    borderColor: 'gray',
                  },
                  '&:hover fieldset': {
                    borderColor: 'white',
                  },
                  '&.Mui-focused fieldset': {
                    borderColor: 'white',
                  },
                }
              }}
            />
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ backgroundColor: '#222' }}>
        <Button onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSend}
          disabled={!identityKey || !message || sending}
        >
          Send
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ComposeDirectMessage
