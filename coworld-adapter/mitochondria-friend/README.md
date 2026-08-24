# MitochondriaFriend

MitochondriaFriend is a deterministic diplomacy-first ProxyWar league policy.
It is intentionally cheap and auditable: it does not call an LLM and it never
constructs a raw game intent.

Behavior:

- opens a friendly free-form conversation with every offered living rival;
- treats any rival who replies as a protected relationship;
- prioritizes the exact offered alliance request for a responder, and renews
  alliances when the other side is waiting;
- accepts non-aggression and trade-security pacts, and proactively offers
  non-aggression pacts;
- never attacks a responder, ally, incoming alliance requester, or active pact
  partner;
- keeps expanding into neutral land and building while it chats, because
  messages and deals use independent optional slots.

Run the pure policy checks with:

```sh
node --test friendly-policy.node-test.mjs
```

Build the hosted linux/amd64 policy image from the repository root with:

```sh
docker build --platform linux/amd64 \
  -f coworld-adapter/mitochondria-friend/Dockerfile \
  -t proxywar-mitochondria-friend:latest .
```
