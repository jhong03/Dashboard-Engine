# Read the user's live Windows notifications via the WinRT
# UserNotificationListener, as JSON, for the `notifications` component.
# Read-only. Invoked by main with a fixed argv (CLAUDE.md shell rule).
#
# Output (always one JSON line):
#   { ok, granted, status, items:[{ app, title, body, time }] }
# granted=false with a status ('Denied'/'Unspecified'/...) means the user
# has not allowed notification access; the component shows how to enable it.

$ErrorActionPreference = 'Stop'
$MAX = 40

function Emit($obj) { $obj | ConvertTo-Json -Compress -Depth 4 }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  # WinRT IAsyncOperation<T> → wait synchronously via AsTask + reflection.
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($op))
    $task.Wait(8000) | Out-Null
    $task.Result
  }

  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications.Management, ContentType=WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null

  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $accessType = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]
  $access = Await ($listener.RequestAccessAsync()) $accessType
  if ("$access" -ne 'Allowed') {
    Emit ([pscustomobject]@{ ok = $true; granted = $false; status = "$access"; items = @() })
    return
  }

  $listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
  $notifs = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType

  $items = New-Object System.Collections.ArrayList
  foreach ($n in $notifs) {
    if ($items.Count -ge $MAX) { break }
    $texts = @()
    try {
      $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
      if ($binding) { $texts = @($binding.GetTextElements() | ForEach-Object { $_.Text }) }
    } catch {}
    $app = ''
    try { $app = $n.AppInfo.DisplayInfo.DisplayName } catch {}
    [void]$items.Add([pscustomobject]@{
      app   = $app
      title = if ($texts.Count -ge 1) { $texts[0] } else { '' }
      body  = if ($texts.Count -ge 2) { ($texts[1..($texts.Count - 1)] -join '  ') } else { '' }
      time  = $n.CreationTime.UtcDateTime.ToString('o')
    })
  }
  # -Depth so nested item objects serialize; force items to an array shape.
  Emit ([pscustomobject]@{ ok = $true; granted = $true; status = 'Allowed'; items = @($items) })
}
catch {
  Emit ([pscustomobject]@{ ok = $false; error = $_.Exception.Message; items = @() })
}
