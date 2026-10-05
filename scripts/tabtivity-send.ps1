# Windows twin of tabtivity-send.sh. Binary stdin is read without text conversion.
$ErrorActionPreference = 'Stop'
function Fail($Code, $Message) { [Console]::Error.WriteLine("tabtivity-send: $Message"); exit $Code }
if ($args.Count -eq 0 -or $args[0] -eq '--help') {
    Write-Output "tabtivity-send FILE...`ncommand | tabtivity-send -n NAME`ntabtivity-send --clear"
    if ($args.Count -eq 0) { exit 2 }; exit 0
}
$fromStdin = $args[0] -eq '-n'
$clear = $args[0] -eq '--clear'
if (($fromStdin -and $args.Count -ne 2) -or ($clear -and $args.Count -ne 1)) { Fail 2 'Invalid arguments; use --help.' }
if ($args[0].StartsWith('-') -and -not $fromStdin -and -not $clear -and $args[0] -ne '--') { Fail 2 'Unknown option; use --help.' }
if ($args[0] -eq '--') { $args = @($args | Select-Object -Skip 1) }
$root = $env:TABTIVITY_PROJECT_DIR
if (-not $root) {
    try { $root = & git rev-parse --show-toplevel 2>$null }
    catch { Fail 3 'Set TABTIVITY_PROJECT_DIR or run inside a git project.' }
}
if (-not $root -or -not [IO.Directory]::Exists($root)) { Fail 3 'Set TABTIVITY_PROJECT_DIR or run inside a git project.' }
$root = [IO.Path]::GetFullPath($root)
$outbox = Join-Path $root '.tabtivity/outbox'
# The agent tab sending: its phone chat shows the file; every gallery lists it.
$tab = $env:TABTIVITY_TAB_UID
if ($tab -notmatch '^[A-Za-z0-9-]{1,64}$') { $tab = $null }
foreach ($dir in @((Join-Path $root '.tabtivity'), $outbox)) {
    if ((Test-Path -LiteralPath $dir) -and ((Get-Item -Force -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail 3 'The outbox must not be a symlink.' }
}
try { [void][IO.Directory]::CreateDirectory($outbox) }
catch { Fail 3 'Cannot create the project outbox.' }
if ($clear) {
    Get-ChildItem -Force -LiteralPath $outbox -File | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Remove-Item -Force
    Write-Output 'tabtivity-send: outbox cleared.'; exit 0
}
$ignored = $false
try { & git -C $root check-ignore -q .tabtivity/ 2>$null; $ignored = $LASTEXITCODE -eq 0 } catch {}
if (-not $ignored) { [Console]::Error.WriteLine('tabtivity-send: warning: .tabtivity/ is not git-ignored; ignore it before committing.') }
$sources = if ($fromStdin) { @($args[1]) } else { @($args) }
foreach ($source in $sources) {
    $inputStream = $null; $outputStream = $null
    $stage = Join-Path $outbox ('.send-' + [guid]::NewGuid().ToString('N'))
    try {
        if ($fromStdin) { $inputStream = [Console]::OpenStandardInput() }
        else {
            if (-not [IO.File]::Exists($source)) { Fail 4 'Only regular files can be sent.' }
            $inputStream = [IO.File]::OpenRead([IO.Path]::GetFullPath($source))
        }
        $outputStream = [IO.File]::Open($stage, [IO.FileMode]::CreateNew)
        $buffer = New-Object byte[] 65536
        $size = 0
        while (($count = $inputStream.Read($buffer, 0, [Math]::Min($buffer.Length, 25165825 - $size))) -gt 0) {
            $outputStream.Write($buffer, 0, $count); $size += $count
            if ($size -gt 25165824) { break }
        }
        $outputStream.Dispose(); $outputStream = $null
        if ($size -eq 0 -or $size -gt 25165824) { Fail 4 'Files must be nonempty and at most 24 MiB.' }
        $name = ([IO.Path]::GetFileName($source) -replace '[^A-Za-z0-9._-]', '_').TrimStart('.')
        if (-not $name) { $name = 'file' }
        $ext = [IO.Path]::GetExtension($name)
        if ($ext.Length -gt 16) { $ext = $ext.Substring(0,16) }
        $stem = [IO.Path]::GetFileNameWithoutExtension($name)
        if ($stem.Length -gt (80 - $ext.Length)) { $stem = $stem.Substring(0, 80 - $ext.Length) }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $suffix = ''; $n = 0
        while ($true) {
            $leaf = "$stamp-$stem$suffix$ext"
            $dest = Join-Path $outbox $leaf
            $marker = Join-Path $outbox ".$leaf.tab"
            # A leaf with no file and no sender marker; the marker lands first,
            # so the phone never lists this file unclaimed.
            if ((Test-Path -LiteralPath $dest) -or (Test-Path -LiteralPath $marker)) { $n++; $suffix = "-$n"; continue }
            if ($tab) { [IO.File]::WriteAllText($marker, $tab) }
            try { [IO.File]::Move($stage, $dest); break }
            catch [IO.IOException] {
                if ($tab) { [IO.File]::Delete($marker) }
                if (-not (Test-Path -LiteralPath $dest)) { throw }; $n++; $suffix = "-$n"
            }
        }
        Write-Output "phone: $leaf ($([Math]::Ceiling($size / 1024)) KB) - preview or download (the phone checks its bytes)"
    } catch { Fail 4 $_.Exception.Message }
    finally {
        if ($inputStream) { $inputStream.Dispose() }
        if ($outputStream) { $outputStream.Dispose() }
        if ([IO.File]::Exists($stage)) { [IO.File]::Delete($stage) }
    }
}
