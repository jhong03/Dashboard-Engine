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
    "wallpaper": "assets/bg.png",     // optional — an image (≤5 MB, png/jpg/webp)
                                      //            OR a video (≤30 MB, mp4/webm) — see below
    "wallpaperFit": "cover",          // cover (crop) | contain (fit whole) | stretch
    "wallpaperPosX": 50,              // focal point %, 0–100 (which part of a crop shows)
    "wallpaperPosY": 50,
    "wallpaperVideo": { "playbackRate": 1 }  // video only, 0.25–2 (ignored for an image)
  },

  "canvas": { "padding": 2 },         // % margin around the component area

  "components": [ /* see below */ ]
}
```

### Video wallpapers

`skin.wallpaper` may point at a **video** (`assets/<name>.mp4` or `.webm`, ≤ 30 MB)
instead of an image. The engine plays it as a looping, muted, full-surface
wallpaper behind your components — `wallpaperFit` / `wallpaperPosX/Y` crop and
position it exactly like an image, and `wallpaperVideo.playbackRate` (0.25–2)
sets the speed.

- **Always muted.** A video wallpaper never plays audio — that's a fixed rule, not
  a knob. If you want sound, the user adds their own music in Settings → Background
  music; a pack never ships or plays audio.
- **Good citizen.** The video pauses (frozen on its last frame) whenever the
  wallpaper is frozen — a full-screen app on the primary monitor, on battery (if
  enabled), or a manual tray pause — and honours the fps cap. With the OS
  "reduce motion" setting on, it shows a still first frame and never autoplays.
- **Size.** Keep it small — a short seamless loop at a sane bitrate. 30 MB is the
  hard cap (the importer and `packs -- validate` both reject anything larger).
  Prefer `webm` (VP9) for the best size/quality; `mp4` (H.264) is the safe
  fallback. It travels inside the `.dpack` like any other asset.
- **Author it** in the editor (Skin tab → **Import video…**) or the from-scratch
  builder (Background → **Choose a video…**).

### Layered backgrounds & parallax

For depth, the background can be a **stack of up to 6 layers** (images and/or
videos), back-to-front, each with a parallax `depth`. This replaces the single
`wallpaper` for advanced packs — a plain `wallpaper` is just the one-layer case
(the engine normalizes it), so you never *have* to use layers.

```jsonc
"skin": {
  "background": {
    "layers": [                      // back-to-front, 1–6; each an image OR video
      { "src": "assets/sky.png",   "depth": 0.0 },                 // fixed backdrop
      { "src": "assets/hills.png", "depth": 0.4, "opacity": 1,
        "drift": { "x": 6, "y": 0 } },                             // slow pan
      { "src": "assets/fog.webm",  "depth": 0.9, "fit": "cover" }  // moves most
    ],
    "parallax": { "strength": 1.0, "axis": "both" }  // strength 0–2; both | x | y
  }
}
```

- **`depth`** (0–1) — how much a layer moves with the cursor: `0` is pinned, `1`
  moves the most. Stack a far backdrop at `0` and nearer layers at higher depths
  for a 3-D feel.
- **`opacity`** (0.05–1) — blend a foreground layer over the ones behind it.
- **`fit` / `posX` / `posY`** — same crop/position controls as a wallpaper.
- **`drift`** `{ x, y }` (−20…20) — a slow, continuous, *bounded* pan even when
  the cursor is still (px/s at the 1920 design basis). Great for clouds/fog.
- **`parallax.strength`** (0–2) scales the whole effect; **`axis`** limits it to
  horizontal or vertical. The user also has a global **Settings → Background
  motion** slider (0–100 %, or Off) that multiplies every pack's motion.
- **No edge gaps, ever.** The engine scales each moving layer up just enough that
  its motion never reveals an edge — you don't manage overscan. **Reduced motion**
  freezes all layers to a still frame.
- Videos in a layer follow every video-wallpaper rule (muted, freeze, 30 MB cap).
- **Author it** in the editor (Skin tab → **Background layers**: add/reorder/
  remove, per-layer depth/opacity/drift) or start simple in the builder
  (Background → **Depth layers (optional)**).

### Background effects (WebGL)

Each background layer can carry up to **3 shader effects** that animate the layer
— ripples, warps, a glow pulse, interactive cursor rings. Effects render through
WebGL; on a machine without it (or with a global override), the layer just draws
as a static image — the pack still works, it simply doesn't animate.

```jsonc
{ "src": "assets/sky.png", "depth": 0, "effects": [
    { "type": "drift-warp", "speed": 0.3, "scale": 3 },
    { "type": "pulse", "speed": 0.6, "amount": 0.12, "paletteKey": "accent" }
] }
```

| effect | params (range) | what it does |
|---|---|---|
| `ripple` | `speed` 0–3, `scale` 0.5–8, `strength` 0–1 | sine ripples across the layer |
| `sway` | `speed` 0–3, `strength` 0–1, `direction` 0–360 | a gentle corner-anchored sway |
| `drift-warp` | `speed` 0–3, `scale` 0.5–8 | slow noise-flow warp (mist, heat-haze) |
| `pulse` | `speed` 0–3, `amount` 0–1, `paletteKey` (a palette key or null) | brightness pulse, or a tint toward a palette colour |
| `cursor-ripple` | `strength` 0–1, `speed` 0.2–3, `decay` 0.2–3 | expanding rings that follow the cursor |
| `waves` | `angle` 0–360, `wavelength` 0.5–8, `speed` 0–3, `strength` 0–1 | a travelling sine ripple marching along `angle` (water, flags) |
| `shimmer` | `density` 0–1, `speed` 0–3 | sparse sparkle glints, gated by the mask/region (glints on water, motes) |
| `shake` | `speed` 0–3, `amplitude` 0–1 | a small whole-layer jitter; `amplitude` is capped tiny on purpose |
| `spin` | `speed` 0–3, `radius` 0.05–1 | a swirl centred on the region (or layer centre), easing off past `radius` |
| `scroll` | `angle` 0–360, `speed` 0–3 | scrolls the layer along `angle` and wraps — best with a **tileable** texture (clouds, starfields) |
| `chroma-shift` | `amount` 0–1, `speed` 0–3 | a subtle oscillating RGB split; `amount` is capped small so it reads as a shimmer, not a broken image |

- **Region** (optional, per effect) — confine the effect to part of the layer:
  `"region": { "shape": "rect" | "ellipse", "x": 0–100, "y": 0–100, "w": 0–100, "h": 0–100, "feather": 0–50 }`
  (percent of the layer; `feather` softens the edge).
- **Mask** (optional, per effect) — `"mask": "assets/mask.png"`, a grayscale PNG
  that multiplies the effect's strength pixel-by-pixel (white = full effect,
  black = none, grey = partial). The mask maps across the **whole surface** (it's
  sampled in the same space you see), so paint it over the layer as it renders.
  **A mask overrides a region** — if you set both, the region is dropped and the
  mask wins. Oversized masks are downscaled to the GPU's limit with a warning
  (keep them ≤ 2048 px). The easiest way to make one is the editor's painter
  (below) — you rarely hand-author a mask PNG.
- **Taste + the quality floor.** Keep `amount`/`strength` low — these read best as
  subtle ambience, not a screensaver. The refreshed `vaporwave`, `sakura` and
  `neon-cyberpunk` seeds are worked examples.
- **Performance.** Effects ride the same fps cap and freeze as everything else
  (a full-screen app / battery pauses them). Reduced motion renders one static
  frame. Prefer one or two gentle effects over stacking three loud ones.
- **Author it** in the editor (Skin tab → a layer's **Effects (WebGL)** section:
  add/reorder/remove, param sliders, and either a numeric **region** or a painted
  **mask**).

#### Painting a mask

Open the editor (Skin tab → a background layer → **Effects (WebGL)** → add an
effect → **Paint mask**). A full-screen painter shows the layer with your mask as
a red overlay:

- **Brush** — set *Size*, *Softness* (hard → feathered), and *Opacity*; paint
  where the effect should show. **Eraser** removes; **Clear** wipes; **Invert**
  flips the whole mask; **Undo/Redo** (or `Ctrl+Z` / `Ctrl+Y`) step through
  strokes; `Esc` cancels.
- **Save mask** flattens what you painted into a grayscale PNG stored in the
  pack's `assets/` (as `mask-<id>.png`) and sets the effect's `mask`. Painting a
  mask removes any region on that effect (mask wins).
- Removing the effect (or **Remove mask**) deletes the orphaned mask from the
  pack, so nothing dead ships.
- A worked example: put a `ripple` on a lake layer, paint the water, and only the
  water ripples — the sky stays still.

### Custom particles (Particle Studio)

The `ambience` block above picks one of 7 built-in effects. For full control,
set `"mode": "custom"` and describe your own particle system in `system`. The
built-in effects are untouched — custom is a separate, fully data-driven layer
(same single animation loop, same fps cap + freeze, reduced-motion safe).

```jsonc
"ambience": {
  "mode": "custom",
  "density": 0.5,                     // still scales the count (0.5 = as authored)
  "system": {
    "emitter": { "shape": "top", "x": 50, "y": 50 },  // where particles spawn
    "sprite":  { "builtin": "flake" },                // or "custom": "assets/p.png"
    "count": 90,                                       // 1–400 (hard cap)
    "sizeMin": 0.15, "sizeMax": 0.4,                  // cqw (resolution-independent)
    "speedMin": 2, "speedMax": 5,                     // cqw / second
    "direction": 180, "spread": 12,                   // degrees CW from up; 180 = down
    "gravity": 1, "wind": 0, "drag": 0,               // cqw/s² accel; drag 0–1
    "color": { "paletteKey": "accentBright", "jitter": 0 },  // token | "custom"+"custom":"#RRGGBB"
    "opacityLife": "constant",                        // fadeInOut | fadeOut | constant
    "rotate": 0, "wobble": 1.2,                       // spin; side-to-side sway
    "blend": "normal",                                // normal | screen | additive
    "pointer": { "mode": "none", "radius": 20, "strength": 0.5 }  // none|attract|repel
  }
}
```

| field | values | notes |
|---|---|---|
| `emitter.shape` | `screen` `top` `bottom` `left` `right` `point` `mask` | `point` uses `x`/`y` (%); `mask` spawns from the bright pixels of `emitter.mask` |
| `sprite.builtin` | `dot` `streak` `flake` `leaf` `note` `spark` `ring` | `sprite.custom` (a ≤256 px PNG) overrides it |
| `count` | 1–400 | scaled by `density` (0.5 = as authored), hard-capped at 400 |
| `sizeMin/Max` | 0.1–8 cqw | particle radius; cqw = % of surface width |
| `speedMin/Max` | 0–30 cqw/s | initial speed along `direction` |
| `direction` / `spread` | 0–360 / 0–180 | 0 = up, 90 = right, 180 = down; `spread` is the cone width |
| `gravity` / `wind` | −20…20 | continuous down / sideways acceleration (cqw/s²) |
| `drag` | 0–1 | slows particles over time |
| `color` | palette token or `custom` + hex | `jitter` 0–1 varies each particle's colour |
| `opacityLife` | `fadeInOut` `fadeOut` `constant` | how a particle's alpha behaves over its life |
| `rotate` / `wobble` | 0–10 | spin rate / sway amount |
| `blend` | `normal` `screen` `additive` | additive = glow |
| `pointer` | `none` `attract` `repel` | cursor force within `radius`, strength 0–1 |

- **Author it** in the editor: Skin tab → Ambience → **Customize particles…**.
  Grouped controls (Emitter / Sprite / Motion / Color / Interaction) update the
  stage live. **Reset to <preset>** reloads a factory starting point; **Save
  preset** stores a named preset in the pack; **Use a preset** returns to the
  built-in effects.
- **Mask emitter** — pick `emitter.shape: "mask"` and paint the spawn zone (the
  same painter as effect masks); particles appear only where you paint.
- **Worked example (recreate snow):** `emitter.shape: "top"`, `sprite: "flake"`,
  `direction: 180`, a little `gravity` and `wobble`, `opacityLife: "constant"` —
  match the built-in `snow` by eye, then push it further (a mask emitter, an
  additive glow, a custom sprite).

## Breathing rig (living characters)

The `rig` component (in the Components list below) stacks **layered PNGs** and
brings them to life with per-layer oscillators — no bones, no mesh, transform
only. It's the "character that feels alive" feature: a body that breathes, hair
that sways, eyes that follow the cursor.

```jsonc
{ "type": "rig", "rect": [8, 6, 26, 60], "z": 3,
  "options": { "layers": [                 // back-to-front, ≤ 8
    { "src": "assets/body.png",
      "anchor": { "x": 50, "y": 95 },       // transform pivot (% of the box); feet-ish
      "breath": { "scale": 0.02, "speed": 0.2, "phase": 0 },  // gentle scale pulse
      "sway":   { "rotate": 1.5, "speed": 0.15, "phase": 0 }, // degrees
      "bob":    { "y": 0.6, "speed": 0.2, "phase": 0 },       // cqw up-down
      "gaze":   { "x": 1, "y": 0.5 },        // cqw pull toward the cursor
      "tiltWithPointer": 1 },                // degrees of lean toward the cursor
    { "src": "assets/hair.png", "anchor": { "x": 50, "y": 30 },
      "sway": { "rotate": 3, "speed": 0.15, "phase": 0.15 } } // 0.15 BEHIND the body
  ] }
}
```

| knob | range | what it does |
|---|---|---|
| `anchor.x/y` | 0–100 | the transform pivot (% of the box) — sway/breath rotate/scale about it |
| `breath.scale` | 0–0.05 | how much the layer scale-pulses |
| `sway.rotate` | 0–6° | side-to-side rock |
| `bob.y` | 0–3 cqw | up-down bob |
| `*.speed` | 0.05–1 | cycles per second for that oscillator |
| `*.phase` | 0–1 | offset — set a layer **behind** another for lifelike lag |
| `gaze.x/y` | 0–4 cqw | how far the layer slides toward the cursor |
| `tiltWithPointer` | 0–4° | how much the layer leans toward the cursor |

- **The phase idiom.** Give secondary layers (hair, a scarf, a tail) a phase a
  little **behind** the body — e.g. hair `phase 0.15` when the body is `0` — so
  they lag and the whole figure reads as one connected thing, not a rigid cut-out.
- **Anchor placement.** A character usually pivots near its feet (`anchor.y` ~90–95)
  so a sway rocks the whole body; hair pivots near the crown (`anchor.y` ~20–30).
- **Pointer = the world's pointer.** Gaze/tilt follow the **same** cursor as the
  background parallax, so the character and the scene move together. On a still
  surface (a gallery thumbnail) or with reduced motion, the rig shows static art.
- **Author it** in the editor: add a **Character rig** from the palette, then
  **Add layer…** (one PNG per layer, back to front), set each layer's sliders,
  and hit **Preview breeze** to judge the motion. Layers are ordinary pack images
  — export/publish carries them like any art.
- **Art tips.** Export each layer as a transparent PNG on the **same canvas size**
  so they align; keep them modest (they scale to the component box). Motion should
  read at the default params in a 10-second clip — subtle beats frantic.

## Time of day (`skin.schedule`)

Recolour the whole dashboard as the local clock passes through four slots —
**dawn, day, dusk, night**. Each slot names a start hour and a *partial* palette
override: only the colours you set change, the rest keep your base palette. When
the active slot changes the palette **crossfades over 2 seconds**.

```jsonc
"skin": {
  "palette": { "accent": "#3FD8FF", "void": "#04080F", ... },   // your base
  "schedule": {
    "enabled": true,
    "slots": {
      "dawn":  { "startHour": 5,  "palette": { "accent": "#FFB27A", "void": "#0C0A12" } },
      "day":   { "startHour": 8,  "palette": {} },               // {} = base palette
      "dusk":  { "startHour": 17, "palette": { "accent": "#FF8A5B", "void": "#160A10" } },
      "night": { "startHour": 20, "palette": { "accent": "#5B7BFF", "void": "#02040A" } }
    }
  }
}
```

- **What changes:** the seven palette tokens (`void`, `glass`, `accent`,
  `accentBright`, `muted`, `warn`, `gold`) — so component chrome, glow, borders
  and the surface colour shift together. The gradient base fill and particle
  colours are baked at load and don't recolour mid-run; drive the mood through
  the palette tokens.
- **Slots wrap.** A slot runs until the next slot's start hour; `night` wraps
  past midnight to `dawn`. Start hours are yours to set (they needn't be the
  defaults), but the order stays dawn → day → dusk → night.
- **Author it** in the editor's Skin tab → **Time of day**: toggle it on, tap a
  **palette preset** (Day & night, Warm ↔ cool, Golden hour) to fill the four
  slots from your own base colours as a starting point, tweak per-slot colours,
  and use **Preview time** to jump the stage to any slot.
- **Dev override:** launch with `DE_FAKE_HOUR=19` to force the clock to 7 pm.

## Animation timeline (`pack.timeline`)

Keyframe a handful of numeric targets over a looping cycle — fade a widget in
and out, slide it, pulse its scale, spin it, or breathe the ambience layer.

```jsonc
"timeline": {
  "duration": 8,            // seconds, 1–300
  "loop": "loop",           // loop | mirror (ping-pong) | once
  "tracks": [               // ≤ 8 tracks
    { "target": { "kind": "component", "index": 2, "prop": "y" },
      "keys": [             // ≤ 6, sorted by time
        { "t": 0, "v": 0,  "ease": "linear" },
        { "t": 4, "v": -6, "ease": "inout" },   // move up 6 cqw by the half-loop
        { "t": 8, "v": 0,  "ease": "inout" } ] },
    { "target": { "kind": "ambience", "prop": "opacity" },
      "keys": [ { "t": 0, "v": 1 }, { "t": 4, "v": 0.3 }, { "t": 8, "v": 1 } ] }
  ]
}
```

| target | `prop` | range | what it animates |
|---|---|---|---|
| `component` (by `index`) | `opacity` | 0–1 | the widget's opacity |
| | `x` / `y` | ±50 cqw | a translate offset |
| | `scale` | 0–3 | scale (1 = normal) |
| | `rotate` | ±180° | rotation, **added** to the component's base tilt |
| `ambience` | `opacity` | 0–1 | fades the whole particle layer |

- **Easing** is per key and governs the segment arriving at it: `linear`,
  `in`, `out`, `inout`. Before the first key / after the last, the value holds.
- **Composed transforms.** All of a component's animated transform props combine
  into one transform (translate · rotate · scale) and preserve its base style
  rotate, so multiple tracks on the same widget cooperate.
- **One shared loop.** The timeline (and the schedule) ride the *same* animation
  frame as ambience and parallax — never a second loop — so they honour the fps
  cap and freeze with the wallpaper. On a still surface (thumbnail, reduced
  motion) the timeline shows its first-keyframe resting frame.
- **Author it** in the editor's Skin tab → **Animation timeline**: tap a
  **ready-made motion** (Float, Breathe, Pulse, Sway, Drift, Fade in/out,
  Twinkle) to drop in a tuned track as a starting point, then tweak its
  keyframes — the columns are labelled Time · Value · Ease and it plays live
  on the stage.

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
| `gallery` | `images` (list of `assets/…`, ≤30), `interval` (2–120 s), `fit`, `transition` (`fade`/`none`), `shuffle` | looping photo slideshow inside the box |
| `divider` | `orientation` (`h`/`v`) | hairline rule |
| `calendar` | `weekStart` (`mon`/`sun`), `showReminders` | month grid, today marked, reminder days dotted |
| `pomodoro` | `focusMin` (1–180), `shortBreakMin`, `longBreakMin`, `cyclesBeforeLong` (1–12), `sound`, `notify`, `showPips` | focus/break timer: countdown ring + cycle dots, with **Start · Stop · Break · Reset** on the desktop. Break offers the short/long lengths and auto-starts when focus ends |
| `countdown` | `target` (ISO date), `label` | days/hours to a date |
| `weather` | `lat`, `lon`, `place`, `details`, `compact` | conditions with glyph, hi/lo + wind, or a one-line strip (Open-Meteo, no key — the one component that goes online) |
| `agenda` | `days` (1–14), `limit` (1–12), `label` | the user's upcoming reminders |
| `notifications` | `limit` (1–12), `label`, `showApp` | the user's live Windows notifications (needs notification access) |
| `launcher` | `pinned`, `recent`, `running`, `labels`, `iconSize` (`s`/`m`/`l`), `label` | the user's pinned/recent/open apps as clickable tiles |
| `mixer` | `showMaster`, `label` | per-app volume mixer (Windows): a master slider + a live volume slider + mute for every app currently using audio |
| `assistant` | `label`, `button` | a console line that opens the AI chat when clicked on the desktop (connects to the user's own OpenAI-compatible endpoint — a local model, a free-tier key, or their own key; configured in the manager) |
| `module` | `html`, `scroll`, `telemetry` | **your own component** — sandboxed HTML/CSS/JS you write. See [Module SDK](#module-sdk) below |

`calendar`, `agenda`, `notifications`, `launcher`, and `mixer` display the
**user's own data** (planner events managed in the engine's Planner tab; app
pins in its Launcher tab; live Windows notifications from the system; the running
apps' audio sessions for the mixer). A pack only places and styles these
components — this data is personal and is never part of a pack, an export, or a
registry download. The `mixer` shows only apps **currently using audio** (the
Windows Volume Mixer model) and is Windows-only + interactive on the desktop
(a static sample in previews); its sliders drive the Windows Core Audio API. The `notifications` component reads
the system's notifications and needs access granted under Windows Settings ›
Privacy › Notifications; without it, the component shows how to enable it.

The `pomodoro` timer is **interactive on the desktop** — **Start** (begin/resume),
**Stop** (pause, keeping the remaining time), **Break** (pick the short or long
length; while a focus session is running it's queued and auto-starts the moment
focus ends, otherwise it starts now), and **Reset** (start over). It runs in the
**background process**, not the wallpaper — so it keeps counting and rings its
phase-end notification even while a full-screen app hides the wallpaper (the
wallpaper freezes for performance, but the timer doesn't). A pack carries only
the display and the default durations; the running timer state is personal and
never part of a pack. In the editor and library previews the component shows a
static sample.

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

The built-in pack is the worked example: `packs/aegis/` (ring clock, ring
meters, per-core bars, sysinfo readouts, compact weather strip, agenda +
launcher rails, layered text panels). Copy it, rename the folder, and start
editing — it is also the project's quality floor for pack design.

## User properties (`props`)

Expose a few knobs the **user** can tweak from Manager → pack detail →
Customize, without opening the editor (Wallpaper-Engine style). Their chosen
values live in their own user data — never in your pack — so exports and forks
always carry your defaults, not someone's tweaks.

Add an optional top-level `props` array (max 16). Each entry binds one control
to one existing skin field:

```jsonc
"props": [
  { "key": "accent", "label": "Accent colour", "type": "color",
    "default": "#4DDDFF", "bind": { "target": "palette", "key": "accent" } },

  { "key": "particles", "label": "Particles", "type": "select", "default": "none",
    "options": [ { "value": "none", "label": "Off" }, { "value": "snow", "label": "Snow" } ],
    "bind": { "target": "ambience", "key": "effect" } },

  { "key": "density", "label": "Particle density", "type": "slider",
    "min": 0.05, "max": 1, "step": 0.05, "default": 0.5,
    "bind": { "target": "ambience", "key": "density" } },

  { "key": "notches", "label": "Corner notches", "type": "toggle", "default": true,
    "bind": { "target": "shape", "key": "cornerNotches" } }
]
```

`key` is a unique id (`[a-z0-9-]`). The supported `type` → `bind` pairs are the
whole contract (anything else is dropped with a warning):

| `type` | `bind.target` | `bind.key` | changes |
|--------|---------------|------------|---------|
| `color` | `palette` | `void`, `glass`, `accent`, `accentBright`, `muted`, `warn`, `gold` | that palette colour |
| `select` | `ambience` | `effect` | the particle effect (`options` values must be real effect names) |
| `slider` | `ambience` | `density` | particle density (0.05–1) |
| `slider` | `texture` | `scanlines`, `grid`, `glow`, `vignette` | that texture intensity (0–1) |
| `toggle` | `shape` | `cornerNotches` | corner notches on/off |

Every value is re-clamped to the field's real range, so a property can only
move a value the skin already allows. `aegis` ships all four control types as
a live example.

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
- **no WebRTC and no camera/microphone/geolocation** — `RTCPeerConnection` and
  `getUserMedia` are removed, and device permissions are denied engine-wide, so
  there's no back channel to leak data or reach hardware;
- **no navigation and no pop-ups** — the frame can't open windows or navigate;
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

### Steam Workshop (prototype)

If the engine is running with Steam, a pack's detail sidebar has **Publish to
Workshop…** — title, description, tags, and visibility, then it uploads
`pack.json` + `assets/` straight to Steam Workshop (the same channel Wallpaper
Engine uses). Personal data never rides along; only the shippable pack files do.

This is an early prototype wired to Steam's public **Spacewar (480)** test app,
so it works without a Steamworks partnership — items land in Spacewar's Workshop
for testing. A real release needs Dashboard Engine shipped on Steam under its
own AppID (and `steam_appid.txt`, the dev-only 480 override, removed). With no
Steam client running, the button just reports Workshop unavailable — nothing
breaks.
