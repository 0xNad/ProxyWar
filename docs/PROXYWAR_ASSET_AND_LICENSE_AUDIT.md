# Proxy War Asset And License Audit

This is a practical beta-readiness audit, not legal advice.

## Source Licensing

The upstream OpenFront source is licensed under AGPL v3. The repo includes:

- `LICENSE`
- `LICENSING.md`
- `LICENSE-ASSETS`
- `CREDITS.md`

Public network deployment of a modified AGPL app should keep source/license
access easy to find from public-facing UI.

## Asset Licensing

The repo includes separate asset-license files:

- `LICENSE-ASSETS`
- `resources/LICENSE`
- `static/LICENSE`
- `proprietary/LICENSE`

The README states assets are CC BY-SA 4.0. Keep visible credit to OpenFront and
contributors in public pages and preserve upstream notices.

## Public Beta Risk List

| Area | Risk | Beta action |
| --- | --- | --- |
| OpenFront logo and branding in `proprietary/images` | May be intended for the upstream OpenFront brand rather than the Proxy War fork. | Avoid using upstream proprietary logo as the Proxy War product mark unless permission is clear. |
| Country and historical flags under `resources/flags` | Large third-party-derived collection with mixed provenance risk. | Do not market with individual flags until provenance is reviewed; in-game use inherits upstream behavior. |
| Map imagery/data under `resources` and `static` | Inherited OpenFront assets need attribution/license preservation. | Keep license links and credits visible. |
| Generated AI league artifacts | Can include raw prompts, reasons, debug data, and local paths. | Public beta should show sanitized replay/report artifacts, not raw JSONL by default. |

## Current Beta Recommendation

For friends-and-family beta:

1. Use the simple Proxy War text identity in the demo hub.
2. Link to license/source/credits in the footer.
3. Avoid a new commercial logo using upstream proprietary logo files.
4. Treat raw artifacts as operator/debug data.
5. Before a broader launch, replace or formally approve any proprietary OpenFront
   branding that appears in the Proxy War public surface.

## Suggested Replacement Work

- Create a simple original Proxy War wordmark.
- Use CSS colors and text rather than inherited logo art on the beta landing
  page.
- Add a public `/credits` or footer link to source, license, and credits.
- Audit any social/marketing screenshots for inherited logos and flag imagery.

## 2026-07-06 — Marketing footage/screenshot resolution (verified against the actual asset layout)

Question resolved: **in-game replay footage and screenshots ARE safe to publish**, under
the conditions below. Basis (all `[repo/file verified]`):

- The All-Rights-Reserved `proprietary/` layer contains ONLY brand assets — per
  `git ls-files proprietary`: the OpenFront logo/wordmark images (`OpenFront*.png/webp/svg`,
  `OF.png/webp`, `Favicon.svg`), one font (`fonts/OpenFront.ttf`), and six music tracks.
  **No terrain art, no unit sprites, no map data, no flags.** All gameplay visuals live in
  `resources/`, which is CC BY-SA 4.0 (`resources/LICENSE`, `LICENSE-ASSETS`).
- Logo art renders only on landing/loading surfaces (`index.html` background vars; the
  desktop var is commented out) — not on the in-game/replay canvas that clips capture.
- Country flags do not appear in agent-replay captures: agent player specs set no flag,
  the leaderboard layer renders none, and the player panel (which can) is hidden by the
  capture pipeline. The mixed-provenance flag caution stays theoretical for footage.
- The in-game typeface is the proprietary `OpenFront.ttf` (loaded in `Main.ts`;
  `resources/fonts/` does not shadow it). Rendered text inside footage is not a
  redistribution of the font file, and typeface designs are not copyrightable in the US —
  acceptable. Optional belt-and-braces: override to Overpass (already in `resources/`)
  during capture.
- AGPL v3 covers the CODE and attaches to the deployed service (source access, Section 7
  notice preservation, no misrepresentation). It imposes nothing on footage.

**Publication conditions (every public clip/screenshot):**

1. Frame in-game views only (map + leaderboard + replay banner). No landing/loading
   screens, no OpenFront logo/wordmark imagery. Never present OpenFront marks as the
   Proxy War identity.
2. Silent audio or separately licensed music — never the bundled `proprietary/sounds`
   tracks. (The `outputs/promo/` pipeline already produces silent video.)
3. Attribution + ShareAlike, once per thread/post in a reasonable place (CC BY-SA 4.0
   §3(a)(2) allows medium-appropriate placement), e.g.:
   *"Game art from OpenFront (openfront.io), CC BY-SA 4.0; footage shared under the same
   license. Proxy War is an independent fork — not affiliated with or endorsed by
   OpenFront."* The no-endorsement line matters (BY-SA 4.0 forbids implying endorsement).
4. Long-form posts carry the same credit block plus a link to this repo's
   `LICENSE`/`CREDITS.md`.

Residual risk, stated honestly: upstream's blanket CC BY-SA label is only as reliable as
upstream's own rights hygiene. For map/sprite art (OpenFront's original work) that is a
low risk; the historically flagged risk (third-party-derived flag pack) is out of frame in
agent replays. This remains a practical audit, not legal advice.
