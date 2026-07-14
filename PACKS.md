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
      "effect": "embers",             // none | embers | dust | snow
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
| `assistant` | `label`, `button` | a console line that opens the AI chat when clicked on the desktop (needs an API key set in the manager) |

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
