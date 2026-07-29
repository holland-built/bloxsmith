<#
Exercises scripts/install.ps1's REFUSAL paths against a locally-served fake
release, and asserts it refused for the right reason and installed nothing.

Why this is a committed script rather than inline CI YAML: the same logic
embedded in a workflow `run:` block failed to parse twice, and each attempt cost
a full CI round trip to discover, because PowerShell inside YAML inside a
generated temp file has three layers of quoting to get wrong. As a file it is
parsed by the same cheap `parses under Windows PowerShell` CI step that guards
install.ps1, so a syntax error is caught in seconds instead of minutes.

  -Case tampered  checksums.txt is corrupted, signature left in place
                  -> must refuse naming the SIGNATURE
  -Case nosig     archive is forged, checksums rewritten to match it, and BOTH
                  signature assets removed -> must refuse naming the absence

The second case is the attack that was live in install.sh until v3.23.2: an
attacker who can write release assets deletes the signature so the check has
nothing to check.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('tampered', 'nosig')]
    [string]$Case
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installer = Join-Path $repoRoot 'scripts\install.ps1'
if (-not (Test-Path -LiteralPath $installer)) {
    Write-Host "::error::cannot find install.ps1 at $installer"
    exit 1
}

$work = Join-Path $env:RUNNER_TEMP "refusal-$Case"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$rel = Join-Path $work 'rel'
New-Item -ItemType Directory -Path $rel -Force | Out-Null

$base = 'https://github.com/holland-built/bloxsmith/releases/latest/download'

# --- fetch the genuine release -----------------------------------------------
Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile (Join-Path $rel 'checksums.txt')
$checksumText = Get-Content -Raw -Path (Join-Path $rel 'checksums.txt')
$m = [regex]::Match($checksumText, 'bloxsmith_([0-9][^_]+)_')
if (-not $m.Success) {
    Write-Host "::error::could not resolve the release version from checksums.txt"
    exit 1
}
$num   = $m.Groups[1].Value
$asset = 'bloxsmith_' + $num + '_windows_amd64.zip'

if ($Case -eq 'tampered') {
    # Keep the real archive and the real signature; corrupt the signed content.
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $rel $asset)
    Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt.sshsig" -OutFile (Join-Path $rel 'checksums.txt.sshsig')

    # Flip the first character of every line. Asset names stay intact, so
    # parsing still succeeds and the refusal is genuinely cryptographic rather
    # than a parse error wearing a security message.
    $lines = Get-Content -Path (Join-Path $rel 'checksums.txt')
    $flipped = foreach ($line in $lines) {
        if ($line.Length -eq 0) { $line }
        elseif ($line.Substring(0, 1) -eq 'f') { '0' + $line.Substring(1) }
        else { 'f' + $line.Substring(1) }
    }
    Set-Content -Path (Join-Path $rel 'checksums.txt') -Value $flipped -Encoding Ascii
    $mustSay = 'SIGNATURE DOES NOT VERIFY'
}
else {
    # Forge an archive that really does contain a bloxsmith.exe, make the
    # checksums match it, and publish no signature at all.
    $payload = Join-Path $work 'payload'
    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    Set-Content -Path (Join-Path $payload 'bloxsmith.exe') -Value 'forged' -Encoding Ascii
    Compress-Archive -Path (Join-Path $payload '*') -DestinationPath (Join-Path $rel $asset) -Force

    $hash = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $rel $asset)).Hash.ToLower()
    $lines = Get-Content -Path (Join-Path $rel 'checksums.txt')
    $rewritten = foreach ($line in $lines) {
        if ($line -like "*$asset") { $hash + '  ' + $asset } else { $line }
    }
    Set-Content -Path (Join-Path $rel 'checksums.txt') -Value $rewritten -Encoding Ascii
    $mustSay = 'no signature'
}

# --- serve those files instead of the network --------------------------------
# A function outranks a cmdlet in PowerShell's command precedence, so defining
# Invoke-WebRequest here intercepts every download install.ps1 makes without
# install.ps1 needing a test-only parameter. Unknown names throw, which is how a
# genuine 404 reaches the script.
$wrapperTemplate = @'
$ErrorActionPreference = 'Continue'
function global:Invoke-WebRequest {
    param(
        [switch]$UseBasicParsing,
        [string]$Uri,
        [string]$OutFile,
        [int]$TimeoutSec
    )
    $name  = ($Uri -split '/')[-1]
    $local = Join-Path '__REL__' $name
    if (-not (Test-Path -LiteralPath $local)) {
        throw [System.Net.WebException]::new("shim: 404 for $name")
    }
    Copy-Item -LiteralPath $local -Destination $OutFile -Force
}
& '__INSTALLER__' -Prefix '__PREFIX__'
exit $LASTEXITCODE
'@

$prefix  = Join-Path $work 'out'
$wrapper = Join-Path $work 'wrapper.ps1'
$wrapperText = $wrapperTemplate.Replace('__REL__', $rel).Replace('__INSTALLER__', $installer).Replace('__PREFIX__', $prefix)
Set-Content -Path $wrapper -Value $wrapperText -Encoding Ascii

# --- run it and judge --------------------------------------------------------
# ErrorActionPreference must NOT be 'Stop' around this call. The installer is
# EXPECTED to fail here, and with 'Stop' the first stderr line a child process
# writes is promoted to a terminating error - so this script would die at the
# moment the thing it is testing works correctly, reporting a test failure for a
# successful refusal. That trap has now bitten three times in this file's
# history; it is why the assertions below judge the exit code instead.
$ErrorActionPreference = 'Continue'
$out  = & powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper 2>&1 | ForEach-Object { $_.ToString() }
$code = $LASTEXITCODE
$text = ($out -join "`n")

Write-Host "--- installer output ($Case) ---"
Write-Host $text
Write-Host "--- end installer output ---"

$failed = $false
if ($code -eq 0) {
    Write-Host "::error::install.ps1 exited 0 against the '$Case' release - it must refuse"
    $failed = $true
}
$exe = Join-Path $prefix 'bloxsmith.exe'
if (Test-Path -LiteralPath $exe) {
    Write-Host "::error::bloxsmith.exe was installed despite the '$Case' release being unusable"
    $failed = $true
}
if ($text -notmatch [regex]::Escape($mustSay)) {
    Write-Host "::error::install.ps1 refused, but not for the stated reason - '$mustSay' is absent from its output"
    $failed = $true
}
if ($failed) { exit 1 }

Write-Host "'$Case' release refused, nothing installed, reason named"

# Explicit success. The GitHub Actions PowerShell wrapper ends the step with
# `exit $LASTEXITCODE`, and $LASTEXITCODE here still holds the CHILD's exit code
# - which is 1, because the child refusing is the whole point. Falling off the
# end of this script therefore reports a FAILED step for a test that passed.
exit 0
