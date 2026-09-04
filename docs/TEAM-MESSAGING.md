# Team messaging and store-and-forward delivery

Convo's workspace supports direct conversations and private groups, with unread
filters and local previews, date and sender grouping, quoted replies, reactions,
mentions (`@`), safe links and code formatting. Draft text, attachments, and reply
context survive conversation switches within the current app session. Drafts are
not uploaded; refreshing or closing the app discards unsent drafts. Enter sends,
Shift+Enter inserts a line, and IME composition never sends a message. Files can
be selected, pasted, or dropped on the composer (20 files, 25 MB each).

Earlier messages load as you scroll up, preserving the visible position. Pagination is distinct from a failed fetch; only failed fetches show a retry action. Text messages with an empty attachment list are valid. Startup uses one central loading indicator and static rail placeholders. A new-message button
returns to the latest messages. Reading state is private to this device; it is
not a network read receipt. `Forwarded` means MessageBox accepted the event,
while `History saved` means durable storage completed. Neither means a human has
read it. Calls retain their existing behavior and are outside this release.

## Queue ownership

MessageBox is temporary delivery infrastructure. GlobalKVStore stores encrypted
history; wallet-private storage holds conversation keys and invitation decisions.
A recipient's encrypted browser journal bridges delivery and chain reconciliation:

1. Authenticate the transport sender and validate/decrypt the epoch envelope.
2. Save valid events in the encrypted local journal before acknowledging them.
3. Acknowledge up to 100 transport IDs in one request. A failed acknowledgment
   remains retryable, including when the message was already projected locally.
4. Fetch the next page only after acknowledging the prior page; each drain yields
   after ten batches. The SDK is explicitly limited to 100 rows and 100-row
   pages. `maxPages: 2` permits its limit check on the next loop iteration when
   `hasMore` is true, without accumulating another full page.
5. Reconcile exact event digests with durable history before pruning journal
   entries. Unread state remains encrypted locally after journal compaction.

The open conversation handles live traffic and polls every 30 seconds. Background
scans drain unopened direct/group chats, archived chats, and known retired epoch
boxes, excluding the current open room. Closed epochs accept only committed
history. Background chain reconciliation rotates through three pending journals
per scan. Unknown conversations remain discoverable through invitations.

Invitation and membership controls are saved in the encrypted wallet-private
inbox before acknowledgment; accept/decline acts on that saved copy. Invalid
private-room payloads can be discarded. The MessageBox SDK's wallet-decryption
error sentinel is explicitly retained for permission recovery. Storage failures
never authorize deletion of the only forwarded copy.

The encrypted sender outbox records acceptance separately for each recipient and
uses a stable, secret-derived message ID per event/recipient. Initial live sends
and post-save retries share one operation; retries skip accepted recipients,
including after restart. An unopened sender conversation can forward via HTTP.
Confirmed chain writes are not repeated after a transport-only failure. Typing
and heartbeat traffic targets only recently observed online peers; initial join
announcements discover peers, without indefinitely filling offline inboxes.

## Validation and limits

Run `npm run verify`. Regression tests cover multi-page draining, transient ACK
failure, local quota failure, socket/poll concurrency, unopened direct and retired
epoch inboxes, persistent encrypted receipt state, and composer interactions.

The recipient journal is origin-local browser storage. A full disk or blocked
storage pauses acceptance and leaves messages queued on MessageBox. Clearing
browser data removes unconfirmed local recovery copies and drafts; durable
history remains recoverable using the wallet. This is not a server retention TTL:
clients must run to drain their inboxes, and previously released clients must
refresh to use the new behavior. The release does not change MessageBox server
retention policy, replace the cryptographic protocol, or constitute an independent
security audit.

For a live store-and-forward smoke check using temporary, isolated test wallets,
run `node frontend/validate-live-messagebox.mjs`. It sends three encrypted test
messages to the production MessageBox, acknowledges the batch, verifies an empty
queue, and attempts cleanup in a finally block. It never uses team conversations.

CARS release tooling is pinned to 1.2.33, which waits for accepted asynchronous
releases. Pull requests verify and build without running release authentication;
master retains the established verification/build and optional scoped-key deploy.
