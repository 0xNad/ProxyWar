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

The direct runtime dependency, npm lockfile, and Node base image are pinned.
Keep all three pins intact when changing the policy so a reviewed source tree
continues to produce the same dependency graph and base image.

Build the hosted linux/amd64 policy image from the repository root with:

```sh
docker build --platform linux/amd64 \
  -f coworld-adapter/mitochondria-friend/Dockerfile \
  -t proxywar-mitochondria-friend:local .
```
