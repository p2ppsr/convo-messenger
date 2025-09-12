import React, { useEffect, useRef, useState } from 'react'
import { loadMessages } from '../utils/loadMessages'
import { sendMessage } from '../utils/sendMessage'
import type { MessagePayloadWithMetadata } from '../types/types'
import type { WalletClient, WalletProtocol } from '@bsv/sdk'

interface ChatProps {
  client: WalletClient
  protocolID: WalletProtocol
  keyID: string
  senderPublicKey: string
  threadId: string
  recipientPublicKeys: string[]
  threadName?: string
}

// --- normalize sender for nameMap lookup ---
// --- normalize sender for nameMap lookup ---
function normalizeSender(sender: string): string {
  try {
    console.log("[normalizeSender] Raw sender input:", sender)

    // Case 1: already looks like a pubkey
    if (sender.startsWith("02") || sender.startsWith("03")) {
      console.log("[normalizeSender] Detected direct pubkey:", sender)
      return sender
    }

    // Case 2: might be hex of ASCII characters (like "3033...")
    // Decode safely without Buffer
    const ascii = sender
      .match(/.{1,2}/g) // split into hex byte pairs
      ?.map((byte) => String.fromCharCode(parseInt(byte, 16)))
      .join("") ?? sender

    console.log("[normalizeSender] Decoded ASCII:", ascii)

    if (ascii.startsWith("02") || ascii.startsWith("03")) {
      console.log("[normalizeSender] Decoded to pubkey:", ascii)
      return ascii
    }

    console.log("[normalizeSender] Fallback return (no match):", sender)
    return sender
  } catch (err) {
    console.warn("[normalizeSender] Failed to normalize:", sender, err)
    return sender
  }
}



export const Chat: React.FC<ChatProps> = ({
  client,
  protocolID,
  keyID,
  senderPublicKey,
  threadId,
  recipientPublicKeys,
  threadName
}) => {
  const [messages, setMessages] = useState<MessagePayloadWithMetadata[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map())

  const chatEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    const fetchMessages = async () => {
      try {
        const result = await loadMessages({
          client,
          protocolID,
          keyID,
          topic: threadId
        })

        if (!('messages' in result) || !('nameMap' in result)) {
          throw new Error('[Chat] loadMessages returned unexpected structure')
        }

        const { messages: loadedMessages, nameMap: resolvedNames } = result

        setMessages((prev) => {
          const hasChanged = JSON.stringify(prev) !== JSON.stringify(loadedMessages)
          return hasChanged ? loadedMessages : prev
        })

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
    // Optional polling:
    // const polling = setInterval(fetchMessages, 5000)
    // return () => clearInterval(polling)
  }, [threadId, client, protocolID, keyID])

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
        recipients: recipientPublicKeys,
        content,
        threadName
      })

      setMessages((prev) => [
        ...prev,
        {
          content,
          sender: senderPublicKey,
          createdAt: Date.now(),
          txid: 'temp',
          vout: 0,
          threadId
        }
      ])

      setNewMessage('')
      scrollToBottom()
    } catch (err) {
      console.error('[Chat] Failed to send message:', err)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex-1 overflow-y-auto space-y-2">
        {/* Thread name header */}
        {threadName && (
          <div className="text-lg font-semibold text-center mb-4">
            {threadName}
          </div>
        )}

        {/* Message list */}
        {loading ? (
          <div className="text-center text-gray-400">Loading messages...</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-gray-400">No messages yet</div>
        ) : (
          messages.map((msg) => {
            const normalized = normalizeSender(msg.sender as string)
            const displaySender =
              nameMap.get(normalized) || normalized.slice(0, 10) + "..."

            return (
              <div
                key={`${msg.txid}-${msg.vout}`}
                className={`p-2 rounded-lg max-w-[75%] ${
                  msg.sender === senderPublicKey
                    ? "bg-blue-500 text-white self-end ml-auto"
                    : "bg-gray-200 text-black self-start mr-auto"
                }`}
              >
                <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
                <div className="text-xs text-right opacity-60 mt-1">
                  {new Date(msg.createdAt).toLocaleTimeString()}
                  <br />
                  {displaySender}
                </div>
              </div>
            )
          })
        )}

        {/* Scroll anchor */}
        <div ref={chatEndRef} />
      </div>

      {/* Input box */}
      <div className="mt-4 flex gap-2">
        <textarea
          className="flex-1 p-2 border rounded resize-none min-h-[40px] max-h-[120px]"
          placeholder="Type a message..."
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={handleKeyPress}
        />
        <button
          className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
          onClick={handleSend}
          disabled={!newMessage.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}

export default Chat
