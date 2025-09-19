import React, { useEffect, useRef, useState } from 'react'
import { loadMessages } from '../utils/loadMessages'
import { sendMessage } from '../utils/sendMessage'
import { IdentitySearchField } from '@bsv/identity-react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  TextField,
  Paper,
} from '@mui/material'
import type { DisplayableIdentity, WalletClient, WalletProtocol } from '@bsv/sdk'
import type { MessagePayloadWithMetadata } from '../types/types'

/**
 * Props passed into the Chat component.
 * - client: WalletClient instance for signing/encrypting/broadcasting
 * - protocolID: namespace (ex: [2, 'convo'])
 * - keyID: wallet key index under identity (ex: "1")
 * - senderPublicKey: current user’s pubkey (used as "from")
 * - threadId: ID that uniquely identifies the conversation
 * - recipientPublicKeys: initial participants in the thread
 * - threadName: optional human-readable name (mainly for group chats)
 */
interface ChatProps {
  client: WalletClient
  protocolID: WalletProtocol
  keyID: string
  senderPublicKey: string
  threadId: string
  recipientPublicKeys: string[]
  threadName?: string
}

/**
 * normalizeSender
 * Utility function that attempts to standardize a "sender" field
 * into a proper compressed pubkey format (02... or 03...).
 */
function normalizeSender(sender: string): string {
  try {
    if (sender.startsWith('02') || sender.startsWith('03')) return sender
    const ascii =
      sender
        .match(/.{1,2}/g)
        ?.map((b) => String.fromCharCode(parseInt(b, 16)))
        .join('') ?? sender
    if (ascii.startsWith('02') || ascii.startsWith('03')) return ascii
    return sender
  } catch {
    return sender
  }
}

/**
 * Chat component
 * Handles:
 *  - Loading past messages
 *  - Sending new messages
 *  - Inviting new participants (via identity-react search)
 */
export const Chat: React.FC<ChatProps> = ({
  client,
  protocolID,
  keyID,
  senderPublicKey,
  threadId,
  recipientPublicKeys,
  threadName,
}) => {
  // 📨 State for conversation messages
  const [messages, setMessages] = useState<MessagePayloadWithMetadata[]>([])
  // ✍️ State for new message being composed
  const [newMessage, setNewMessage] = useState('')
  // ⏳ Show spinner until messages are loaded
  const [loading, setLoading] = useState(true)
  // 🧾 Map of pubkey → resolved display name
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map())
  // 🔑 Current list of recipients (starts with props but grows after invites)
  const [currentRecipients, setCurrentRecipients] = useState<string[]>(recipientPublicKeys)

  // 🆕 Invite dialog state
  const [inviteOpen, setInviteOpen] = useState(false)
  const [pendingInvite, setPendingInvite] = useState<DisplayableIdentity | null>(null)

  // 📜 Scroll anchor for always jumping to bottom of chat
  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })

  /**
   * Effect: Load messages when thread changes.
   * Uses loadMessages() to query overlay and decrypt.
   */
  useEffect(() => {
    const fetchMessages = async () => {
      try {
        const result = await loadMessages({ client, protocolID, keyID, topic: threadId })
        if (!('messages' in result) || !('nameMap' in result)) {
          throw new Error('[Chat] loadMessages returned unexpected structure')
        }
        const { messages: loadedMessages, nameMap: resolvedNames } = result

        // Replace state only if messages changed
        setMessages((prev) =>
          JSON.stringify(prev) !== JSON.stringify(loadedMessages) ? loadedMessages : prev
        )
        setNameMap(resolvedNames)
      } catch (err) {
        console.error('[Chat] Failed to load messages:', err)
      } finally {
        setLoading(false)
        scrollToBottom()
      }
    }
    setLoading(true)
    fetchMessages()
  }, [threadId, client, protocolID, keyID])

  /**
   * Send a normal text message.
   * - Calls sendMessage to encrypt + broadcast
   * - Optimistically adds message to UI
   */
  const handleSend = async () => {
    if (!newMessage.trim()) return
    const content = newMessage.trim()
    try {
      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId,
        senderPublicKey,
        recipients: currentRecipients,
        content,
        threadName,
      })
      setMessages((prev) => [
        ...prev,
        {
          content,
          sender: senderPublicKey,
          createdAt: Date.now(),
          txid: 'temp',
          vout: 0,
          threadId,
        },
      ])
      setNewMessage('')
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to send message:', err)
    }
  }

  /**
   * Confirm an invite once identity is selected from IdentitySearchField.
   * - Appends new recipient key to local state
   * - Sends a system-style "invited" message
   */
  const handleConfirmInvite = async () => {
    if (!pendingInvite) return
    const newKey = pendingInvite.identityKey
    const updated = [...new Set([...currentRecipients, newKey])] // dedupe

    try {
      await sendMessage({
        client,
        protocolID,
        keyID,
        threadId,
        senderPublicKey,
        recipients: updated,
        content: `🔔 Invited new participant: ${pendingInvite.name || newKey.slice(0, 12)}...`,
        threadName,
      })

      // Update state so future messages include this new participant
      setCurrentRecipients(updated)

      // Optimistically show invite message
      setMessages((prev) => [
        ...prev,
        {
          content: `🔔 Invited new participant: ${pendingInvite.name || newKey.slice(0, 12)}...`,
          sender: senderPublicKey,
          createdAt: Date.now(),
          txid: 'temp',
          vout: 0,
          threadId,
        },
      ])
      setPendingInvite(null)
      setInviteOpen(false)
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to invite new participant:', err)
    }
  }

  /**
   * Intercept Enter key → send message
   * Shift+Enter still allows newline
   */
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  /**
   * Render
   */
  return (
    <Box display="flex" flexDirection="column" height="100%" p={2}>
      <Box flex={1} overflow="auto" mb={2}>
        {/* Banner for group thread name */}
        {threadName && (
          <Box my={2} display="flex" justifyContent="center">
            <Paper
              elevation={3}
              sx={{
                px: 2,
                py: 1,
                borderRadius: '16px',
                background: (theme) => theme.palette.primary.main,
                color: 'white',
                fontWeight: 'bold',
              }}
            >
              {threadName}
            </Paper>
          </Box>
        )}

        {/* Message list */}
        {loading ? (
          <Typography align="center" color="text.secondary">
            Loading messages...
          </Typography>
        ) : messages.length === 0 ? (
          <Typography align="center" color="text.secondary">
            No messages yet
          </Typography>
        ) : (
          messages.map((msg) => {
            const normalized = normalizeSender(msg.sender as string)
            const displaySender = nameMap.get(normalized) || normalized.slice(0, 10) + '...'
            const isOwn = msg.sender === senderPublicKey

            return (
              <Box
                key={`${msg.txid}-${msg.vout}`}
                sx={{
                  p: 1,
                  mb: 1,
                  borderRadius: 2,
                  maxWidth: '75%',
                  ml: isOwn ? 'auto' : 0,
                  backgroundColor: 'black',
                  color: 'white',
                }}
              >
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {msg.content}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, textAlign: 'right' }}>
                  {new Date(msg.createdAt).toLocaleTimeString()}
                  <br />
                  {displaySender}
                </Typography>
              </Box>
            )
          })
        )}
        <div ref={chatEndRef} />
      </Box>

      {/* Input + actions */}
      <Box display="flex" gap={1}>
        <TextField
          multiline
          minRows={1}
          maxRows={4}
          fullWidth
          placeholder="Type a message..."
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={handleKeyPress}
        />
        <Button
          variant="contained"
          color="primary"
          disabled={!newMessage.trim()}
          onClick={handleSend}
        >
          Send
        </Button>
        <Button variant="contained" color="secondary" onClick={() => setInviteOpen(true)}>
          Invite
        </Button>
      </Box>

      {/* Invite participant dialog */}
      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Invite New Participant</DialogTitle>
        <DialogContent>
          <IdentitySearchField appName="Convo" onIdentitySelected={(id) => setPendingInvite(id)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
          <Button onClick={handleConfirmInvite} disabled={!pendingInvite} variant="contained">
            Invite
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default Chat
