# Read-only local verification. Does not start DSH or touch user profile.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host 'Workspace:' (Get-Location).Path
Write-Host 'Node:' (node --version)
Write-Host 'pnpm:' (pnpm --version)
Write-Host 'Target DSH package:' ((Get-Content package.json -Raw | ConvertFrom-Json).devDependencies.'@deepseek-ai/dsh')
$required = @('TEAM.md','PROJECT_UNDERSTANDING.md','FAILURE_COLLECTION.md','AGENTS.md',
 'team/chief-of-staff.md','team/architect.md','team/implementer.md','team/reviewer.md','team/secretary.md',
 'docs/architecture/MIKA_OPERATING_PROTOCOL.md','docs/architecture/MULTICA_SQUAD_INSTRUCTIONS.md',
 'docs/CORE_SPEC_V1_0_2026-10-19.md','docs/MEMORY_SPEC_V1_0_2026-10-19.md',
 'docs/INSTRUCTIONS_SPEC_V1_0_2026-10-19.md','package.json','cordis.patch.yml','src/index.ts')
$missing = $required | Where-Object { -not (Test-Path $_) }
if ($missing) { throw "Missing: $($missing -join ', ')" }
Write-Host 'Required files: present. No host runtime validation attempted.'
