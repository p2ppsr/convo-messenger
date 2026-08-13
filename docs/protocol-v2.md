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

The secret record is written before its ID is added to the private index. Exact invitation and membership envelopes remain in that wallet-private record until their encrypted MessageBox sends succeed, so retries never generate divergent keys. A control envelope records the local event it depends upon and is not transmitted until that immutable event is confirmed in GlobalKVStore. Incoming control messages are acknowledged only after the secret is persisted and an encrypted event read has succeeded.

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

Every value is independently owned by its writer. For root key `K`, member identity `I`, event ID `E`, and domain string `convo:v2`:

```text
event tag        = HMAC-SHA256(K, "convo:v2:locator:events:" + I)
event locator    = HMAC-SHA256(K, "convo:v2:locator:event:" + I + ":" + E)
content key      = HMAC-SHA256(K, "convo:v2:content:" + purpose)
live box         = "convo-v2-" + HMAC-SHA256(K, "convo:v2:locator:live:" + recipient)[0:40]
```

Each event is padded to a 1,024-byte plaintext block and encrypted with its purpose-specific symmetric key. Readers query a secret-derived tag together with the expected controller and validate that every decrypted event ID reproduces its opaque locator. Tags paginate in bounded batches; there is no global scan, public thread query, or latest-messages endpoint. The former per-writer manifest/page layout remains read-only so events written immediately before this change are still visible.

The client verifies the event locator, query controller, writer identity, epoch number, conversation ID, event shape, event size, and any closed-epoch digest before materialization.

## Events

The append log supports message, edit, delete, reaction, private metadata, and membership events. Event IDs make append retries idempotent. Materialization sorts by creation time and ID, deduplicates IDs, limits edits to the original sender, and limits deletion to the original sender or an epoch administrator.

## Delivery and recovery

Before a global write, the event is purpose-encrypted in a local durable outbox. State advances through `queued`, `writing`, `confirmed`, and `notified`. A retry uses the same event ID and locator, decrypts any indexed winner, and accepts it only when the complete event digest matches, so randomized encryption remains semantically idempotent without another spend. Failed invitation and membership sends retain their exact wallet-private envelopes and retry at startup, on subsequent mutations, and during periodic synchronization; prerequisite gating prevents a recipient from learning an epoch whose membership event has not become durable.

Writes are serialized per conversation/epoch/writer and membership mutations are serialized per conversation using the Web Locks API with in-process fallbacks. The production build preserves wallet error class names so the SDK can rebroadcast the competing BEEF, query the fresh token, and retry natively. Convo then waits for overlay indexing, accepts an identical indexed winner, retries with bounded delay, and performs a final delayed verification. Logs contain only stable error/status names, never competing transactions. Because different events never update the same token, a retry cannot replace an unrelated winning event.

MessageBox live notifications carry complete conversation events, presence, typing, reconciliation requests, and targeted call signaling inside recipient-specific encrypted boxes. The outer envelope is padded and exposes none of the conversation ID, epoch, event, call metadata, SDP, sender roster, or recipient roster. GlobalKVStore remains authoritative. If the socket is unavailable, Convo drains the box over HTTP every 30 seconds and reconciles durable state independently.

## Realtime meetings

Meeting invite, join/readiness, offer, answer, ICE candidate, media-state, ringing, decline, busy, and leave signals use the same encrypted recipient-specific live transport. The encrypted invite contains only the selected meeting roster, capped at eight participants. Signal validation binds the exact recipient, active membership epoch, meeting ID, bounded expiry, roster membership, and payload shape before WebRTC sees the data. No meeting ID, roster, SDP, candidate, device state, or media type is present in the outer MessageBox envelope.

Each participant pair deterministically elects one offerer, preventing SDP glare while building a small-group full mesh. Each connection creates one ordered WebRTC data channel implementing the SDK `Transport` contract. A BRC-103 `Peer` handshake proves the expected Metanet identity and exchanges signed control messages containing the exact meeting ID and conversation ID. The local capture stream is cloned separately for every peer; each outbound clone remains disabled until that peer's handshake succeeds. This prevents an authenticated participant from implicitly authenticating another participant's media path. DTLS-SRTP protects media end to end; TURN relays encrypted packets only.

The frontend requests short-lived managed STUN/TURN configuration through BRC-103 AuthFetch and reuses the result within one meeting. The credential broker rate-limits authenticated identities, permits only configured browser origins, returns no provider errors or long-term secret, and does not receive signaling or media. Direct Cloudflare and Google STUN remain a degraded fallback. Every deterministic offerer can perform one ICE restart after a ten-second disconnect grace, with fresh managed credentials fetched first. One failed peer link does not end a group meeting.

Public display names are best-effort UI metadata resolved lazily from public identity certificates only for visible message senders, online or calling participants, and a roster the user explicitly opens. Results are cached per wallet session and never become part of the encrypted conversation state or meeting trust decision; the BRC-103 identity key remains authoritative. This avoids correlating a complete private roster through an eager burst of certificate queries. Audio and video invitations use distinct Web Audio ringtones synthesized locally, so no third-party sound request or tracking surface is introduced.

## Attachments

Files are limited to 25 MB. Their bytes are length-prefixed, padded into power-of-two size classes starting at 4 KiB, encrypted with a key derived from the epoch root and random attachment ID, and only then uploaded. Download verifies the declared limit, decrypted length, and SHA-256 digest before returning a Blob.
