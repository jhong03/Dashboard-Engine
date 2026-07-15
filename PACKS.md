# Authoring Dashboard Engine Packs

A pack is a folder: `packs/<your-pack-id>/pack.json` plus optional images in
`packs/<your-pack-id>/assets/`. No code, no fonts, no build step — JSON in,
skin out. The dashboard **hot-reloads while you edit**: run the app, open your
`pack.json`, save, watch it repaint.

Quick loop:

```
npm start                        # dashboard, pick your pack in the top bar
DE_PACK=my-pack npm start     # or open it directly
npm run packs -- validate        # preflight: see what got clamped and why
```

Anything invalid is clamped or dropped with a warning — a broken pack renders
as the default skin, never a crash. Save your file as UTF-8 (BOM is tolerated).

## pack.json anatomy

```jsonc
{
  "schema": 2,
  "name": "My Pack",
  "author": "you",

  "persona": {
    "name": "VIOLET",                 // shown by the status component (≤40 chars)
    "tagline": "night-shift navigator",
    "lines": ["plotting course…", "all quiet"]   // rotating ticker, ≤8 × ≤80 chars
  },

  "skin": {
    "palette": {                      // hex only: #RGB / #RRGGBB / #RRGGBBAA
      "void": "#04080F",              // window background
      "glass": "#0A16238C",           // panel fill (alpha ignored; see panelOpacity)
      "accent": "#3FD8FF",            // lines, glows, numbers
      "accentBright": "#7FE9FF",      // body text
      "muted": "#5A7E93",             // labels
      "warn": "#FFB23E",              // hot meters, warnings
      "gold": "#E8C56A"               // ticker, flourishes
    },
    "typography": {
      "display": "rajdhani",          // rajdhani | system-sans | system-serif | mono
      "uppercase": true,
      "letterSpacing": 0.22           // em, 0–0.4
    },
    "texture": {                      // all 0–1 intensity knobs
      "scanlines": 0.35, "grid": 0.25, "glow": 0.5, "vignette": 0.4
    },
    "shape": {
      "cornerNotches": true,          // the L-bracket corners
      "borderOpacity": 0.28,          // 0.05–1
      "panelOpacity": 0.55,           // 0–1
      "radius": 0                     // px, 0–16
    },
    "ambience": {                     // optional drifting-particle layer
      "effect": "embers",             // none | embers | dust | snow | petals | rain | sparkle
      "density": 0.45                 // 0.05–1
    },
    "wallpaper": "assets/bg.png"      // optional, ≤5 MB, png/jpg/webp
  },

  "canvas": { "padding": 2 },         // % margin around the component area

  "components": [ /* see below */ ]
}
```

## Components

Up to 24 components, placed freely: `rect: [x, y, w, h]` in **percent of the
canvas**, `z` (0–20) for layering. Overlap is allowed — that's how you layer
art behind widgets.

| type | options | what it shows |
|---|---|---|
| `status` | — | persona name, tagline, rotating ticker |
| `clock` | `format` (`24h`/`12h`), `seconds`, `showDate` | digital clock |
| `analog-clock` | `seconds`, `numerals` (`quarters`/`all`/`none`), `minuteTicks` | drawn clock face in your palette |
| `hud-clock` | `format`, `seconds`, `showDate` | sci-fi reactor: counter-rotating rings around a digital readout |
| `cores` | `label` | per-core CPU load bars |
| `sysinfo` | `memory`, `disk`, `uptime`, `host`, `statusText` | key/value machine readouts |
| `stats` | `cpu`, `mem`, `disk`, `battery`, `history` | labelled bars with a faint history trace |
| `meter` | `bind` (`cpu`/`mem`/`disk`/`battery`), `variant` (`ring`/`bar`), `label`, `readout`, `ticks` | one live value; the bar variant gets a big number + scale ticks |
| `sparkline` | `bind`, `label`, `grid`, `readout` | 3-minute history graph with grid + live value |
| `text` | `text` (≤200 chars, `\n` allowed) | free text block |
| `image` | `src` (`assets/…`), `fit` (`contain`/`cover`) | your art, ≤5 MB each |
| `divider` | `orientation` (`h`/`v`) | hairline rule |
| `calendar` | `weekStart` (`mon`/`sun`), `showReminders` | month grid, today marked, reminder days dotted |
| `countdown` | `target` (ISO date), `label` | days/hours to a date |
| `weather` | `lat`, `lon`, `place`, `details`, `compact` | conditions with glyph, hi/lo + wind, or a one-line strip (Open-Meteo, no key — the one component that goes online) |
| `agenda` | `days` (1–14), `limit` (1–12), `label` | the user's upcoming reminders |
| `notifications` | `limit` (1–12), `label`, `showApp` | the user's live Windows notifications (needs notification access) |
| `launcher` | `pinned`, `recent`, `running`, `labels`, `iconSize` (`s`/`m`/`l`), `label` | the user's pinned/recent/open apps as clickable tiles |
| `assistant` | `label`, `button` | a console line that opens the AI chat when clicked on the desktop (runs on a free model by default; configure in the manager) |
| `module` | `html`, `scroll`, `telemetry` | **your own component** — sandboxed HTML/CSS/JS you write. See [Module SDK](#module-sdk) below |

`calendar`, `agenda`, `notifications`, and `launcher` display the **user's own
data** (planner events managed in the engine's Planner tab; app pins in its
Launcher tab; live Windows notifications from the system). A pack only places
and styles these components — this data is personal and is never part of a
pack, an export, or a registry download. The `notifications` component reads
the system's notifications and needs access granted under Windows Settings ›
Privacy › Notifications; without it, the component shows how to enable it.

Rather not hand-write JSON? Open any pack in the **editor** (manager → pack
→ OPEN IN EDITOR, or `--edit <id>`): drag components from the palette, move/
resize/restyle them, edit the skin and persona, save. Editing a pack you
didn't author forks it to a copy in your library — originals stay pristine.

## Per-component style overrides

Any component takes an optional `style` — every field optional, omitted means
"inherit the skin":

```jsonc
"style": {
  "accent": "#FF6B4A",      // recolours lines/glow/hairlines locally
  "textColor": "#FFD27A",
  "font": "mono",           // same allowlist as typography.display
  "fontScale": 1.5,         // 0.5–3, scales everything inside
  "align": "left|center|right",
  "place": "top|center|bottom|spread", // vertical placement inside the box
                            // ("spread" pushes content apart to fill it)
  "panel": false,           // no glass background — float on the wallpaper
  "border": false,
  "notches": false,
  "opacity": 0.35,          // 0.05–1, great for background art
  "glow": 0.8,              // 0–1, local glow intensity
  "padding": 24,            // px, 0–48
  "rotate": -6              // degrees, ±20
}
```

The built-in pack is the worked example: `packs/jarvis/` (HUD clock, ring
meters, per-core bars, sysinfo readouts, compact weather strip, agenda +
launcher rails, layered text panels). Copy it, rename the folder, and start
editing — it is also the project's quality floor for pack design.

## Module SDK

The 19 built-in components cover the common dashboard vocabulary. When you need
something they don't do — a bespoke gauge, an animated crest, a layout only your
pack has — author it yourself with a **module** component.

A module is a self-contained fragment of HTML + CSS + JS that you write. It runs
inside a **locked-down sandbox**, so it can look like anything while staying
safe for the people who install your pack:

- an isolated `<iframe>` with an opaque origin — no access to the page around
  it, the engine, the user's files, cookies, or storage;
- a strict Content-Security-Policy that **blocks the network entirely** — no
  `fetch`, no `XMLHttpRequest`, no WebSocket, no external scripts/styles/images;
- no Node, no `require`, no `eval`.

The engine talks to your module over one channel only, and only ever *hands it*
data — your module can't ask the engine to do anything. That's the deal that
lets untrusted packs run designer code safely.

### Authoring

Write the fragment like a web-page body — markup plus inline `<style>` and
`<script>`. **No `<html>`, `<head>`, or `<body>` tags**; the engine wraps your
fragment in the sandbox shell. Store it in the component's `html` option (≤24 KB):

```jsonc
{ "type": "module", "rect": [4, 60, 30, 30], "z": 2,
  "options": {
    "scroll": false,        // let the module scroll if its content overflows
    "telemetry": true,      // receive the live system-stats feed (default true)
    "html": "<div class=\"card\">…</div><style>…</style><script>…</script>"
  },
  "style": { "panel": true, "border": false }
}
```

Easier: in the **editor**, drop a *Custom module* from the palette. You get a
working, theme-aware starter in the inspector's code box, editing live on the
stage. (Escaping a whole HTML document into one JSON string by hand is no fun —
let the editor do it.)

### The `DE` API

A tiny global, `window.DE`, is available before your code runs:

```js
DE.onTheme(theme => { … });  // pack skin — called immediately + whenever it changes
DE.onData(data  => { … });   // live system stats — called ~every 2s (if telemetry on)
DE.theme();                  // the latest theme object (or null)
DE.data();                   // the latest stats object (or null)
DE.asset('assets/x.png');    // a pack image as a data: URI, or null
```

**Theme** mirrors your pack skin and is also injected as CSS custom properties on
`:root`, so the easiest path is to just use the variables:

```
--de-void  --de-glass  --de-accent  --de-accent-bright  --de-muted
--de-warn   --de-gold   --de-font    --de-font-mono   --de-radius   --de-ls
```

`theme` (the object) also carries `palette`, `fonts`, `radius`, `uppercase`,
`letterSpacing`, and `persona` (`{ name, tagline }`) so your module can greet in
character.

**Data** (when `telemetry` is on) is the same system feed the built-in widgets
use: `cpu`, `mem`, `disk`, `battery` (0–100), a `cores` array, the pre-formatted
`memText` / `diskText` / `diskFreeText` / `uptimeText` / `batteryText`, and
`now` (ms). No personal data — no hostname, files, notifications, or reminders.

Sizes: length units resolve against the component box, so `cqw`/`cqh` (or `%`)
scale your module with its rectangle — the same way native components scale.

### Example

```html
<div class="wrap">
  <div class="hi">hello, <span id="who">friend</span></div>
  <div class="row"><span>CPU</span><b id="cpu">—</b></div>
  <div class="bar"><i id="cpuBar"></i></div>
</div>
<style>
  .wrap{height:100%;padding:5cqw;display:flex;flex-direction:column;justify-content:center;gap:2cqw}
  .hi{font-size:4cqw;color:var(--de-accent)}
  .row{display:flex;justify-content:space-between;font-size:2.6cqw;color:var(--de-muted)}
  .row b{color:var(--de-accent-bright)}
  .bar{height:1.4cqw;background:rgba(127,127,127,.18);border-radius:var(--de-radius)}
  .bar i{display:block;height:100%;width:0;background:var(--de-accent);transition:width .6s}
</style>
<script>
  DE.onTheme(t => who.textContent = t.persona.name || 'friend');
  DE.onData(d => { cpu.textContent = d.cpu + '%'; cpuBar.style.width = d.cpu + '%'; });
</script>
```

### Limits & etiquette

- **No network, ever.** Bundle what you need; reference pack art via
  `DE.asset()` (data URIs) rather than inlining giant base64 blobs.
- Keep it light — it runs on the desktop behind everything else. Respect
  `@media (prefers-reduced-motion: reduce)`.
- A broken module fails soft: an empty or throwing fragment just renders blank,
  it never takes down the dashboard.
- The quality floor still applies — a module should look at least as considered
  as the built-in components beside it.

## Distributing your pack

Give your manifest an `"id"` (lowercase letters/digits/hyphens — it names the
install folder), then export:

```
npm run packs -- export my-pack        # writes my-pack.dpack
```

(or Export pack in the app). A `.dpack` is a plain zip of `pack.json` +
`assets/` — share the file anywhere. Users install it via Install from file,
and it lands in their user-data folder, never in the engine. Legacy
`.aegispack` files install fine too.

### Hosting a registry

A registry is one static JSON file on any https host — GitHub Pages, itch,
your own site:

```jsonc
{
  "name": "My Pack Registry",
  "packs": [
    {
      "id": "my-pack",
      "name": "My Pack",
      "author": "you",
      "description": "one line for the browse list",
      "version": "1.0.0",
      "download": "https://your.host/my-pack-1.0.0.dpack",
      "sha256": "<sha256 of the .dpack file>",
      "sizeBytes": 123456
    }
  ]
}
```

Users subscribe to the index URL in LIBRARY → REGISTRIES. The app verifies
every download against your pinned `sha256` + `sizeBytes` and refuses
mismatches, and it flags an update whenever your `version` differs from what
a subscriber has installed. Bump `version`, upload the new file, update the
entry — that's a release.

Caps the engine enforces on installs: ≤ 40 files per archive, ≤ 5 MB per
asset, ≤ 25 MB unpacked, images only, built-in pack ids are reserved.
