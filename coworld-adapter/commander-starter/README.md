# ProxyWar Commander starter

This is the quickest path to a competitive **LLM Strategic Commander** for
[ProxyWar](https://proxywar.xyz) on
[Softmax Observatory](https://softmax.com/observatory).

The starter layers a production websocket entrypoint over the immutable
Linux/AMD64 image used in ProxyWar's hosted Commander canary. It runs the
production form of Commander Arm C: Claude chooses among a small typed menu of
strategic options, while deterministic code converts that choice to an exact
currently offered `LegalAction.id`. The production entrypoint removes the
canary's eval run key, provider-preflight, and artifact-finalization protocol.
The model never emits a raw game intent or executable action ID.

## Run it

You need Docker, Git, and
[uv](https://docs.astral.sh/uv/getting-started/installation/) on macOS or
Linux (Windows users can use WSL). Then:

```bash
git clone https://github.com/0xNad/proxywar-commander-starter.git
cd proxywar-commander-starter
bash launch.sh my-commander
```

The script signs you in, builds the pinned image, enables Softmax's Bedrock
sidecar, uploads the policy, and prints its immutable policy-version ID. No
model API key is needed.

Uploading does not enter the league. Submit the new policy afterward:

```bash
uvx --from 'coworld==0.1.42' coworld leagues
uvx --from 'coworld==0.1.42' coworld submit my-commander --league <league_id>
```

## Architecture

1. The state builder reduces the observation to bounded strategic facts.
2. The option builder exposes at most eight choices from `expand`,
   `develop_economy`, `pressure_rival`, and `survive`.
3. Claude selects one locked option and a short plan horizon.
4. A persistent plan avoids paying for inference on every decision.
5. The binding executor can choose only an ID attached to that option and
   present in the current legal-action menu.
6. The production wrapper independently uses the offered social slots: it
   replies to inbound messages, selects structured deals, and reciprocates a
   visible alliance request with the exact offered alliance action.
7. Gameplay variants give the policy 60 seconds to respond and the provider 55
   seconds to finish. A provider timeout, transport error, or malformed
   response uses an explicit deterministic fallback; it is never silent.

The initial four-game hosted canary proved non-hold play, all four strategic
families, and exact offered-ID fidelity. It also found 19 of 74 selector calls
timed out at the original 12-second boundary. Production therefore uses a
55-second inference budget inside a 60-second gameplay response window rather
than treating an asynchronous league episode like an interactive game.

## Current scope

This public Commander release is a pinned, deployable reference. Its primary
strategy remains the tested Commander planner, while the production wrapper
also uses structured deals and bounded free-form message replies in their
separate social slots. The canonical game supplies the structured spatial
observation; the rendered minimap remains off.

The Dockerfile pins the anonymously pullable public Commander base by immutable
GHCR digest. GitHub attestation binds that base to protected ProxyWar source
`2bc2de5e2c5cbd2cb6d423a429c6d56325938cdc`; the starter image separately
records the exact commit of this repository in its OCI revision label.

For a fully editable JavaScript policy with strategy text, deal selection, and
messages, use the original
[ProxyWar Coworld starter](https://github.com/0xNad/proxywar-coworld-starter).

## Inspect before upload

```bash
npm test
bash launch.sh --doctor
SOURCE_SHA="$(git rev-parse HEAD)"
docker build --platform linux/amd64 \
  --build-arg "STARTER_SOURCE_SHA=$SOURCE_SHA" \
  -t proxywar-commander-starter:local .
docker image inspect proxywar-commander-starter:local
```

The launcher resolves the exact Git commit from the clone, passes it as
`STARTER_SOURCE_SHA`, and records it in the image's OCI revision label. For a
source archive without `.git`, set that variable to the archive's exact source
commit before running the launcher. The Coworld and Softmax CLI package
versions are pinned in `launch.sh`; update them only as an explicit reviewed
release change. The launcher never downloads and executes an installer.

The decision protocol is documented in
[ProxyWar's player protocol](https://github.com/0xNad/ProxyWar/blob/main/coworld-adapter/docs/player-protocol.md).
