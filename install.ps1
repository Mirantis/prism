#!/usr/bin/env pwsh
#
# Prism installer (Windows).
#
# The PowerShell counterpart of install.sh. Installs the `prism` (terminal UI)
# and `prism-server` (agent runtime) binaries plus the server's sidecar
# (node_modules\, web\) into %USERPROFILE%\.prism, puts `prism` on the user
# PATH, and registers `prism-server` to run always via a "PrismServer"
# scheduled task (the Windows analog of the launchd/systemd user services the
# bash installer creates -- it runs at logon, restarts on failure, and needs
# no admin elevation).
#
# Run via the one-liner:
#   irm https://raw.githubusercontent.com/lensapp/prism-agent/main/install.ps1 | iex
# or from a built checkout (after scripts/build-sea.mjs + collect-natives.mjs),
# or point $env:PRISM_DIST at a directory containing the artifacts.
#
# No dependencies are installed: Windows 10/11 ship PowerShell with everything
# this script uses (Invoke-RestMethod, Expand-Archive, Register-ScheduledTask).

$ErrorActionPreference = 'Stop'
# Force TLS 1.2 for older Windows PowerShell hosts that still default to 1.0/1.1,
# and silence the progress UI so Invoke-WebRequest downloads at full speed.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$PrismHome = if ($env:PRISM_HOME) { $env:PRISM_HOME } else { Join-Path $env:USERPROFILE '.prism' }

# Only win32-x64 is published (CI builds on windows-latest, which is x64). On
# ARM64 the x64 build runs fine under Windows' x64 emulation.
$osArch = 'win32-x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Write-Host "Note: ARM64 detected; installing the x64 build (runs under emulation)."
}

$tmp = $null
try {
  # Locate the artifacts. Prefer an explicit $env:PRISM_DIST or a local build
  # next to this script (running from a checkout / extracted zip); otherwise
  # download the latest release. When run via `irm | iex`, $PSScriptRoot is
  # empty, so the download path is taken automatically.
  $dist = $null
  if ($env:PRISM_DIST) {
    $dist = $env:PRISM_DIST
  } elseif ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "dist-sea\$osArch\prism.exe"))) {
    $dist = Join-Path $PSScriptRoot "dist-sea\$osArch"
  }

  if (-not $dist -or -not (Test-Path (Join-Path $dist 'prism.exe'))) {
    Write-Host "No local build found; fetching the latest release from GitHub..."
    $headers = @{ 'User-Agent' = 'prism-installer' }
    $tag = (Invoke-RestMethod -Uri 'https://api.github.com/repos/lensapp/prism-agent/releases/latest' -Headers $headers).tag_name
    if (-not $tag) {
      throw "Could not resolve the latest release. Set `$env:PRISM_DIST to a local build to install offline."
    }
    $archive = "prism-$tag-$osArch.zip"
    $url = "https://github.com/lensapp/prism-agent/releases/download/$tag/$archive"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("prism-" + [System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zipPath = Join-Path $tmp $archive
    Write-Host "Downloading $archive ($tag)..."
    try {
      $iwParams = @{ Uri = $url; OutFile = $zipPath; Headers = $headers }
      if ($PSVersionTable.PSEdition -eq 'Desktop') { $iwParams.UseBasicParsing = $true }
      Invoke-WebRequest @iwParams
    } catch {
      throw "Download failed: $url`nMake sure the latest release publishes $archive."
    }
    Write-Host "Extracting..."
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    $dist = Join-Path $tmp $osArch
    if (-not (Test-Path (Join-Path $dist 'prism.exe')) -or -not (Test-Path (Join-Path $dist 'prism-server.exe'))) {
      throw "Extracted archive doesn't contain the expected layout at $osArch\."
    }
  }

  Write-Host "Installing Prism into $PrismHome (from $dist)"
  New-Item -ItemType Directory -Path $PrismHome -Force | Out-Null

  # Stop a running instance first so its exe isn't locked while we overwrite it
  # (matters on reinstall -- Windows refuses to replace an in-use file).
  try { Stop-ScheduledTask -TaskName 'PrismServer' -ErrorAction Stop | Out-Null } catch { }
  Get-Process -Name 'prism-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  Copy-Item -Path (Join-Path $dist 'prism.exe') -Destination (Join-Path $PrismHome 'prism.exe') -Force
  Copy-Item -Path (Join-Path $dist 'prism-server.exe') -Destination (Join-Path $PrismHome 'prism-server.exe') -Force
  foreach ($sub in 'node_modules', 'web') {
    $target = Join-Path $PrismHome $sub
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Path (Join-Path $dist $sub) -Destination $target -Recurse -Force
  }

  # Config template -- never clobber an existing one. Bake
  # AWS_BEARER_TOKEN_BEDROCK from the installer's environment when set; the
  # scheduled task runs with an isolated env, so a shell export otherwise
  # wouldn't reach the server. In SEA, prism-server loads `.env` from the
  # directory containing the executable (e.g. $PrismHome\.env).
  $envPath = Join-Path $PrismHome '.env'
  if (-not (Test-Path $envPath)) {
    $bearer = if ($env:AWS_BEARER_TOKEN_BEDROCK) { $env:AWS_BEARER_TOKEN_BEDROCK } else { '' }
    $envContent = @"
# Prism server configuration. Restart the service after editing:
#   Restart-ScheduledTask -TaskName PrismServer
#
# The prism-server binary sets its own database path before this file is read,
# so setting DATABASE_URL here has no effect -- move `$env:PRISM_HOME if you
# need a different location.
AWS_BEARER_TOKEN_BEDROCK=$bearer
# SLACK_BOT_TOKEN=
# SLACK_APP_TOKEN=
"@
    Set-Content -Path $envPath -Value $envContent -Encoding ascii
    if ($bearer) {
      Write-Host "Wrote $envPath with AWS_BEARER_TOKEN_BEDROCK from the installer environment."
    } else {
      Write-Host "Wrote $envPath - set AWS_BEARER_TOKEN_BEDROCK for chat."
    }
  }

  # Put $PrismHome on the user PATH so `prism` resolves to prism.exe (no symlink
  # needed on Windows). Update both the persisted user PATH and this session.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $userParts = if ($userPath) { $userPath -split ';' } else { @() }
  if ($userParts -notcontains $PrismHome) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $PrismHome } else { $userPath.TrimEnd(';') + ';' + $PrismHome }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "Added $PrismHome to your user PATH."
  }
  if (($env:Path -split ';') -notcontains $PrismHome) {
    $env:Path = $env:Path.TrimEnd(';') + ';' + $PrismHome
  }

  # Register prism-server to run always. AtLogOn start + restart-on-failure +
  # no execution time limit mirror launchd KeepAlive / systemd Restart=always.
  # The default principal runs as the current user only while logged on (like
  # the launchd gui agent / systemd --user service), so no admin is required.
  $action = New-ScheduledTaskAction -Execute (Join-Path $PrismHome 'prism-server.exe') -WorkingDirectory $PrismHome
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settingsArgs = @{
    AllowStartIfOnBatteries    = $true
    DontStopIfGoingOnBatteries = $true
    RestartCount               = 999
    RestartInterval            = (New-TimeSpan -Minutes 1)
    ExecutionTimeLimit         = [TimeSpan]::Zero
    MultipleInstances          = 'IgnoreNew'
  }
  $settings = New-ScheduledTaskSettingsSet @settingsArgs
  $registerArgs = @{
    TaskName    = 'PrismServer'
    Action      = $action
    Trigger     = $trigger
    Settings    = $settings
    Description = 'Prism agent runtime'
    Force       = $true
  }
  Register-ScheduledTask @registerArgs | Out-Null
  Start-ScheduledTask -TaskName 'PrismServer'
  Write-Host "Registered and started scheduled task PrismServer"

  Write-Host ""
  Write-Host "Done. prism-server is starting on http://127.0.0.1:3003 - run 'prism' to connect."
  Write-Host "Open a new terminal so the updated PATH takes effect."
} finally {
  if ($tmp -and (Test-Path $tmp)) {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
