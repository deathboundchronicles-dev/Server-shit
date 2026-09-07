# Power Rangers RPG Character Builder — v0.27-exp Mobile VTT QoL

Experimental multiplayer / GM / Tactical Table branch. The protected standalone v0.18.0 trunk remains untouched.

v0.27 is a human-testing QoL release built directly on the fully audited v0.26 branch. Its scope is presentation, touch/mobile ergonomics, Tactical Table organization, and elevation handling. The MMPR:NOIR rules payload itself is unchanged.

## Human-testing goals addressed

### GM theme contrast

The Moon Palace / GM interface intentionally keeps its darker villain-theme panels, but dark surfaces now explicitly force readable light foreground colors.

The contrast pass covers GM command cards, Threat cards, custom Threat forms, encounter/combat cards, remote-check UI, multiplayer GM controls, and all dark Tactical Table panels. Dark inputs/selects/textareas also use light text and readable placeholders.

Paper-style Ranger dossier sheets remain intentionally light paper with dark ink and are explicitly excluded from the dark-panel override.

### Tactical Table organization

The VTT no longer piles unrelated controls into one oversized HUD.

The table is divided into distinct responsibilities:

- **Tactical Tools** — selection/navigation, measuring, markup/templates, GM scene layers, and layer history.
- **Token HUD** — selected creature resources, status, defenses, movement, footprint, and elevation.
- **GM Scene** — map library and map/grid calibration.
- **Spatial Awareness** — distance/elevation relationships between visible tokens.
- **Mobile control bar** — quick access to zoom, Tools, Token, Map, Range, and Dice without desktop-sized floating windows.

The desktop layout keeps these as separate collapsible floating cards. On phones they become bounded, scrollable bottom-sheet style panels and only the requested panel opens over the map.

## Elevation / third-axis movement

Elevation already existed in tactical state and 3D distance calculations. v0.27 turns it into a first-class movement control.

### Controls

For the selected movable token the Tactical Table provides:

- `▼ 5 ft`
- direct numeric elevation entry in 5-foot increments
- `▲ 5 ft`
- `GROUND`
- a persistent quick elevation dock on the map
- an elevation badge on the token itself when above or below ground level

### Movement behavior

The v0.26 free-staging contract is preserved.

**Outside active combat:**

- horizontal token placement is free;
- elevation changes are free;
- movement spent remains 0;
- players can establish the real starting square and starting altitude after tokens autopopulate.

**During the active combatant's turn:**

- horizontal movement uses the existing tactical movement engine;
- changing elevation adds the absolute number of vertical feet traveled to movement spent;
- elevation values snap to 5-foot increments;
- movement-locking Conditions also prevent voluntary elevation changes for players;
- GM forced repositioning remains possible without consuming a movement-locked creature's voluntary movement.

The multiplayer server performs the canonical vertical movement accounting, so all participants receive the same movement total.

## Mobile / touch behavior

The app-wide phone pass uses the existing responsive layout as a base and adds handset-specific behavior rather than maintaining a separate mobile application.

### App-wide mobile improvements

- Primary navigation becomes a horizontally scrollable touch strip rather than wrapping into a large wall of buttons.
- Inputs use a phone-safe readable font size to avoid unwanted browser zoom while editing.
- Cards, grids, inline actions, character-build controls, and major tables remain inside the handset viewport.
- Rule-reference and confirmation dialogs are capped to the dynamic viewport height and scroll internally.
- Confirmation actions stay reachable at the bottom of long dialogs.
- Dice/check overlays are constrained to the visible phone viewport.
- Safe-area insets are honored where appropriate.

### Tactical Table touch gestures

When `SELECT / PAN` is active:

- **one-finger drag on empty map:** pan the table;
- **one-finger drag on a movable token:** move the token;
- **two-finger pinch:** zoom around the gesture midpoint;
- **two-finger movement while pinching:** naturally pans with the gesture;
- **double-tap empty map:** quick zoom in;
- **FIT:** fit the active map to the viewport;
- touch panning/zooming updates the live VTT transform without rebuilding the whole table every frame.

Desktop/trackpad behavior remains available. Ctrl-wheel/trackpad pinch can adjust zoom around the pointer while normal scrolling/panning remains available.

### Mobile VTT chrome

The mobile VTT header hides nonessential branding so `RETURN TO APP` and GM session controls stay reachable without clipping. The global dice dock is hidden while closed on the VTT and opens above the mobile control bar only when requested through `DICE`.

## Rules and data compatibility

v0.27 intentionally does **not** alter the MMPR:NOIR homebrew payload.

Using the same extraction boundary on v0.26 and v0.27 (`const NOIR_PACK_DATA=` through the line before `function withPackSource`):

- payload bytes: 49,931
- SHA-256: `d125da6af8614ee5d5699b88f21d3255a59458c1a4ba2dd048d2e057c29e5710`
- v0.26 and v0.27 payloads: byte-for-byte identical

The v0.26 rules/geometry/movement corrections remain in place, including Size Class shifts, Sliding Dice Shift automatic stages, combat-only movement tracking, footprint-aware walls, exact Difficult Terrain intersection, occupancy rules, Conditions, Fog/Vision footprint handling, and per-map token positions.

## Multiplayer / deployment compatibility

v0.27 remains on **multiplayer protocol 7**.

Deploy:

```text
multiplayer-server-v0.27-exp.js
```

The protocol number did not need another bump because the message shapes remain compatible. However, a v0.27 client should be paired with the v0.27 server because the server now performs canonical vertical movement accounting for `vtt_elevation_set`.

## Included regression suites

The bundle includes thirteen suites.

### Retargeted inherited/deep-audit gates

- `test_client_regression_v027.js`
- `test_assets_static_v027.js`
- `test_client_static_v027_regression.js`
- `test_tactical_tools_static_v027.js`
- `test_protocol_regression_v027.js`
- `test_assets_protocol_v027.js`
- `test_protocol_v027_regression.js`
- `test_tactical_tools_protocol_v027.js`
- `test_deep_audit_static_v027.js`
- `test_deep_audit_protocol_v027.js`
- `test_deep_audit_browser_v027.py`

### New v0.27 QoL gates

- `test_mobile_vtt_protocol_v027.js`
  - verifies free pre-combat vertical staging;
  - verifies server-canonical vertical movement spending during combat;
  - verifies 5-foot elevation snapping.

- `test_mobile_vtt_qol_v027.py`
  - runs the actual client in headless Chromium at a 390×844 mobile viewport;
  - checks all primary app modes for page-level/card overflow;
  - verifies mobile navigation and phone-safe form sizing;
  - bounds-checks rule/confirm dialogs;
  - opens Tools, Token, Map, and Range panels and ensures each stays on-screen;
  - checks GM dark-panel foreground colors;
  - exercises free elevation staging and combat elevation spending;
  - dispatches touch-style PointerEvents to verify one-finger pan, pinch zoom, and double-tap zoom;
  - captures `MOBILE_VTT_QA_v0.27.png` as a visual QA artifact.

The package also retains `tests/v025_function_inventory.json` as the historical gameplay-function deletion guard.

## Current verification result

Working-directory verification:

- **225 / 225 behavioral assertions passed across all thirteen suites.**
- client JavaScript syntax passed.
- server JavaScript syntax passed.
- 853 named client functions, 853 unique.
- all 808 v0.25 named gameplay functions retained.
- MMPR:NOIR payload byte-for-byte unchanged from v0.26.

See `TEST_REPORT_v0.27-exp.txt` for the release summary.

## Intentional boundaries

- Fog/Vision remains live line-of-sight visibility rather than persistent explored-area memory.
- Hazard and Cover remain shared annotations; Difficult Terrain is the automated movement-cost terrain type.
- Rulers are local/private. Drawings and AoE templates are shared. Pings are transient.
- Movement tracking remains informational and does not hard-stop a creature at its nominal allowance.
- Pre-combat horizontal and vertical movement are intentionally permissive staging.
- The mobile interface is the same single-file application with responsive/touch behavior, not a separate mobile client.

## Clean-package release gate

The release archive was also extracted into a fresh directory and the packaged copy reran all thirteen suites successfully: **225 / 225 behavioral assertions passed**, with both client and server JavaScript syntax gates passing. The ZIP integrity check also passed.
