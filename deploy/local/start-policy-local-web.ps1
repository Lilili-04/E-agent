param(
  [string]$ModelKeyFile = '.dsh-build/qwen-api.key',
  [string]$EmbeddingUrl = 'http://172.27.153.44:8000',
  [int]$VectorPort = 18102
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Push-Location -LiteralPath $repo
$names = @('DGX_QWEN36_API_KEY', 'POLICY_V2_DB_PATH', 'POLICY_V2_SEMANTIC_CONFIG_PATH', 'POLICY_V2_VECTOR_MANIFEST_PATH', 'POLICY_V2_GRAPH_CONFIG_PATH', 'POLICY_V2_LATEST_MANIFEST_PATH')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  $manifestPath = (Resolve-Path -LiteralPath 'data/policy-combined-local-vectors-r2/manifest.json').Path
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $databasePath = (Resolve-Path -LiteralPath 'data/policy-combined-local-20261022-r2.sqlite').Path
  $stream = [IO.File]::Open($databasePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try { $databaseHash = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash.ToLowerInvariant() }
  finally { $stream.Dispose() }
  if (-not $manifest.complete -or $databaseHash -ne $manifest.database_sha256) {
    throw 'Combined vector manifest does not match the completed SQLite snapshot.'
  }
  $key = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $ModelKeyFile).Path).Trim()
  if (-not $key) { throw 'A model API key is required.' }
  $models = Invoke-RestMethod -Uri 'http://172.27.153.44:8001/v1/models' -Headers @{Authorization="Bearer $key"} -TimeoutSec 15
  if ('qwen3.6-35b-a3b-vllm' -notin $models.data.id) { throw 'The configured Qwen3.6 model is unavailable.' }
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$VectorPort/healthz" -TimeoutSec 2 }
  catch { $health = $null }
  if (-not $health) { & ./deploy/db-viewers/local-chroma.ps1 -Port $VectorPort }
  elseif ($health.viewer -ne 'local-policy-chroma') { throw 'Vector port belongs to another service.' }
  $semanticPath = Join-Path $repo '.dsh-build/policy-combined-semantic.json'
  @{
    embeddingUrl=$EmbeddingUrl.TrimEnd('/'); chromaUrl="http://127.0.0.1:$VectorPort"; model=$manifest.model
    documentCollection=$manifest.collections.document; passageCollection=$manifest.collections.passage
    timeoutMs=60000; embeddingRetries=1; documentCandidates=10; passageCandidates=30
    documentMaxDistance=4; maxDistance=2
  } | ConvertTo-Json | Set-Content -LiteralPath $semanticPath -Encoding utf8
  $patch = Get-Content -LiteralPath 'apps/cli/config/examples/environment-policy-local-combined.patch.yml' -Raw
  foreach ($module in @('v2-service', 'v2-tools')) {
    $uri = [Uri]::new((Join-Path $repo "packages/experimental/environment-policy/src/$module.ts")).AbsoluteUri
    $patch = $patch.Replace("'@deepseek-ai/dsh-experimental-environment-policy/$module'", "'$uri'")
  }
  $patchPath = Join-Path $repo '.dsh-build/environment-policy-combined-web.patch.yml'
  $patch | Set-Content -LiteralPath $patchPath -Encoding utf8
  $env:DGX_QWEN36_API_KEY = $key
  $env:POLICY_V2_DB_PATH = $databasePath
  $env:POLICY_V2_SEMANTIC_CONFIG_PATH = $semanticPath
  $env:POLICY_V2_VECTOR_MANIFEST_PATH = $manifestPath
  $env:POLICY_V2_LATEST_MANIFEST_PATH = (Resolve-Path -LiteralPath 'deploy/local/policy-latest.json').Path
  $env:POLICY_V2_GRAPH_CONFIG_PATH = (Resolve-Path -LiteralPath 'deploy/local/policy-graph.json').Path
  Write-Output 'Local combined Harness: http://127.0.0.1:3080/ ; vector API/viewer is an independent process.'
  & node --import tsx/esm apps/cli/src/bin.ts web --patch $patchPath --no-open
  if ($LASTEXITCODE -ne 0) { throw 'Local combined Harness exited with an error.' }
} finally {
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  Pop-Location
}
