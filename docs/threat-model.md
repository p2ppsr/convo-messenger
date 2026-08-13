# Convo v2 threat model

## Security goals

Convo protects message content, attachment content and metadata, conversation titles and IDs, explicit membership rosters, administrator roles, reply/reaction relationships, and the link between per-member storage locations from observers of the public overlay. It provides forward exclusion: a removed member cannot discover or decrypt later epochs. Accepted historical events are committed when an epoch closes.

## Trust boundaries

- Metanet Client is trusted to authenticate the user, protect wallet keys, and implement wallet encryption correctly.
- CurvePoint is trusted to seal an epoch key only to the named identity keys.
- GlobalKVStore and its overlay are untrusted for confidentiality, ordering, availability, and integrity. Confidentiality and validation are enforced client-side.
- MessageBox and NanoStore are untrusted for confidentiality and availability. Payloads are encrypted before use.
- Managed STUN/TURN and the Convo credential broker are untrusted for media confidentiality. WebRTC DTLS-SRTP protects media; the broker receives only the caller's authenticated BRC-103 identity and returns short-lived ICE credentials.
- Current group members are authorized to read the current epoch and append events as themselves. Administrators are authorized to change membership and private metadata.

## Defended attacks

- A public crawler cannot enumerate Convo conversations because there is no Convo lookup service and locators require an epoch secret.
- Stored values reveal neither plaintext nor the exact length of small payloads because values are encrypted and block padded.
- A member cannot impersonate another writer inside a page; decrypted events must match the page controller.
- Replayed writes deduplicate by event ID.
- A removed member’s later old-key insertion or modification is excluded by the prior-epoch digest commitment distributed under the new epoch.
- An unauthorized wallet cannot decrypt the CurvePoint epoch envelope.
- Concurrent GlobalKVStore spends are read back and retried without leaking transaction details into application logs.
- A failed live socket does not lose durable messages because recipients poll and senders retain encrypted outbox state. Failed invitations and rotations retain their exact envelopes in wallet-private storage for retry.
- A signaling-box observer cannot read call participants, media type, SDP, candidates, or call identifiers because targeted signals are epoch-encrypted and padded.
- A signaling attacker cannot enable local camera or microphone media: every peer receives its own cloned tracks, which remain disabled until BRC-103 proves that expected member identity and binds the exact meeting and conversation over the WebRTC data channel.
- Long-term TURN credentials are never shipped to the browser. The broker requires wallet mutual authentication, applies bounded CORS and issuance limits, and returns expiring credentials from a dedicated secret-scoped runtime identity.

## Residual metadata and limitations

The BSV transaction and GlobalKVStore token still expose the controller identity that paid for an individual opaque write, transaction timing, value size class, and network-level metadata. NanoStore can expose an encrypted attachment's power-of-two size class. An observer may make timing or traffic-analysis guesses, especially when several known identities transact close together, but the records contain no explicit roster or shared public locator that proves group membership.

Current members necessarily know the current roster. A malicious current member may copy plaintext or epoch keys outside Convo. End-to-end encryption cannot prevent endpoint compromise, screenshots, social engineering, or a wallet approving a hostile application.

Availability depends on wallet, overlay, MessageBox, NanoStore, and network availability. Outbox retry and HTTP fallback improve recovery but cannot guarantee service during an indefinite outage. Local browser storage holds only encrypted outbox payloads, but deletion of browser and wallet-private state can make a conversation undiscoverable.

Presence is intentionally visible to current conversation members while a conversation is open; it is not a global availability directory. Public certificate names are display-only and never replace identity-key verification. MessageBox and the TURN provider can still observe network addresses, timing, traffic volume, and encrypted packet sizes. The broker can observe the requesting wallet identity and issuance timing. TURN credentials are bearer credentials until expiry, so broker authentication, rate limits, provider spend monitoring, and timely credential rotation remain operational controls. A full mesh is intentionally capped at eight participants to bound upload bandwidth, peer count, and TURN cost; larger meetings require a separately reviewed SFU design.

Membership rotation establishes a serialization boundary. Events racing the administrator’s full-history snapshot may be omitted from the accepted closed epoch and should be resent in the new epoch. Convo blocks rotation when history is incomplete.

Newly added members deliberately receive no earlier keys or history. There is no v1 import path.

## Operational requirements

- Keep `@bsv/sdk`, CurvePoint, MessageBox client, and CARS dependencies pinned through lockfiles and review security advisories before release.
- Deploy from CI after `npm run verify`; do not reintroduce `tm_convo`, `ls_convo`, broad overlay scans, or public CurvePoint headers.
- Treat a MessageBox outage as a degraded state, not permission to publish invitation metadata elsewhere.
- Test membership removal, outbox recovery, websocket fallback, public-record leakage, deterministic mesh formation, per-peer pre-auth media suppression, exact meeting binding, participant departure, and managed-relay failure for every protocol change.
