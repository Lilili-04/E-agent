param(
    [switch]$DumpConfig,
    [string]$ExtraSkillsDir
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$utf8 = [Text.UTF8Encoding]::new($false)
$scratch = Join-Path $repo ".dsh-build/environment-qa-$PID"
$envNames = @('DSH_ENVIRONMENT_SKILLS_DIR', 'DSH_ENVIRONMENT_EXTRA_SKILLS_DIR')
$saved = @{}
foreach ($name in $envNames) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }

Push-Location -LiteralPath $repo
try {
    $env:DSH_ENVIRONMENT_SKILLS_DIR = Join-Path $PSScriptRoot 'skills'
    if ($ExtraSkillsDir) {
        $env:DSH_ENVIRONMENT_EXTRA_SKILLS_DIR = (Resolve-Path -LiteralPath $ExtraSkillsDir).Path
    }
    [void][IO.Directory]::CreateDirectory($scratch)
    $webPatch = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web.patch.yml'))
    foreach ($module in 'v2-service', 'v2-tools') {
        $moduleUri = [Uri]::new((Join-Path $repo "packages/experimental/environment-policy/src/$module.ts")).AbsoluteUri
        $webPatch = $webPatch.Replace("'@deepseek-ai/dsh-experimental-environment-policy/$module'", "'$moduleUri'")
    }
    $mode = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mode.patch.yml'))
    $eiaTool = 'skills/eia-preflight/scripts/tool.mjs'
    $toolUri = [Uri]::new((Join-Path $PSScriptRoot $eiaTool)).AbsoluteUri
    $webPath = Join-Path $scratch 'web.patch.yml'
    $modePath = Join-Path $scratch 'mode.patch.yml'
    [IO.File]::WriteAllText($webPath, $webPatch, $utf8)
    [IO.File]::WriteAllText($modePath, $mode.Replace("'./$eiaTool'", "'$toolUri'"), $utf8)
    $dshArgs = @('web', '--patch', $webPath, '--patch', $modePath)
    if ($DumpConfig) { $dshArgs += '--dump-config' } else { $dshArgs += '--no-open' }
    & node --import tsx/esm apps/cli/src/bin.ts @dshArgs
    exit $LASTEXITCODE
} finally {
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    Pop-Location
}
