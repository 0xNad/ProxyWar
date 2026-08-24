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

You need Docker on macOS or Linux (Windows users can use WSL). Then:

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
uvx --from coworld coworld leagues
uvx --from coworld coworld submit my-commander --league <league_id>
```

## Architecture

1. The state builder reduces the observation to bounded strategic facts.
2. The option builder exposes at most eight choices from `expand`,
   `develop_economy`, `pressure_rival`, and `survive`.
3. Claude selects one locked option and a short plan horizon.
4. A persistent plan avoids paying for inference on every decision.
5. The binding executor can choose only an ID attached to that option and
   present in the current legal-action menu.
6. A provider timeout, transport error, or malformed response uses an explicit
   deterministic fallback; it is never silent.

The initial four-game hosted canary proved non-hold play, all four strategic
families, and exact offered-ID fidelity. It also found 19 of 74 selector calls
timed out at the 12-second boundary. The fallback kept every game functional,
but this is a real reliability cost rather than a hidden success.

## Current scope

This first public Commander release is a pinned, deployable reference. It does
not send structured deals or free-form messages, and its spatial observation
flags remain off. Those omissions are deliberate: the hosted Commander test
isolated primary strategic play, so enabling additional treatment bytes here
would create a different, untested policy.

For a fully editable JavaScript policy with strategy text, deal selection, and
messages, use the original
[ProxyWar Coworld starter](https://github.com/0xNad/proxywar-coworld-starter).

## Inspect before upload

```bash
npm test
bash launch.sh --doctor
docker build --platform linux/amd64 -t proxywar-commander-starter:local .
docker image inspect proxywar-commander-starter:local
```

The decision protocol is documented in
[ProxyWar's player protocol](https://github.com/0xNad/ProxyWar/blob/main/coworld-adapter/docs/player-protocol.md).
