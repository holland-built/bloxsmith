<#
Bloxsmith installer for Windows (PowerShell 5.1 and 7+).

Downloads the standalone bloxsmith.exe from GitHub Releases, verifies its
SHA-256 against the release's checksums.txt, and installs it to your user
profile (no admin, no Docker). Adds the install dir to your USER PATH.

  # latest release, default location (%LOCALAPPDATA%\Programs\Bloxsmith)
  powershell -ExecutionPolicy Bypass -File .\install.ps1

  # once trusted / already unblocked:
  .\install.ps1

  # pin an exact release, or install elsewhere:
  .\install.ps1 -Version v2.0.0
  .\install.ps1 -Prefix C:\Tools\Bloxsmith

Notes:
  * ExecutionPolicy: if scripts are blocked, run it for this process only with
    `powershell -ExecutionPolicy Bypass -File .\install.ps1` — nothing global changes.
  * The SHA-256 check proves the download is INTACT (not corrupt/truncated). It
    does NOT prove publisher identity — the binary is unsigned, and the checksums
    ship next to it. Signature verification (cosign) is a planned hardening step.
#>

[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$Prefix  = "$env:LOCALAPPDATA\Programs\Bloxsmith",
    [switch]$Uninstall,
    [switch]$Purge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$REPO = 'holland-built/bloxsmith'

# --- uninstall (no download needed) -----------------------------------------
if ($Uninstall) {
    Write-Host 'Bloxsmith uninstaller (Windows)'
    $exe = Join-Path $Prefix 'bloxsmith.exe'
    if (Test-Path -LiteralPath $exe) {
        # unregister + stop the login service if it was ever set up (best-effort)
        try { & $exe service uninstall 2>&1 | Out-Null } catch {}
        Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
        Write-Host "  removed  : $exe"
    } else {
        Write-Host "  (no bloxsmith.exe at $exe - nothing to remove there)"
    }
    $tpl = Join-Path $Prefix 'templates'
    if (Test-Path -LiteralPath $tpl) {
        Remove-Item -LiteralPath $tpl -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  removed  : $tpl"
    }
    # strip the install dir back out of the user PATH (reverse of install)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath) {
        $kept = $userPath -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ine $Prefix.TrimEnd('\') }
        [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
        Write-Host "  PATH     : removed $Prefix from your user PATH (reopen your shell)"
    }
    $cfg = Join-Path $env:AppData 'bloxsmith'
    if ($Purge) {
        if (Test-Path -LiteralPath $cfg) {
            Remove-Item -LiteralPath $cfg -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "  removed  : $cfg (config + vault)"
        }
    } elseif (Test-Path -LiteralPath $cfg) {
        Write-Host ''
        Write-Host 'Config + encrypted vault left in place at:'
        Write-Host "    $cfg"
        Write-Host '  Delete it too with:  .\install.ps1 -Uninstall -Purge'
    }
    Write-Host ''
    Write-Host 'Bloxsmith uninstalled.'
    return
}

if ($Version -eq 'latest') {
    $base = "https://github.com/$REPO/releases/latest/download"
} else {
    $base = "https://github.com/$REPO/releases/download/$Version"
}

Write-Host 'Bloxsmith installer (Windows)'
Write-Host "  platform : windows/amd64"
Write-Host "  release  : $Version"

$tmp = Join-Path $env:TEMP ("bloxsmith-" + [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null

    # --- checksums.txt first; for 'latest' it also reveals the real version ---
    $checksums = Join-Path $tmp 'checksums.txt'
    Write-Host "  fetching : checksums.txt"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile $checksums
    } catch {
        throw "could not download checksums.txt from $base : $($_.Exception.Message)"
    }
    $checksumText = Get-Content -Raw -Path $checksums

    if ($Version -eq 'latest') {
        # Asset names carry the bare version (e.g. bloxsmith_2.1.1_windows_amd64.zip);
        # 'latest' is not a real filename, so resolve the number from checksums.txt.
        $m = [regex]::Match($checksumText, 'bloxsmith_([0-9][^_]+)_')
        if (-not $m.Success) { throw "could not determine release version from checksums.txt" }
        $num = $m.Groups[1].Value
    } else {
        $num = $Version -replace '^v', ''
    }

    $asset = "bloxsmith_${num}_windows_amd64.zip"
    $zip   = Join-Path $tmp $asset
    Write-Host "  asset    : $asset"

    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $zip
    } catch {
        throw "could not download $asset from $base : $($_.Exception.Message)"
    }

    # --- verify checksum (fail-closed) ----------------------------------------
    # Find the checksums.txt line whose second field is exactly our asset name.
    # Require EXACTLY ONE match with a single 64-hex-char digest.
    $expected = @()
    foreach ($line in ($checksumText -split "`r?`n")) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S+)\s*$') {
            if ($matches[2] -eq $asset) { $expected += $matches[1] }
        }
    }
    if ($expected.Count -eq 0) {
        throw "$asset has no entry in checksums.txt - refusing to install"
    }
    if ($expected.Count -gt 1) {
        throw "$asset has multiple checksum entries - refusing to install (ambiguous)"
    }
    $expectedHash = $expected[0]
    $actualHash   = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash

    if ($expectedHash -ne $actualHash) {
        Write-Error @"
CHECKSUM MISMATCH for $asset - refusing to install.
  expected: $expectedHash
  actual  : $actualHash
The download is corrupt or has been tampered with. Try again; if it keeps
failing, open an issue at https://github.com/$REPO/issues
"@
        exit 1
    }
    Write-Host "  checksum : ok (sha256)"

    # --- extract; require exactly one bloxsmith.exe ---------------------------
    $unzip = Join-Path $tmp 'unzip'
    New-Item -ItemType Directory -Path $unzip -Force | Out-Null
    Expand-Archive -Path $zip -DestinationPath $unzip -Force

    $exes = @(Get-ChildItem -Path $unzip -Recurse -Filter 'bloxsmith.exe' -File)
    if ($exes.Count -eq 0) { throw "no 'bloxsmith.exe' inside $asset" }
    if ($exes.Count -gt 1) { throw "multiple 'bloxsmith.exe' found inside $asset - refusing to install" }
    $srcExe = $exes[0].FullName

    # --- install (safe replace, no admin) -------------------------------------
    New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
    $dest = Join-Path $Prefix 'bloxsmith.exe'
    $old  = "$dest.old"

    if (Test-Path -LiteralPath $dest) {
        try {
            if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
            Rename-Item -LiteralPath $dest -NewName 'bloxsmith.exe.old' -Force
        } catch {
            Write-Error "cannot replace $dest - it looks locked (is bloxsmith running?). Close running bloxsmith first, then re-run. Nothing was changed."
            exit 1
        }
        try {
            Move-Item -LiteralPath $srcExe -Destination $dest -Force
        } catch {
            # roll back to the old exe so we never leave a partial/no install
            Rename-Item -LiteralPath $old -NewName 'bloxsmith.exe' -Force
            Write-Error "could not write the new bloxsmith.exe to $Prefix - restored the previous version. $($_.Exception.Message)"
            exit 1
        }
        Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    } else {
        Move-Item -LiteralPath $srcExe -Destination $dest -Force
    }

    # The zip bundles a templates\ dir next to the exe; the default TemplatesDir
    # is <exe-dir>\templates, so copy it beside the installed exe or Seed Demo /
    # Provision report "templates not installed".
    $templatesSrc = Join-Path (Split-Path -Parent $srcExe) 'templates'
    if (Test-Path -LiteralPath $templatesSrc) {
        $templatesDest = Join-Path $Prefix 'templates'
        if (Test-Path -LiteralPath $templatesDest) { Remove-Item -LiteralPath $templatesDest -Recurse -Force }
        try {
            Copy-Item -LiteralPath $templatesSrc -Destination $templatesDest -Recurse -Force
        } catch {
            Write-Warning "could not install templates -> $templatesDest (Seed Demo will be unavailable). $($_.Exception.Message)"
        }
    }

    Write-Host ''
    Write-Host "Installed bloxsmith $num -> $dest"

    # --- USER PATH (idempotent, no clobber) -----------------------------------
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $entries = $userPath -split ';' | Where-Object { $_ -ne '' }
    $onPath = $false
    foreach ($e in $entries) {
        if ($e.TrimEnd('\') -ieq $Prefix.TrimEnd('\')) { $onPath = $true; break }
    }
    if ($onPath) {
        Write-Host "PATH     : $Prefix is already on your user PATH."
    } else {
        $newPath = ($userPath.TrimEnd(';') + ';' + $Prefix).TrimStart(';')
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "PATH     : added $Prefix to your user PATH - reopen your shell for it to take effect."
    }

    # --- get the user to the dashboard, zero extra steps ----------------------
    $url = 'http://localhost:8080'
    if ([Environment]::UserInteractive) {
        Write-Host ''
        Write-Host "Starting Bloxsmith and opening $url ..."
        Start-Process -FilePath $dest | Out-Null
        $up = $false
        for ($i = 0; $i -lt 40; $i++) {
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2 | Out-Null
                $up = $true; break
            } catch { Start-Sleep -Milliseconds 500 }
        }
        Start-Process $url | Out-Null
        if (-not $up) {
            Write-Host "Bloxsmith is still starting — the browser may need a refresh."
        }
    }

    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  bloxsmith                 # start it -> http://localhost:8080'
    Write-Host '  bloxsmith --version       # confirm the install'
    Write-Host ''
    Write-Host 'Bloxsmith self-updates from the in-app "Update now" button (or `bloxsmith update`).'
    Write-Host 'No admin rights needed, and no winget.'
}
finally {
    if (Test-Path -LiteralPath $tmp) {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
