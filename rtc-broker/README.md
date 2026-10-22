# Convo RTC credential broker

This small Convo-specific service exchanges a mutually authenticated BRC-103
request for short-lived managed TURN credentials. It never handles call media,
signaling, conversation identifiers, or group membership.

Required runtime secrets are `SERVER_PRIVATE_KEY`, `TWILIO_ACCOUNT_SID`, and
`TWILIO_AUTH_TOKEN`. The default credential lifetime is one hour; the client
refreshes managed credentials before an ICE restart. Deploy a
single Cloud Run instance because the BRC-103 session manager is process-local.


The runtime image pins Node 22.23.4 and its immutable base digest. CI builds
the Linux/amd64 recipe and verifies the native interpreter and Brotli without
production credentials. Source merge does not deploy this Cloud Run broker;
its existing service identity, secret references, BRC-103 policy, CORS,
provider limits and traffic promotion must be preserved by the owning release.
