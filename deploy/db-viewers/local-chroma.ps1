param(
    [ValidateRange(1024, 65535)][int]$Port = 18102,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runtime = Join-Path $repo '.dsh-build/local-vector-venv/Scripts/python.exe'
$script = Join-Path $PSScriptRoot 'local-chroma.py'
$stopFile = Join-Path $repo ".dsh-build/local-chroma-viewer-$Port.stop"
$pidFile = Join-Path $repo ".dsh-build/local-chroma-viewer-$Port.pid"
$url = "http://127.0.0.1:$Port/"

if ($Stop) {
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            Invoke-WebRequest -Uri ($url + 'healthz') -UseBasicParsing -TimeoutSec 2 | Out-Null
        } catch {
            if (Test-Path -LiteralPath $pidFile) {
                $viewerPid = [int](Get-Content -LiteralPath $pidFile)
                try { $process = [System.Diagnostics.Process]::GetProcessById($viewerPid) }
                catch { $process = $null }
                if ($process -and -not $process.WaitForExit(15000)) {
                    throw "Viewer is still closing; see .dsh-build/local-chroma-viewer-$Port.err.log"
                }
                Remove-Item -LiteralPath $pidFile
            }
            Write-Output "Stopped local vector viewer on port $Port."
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Viewer did not stop; see .dsh-build/local-chroma-viewer-$Port.err.log"
}

if (-not (Test-Path -LiteralPath $runtime)) { throw 'Install the local vector Python environment first; see README.' }
try {
    $probe = [System.Net.Sockets.TcpClient]::new()
    $probe.Connect('127.0.0.1', $Port)
    $occupied = $true
} catch { $occupied = $false }
finally { if ($probe) { $probe.Dispose() } }
if ($occupied) { throw "Port $Port is occupied. Stop its owner or choose another -Port." }
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
$viewerArgs = @('-X', 'utf8', '-u', "`"$script`"", '--port', "$Port", '--stop-file', "`"$stopFile`"")
$process = Start-Process -FilePath $runtime -ArgumentList $viewerArgs -WorkingDirectory $repo `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $repo ".dsh-build/local-chroma-viewer-$Port.out.log") `
    -RedirectStandardError (Join-Path $repo ".dsh-build/local-chroma-viewer-$Port.err.log")
$process.Id | Set-Content -LiteralPath $pidFile
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($process.HasExited) { throw "Viewer exited; see .dsh-build/local-chroma-viewer-$Port.err.log" }
    try {
        $health = Invoke-RestMethod -Uri ($url + 'healthz') -TimeoutSec 2
        if ($health.viewer -eq 'local-policy-chroma') {
            Write-Output "Local vector viewer: $url (PID $($process.Id))"
            return
        }
    } catch { Start-Sleep -Milliseconds 500 }
}
throw "Viewer did not become ready; see .dsh-build/local-chroma-viewer-$Port.err.log"
