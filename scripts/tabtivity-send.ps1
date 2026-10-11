# Windows twin of tabtivity-send.sh, kept line for line with it: same exit
# codes, messages, marker leaves and caps. Binary stdin is read without text
# conversion. Windows PowerShell 5.1 and PowerShell 7 both run it.
$ErrorActionPreference = 'Stop'
function Fail($Code, $Message) { [Console]::Error.WriteLine("tabtivity-send: $Message"); exit $Code }
function Usage { Write-Output @('tabtivity-send FILE...', 'command | tabtivity-send -n NAME', 'tabtivity-send --clear', 'tabtivity-send --help') }
if ($args.Count -eq 0) { Usage; exit 2 }
if ($args[0] -ceq '--help') { Usage; exit 0 }
$mode = 'files'
$label = $null
switch -CaseSensitive ($args[0]) {
    '--clear' { if ($args.Count -ne 1) { Fail 2 'Use --clear alone.' }; $mode = 'clear' }
    '-n' { if ($args.Count -ne 2) { Fail 2 'Use -n NAME for stdin.' }; $mode = 'stdin'; $label = $args[1] }
    '--' { $args = @($args | Select-Object -Skip 1); if ($args.Count -eq 0) { Fail 2 'Name at least one file.' } }
    default { if (([string]$args[0]).StartsWith('-')) { Fail 2 'Unknown option; use --help.' } }
}
$root = $env:TABTIVITY_PROJECT_DIR
if (-not $root) {
    try { $root = & git rev-parse --show-toplevel 2>$null; if ($LASTEXITCODE -ne 0) { $root = $null } }
    catch { $root = $null }
    if (-not $root) { Fail 3 'Set TABTIVITY_PROJECT_DIR or run inside a git project.' }
}
if (-not [IO.Directory]::Exists($root)) { Fail 3 'The project directory is unavailable.' }
$root = [IO.Path]::GetFullPath($root)
# The project root with one trailing separator, the prefix a project file's
# full path starts with (`origin_of` in the sh twin strips `$root/`).
$rootPrefix = $root.TrimEnd('\') + '\'
# Refuse redirected outboxes, especially before --clear.
$outbox = [IO.Path]::GetFullPath((Join-Path $root '.tabtivity\outbox'))
foreach ($dir in @((Join-Path $root '.tabtivity'), $outbox)) {
    if ((Test-Path -LiteralPath $dir) -and ((Get-Item -Force -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail 3 'The outbox must not be a symlink.' }
}
# The agent tab sending (its `TABTIVITY_TAB_UID`): that tab's phone chat shows
# the file; every gallery lists it. No tab (a plain shell): gallery only.
$tab = $env:TABTIVITY_TAB_UID
if ($tab -cnotmatch '^[A-Za-z0-9-]{1,64}\z') { $tab = $null }
try { [void][IO.Directory]::CreateDirectory($outbox) }
catch { Fail 3 'Cannot create the project outbox.' }
# One send or clear at a time: the `.send-lock` directory is the mutex,
# removed in `finally` on every exit, `Fail` included. A fresh private
# directory renamed onto it is the atomic `mkdir` of the sh twin: the rename
# fails when the lock exists. (`New-Item -Path` would read `[`/`]` in a
# project path as wildcards on some PowerShell versions.)
$lock = Join-Path $outbox '.send-lock'
$claim = Join-Path $outbox ('.send-' + [guid]::NewGuid().ToString('N'))
try { [void][IO.Directory]::CreateDirectory($claim); [IO.Directory]::Move($claim, $lock) }
catch {
    try { if ([IO.Directory]::Exists($claim)) { [IO.Directory]::Delete($claim) } } catch {}
    Fail 5 'Another send or clear is in progress; retry shortly.'
}

# Regular, non-symlink files in the outbox (its markers included): what a
# clear removes and what the 1 GiB cap sums.
function OutboxFiles {
    @(Get-ChildItem -Force -LiteralPath $outbox -File | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
}

# Where a sent file lives in the project, root-relative with `/`, for its
# origin marker: the phone then opens the project file itself, and its marks
# are the files drawer's. Empty for a file outside the project, an outbox file
# sent again, or a path the marker could not hold.
function OriginOf($Full) {
    $dir = [IO.Path]::GetDirectoryName($Full)
    if (-not $dir) { return '' }
    if (-not $dir.EndsWith('\')) { $dir = $dir + '\' }
    if (-not $dir.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { return '' }
    $rel = ($dir.Substring($rootPrefix.Length) + [IO.Path]::GetFileName($Full)).Replace('\', '/')
    if ($rel.StartsWith('.tabtivity/', [StringComparison]::OrdinalIgnoreCase) -or $rel.Contains("`n")) { return '' }
    return $rel
}

# A directory entry by that name, a dangling link included: the sh twin's
# `[ -e ] || [ -L ]`. `Test-Path` follows links, and a marker written through
# a dangling one would land wherever it points.
function Present($Path) { try { [void][IO.File]::GetAttributes($Path); return $true } catch { return $false } }

# What the phone does with the first bytes: the sh twin's `od` magic table and
# its UTF-8 check of the first 4096 bytes (no NUL, every sequence well formed;
# a sequence cut by the 4096 limit is fine, one cut by the end of the file is not).
function KindOf($Path) {
    $head = New-Object byte[] 4096
    $read = 0
    $stream = [IO.File]::OpenRead($Path)
    try {
        while ($read -lt $head.Length) {
            $count = $stream.Read($head, $read, $head.Length - $read)
            if ($count -le 0) { break }
            $read += $count
        }
    } finally { $stream.Dispose() }
    $magic = [BitConverter]::ToString($head, 0, [Math]::Min($read, 12)).Replace('-', '')
    if ($magic -match '^(89504E470D0A1A0A|FFD8FF|474946383761|474946383961|52494646.{8}57454250)') { return 'shown as an image' }
    if ($magic -match '^255044462D') { return 'opens as a PDF' }
    $valid = $true; $need = 0; $low = 128; $high = 191
    for ($i = 0; $i -lt $read; $i++) {
        $b = $head[$i]
        if ($need -gt 0) {
            if ($b -lt $low -or $b -gt $high) { $valid = $false }
            $need--; $low = 128; $high = 191
        } elseif ($b -eq 0) { $valid = $false }
        elseif ($b -lt 128) { continue }
        elseif ($b -ge 194 -and $b -le 223) { $need = 1 }
        elseif ($b -ge 224 -and $b -le 239) {
            $need = 2
            if ($b -eq 224) { $low = 160 }
            if ($b -eq 237) { $high = 159 }
        } elseif ($b -ge 240 -and $b -le 244) {
            $need = 3
            if ($b -eq 240) { $low = 144 }
            if ($b -eq 244) { $high = 143 }
        } else { $valid = $false }
    }
    if ($valid -and ($need -eq 0 -or $read -ge 4096)) { return 'shown as text' }
    return 'offered as a download'
}

try {
    if ($mode -eq 'clear') {
        OutboxFiles | Remove-Item -Force
        Write-Output 'tabtivity-send: outbox cleared.'
        exit 0
    }
    $ignored = $false
    try { & git -C $root check-ignore -q .tabtivity/ 2>$null; $ignored = $LASTEXITCODE -eq 0 } catch {}
    if (-not $ignored) { [Console]::Error.WriteLine('tabtivity-send: warning: .tabtivity/ is not git-ignored; ignore it before committing.') }
    $sources = if ($mode -eq 'stdin') { @($label) } else { @($args) }
    foreach ($source in $sources) {
        $inputStream = $null; $outputStream = $null
        # Stage a bounded copy under a private name. Only complete files become
        # visible; a move that never overwrites publishes it.
        $stage = Join-Path $outbox ('.send-' + [guid]::NewGuid().ToString('N'))
        $originRel = ''
        try {
            if ($mode -eq 'stdin') { $inputStream = [Console]::OpenStandardInput() }
            else {
                $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($source)
                if (-not [IO.File]::Exists($full)) { Fail 4 'Only regular files can be sent.' }
                try { $inputStream = [IO.File]::OpenRead($full) } catch { Fail 4 'Cannot read the file.' }
                $originRel = OriginOf $full
            }
            try { $outputStream = [IO.File]::Open($stage, [IO.FileMode]::CreateNew) } catch { Fail 3 'Cannot stage the file.' }
            $buffer = New-Object byte[] 65536
            $size = 0
            try {
                while (($count = $inputStream.Read($buffer, 0, [Math]::Min($buffer.Length, 25165825 - $size))) -gt 0) {
                    $outputStream.Write($buffer, 0, $count); $size += $count
                    if ($size -gt 25165824) { break }
                }
            } catch { Fail 4 'Cannot read the file.' }
            $outputStream.Dispose(); $outputStream = $null
            if ($size -eq 0 -or $size -gt 25165824) { Fail 4 'Files must be nonempty and at most 24 MiB.' }
            # The -n NAME as given, a file's leaf: `A-Za-z0-9._-`, no leading dot.
            $given = if ($mode -eq 'stdin') { $source } else { [IO.Path]::GetFileName($full) }
            $name = ($given -creplace '[^A-Za-z0-9._-]', '_').TrimStart('.')
            if (-not $name) { $name = 'file' }
            $ext = ''; $stem = $name
            $dot = $name.LastIndexOf('.')
            if ($dot -ge 0) { $ext = $name.Substring($dot); $stem = $name.Substring(0, $dot) }
            if ($ext.Length -gt 16) { $ext = $ext.Substring(0, 16) }
            if (-not $stem) { $stem = 'file' }
            if ($stem.Length -gt (80 - $ext.Length)) { $stem = $stem.Substring(0, 80 - $ext.Length) }
            $total = [long]0
            foreach ($item in (OutboxFiles)) { if ($item.FullName -ne $stage) { $total += $item.Length } }
            if (($total + $size) -gt 1073741824) { Fail 5 'The outbox is full (1 GiB); use --clear.' }
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $suffix = ''; $n = 0
            while ($true) {
                $leaf = "$stamp-$stem$suffix$ext"
                $dest = Join-Path $outbox $leaf
                $marker = Join-Path $outbox ".$leaf.tab"
                $origin = Join-Path $outbox ".$leaf.src"
                # A leaf with neither a file nor a sender or origin marker. The
                # lock keeps other sends out, so the markers below are ours; they
                # land before the file does, so the phone never lists this file
                # unclaimed.
                if ((Present $dest) -or (Present $marker) -or (Present $origin)) { $n++; $suffix = "-$n"; continue }
                try {
                    if ($tab) { [IO.File]::WriteAllText($marker, $tab) }
                    # The project file this is a copy of (`OriginOf`): `.<leaf>.src`.
                    if ($originRel) { [IO.File]::WriteAllText($origin, $originRel) }
                } catch {
                    if ($tab) { [IO.File]::Delete($marker) }
                    if ($originRel) { [IO.File]::Delete($origin) }
                    Fail 4 'Cannot publish the file.'
                }
                try { [IO.File]::Move($stage, $dest); break }
                catch {
                    if ($tab) { [IO.File]::Delete($marker) }
                    if ($originRel) { [IO.File]::Delete($origin) }
                    # Lost the leaf to a file that appeared meanwhile: the next suffix.
                    if (Present $dest) { $n++; $suffix = "-$n"; continue }
                    Fail 4 'Cannot publish the file.'
                }
            }
            $report = KindOf $dest
            Write-Output "$([char]0x2192) phone: $leaf ($([Math]::Ceiling($size / 1024)) KB) $([char]0x2014) $report"
        } catch { Fail 4 $_.Exception.Message }
        finally {
            if ($inputStream) { $inputStream.Dispose() }
            if ($outputStream) { $outputStream.Dispose() }
            if ([IO.File]::Exists($stage)) { [IO.File]::Delete($stage) }
        }
    }
} finally {
    try { [IO.Directory]::Delete($lock) } catch {}
}
