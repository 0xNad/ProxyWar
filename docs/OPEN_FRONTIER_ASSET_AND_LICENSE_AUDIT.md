# Open Frontier Asset And License Audit

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
| OpenFront logo and branding in `proprietary/images` | May be intended for the upstream OpenFront brand rather than the Open Frontier fork. | Avoid using upstream proprietary logo as the Open Frontier product mark unless permission is clear. |
| Country and historical flags under `resources/flags` | Large third-party-derived collection with mixed provenance risk. | Do not market with individual flags until provenance is reviewed; in-game use inherits upstream behavior. |
| Map imagery/data under `resources` and `static` | Inherited OpenFront assets need attribution/license preservation. | Keep license links and credits visible. |
| Generated AI league artifacts | Can include raw prompts, reasons, debug data, and local paths. | Public beta should show sanitized replay/report artifacts, not raw JSONL by default. |

## Current Beta Recommendation

For friends-and-family beta:

1. Use the simple Open Frontier text identity in the demo hub.
2. Link to license/source/credits in the footer.
3. Avoid a new commercial logo using upstream proprietary logo files.
4. Treat raw artifacts as operator/debug data.
5. Before a broader launch, replace or formally approve any proprietary OpenFront
   branding that appears in the Open Frontier public surface.

## Suggested Replacement Work

- Create a simple original Open Frontier wordmark.
- Use CSS colors and text rather than inherited logo art on the beta landing
  page.
- Add a public `/credits` or footer link to source, license, and credits.
- Audit any social/marketing screenshots for inherited logos and flag imagery.
