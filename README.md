# Convo Messenger

Convo is a wallet-native, end-to-end encrypted messenger for direct and group conversations. Version 2 is a clean protocol replacement: it does not read or migrate Convo v1 data and it has no application-specific public indexer.

## Privacy architecture

- A fresh random root key defines each membership epoch.
- CurvePoint seals that key to the epoch members. The CurvePoint header is sent only inside an encrypted MessageBox invitation or membership update; it is never written as a public Convo record.
- Wallet-encrypted `LocalKVStore` keeps conversation IDs, titles, rosters, epoch keys, preferences, and the private conversation index.
- `GlobalKVStore` holds one immutable encrypted token per event. Event locators, per-writer query tags, and live MessageBox names are HMAC-derived from the secret epoch key; original paged records remain readable but receive no new writes.
- Global values are padded before symmetric encryption. The public overlay sees a member controller updating an opaque random-looking key, but receives no explicit conversation ID, title, roster, recipient, sender/thread relationship, or message content.
- Membership changes rotate the root key and commit the prior epoch event set. Removed members cannot locate new event tokens, decrypt the new epoch, or inject altered events into the accepted historical view.
- Attachments are encrypted locally before NanoStore upload; names, MIME types, digests, and handles remain inside encrypted message events.
- Encrypted durable outboxes make event writes and exact invitation/membership envelopes retryable. GlobalKVStore double-spend conflicts use native fresh-token recovery plus bounded indexed readback/final verification. Immutable event tokens make retries idempotent without overwriting a sibling event, and control envelopes are withheld until their roster event is durable.
- Recipient-specific encrypted MessageBox rooms carry immediate messages, presence, typing, and call signaling while GlobalKVStore remains the durable source of truth.
- Voice and video meetings use a bounded WebRTC mesh (up to eight participants) with managed TURN fallback. Every peer association performs an independent BRC-103 handshake that binds DTLS to the expected Metanet identity, exact meeting, and exact conversation before its private outbound track clones are enabled.
- Public identity certificates are resolved lazily and cached for visible participant display, with abbreviated identity keys used only when no public name is available. Incoming audio and video meetings use distinct locally synthesized Convo ringtones.

The exact wire format and security assumptions are documented in [docs/protocol-v2.md](docs/protocol-v2.md) and [docs/threat-model.md](docs/threat-model.md).

## Development

Requirements: Node.js 22 or newer and Metanet Client for an interactive wallet session.

```bash
npm ci
npm --prefix frontend ci
npm run verify
npm run frontend:dev
```

The frontend runs at `http://localhost:5173`. Unit and integration tests use in-memory private/global stores plus real `CompletedProtoWallet` CurvePoint encryption.

## Deployment

`deployment-info.json` defines a frontend-only CARS project. Pushes to `master` run lint, all tests, a production build, CARS diagnostics, balance checks, and a release. The retired `tm_convo` and `ls_convo` services are not part of the artifact.

The app-specific `rtc-broker` is deployed separately as a single-instance managed service. It requires BRC-103 AuthFetch, returns only short-lived managed ICE credentials, and never receives call media, SDP, conversation identifiers, or group membership. Twilio credentials and the broker wallet key must remain runtime secrets.

## License

Open BSV License. See `LICENSE.txt`.
