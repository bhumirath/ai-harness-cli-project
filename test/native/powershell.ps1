$ErrorActionPreference = 'Stop'
$nativeTemp = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $nativeTemp | Out-Null
$env:HARNESS_CONFIG = Join-Path $nativeTemp 'config.json'
Set-Content -Path $env:HARNESS_CONFIG -Value '{"keychainRef":"completion-must-not-read-this"}'
try {
    . ([ScriptBlock]::Create((harness completion powershell | Out-String)))
    $cases = @(
        @('harness conversations s', 'show'),
        @('harness conversations ', 'ls'),
        @('harness conversations --l', '--limit'),
        @('harness conversations --limit 2 --q', '--query'),
        @('harness --org "Some Org" conversations s', 'show'),
        @('harness --org "ทีม AI" conversations s', 'show'),
        @('harness "conversations" s', 'show'),
        @('harness "conversations" "s"', 'show'),
        @('harness "conversations" "s', 'show'),
        @('harness conversations --query "some title" --l', '--limit'),
        @('harness conversations --limit 2 ', '--query'),
        @('harness --org conversations ag', 'agents'),
        @('harness --h', '--help')
    )
    foreach ($mode in @('Legacy', 'Standard', 'Windows')) {
      $PSNativeCommandArgumentPassing = $mode
      foreach ($case in $cases) {
        $line = $case[0]
        $matches = [System.Management.Automation.CommandCompletion]::CompleteInput($line, $line.Length, $null).CompletionMatches.CompletionText
        if ($matches -notcontains $case[1]) { throw "Missing completion $($case[1]) for: $line" }
    }
    }
    Write-Output 'native PowerShell completion checks passed (Legacy/Standard/Windows argument modes)'
} finally {
    Remove-Item -Recurse -Force $nativeTemp
}
