# Reviewer instructions — how to interact with the dashboard (STEP BY STEP)

Paste this into the "Mark build ready for review" notes (with the moderation section
below it). Plain text is fine.

---

## About this app (context)

Dashboard Engine is a **live desktop wallpaper** (a Utilities app, not a game). Once
running, it draws an interactive dashboard directly onto your Windows desktop — behind
your desktop icons, the same way Wallpaper Engine works. You interact with it by
**clicking on the dashboard on your desktop**.

## Candidate changes since the last review

The previous report described all dashboard controls as inert after desktop
attachment. The candidate build addresses both the renderer stall path and the
native desktop path: the bundled model is spawned on a worker thread; attachment
now converts and verifies the native child-window styles and parent; helper
failures roll back cleanly; the fullscreen watcher explicitly excludes the
dashboard HWND; and an ambiguous fallback recreates a normal window. Every
attach attempt is bounded and logged.

These instructions describe the interaction test for the candidate build. They
should be used only after the exact Steam candidate has been installed; source
or development-window success is not sufficient evidence.

---

## STEP 1 — See the dashboard on your desktop

1. Launch the app from Steam. On first run the **Manager window** opens — you can close it.
2. Press **Windows key + D** (this minimizes all windows and shows your desktop).
3. You now see the dashboard covering your desktop: clocks, system meters, a weather
   panel, and — **across the very bottom of the screen** — a dark bar that reads
   **"Ask anything, or give me a task on this machine…"** with an **EXECUTE** button on
   the right. That bottom bar is the AI assistant.

> If you don't see it: make sure no other window is covering the screen (press Win+D
> again). The dashboard is your wallpaper, so any open window sits on top of it.

## STEP 2 — Use the AI assistant (the main thing to test)

1. **Click anywhere on the "Ask anything…" bar** at the bottom of the screen. (The whole
   bar is clickable, including the EXECUTE button and the empty space around the text.)
2. A **chat panel** appears above the bar.
3. The first time, the panel may show **"Warming up the assistant…"** while the
   local model loads. Continue with STEP 3 while it warms; the rest of the desktop
   must remain clickable. This separates input routing from model-response time.
4. When the text box becomes active, **type a message** (for example: `Hello, who are
   you?`) and **press Enter**.
5. The assistant **replies in text** in the panel, and **speaks the reply out loud**
   (the built-in text-to-speech voice). ✔ This confirms the AI + voice both work.
6. You can drag the panel by its top bar, and close it with the **×** in its corner.

## STEP 3 — Use the app launcher (while the AI warms up)

1. On the dashboard there is a **Launcher** area showing small **app tiles** (icons of
   apps).
2. **Click any tile.** That app **opens** on your machine (or, if it's already open, its
   window comes to the front). ✔ This confirms the dashboard receives clicks.

> The default dashboard also has a **Notifications** area — if you have any Windows
> notifications, they appear here and the **dismiss / clear** buttons remove them.

## STEP 4 — Test a custom dashboard + a manually-added element

Your report mentioned custom dashboards. To verify those interact too:

1. Open the **Manager** (right-click the app's **tray icon** — the small icon near the
   clock, bottom-right of the taskbar — and choose **Open Manager**).
2. Click **Create**, then start a new dashboard (or click **Edit** on an existing one).
3. In the editor, **add an "Assistant" component and/or a "Launcher" component** from the
   parts list, then **Save**.
4. Back in the Manager, click **Use** on that dashboard to set it on the desktop.
5. Press **Win + D** and repeat STEP 2 / STEP 3 on your new dashboard — the added
   components respond to clicks exactly the same way.

## If a click ever seems to do nothing

- Make sure you're clicking **directly on a dashboard component** (the AI bar, an app
  tile), **not** on a desktop icon sitting on top of it, and that no window is covering it
  (press **Win + D**).
- For the AI bar specifically: if you just clicked it, give it a few seconds — it may
  still be showing **"Warming up the assistant…"** (see STEP 2, point 3). Type once the
  box is active.

Thank you — please let us know if any step is unclear and we'll clarify immediately.
