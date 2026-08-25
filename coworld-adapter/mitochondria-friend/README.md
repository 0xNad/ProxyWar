# MitochondriaFriend

MitochondriaFriend is an LLM-powered diplomacy-first ProxyWar league policy.
Claude Sonnet's Strategic Commander chooses its ordinary primary gameplay with
the diplomatic strategy profile. A deterministic relationship layer still
keeps explicit promises, filters attacks against responders/allies/pact
partners, and owns the independent message and deal slots. It never constructs
or emits a raw game intent.

Behavior:

- opens a friendly free-form conversation with every offered living rival;
- treats any rival who replies as a protected relationship;
- prioritizes the exact offered alliance request for a responder, and renews
  alliances when the other side is waiting;
- accepts non-aggression and trade-security pacts, and proactively offers
  non-aggression pacts;
- never attacks a responder, ally, incoming alliance requester, or active pact
  partner;
- lets the LLM Commander decide how to expand, build, defend, and pressure
  unprotected rivals while it chats, because messages and deals use independent
  optional slots.

Run the pure policy checks with:

```sh
npm ci --ignore-scripts
npm test
```

The direct runtime dependency and npm lockfile are pinned for local checks. The
hosted image uses Coworld's immutable, digest-pinned Cogames base and requires
an exact 40- or 64-character source digest in its OCI revision label. Keep all
of those pins intact when changing the policy.

Build the hosted linux/amd64 policy image from the repository root with:

```sh
docker build --platform linux/amd64 \
  --build-arg "MITO_SOURCE_SHA=<exact-source-sha>" \
  -f coworld-adapter/mitochondria-friend/Dockerfile \
  -t proxywar-mitochondria-friend:local \
  .
```
