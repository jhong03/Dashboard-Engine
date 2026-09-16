# Desktop interaction investigation and troubleshooting

This note records the candidate fix for the Steam report that dashboards become
non-interactive after attachment to the Windows desktop. An attached log line,
a screenshot, or a DOM `element.click()` does not prove that a physical mouse
event reached the desktop window.

## Diagnostic run

Use a disposable profile or VM when testing a packaged build. Enable the bounded
renderer trace for one run:

```powershell
$env:DE_INPUT_TRACE = '1'
& 'Dashboard Engine.exe'
```

The rotating log is `%APPDATA%\dashboard-engine\logs\engine.log`. Relevant lines
include the launch route, display resolution, attach attempt/result, helper
stderr, fullscreen transitions, and `[INPUT]` renderer milestones. The trace
never records typed text, key values, clipboard data, notification contents, or
tokens.

The focused helper check is safe to run on a development checkout:

```powershell
npm.cmd run desktop-check
npm.cmd run packs -- validate
```

`desktop-check` rejects an invalid HWND and starts the fullscreen watcher long
enough to observe its initial state. It does not call `SetParent` on Explorer.

Fresh VM consoles can take longer to initialize PowerShell's embedded C# helper
than a developer machine, so the packaged attach attempt is bounded at 30 seconds.
The Manager also clamps and centers itself to the available work area; this keeps
first-run onboarding visible on small VM displays such as 820x615.

## Interpreting the trace

- No `pointerdown` line after a real click: investigate the native HWND, parent,
  z-order, shell hit testing, and Explorer desktop hierarchy.
- `pointerdown`/`click` followed by `power active=0` or `freeze-start`: the
  fullscreen/power path is stopping the renderer; inspect the watcher state and
  dashboard HWND exclusion.
- Click and focus milestones with no visible change: inspect the component
  handler, IPC response, and renderer error/rejection lines.

The candidate helper records the parent and style after every attach. A first
`SetParent` call may return a null previous parent on success; the post-call
parent relationship is authoritative. On failure, the helper restores the saved
parent, style, and bounds. If main cannot verify that restoration, it destroys
the ambiguous HWND and creates a fresh ordinary window.

## Acceptance status

Local syntax, parser, controlled helper, pack-validation, and diff checks pass on
the development host. The local directory candidate is `dist/win-unpacked`, built
from checkout `HEAD` `6cf97b9983b117b93b42cb64241dcc4ca150f2c2` plus the
uncommitted working-tree candidate changes, with executable SHA-256
`DA7118BAF6F96133633A62B4ADA9D66CABF0492638D242CD2E7CFE6A2E8ABA76`.

| Environment | Launch route | Result | Evidence |
|---|---|---|---|
| Development host, Windows 10 Pro 25H2 / build 26200, AMD64 console session | Node helper checks | Pass | `npm.cmd run desktop-check`; all packs validate |
| Local packaged directory, same host and checkout plus working-tree patch | `dist/win-unpacked` (not Steam) | Built and payload-audited; physical input unrun | `npm.cmd run pack`; source/package hashes match |
| Clean Windows VM | Steam or exact local candidate | Pending | Requires a disposable Windows guest |
| Physical Windows PC | Steam or exact local candidate | Pending | Requires a real mouse/keyboard run |
| Steam candidate | Steam launch/session + installed BuildID | Pending | No upload/branch change was authorized |

Do not describe the Steam issue as resolved until the pending environments record
real mouse and keyboard results.
