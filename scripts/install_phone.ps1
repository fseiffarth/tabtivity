# Tabtivity Mobile phone-install handoff (Windows). The PowerShell twin of
# install_phone.sh: verifies that Tailscale Serve maps the verified private
# origin onto the configured loopback port, then prints the trusted URL and a
# scannable QR code. It does not enable Mobile or change your Tailscale
# configuration.
param([switch]$Url)

$ErrorActionPreference = 'Stop'

# The app writes this script into <state dir>\mobile-control\ and runs it from
# there, so the state dir is the folder above - whatever it is called and
# wherever an override put it. Run from a checkout instead, fall back to
# storage::state_dir on Windows: TABTIVITY_STATE_DIR, else %APPDATA%\tabtivity.
$stateDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $stateDir 'settings.json'))) {
  $stateDir = if ($env:TABTIVITY_STATE_DIR) { $env:TABTIVITY_STATE_DIR } else { Join-Path $env:APPDATA 'tabtivity' }
}
$settingsPath = Join-Path $stateDir 'settings.json'

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  Write-Error 'Tailscale is not installed'
  exit 1
}
if (-not (Test-Path -LiteralPath $settingsPath)) {
  Write-Error 'Tabtivity settings are unavailable'
  exit 1
}

$settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
$mobile = $settings.tabtivity_mobile_host
$port = if ($mobile -and $mobile.port) { [int]$mobile.port } else { 8742 }
$origin = if ($mobile) { [string]$mobile.serve_origin } else { '' }
if (-not ($origin -match '^https://([^/:]+)(:([0-9]+))?$')) {
  Write-Error 'No verified exact HTTPS Serve origin is configured'
  exit 1
}
$serveHost = $Matches[1]
$publicPort = if ($Matches[3]) { $Matches[3] } else { '443' }
$authority = "${serveHost}:${publicPort}"

$serve = (& tailscale serve status --json) | ConvertFrom-Json
$needle = "http://127.0.0.1:$port"
$tcp = $serve.TCP.$publicPort
$web = $serve.Web.$authority
$funnel = $false
if ($serve.AllowFunnel) { $funnel = [bool]$serve.AllowFunnel.$authority }
$mapped = ($tcp -and $tcp.HTTPS -eq $true) -and
  ($web -and $web.Handlers.'/'.Proxy -eq $needle) -and
  (-not $funnel)
if (-not $mapped) {
  Write-Error 'Tailscale Serve does not have the verified private root mapping to the configured loopback port'
  exit 1
}

if ($Url) {
  Write-Output $origin
  exit 0
}

Write-Output 'Open this private URL on your phone:'
Write-Output $origin
if (Get-Command qrencode -ErrorAction SilentlyContinue) {
  # Plain UTF-8 blocks, no ANSI colours: the terminal theme picks the contrast.
  & qrencode -t UTF8 $origin
} else {
  Write-Output 'Install qrencode (winget install qrencode, or scoop) to print a terminal QR code.'
}
Write-Output 'Then use Install app / Add to Home Screen and pair it from Tabtivity Settings.'
