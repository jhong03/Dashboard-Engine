# Translate Dashboard Engine

The interface can speak any language. English ships in the app; every other
language is a single JSON file. **Anyone can make one** — no account and no
programming required.

English (`en.json`) is always the source of truth for *which* text keys exist.
Any key your translation leaves out just falls back to English, so a partial or
in-progress translation works fine.

**Included today:** English, Spanish (`es`), French (`fr`), Chinese (`zh`),
Japanese (`ja`), Korean (`ko`).

---

## 1 · Make your translation

Pick whichever is comfortable — both produce the same result.

**A. In a spreadsheet (easiest).** Open **`i18n-template.csv`** in Excel, Google
Sheets, or LibreOffice. It has three columns: `key`, `english`, `translation`.
Fill in the **translation** column and save. Leave a row blank to keep English.

**B. Edit the JSON directly (no tools, and you can test it immediately).** Make a
copy of `en.json`, rename it to your 2-letter language code (e.g. `de.json`,
`pt.json`, `it.json`), and translate the text on the right of each `":"`. Leave
the `"key"` on the left unchanged.

## 2 · Try it in the app right away

If you made a **JSON** file (path B), drop it into your personal locales folder
and restart Dashboard Engine — no reinstall needed:

```
%APPDATA%\dashboard-engine\locales\<code>.json      (Windows)
```

Then choose it in **Manager → Settings → Language** (or set Language to
Automatic and it follows your system language).

*(Made a spreadsheet instead? Send it in — we convert it to JSON and it comes
back to everyone in an app update. If you have the developer tools, you can also
convert it yourself: `node scripts/i18n-csv.js import <code> your-sheet.csv`.)*

## 3 · Share it with everyone

Post your finished file — the `.csv` **or** the `.json` — in the **Translations**
thread on our Steam Community Discussions (or open a pull request on the public
translation repo). Good translations get bundled into the app so every user gets
them, and we credit contributors. Corrections and improvements are always
welcome.

---

## A few rules that keep a translation working

- **Keep placeholders exactly:** `{name}`, `{count}`, `{pct}`, `{size}`, … They
  get replaced with live values. Translate the words around them; never translate
  or delete the `{...}` itself. You may move it to fit your grammar.
- **Keep the simple tags:** some lines contain `<b>`, `<strong>`, `<em>`, `<i>`,
  `<code>`, `<kbd>`, `<small>`, `<u>`, `<br>`. Keep the tags; translate the text
  between them. No other HTML is allowed (it's stripped for safety).
- **Leave identifiers as-is:** product names (Dashboard Engine, Steam, Workshop,
  Windows, Spotify…), anything inside `<code>…</code>` (URLs, model names, `/v1`,
  `sk-`, `DE.onData`, `--de-*`), file names like `PACKS.md`, and palette keys like
  `void · glass · accent`.
- Keep it short — most lines are buttons, labels, and hints in a compact UI.
