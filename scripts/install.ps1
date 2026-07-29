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
    `powershell -ExecutionPolicy Bypass -File .\install.ps1` - nothing global changes.
  * The SHA-256 check proves the download is INTACT (not corrupt/truncated).
    Before installing, the script also verifies checksums.txt itself was
    signed by this project's release key (ssh-keygen -Y verify against
    checksums.txt.sshsig, key pinned in the script). HONEST SCOPE: this
    authenticates the release PIPELINE - the artifact left this repo's CI
    unmodified since it was signed - not the SOURCE, and the exe is still
    unsigned for Windows SmartScreen. Releases before 3.23.0 predate signing;
    if you pin one with -Version, the script says so explicitly rather than
    silently skipping the check.
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

    # --- verify release signature (fail-closed) --------------------------------
    # checksums.txt is signed with an Ed25519 key held only in this repo's CI
    # secrets; the public half is pinned here, so the thing that decides
    # whether a release is genuine does not travel with the release. This
    # authenticates the release PIPELINE (the same signature go/signing.go
    # checks before a self-update) - it does not authenticate the exe's
    # publisher identity to Windows; that's SmartScreen, a separate control.
    $SIG_SSH_PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILh1e4Aj8VwLy+7PBMzfkwqDa7amfqAgpSmF1sq4S+g9'
    $SIGNING_SINCE  = [version]'3.23.0'

    # Extracts a leading X.Y.Z from a version string, ignoring any -suffix.
    # Returns $null when the string doesn't start with one at all.
    function Get-SemverPrefix([string]$v) {
        $m = [regex]::Match($v, '^(\d+)\.(\d+)\.(\d+)')
        if (-not $m.Success) { return $null }
        return [version]("{0}.{1}.{2}" -f $m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value)
    }

    # Releases from 3.23.0 onward always carry a signature (CI refuses to
    # publish without one). "latest" and a version number that can't be parsed
    # are treated the same as ">= 3.23.0" - fail closed, never assume it's old.
    # The ONLY legitimate skip is a version pinned by the caller that
    # genuinely predates signing; that is a fact about that one old release,
    # never phrased as "signing is generally unavailable".
    $sigRequired = $true
    if ($Version -ne 'latest') {
        $parsedNum = Get-SemverPrefix $num
        if ($parsedNum -and $parsedNum -lt $SIGNING_SINCE) {
            $sigRequired = $false
        }
    }

    # ssh-keygen -Y verify needs OpenSSH >= 8.0 (that's when -Y sign/verify was
    # added). Windows 10 1809 shipped OpenSSH 7.7, which doesn't understand -Y
    # at all - probe the real version rather than assuming ssh-keygen exists
    # or is new enough.
    $sshSupported   = $false
    $sshVersionNote = ''
    $sshKeygenCmd = Get-Command ssh-keygen -ErrorAction SilentlyContinue
    $sshCmd       = Get-Command ssh -ErrorAction SilentlyContinue
    if ($sshKeygenCmd -and $sshCmd) {
        try {
            # `ssh -V` writes its version to stderr. Capturing that through the
            # PowerShell pipeline (2>&1 | Out-String) is a known trap: under
            # $ErrorActionPreference = 'Stop', native-command stderr lines can
            # be promoted to a terminating error instead of plain text. Route
            # it through cmd /c instead, which merges the streams at the OS
            # level before PowerShell ever sees them as its own error records.
            $verOut = (& cmd /c 'ssh -V 2>&1') -join "`n"
            # Version strings differ by platform and the Windows one does NOT
            # match a naive 'OpenSSH_(\d+)': Linux/macOS report "OpenSSH_9.6p1",
            # Windows reports "OpenSSH_for_Windows_9.5p2". Anchoring on the
            # digits after any OpenSSH prefix covers both. Getting this wrong
            # rejected OpenSSH 9.5 as "predates 8.0" on the only platform this
            # script runs on.
            $vm = [regex]::Match($verOut, 'OpenSSH[A-Za-z_]*_(\d+)\.(\d+)')
            if ($vm.Success -and [int]$vm.Groups[1].Value -ge 8) {
                $sshSupported = $true
            } else {
                $sshVersionNote = "ssh-keygen here predates OpenSSH 8.0 ($($verOut.Trim()))"
            }
        } catch {
            $sshVersionNote = "could not determine ssh-keygen's OpenSSH version"
        }
    } else {
        $sshVersionNote = 'ssh-keygen (OpenSSH Client) was not found on PATH'
    }

    # Fetch checksums.txt.sshsig. A genuine 404 (release truly has no
    # signature) and a network/local failure (tells us nothing either way)
    # must not be reported the same way, so tell them apart via HTTP status.
    $sshsigPath     = Join-Path $tmp 'checksums.txt.sshsig'
    $sigFetchOk     = $false
    $sigFetch404    = $false
    $sigFetchErrMsg = ''
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt.sshsig" -OutFile $sshsigPath
        $sigFetchOk = $true
    } catch {
        $statusCode = $null
        # Use the PSObject.Properties indexer rather than dereferencing
        # .Response/.StatusCode directly - under Set-StrictMode -Version
        # Latest, touching a property the exception type doesn't declare
        # (e.g. a plain connection failure with no HTTP response at all)
        # throws instead of returning $null.
        $responseProp = $_.Exception.PSObject.Properties['Response']
        if ($responseProp -and $responseProp.Value) {
            $statusProp = $responseProp.Value.PSObject.Properties['StatusCode']
            if ($statusProp) {
                try { $statusCode = [int]$statusProp.Value } catch { $statusCode = $null }
            }
        }
        if ($statusCode -eq 404) {
            $sigFetch404 = $true
        } else {
            $sigFetchErrMsg = $_.Exception.Message
        }
    }

    if ($sshSupported -and $sigFetchOk) {
        $allowedSigners = Join-Path $tmp 'allowed_signers'
        # Identity first, key WITHOUT a trailing comment - must match the -I
        # value passed to ssh-keygen below exactly. Written as plain ASCII, no
        # BOM, since it's just a config line (not signed data itself).
        [System.IO.File]::WriteAllText($allowedSigners, "bloxsmith-release-signing $SIG_SSH_PUBKEY`n", [System.Text.Encoding]::ASCII)

        # ssh-keygen -Y verify checks an EXACT byte signature over stdin.
        # Piping through the PowerShell pipeline (Get-Content | ssh-keygen)
        # re-encodes text and can rewrite line endings (CRLF<->LF), silently
        # corrupting the bytes being checked - that produces a FALSE "does not
        # verify" on a genuine release, which is worse than skipping the check
        # entirely because it looks like tampering. So the process is driven
        # directly here and checksums.txt's raw bytes are written straight
        # into its stdin stream, byte-for-byte identical to what's on disk
        # (and to what was signed). Both streams are tiny (a checksums file
        # and one status line), so writing stdin fully before reading output
        # cannot deadlock on a full pipe buffer here.
        # HOW THE DATA REACHES ssh-keygen, and why it is done this way.
        #
        # ssh-keygen -Y verify reads the signed data from stdin and checks an
        # EXACT byte signature. Two approaches were tried:
        #
        #   1. Get-Content | ssh-keygen        - rejected outright: the
        #      PowerShell pipeline re-encodes text and rewrites line endings,
        #      which corrupts the signed bytes.
        #   2. ProcessStartInfo with RedirectStandardInput, writing the raw
        #      bytes onto StandardInput.BaseStream - looks byte-exact, and is
        #      not. Measured in CI against a genuine release: ssh-keygen
        #      reported "incorrect signature" for a checksums.txt that verified
        #      correctly the moment the same bytes were fed in via a cmd
        #      redirect. A false "does not verify" is the worst outcome
        #      available here - it accuses a good release of being forged.
        #
        # So: cmd's < redirect, which hands the file to the process as raw
        # bytes with nothing in between. Proven in CI on the same file that
        # approach 2 rejected. Paths are quoted for cmd because a user's TEMP
        # or -Prefix may contain spaces.
        $sshExitCode = -1
        $sshStdErr   = ''
        try {
            $cmdLine = 'ssh-keygen -Y verify -f "{0}" -I bloxsmith-release-signing -n bloxsmith-release -s "{1}" < "{2}" 2>&1' -f `
                $allowedSigners, $sshsigPath, $checksums
            $sshStdErr   = (& cmd /c $cmdLine) -join "`n"
            $sshExitCode = $LASTEXITCODE
        } catch {
            $sshExitCode = -1
            $sshStdErr   = $_.Exception.Message
        }

        if ($sshExitCode -eq 0) {
            Write-Host "  signature: ok (ssh-ed25519, key pinned in this script)"
        } else {
            Write-Error @"
RELEASE SIGNATURE DOES NOT VERIFY for checksums.txt - refusing to install.
$sshStdErr
checksums.txt was not signed by this project's release key. Do not retry
blindly; report it at https://github.com/$REPO/issues
"@
            exit 1
        }
    }
    elseif ($sigFetchOk -and -not $sshSupported) {
        # The signature asset exists, but nothing here can check it.
        if ($sigRequired) {
            Write-Error @"
release $num is signed, but this system cannot verify it ($sshVersionNote) -
refusing to install unverified.
Windows: add the OpenSSH Client optional feature, or install a newer OpenSSH
(need version 8.0 or later for ssh-keygen -Y verify).
Do not retry blindly if this persists; report it at https://github.com/$REPO/issues
"@
            exit 1
        } else {
            Write-Host "  signature: present but NOT checked ($sshVersionNote)"
            Write-Host "             the installed binary verifies it on every self-update"
        }
    }
    elseif ($sigFetch404) {
        # Genuinely absent (a real 404), not a fetch problem.
        if ($sigRequired) {
            Write-Error @"
release $num has no signature asset (checksums.txt.sshsig) - refusing to
install. Releases from $SIGNING_SINCE onward are always signed, so a release
in that range with no signature asset cannot be authenticated.
Do not retry blindly if this persists; report it at https://github.com/$REPO/issues
"@
            exit 1
        } else {
            Write-Host "  signature: none - release $num predates release signing (introduced in $SIGNING_SINCE); checksum only for this specific old release"
        }
    }
    else {
        # Neither a successful fetch nor a confirmed-absent (404) outcome - a
        # fetch problem (network/local), not evidence the release lacks a
        # signature.
        if ($sigRequired) {
            Write-Error @"
could not download the release signature (checksums.txt.sshsig): $sigFetchErrMsg
Refusing to install without verifying the signature - this is a fetch
failure, not a release that lacks a signature; check your network and retry.
Do not retry blindly if this persists; report it at https://github.com/$REPO/issues
"@
            exit 1
        } else {
            Write-Host "  signature: could not be downloaded ($sigFetchErrMsg); release $num predates release signing anyway (introduced in $SIGNING_SINCE), so continuing checksum only"
        }
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
    # [Environment]::UserInteractive is True on most CI runners too (it means
    # "no attached console prevented UI", not "a human is at a terminal"), so
    # without the $env:CI check an unmodified pipeline run would launch a
    # long-lived server and pop a browser inside an automated job. $env:CI is
    # only the common convention (GitHub Actions and most other CI set it) -
    # it does not detect every kind of automation, and anything cleverer risks
    # skipping the launch for a real person sitting at a real terminal, which
    # is the entire point of this step.
    if ([Environment]::UserInteractive -and -not $env:CI) {
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
            Write-Host "Bloxsmith is still starting - the browser may need a refresh."
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
