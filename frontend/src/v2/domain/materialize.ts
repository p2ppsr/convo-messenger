import type {
  ConversationEvent,
  ConversationSecret,
  ConversationView,
  MaterializedMessage,
} from './types'

export function sortAndDedupeEvents(events: ConversationEvent[]): ConversationEvent[] {
  const unique = new Map<string, ConversationEvent>()
  const conflicted = new Set<string>()
  for (const event of events) {
    if (conflicted.has(event.id)) continue
    const existing = unique.get(event.id)
    if (!existing) unique.set(event.id, event)
    else if (JSON.stringify(existing) !== JSON.stringify(event)) {
      unique.delete(event.id)
      conflicted.add(event.id)
    }
  }
  return [...unique.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export function materializeConversation(
  secret: ConversationSecret,
  events: ConversationEvent[],
  partial = false,
  loadedPages = 0,
): ConversationView {
  const messages = new Map<string, MaterializedMessage>()
  let title = secret.title

  for (const event of sortAndDedupeEvents(events)) {
    if (event.type === 'message') {
      messages.set(event.id, {
        id: event.id,
        sender: event.sender,
        body: event.body,
        createdAt: event.createdAt,
        epoch: event.epoch,
        replyTo: event.replyTo,
        attachments: event.attachments ?? [],
        attachmentKey: event.attachmentKey,
        reactions: [],
        edited: false,
      })
    } else if (event.type === 'edit') {
      const target = messages.get(event.targetId)
      if (target && target.sender === event.sender) {
        target.body = event.body
        target.edited = true
      }
    } else if (event.type === 'delete') {
      const target = messages.get(event.targetId)
      const eventEpoch = secret.epochs.find((epoch) => epoch.epoch === event.epoch)
      if (target && (target.sender === event.sender || eventEpoch?.admins.includes(event.sender))) {
        messages.delete(event.targetId)
      }
    } else if (event.type === 'reaction') {
      const target = messages.get(event.targetId)
      if (!target) continue
      target.reactions = target.reactions.filter((reaction) => reaction.sender !== event.sender || reaction.emoji !== event.emoji)
      if (!event.removed) target.reactions.push({ sender: event.sender, emoji: event.emoji })
    } else if (event.type === 'metadata' && event.title && secret.epochs.find((epoch) => epoch.epoch === event.epoch)?.admins.includes(event.sender)) {
      title = event.title
    }
  }

  const current = secret.epochs.find((epoch) => epoch.epoch === secret.currentEpoch)
  if (!current) throw new Error('Conversation has no current epoch')
  return {
    title,
    members: current.members,
    admins: current.admins,
    messages: [...messages.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    partial,
    loadedPages,
  }
}

/**
 * Apply one validated socket event to the rendered view immediately. The
 * durable overlay later returns the same event ID, at which point a normal
 * reload replaces this optimistic projection without duplicating anything.
 */
export function applyConversationEvent(
  view: ConversationView,
  secret: ConversationSecret,
  event: ConversationEvent,
): ConversationView {
  if (event.conversationId !== secret.conversationId) return view
  const epoch = secret.epochs.find((candidate) => candidate.epoch === event.epoch)
  if (!epoch || !epoch.members.includes(event.sender)) return view
  const messages = view.messages.map((message) => ({
    ...message,
    attachments: [...message.attachments],
    reactions: [...message.reactions],
  }))
  const targetIndex = 'targetId' in event ? messages.findIndex((message) => message.id === event.targetId) : -1

  if (event.type === 'message') {
    if (messages.some((message) => message.id === event.id)) return view
    messages.push({
      id: event.id,
      sender: event.sender,
      body: event.body,
      createdAt: event.createdAt,
      epoch: event.epoch,
      replyTo: event.replyTo,
      attachments: event.attachments ?? [],
      attachmentKey: event.attachmentKey,
      reactions: [],
      edited: false,
    })
  } else if (event.type === 'edit' && targetIndex >= 0 && messages[targetIndex].sender === event.sender) {
    messages[targetIndex] = { ...messages[targetIndex], body: event.body, edited: true }
  } else if (event.type === 'delete' && targetIndex >= 0
    && (messages[targetIndex].sender === event.sender || epoch.admins.includes(event.sender))) {
    messages.splice(targetIndex, 1)
  } else if (event.type === 'reaction' && targetIndex >= 0) {
    const target = messages[targetIndex]
    const reactions = target.reactions.filter((reaction) => reaction.sender !== event.sender || reaction.emoji !== event.emoji)
    if (!event.removed) reactions.push({ sender: event.sender, emoji: event.emoji })
    messages[targetIndex] = { ...target, reactions }
  }

  const title = event.type === 'metadata' && event.title && epoch.admins.includes(event.sender)
    ? event.title
    : view.title
  return {
    ...view,
    title,
    members: event.type === 'membership' ? [...event.members] : view.members,
    admins: event.type === 'membership' ? [...event.admins] : view.admins,
    messages: messages.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
  }
}
