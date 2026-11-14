# Windows twin of tabtivity-mcp.sh, kept line for line with it: same commands,
# exit codes and messages. The token goes in a request header, never in argv,
# and only to a loopback URL. Windows PowerShell 5.1 and PowerShell 7 both run it.
$ErrorActionPreference = 'Stop'
$me = 'tabtivity-mcp'
function Fail($Code, $Message) { [Console]::Error.WriteLine("${me}: $Message"); exit $Code }
function Usage {
    Write-Output @(
        "$me                          list the servers this tab can use",
        "$me tools SERVER             list a server's tools and their arguments (JSON)",
        "$me call SERVER TOOL [JSON]  call a tool; JSON is its arguments object (default {}, - reads stdin)",
        "$me --help",
        '',
        'SERVER is a name from the list (print, git, markup, help, cockpit, tabs, schedule, root).')
}
$lanes = @('print', 'git', 'markup', 'help', 'cockpit', 'tabs', 'schedule', 'root')

# The env pair of a lane: its URL and token, or $null when this tab has none.
function LaneEnv($Lane) {
    $upper = $Lane.ToUpperInvariant()
    $url = [Environment]::GetEnvironmentVariable("TABTIVITY_${upper}_MCP_URL")
    $token = [Environment]::GetEnvironmentVariable("TABTIVITY_${upper}_MCP_TOKEN")
    if ($url -and $token) { return @{ Url = $url; Token = $token } }
    return $null
}

# One JSON-RPC request to a lane; returns the response body.
function Post($Lane, $Pair, $Body) {
    if ($Pair.Url -notmatch '^http://127\.0\.0\.1:[0-9]+/mcp') { Fail 3 "The $Lane server's address is not a local one; refusing to send its token." }
    $headers = @{ Authorization = "Bearer $($Pair.Token)"; Accept = 'application/json' }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $Pair.Url -Headers $headers -ContentType 'application/json' -Body $bytes -TimeoutSec 120
    } catch { Fail 3 "The $Lane server did not answer: $($_.Exception.Message)" }
    if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
    return [string]$response.Content
}

if ($args.Count -eq 0) { $args = @('list') }
switch -CaseSensitive ($args[0]) {
    { $_ -in @('--help', '-h', 'help') } { Usage; exit 0 }
    'list' {
        if ($args.Count -ne 1) { Fail 2 'Use list alone.' }
        $found = $false
        foreach ($lane in $lanes) {
            if (LaneEnv $lane) {
                if (-not $found) { Write-Output 'Servers this tab can use (tabtivity-mcp tools SERVER for their tools):' }
                $found = $true
                Write-Output "  $lane"
            }
        }
        if (-not $found) { Fail 3 'This tab holds no Tabtivity MCP server (only local project agent tabs do).' }
        exit 0
    }
    { $_ -in @('tools', 'call') } { break }
    default { Fail 2 "Unknown command $($args[0]); use --help." }
}

$cmd = $args[0]
if ($args.Count -lt 2) { Fail 2 'Name a server; run tabtivity-mcp to list them.' }
$lane = ([string]$args[1]) -replace '^tabtivity-', ''
if ($lane -ceq 'tabtivity') { $lane = 'root' }
if ($lanes -notcontains $lane) { Fail 2 "Unknown server $lane; run tabtivity-mcp to list them." }
$pair = LaneEnv $lane
if (-not $pair) { Fail 3 "This tab has no $lane server; run tabtivity-mcp to list them." }

if ($cmd -ceq 'tools') {
    if ($args.Count -ne 2) { Fail 2 'Use tools SERVER alone.' }
    Write-Output (Post $lane $pair '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    exit 0
}

if ($args.Count -lt 3) { Fail 2 'Name a tool; run tabtivity-mcp tools SERVER for the list.' }
$tool = [string]$args[2]
if ($tool -notmatch '^[A-Za-z0-9_-]+$') { Fail 2 "Not a tool name: $tool" }
if ($args.Count -gt 4) { Fail 2 "Pass the arguments as one JSON object, quoted: '{""key"": ""value""}'." }
$arguments = if ($args.Count -eq 4) { [string]$args[3] } else { '{}' }
if ($arguments -ceq '-') { $arguments = [Console]::In.ReadToEnd() }
if (-not $arguments.Contains('{')) { Fail 2 'The arguments must be a JSON object, like {"path": "out.pdf"}.' }
$out = Post $lane $pair ('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"' + $tool + '","arguments":' + $arguments + '}}')
Write-Output $out
# A refused or failed call exits 1, so a script can tell.
if ($out.Contains('"isError":true') -or $out.Contains('"error":{') -or $out.Contains('"status":"refused"')) { exit 1 }
