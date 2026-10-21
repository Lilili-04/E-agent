param(
  [string]$ModelKeyFile = '.dsh-build/qwen-api.key',
  [string]$PolicyTokenFile = '.dsh-build/dgx-policy-v2.token',
  [string]$PolicyEndpoint = 'http://172.27.153.44:18081'
)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Push-Location -LiteralPath $taskRoot
$taskNames = @('DGX_QWEN36_API_KEY', 'POLICY_V2_API_TOKEN_FILE', 'DGX_POLICY_V2_URL')
$taskPrevious = @{}
foreach ($taskName in $taskNames) { $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
try {
  $taskKeyPath = (Resolve-Path -LiteralPath $ModelKeyFile).Path
  $taskTokenPath = (Resolve-Path -LiteralPath $PolicyTokenFile).Path
  $taskKey = [IO.File]::ReadAllText($taskKeyPath).Trim()
  $taskToken = [IO.File]::ReadAllText($taskTokenPath).Trim()
  if (-not $taskKey -or $taskToken.Length -lt 32) { throw 'A model key and a policy API token of at least 32 characters are required.' }
  $taskStatus = Invoke-RestMethod -Uri "$($PolicyEndpoint.TrimEnd('/'))/v2/policy/status" -Headers @{Authorization="Bearer $taskToken"} -TimeoutSec 15
  if ($taskStatus.schemaVersion -ne 2) { throw 'The DGX endpoint does not provide policy v2 search/read.' }
  $taskModels = Invoke-RestMethod -Uri 'http://172.27.153.44:8001/v1/models' -Headers @{Authorization="Bearer $taskKey"} -TimeoutSec 15
  if ('qwen3.6-35b-a3b-vllm' -notin $taskModels.data.id) { throw 'DGX is not serving the configured Qwen3.6 model.' }
  $env:DGX_QWEN36_API_KEY = $taskKey
  $env:POLICY_V2_API_TOKEN_FILE = $taskTokenPath
  $env:DGX_POLICY_V2_URL = $PolicyEndpoint
  # Foreground launch keeps shutdown under the caller's control and never kills an occupied port.
  & node --import tsx/esm apps/cli/src/bin.ts web --patch apps/cli/config/examples/environment-policy-remote-dgx.patch.yml --no-open
  if ($LASTEXITCODE -ne 0) { throw 'Local Harness exited with an error.' }
} finally {
  foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName], 'Process') }
  Pop-Location
}
