# Dismiss the user's live Windows notifications (clear one, some, or all) via the
# WinRT UserNotificationListener, for the `notifications` component's clear/X
# buttons. Args: -Ids "all"  OR  -Ids "123,456"  (uint32 ids from
# notifications-list.ps1). Emits {"ok":true|false}. Read-only otherwise.
param([string]$Ids = '')
$ErrorActionPreference = 'Stop'
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

  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $accessType = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]
  $access = Await ($listener.RequestAccessAsync()) $accessType
  if ("$access" -ne 'Allowed') { [Console]::Out.WriteLine('{"ok":false}'); return }

  if ($Ids -eq 'all') {
    # No ClearNotifications API — enumerate the current toasts and remove each.
    $listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
    $notifs = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType
    foreach ($n in $notifs) { try { $listener.RemoveNotification($n.Id) } catch {} }
  } else {
    foreach ($idStr in ($Ids -split ',')) {
      $id = 0
      if ([uint32]::TryParse($idStr.Trim(), [ref]$id)) { try { $listener.RemoveNotification($id) } catch {} }
    }
  }
  [Console]::Out.WriteLine('{"ok":true}')
}
catch {
  [Console]::Out.WriteLine('{"ok":false}')
}
