# Convo private protocol v2

## Scope

Version 2 is a new protocol with no v1 reader, data migration, or compatibility mode. A wallet with no v2 private index sees an empty Convo account.

## Secret state

Each wallet stores a `ConversationSecret` in wallet-encrypted `LocalKVStore` context `convo private v2`. The private index contains opaque 32-byte conversation IDs. Each secret contains the local title, conversation type, preferences, and one or more membership epochs.

An epoch contains:

- a monotonically increasing number;
- a random 256-bit root key;
- current member and administrator identity keys;
- its activation time; and
- once superseded, a local digest map for every accepted event plus its aggregate history commitment.

The secret record is written before its ID is added to the private index. Exact invitation and membership envelopes remain in that wallet-private record until their encrypted MessageBox sends succeed, so retries never generate divergent keys. Incoming control messages are acknowledged only after the secret is persisted and at least one encrypted page read has succeeded.

## Invitations and key rotation

The creator uses CurvePoint with wallet protocol `[2, "Convo Messenger"]` and key ID `<conversationId>:<epoch>` to seal the epoch root key to every member. The resulting header and ciphertext are serialized as one envelope. That envelope, private title, roster, roles, and epoch metadata are carried only in the recipient’s encrypted `convo-v2-invites` MessageBox.

Rotation messages carry only a constant-size SHA-256 history commitment and event count—not the full digest map. Each continuing member loads the complete prior epoch, independently reconstructs that commitment, and stores its detailed closure only in wallet-private state. Rotation envelope size therefore does not grow with conversation history.

For a roster change, an administrator:

1. loads the complete prior epoch;
2. commits every accepted prior event ID and digest;
3. creates a fresh random root key and secret-derived namespace;
4. writes the membership event under the new epoch;
5. sends current members a private membership envelope; and
6. sends newly added members an invitation containing only the current epoch.

Removed members receive nothing. Newly added members have no prior epoch key and therefore receive no history. Current members reject old-epoch events absent from the closure or whose digest changed. Existing members independently verify that a received closure commits their complete accepted history before storing the new epoch.

## GlobalKVStore layout

Every value is independently owned by its writer. For root key `K`, member identity `I`, page `P`, and domain string `convo:v2`:

```text
manifest locator = HMAC-SHA256(K, "convo:v2:locator:manifest:" + I)
page locator     = HMAC-SHA256(K, "convo:v2:locator:page:" + I + ":" + P)
content key      = HMAC-SHA256(K, "convo:v2:content:" + purpose)
live box         = "convo-v2-" + HMAC-SHA256(K, "convo:v2:locator:live:" + recipient)[0:40]
```

Manifests are padded to 512-byte plaintext blocks. Pages are padded to 1,024-byte plaintext blocks and roll at 32 events or 24,000 plaintext bytes. Each page is encrypted with its purpose-specific symmetric key. Reads always specify both locator and expected controller; there is no global scan, public thread query, or latest-messages endpoint.

The client verifies decrypted page scope, writer identity, epoch number, conversation ID, event shape, event size, and any closed-epoch digest before materialization.

## Events

The append log supports message, edit, delete, reaction, private metadata, and membership events. Event IDs make append retries idempotent. Materialization sorts by creation time and ID, deduplicates IDs, limits edits to the original sender, and limits deletion to the original sender or an epoch administrator.

## Delivery and recovery

Before a global write, the event is purpose-encrypted in a local durable outbox. State advances through `queued`, `writing`, `confirmed`, and `notified`. A retry may safely append the same ID again. Failed invitation and membership sends retain their exact wallet-private envelopes and retry at startup, on subsequent mutations, and during periodic synchronization.

Writes are serialized per conversation/epoch/writer using the Web Locks API with an in-process fallback. On a wallet `WERR_REVIEW_ACTIONS` double-spend, Convo reads the current encrypted value. It accepts a matching winner or retries with bounded delay; logs contain only stable error/status names, never competing transactions.

MessageBox live notifications carry complete conversation events, presence, typing, reconciliation requests, and targeted call signaling inside recipient-specific encrypted boxes. The outer envelope is padded and exposes none of the conversation ID, epoch, event, call metadata, SDP, sender roster, or recipient roster. GlobalKVStore remains authoritative. If the socket is unavailable, Convo drains the box over HTTP every 30 seconds and reconciles durable state independently.

## Realtime calls

Call offer, answer, ICE candidate, ringing, decline, busy, and hang-up signals use the same encrypted recipient-specific live transport. Signal validation binds the exact recipient, active membership epoch, call ID, bounded expiry, and payload shape before WebRTC sees the data.

Each call creates one ordered WebRTC data channel implementing the SDK `Transport` contract. A BRC-103 `Peer` handshake then proves the expected Metanet identity and exchanges signed control messages containing the exact call ID and conversation ID. Microphone and camera tracks are attached disabled and remain disabled until that handshake succeeds. DTLS-SRTP protects media end to end; TURN relays encrypted packets only.

The frontend requests short-lived managed STUN/TURN configuration through BRC-103 AuthFetch. The credential broker rate-limits authenticated identities, permits only configured browser origins, returns no provider errors or long-term secret, and does not receive signaling or media. Direct Cloudflare and Google STUN remain a degraded fallback. One ICE restart is allowed after a ten-second disconnect grace, with fresh managed credentials fetched first.

## Attachments

Files are limited to 25 MB. Their bytes are length-prefixed, padded into power-of-two size classes starting at 4 KiB, encrypted with a key derived from the epoch root and random attachment ID, and only then uploaded. Download verifies the declared limit, decrypted length, and SHA-256 digest before returning a Blob.
