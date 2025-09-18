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

/**
 * Props passed into this modal component
 * - open: controls whether the dialog is visible
 * - onClose: callback to close the dialog (cancel)
 * - onCreate: callback fired after message is successfully sent,
 *             receives the new threadId and list of all recipients
 * - client: WalletClient instance (used for signing, encrypting, etc.)
 * - senderPublicKey: pubkey of the currently logged-in user
 * - protocolID: namespace for messaging (e.g. [2, 'convo'])
 * - keyID: which key derivation index to use (usually '1')
 */
interface ComposeDirectMessageProps {
  open: boolean
  onClose: () => void
  onCreate: (threadId: string, allRecipients: string[]) => void
  client: WalletClient
  senderPublicKey: string
  protocolID: WalletProtocol
  keyID: string
}

/**
 * This component handles composing a **new direct 1-on-1 message**.
 * Steps:
 *   1. User selects or pastes a recipient identity key
 *   2. User types a first message
 *   3. When "Send" is clicked:
 *      - Deterministic threadId is generated from both keys
 *      - sendMessage() is called to actually encrypt & broadcast
 *      - onCreate() callback fires so parent can add this thread to UI
 */
const ComposeDirectMessage: React.FC<ComposeDirectMessageProps> = ({
  open,
  onClose,
  onCreate,
  client,
  senderPublicKey,
  protocolID,
  keyID
}) => {
  // Holds identity object if selected through IdentitySearchField
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)
  // Holds manually pasted identity key if typed in directly
  const [manualKey, setManualKey] = useState<string>('')
  // Holds the actual message text typed by user
  const [message, setMessage] = useState('')
  // Whether we are currently in the process of sending
  const [sending, setSending] = useState(false)

  // Determine which identity key to use:
  // Priority: selectedIdentity → manualKey → null
  const identityKey = selectedIdentity?.identityKey || manualKey.trim() || null

  /**
   * Called when user clicks "Send".
   * Handles:
   *   - Generating a deterministic thread ID (based on both pubkeys)
   *   - Creating the recipients list (sender + recipient)
   *   - Calling sendMessage() utility to actually broadcast
   *   - Clearing form and closing on success
   */
  const handleSend = async () => {
    if (!identityKey || !message) return

    setSending(true)

    try {
      // --- Deterministic thread ID generation ---
      // Take both pubkeys, sort them for consistency (A|B == B|A),
      // hash with SHA-256 → hex string
      const keys = [senderPublicKey, identityKey].sort()
      const threadId = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(keys.join('|'))
      )
      const threadIdHex = Array.from(new Uint8Array(threadId))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      // --- Recipients ---
      // Deduplicate just in case → [recipient, sender]
      const allRecipients = Array.from(new Set([identityKey, senderPublicKey]))

      // --- Actually send the message ---
      await sendMessage({
        client,
        senderPublicKey,
        threadId: threadIdHex,
        content: message,
        recipients: allRecipients, // this is the critical array for encryption header
        protocolID,
        keyID
      })

      // --- Notify parent & reset ---
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

  /**
   * Render the modal dialog
   */
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      {/* Title bar */}
      <DialogTitle sx={{ backgroundColor: '#222', color: 'white' }}>
        New 1-on-1 Message
      </DialogTitle>

      {/* Main content */}
      <DialogContent sx={{ backgroundColor: '#333', color: 'white' }}>
        <Box sx={{ my: 2 }}>
          {/* Identity search box from @bsv/identity-react */}
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

        {/* Show preview section only if we have a valid recipient key */}
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

      {/* Action buttons */}
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
