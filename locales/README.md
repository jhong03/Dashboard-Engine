# Translating Dashboard Engine

The interface can speak any language. English ships in the app; every other
language is a single JSON file in this folder. **Anyone can add one** — no code,
no build step.

Currently bundled: **English (`en`), Spanish (`es`), French (`fr`), Chinese
(`zh`), Japanese (`ja`), Korean (`ko`)**. `en.json` is always the source of truth
for *which* text keys exist; any key a translation leaves out simply falls back
to English at runtime, so a partial translation is perfectly fine.

## The easy way: fill a spreadsheet

1. Open **`i18n-template.csv`** (in the repo root) in Excel, Google Sheets, or
   LibreOffice. It has three columns: `key`, `english`, `translation`.
2. Fill in the **`translation`** column. Leave a row blank to keep the English.
3. Turn it back into a locale file:

   ```
   node scripts/i18n-csv.js import <code> your-filled-sheet.csv
   ```

   `<code>` is a 2-letter language code (e.g. `de`, `pt`, `it`). This writes
   `locales/<code>.json`.

To start from an existing translation instead of a blank sheet (to fix or finish
one), export it first: `node scripts/i18n-csv.js export <code>`.

## Using your translation right away

Drop your `<code>.json` into your **user** locales folder and restart the app —
no rebuild needed:

```
%APPDATA%\dashboard-engine\locales\<code>.json      (Windows)
```

Then pick it in **Manager → Settings → Language** (or set the language to
Automatic and it follows your OS locale).

## Contributing it back

Share your finished `locales/<code>.json` (open a pull request, or send it) and
it can be bundled so everyone gets it. Community translations are welcome and
refined over time.

## Rules that keep a translation working

- **Keep placeholders exactly:** `{name}`, `{count}`, `{pct}`, `{size}`, … They
  are replaced with live values. Translate the words around them; never translate
  or delete the `{...}` itself. You may move it to fit your grammar.
- **Keep the simple tags:** some strings contain `<b>`, `<strong>`, `<em>`,
  `<i>`, `<code>`, `<kbd>`, `<small>`, `<u>`, `<br>`. Keep the tags; translate the
  text between them. (No other HTML is allowed — it is stripped for safety.)
- **Leave identifiers literal:** product names (Dashboard Engine, Steam,
  Workshop, Windows, Spotify…), anything inside `<code>…</code>` (URLs, model
  names, `/v1`, `sk-`, `DE.onData`, `--de-*`), file names like `PACKS.md`, and
  palette keys like `void · glass · accent`.
- Keep it short — most strings are buttons, labels, and hints in a compact UI.
