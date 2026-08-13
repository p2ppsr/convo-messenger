# Convo v2 implementation plan and status

Convo v2 is a clean replacement. There is no v1 reader, migration, compatibility mode, or application-specific public lookup service.

## Completed work

1. **Private discovery and group secrets** — wallet-encrypted LocalKVStore holds the conversation index, title, roster, roles, preferences, epoch roots, accepted history closures, and pending control deliveries.
2. **Unlinkable public storage** — per-event immutable GlobalKVStore tokens use HMAC-derived locators and per-writer query tags plus purpose-derived keys, encryption, padding, controller validation, and bounded reads. The original paged layout is read-only. CurvePoint headers never enter public records.
3. **Membership and delivery** — CurvePoint envelopes travel only through encrypted MessageBox control messages. Every roster mutation rotates the root, excludes removed members, gives new members no history, and uses a constant-size history commitment verified by continuing members. Event and control outboxes retry exact encrypted payloads.
4. **Reliable synchronization** — Web Locks serialize event and roster mutations, SDK double-spend recovery is production-name-safe, bounded indexed readback includes final verification, immutable event IDs make retries non-destructive, control envelopes wait for durable prerequisite events, live notification boxes are secret-derived per recipient, and a 30-second durable poll backs up sockets.
5. **Client-side attachments** — files are size-bounded, length-prefixed, power-of-two padded, encrypted before NanoStore upload, and integrity checked after download.
6. **Application rebuild** — the oversized v1 component set, Mongo/Express overlay backend, old deployment assets, and public message scans were removed. The replacement UI supports direct/group creation, identity-first DM labels and certified avatars, separate direct/group navigation, wallet-private archive/favorite/mute controls, local decrypted-message search, canonical member mentions, private identity search, messages, edits, deletes, reactions, files, membership administration, invitation review, offline state, and responsive navigation.
7. **Release path** — the CARS project is frontend-only. CI installs from lockfiles, runs lint/tests/production build, packages the artifact, checks CARS health/balance, and releases from `master` with bounded retries.

## Completed evaluation

- Static checks: ESLint and TypeScript production compilation pass.
- Automated checks cover CurvePoint member/non-member access, encrypted padding and locator separation, GlobalKV public leakage, multi-writer reads, immutable sibling-event isolation, removed-member exclusion, constant-size membership commitments, multi-member add/remove rotation, duplicate-save idempotency, prerequisite control gating, encrypted event outbox recovery, indexed write-conflict recovery, input limits, event authorization/materialization, and explicit startup loading state.
- Supply chain: both npm dependency trees report zero known vulnerabilities.
- Packaging: the final 256 KiB CARS archive contains only frontend runtime assets and deployment manifests; it contains no backend, source maps, v1 assets, or secrets.
- Interactive wallet evaluation: Metanet Client authenticated the local app, opened an empty v2 account without scanning v1, and rendered the new desktop conversation shell, control inbox, and creation dialog with no browser console errors. No message, transaction, invitation, or deployment was submitted during evaluation.

## Publication and live validation

The implementation is intentionally left in its isolated application worktree. Publishing commits, pushing the application branch, releasing CARS, and updating the network-ops deployment dossier require explicit operator authorization. After publication, validate the deployed URL with two or more controlled wallets, including invite acceptance, multi-writer messaging, forced socket fallback, an interrupted control send, a member add/remove rotation, attachment upload/download, and public transaction inspection for traffic-only metadata.
