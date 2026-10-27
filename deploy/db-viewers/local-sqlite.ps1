param(
    [ValidateRange(1024, 65535)][int]$Port = 18101,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runtime = Join-Path $repo '.dsh-build/local-db-viewer-venv/Scripts/python.exe'
$database = Join-Path $repo 'data/policy-combined-local-20261022-r2.sqlite'
$metadata = Join-Path $PSScriptRoot 'local-metadata.json'
$state = Join-Path $repo ".dsh-build/local-db-viewer-$Port.pid"
$url = "http://127.0.0.1:$Port/"

if ($Stop) {
    if (-not (Test-Path -LiteralPath $state)) { throw "No viewer PID recorded: $state" }
    $viewerPid = [int](Get-Content -LiteralPath $state)
    $viewer = Get-CimInstance Win32_Process -Filter "ProcessId = $viewerPid"
    if ($viewer) {
        if ($viewer.CommandLine -notlike '*-m datasette*' -or
            -not $viewer.CommandLine.Contains($metadata)) {
            throw "PID $viewerPid no longer belongs to this viewer; refusing to stop it."
        }
        # Windows venv launchers keep a child Python server; stop the owned tree.
        & taskkill.exe /PID $viewerPid /T /F
        if ($LASTEXITCODE -ne 0) { throw "Could not stop viewer process tree $viewerPid" }
    }
    Remove-Item -LiteralPath $state
    Write-Output "Stopped local viewer on port $Port."
    return
}

if (-not (Test-Path -LiteralPath $runtime)) {
    throw 'Install Datasette 0.65.5 in .dsh-build/local-db-viewer-venv first; see README.'
}
if (-not (Test-Path -LiteralPath $database)) { throw "Database not found: $database" }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    throw "Port $Port is occupied. Stop its owner or choose -Port <number>."
}

# Immutable mode opens the snapshot read-only. Reopen the viewer after rebuilding it.
$viewerArgs = @(
    '-X', 'utf8', '-m', 'datasette', '-i', "`"$database`"",
    '--metadata', "`"$metadata`"", '--host', '127.0.0.1', '--port', "$Port",
    '--setting', 'default_page_size', '50',
    '--setting', 'max_returned_rows', '1000',
    '--setting', 'sql_time_limit_ms', '1500',
    '--setting', 'num_sql_threads', '2',
    '--setting', 'suggest_facets', 'off',
    '--setting', 'allow_download', 'off',
    '--setting', 'allow_csv_stream', 'off'
)
$process = Start-Process -FilePath $runtime -ArgumentList $viewerArgs -WorkingDirectory $repo `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $repo ".dsh-build/local-db-viewer-$Port.out.log") `
    -RedirectStandardError (Join-Path $repo ".dsh-build/local-db-viewer-$Port.err.log")
$process.Id | Set-Content -LiteralPath $state
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($process.HasExited) { throw "Viewer exited; see .dsh-build/local-db-viewer-$Port.err.log" }
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            Write-Output "Local viewer: $url (PID $($process.Id))"
            return
        }
    } catch {
        Start-Sleep -Milliseconds 300
    }
}
throw "Viewer did not become ready; see .dsh-build/local-db-viewer-$Port.err.log (PID $($process.Id))."
