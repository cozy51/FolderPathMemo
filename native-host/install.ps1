param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$frameworkDirectory = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$installDirectory = Join-Path $env:LOCALAPPDATA 'FolderPathMemo'
New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null

$source = Join-Path $PSScriptRoot 'FolderPathNativeHost.cs'
$executable = Join-Path $installDirectory 'FolderPathNativeHost.exe'
$stagedExecutable = Join-Path $installDirectory 'FolderPathNativeHost.staged.exe'
$logFile = Join-Path $installDirectory 'last-open.log'

$expectedVersion = [regex]::Match((Get-Content -LiteralPath $source -Raw), 'HostVersion\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $expectedVersion) {
    throw "Could not read the host version from $source. The file is not the current FolderPathNativeHost.cs."
}

$previousVersion = 'not installed'
if (Test-Path -LiteralPath $executable -PathType Leaf) {
    $previousVersion = & $executable -version 2>$null | Select-Object -First 1
    if (-not $previousVersion) { $previousVersion = 'older build without a version' }
}

# Build into a staging file first. The previous version deleted the installed host before
# compiling, so a build failure left no host at all, and a host that could not be replaced went
# unnoticed while Chrome kept running the old build.
Remove-Item -Force -ErrorAction SilentlyContinue $stagedExecutable
try {
    Add-Type -Path $source -OutputAssembly $stagedExecutable -OutputType ConsoleApplication `
        -ReferencedAssemblies @(
            (Join-Path $frameworkDirectory 'System.dll'),
            (Join-Path $frameworkDirectory 'System.Core.dll'),
            (Join-Path $frameworkDirectory 'System.Windows.Forms.dll'),
            (Join-Path $frameworkDirectory 'System.Web.Extensions.dll')
        )
}
catch {
    Write-Host 'The native host did not compile. The installed host was left untouched.' -ForegroundColor Red
    Write-Host 'The compiler messages above name the file and line that failed.' -ForegroundColor Red
    Remove-Item -Force -ErrorAction SilentlyContinue $stagedExecutable
    throw
}
if (-not (Test-Path -LiteralPath $stagedExecutable -PathType Leaf)) {
    throw "The native host was not built: $stagedExecutable"
}

try {
    Remove-Item -Force -ErrorAction SilentlyContinue $executable
    Move-Item -LiteralPath $stagedExecutable -Destination $executable -Force
}
catch {
    Write-Host 'The installed host could not be replaced. Close Chrome completely and run this script again.' -ForegroundColor Red
    throw
}

$installedVersion = & $executable -version 2>$null | Select-Object -First 1
if ($installedVersion -ne $expectedVersion) {
    throw "The installed host reports version '$installedVersion' but '$expectedVersion' was built."
}

$manifestPath = Join-Path $installDirectory 'jp.folderpath.memo.json'
$manifest = @{
    name = 'jp.folderpath.memo'
    description = 'FolderPath Memo native Explorer launcher'
    path = $executable
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))

$chromeRegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\jp.folderpath.memo'
New-Item -Force -Path $chromeRegistryPath | Out-Null
Set-Item -Path $chromeRegistryPath -Value $manifestPath

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Native host manifest was not created: $manifestPath"
}
$registeredManifest = (Get-Item $chromeRegistryPath).GetValue('')
if ($registeredManifest -ne $manifestPath) {
    throw "Chrome native host registration does not match: $registeredManifest"
}
$installedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expectedOrigin = "chrome-extension://$ExtensionId/"
if ($installedManifest.allowed_origins -notcontains $expectedOrigin) {
    throw "Extension ID was not registered: $expectedOrigin"
}

# A log left over from the previous build would be mistaken for the next run's record.
Remove-Item -Force -ErrorAction SilentlyContinue $logFile

Write-Host 'FolderPath Memo native host was installed.' -ForegroundColor Green
Write-Host "Verified executable: $executable" -ForegroundColor Green
Write-Host "Verified extension:  $expectedOrigin" -ForegroundColor Green
Write-Host "Host version:        $previousVersion -> $installedVersion" -ForegroundColor Green
Write-Host "Built at:            $((Get-Item $executable).LastWriteTime)" -ForegroundColor Green
Write-Host ''
Write-Host 'Native host installation does not launch the popup.' -ForegroundColor Yellow
Write-Host 'Next: completely restart Chrome, reload the extension at chrome://extensions, then click its toolbar icon.'
Write-Host 'You can also press Alt+Shift+F, or select Extension options from the extension menu.'
Write-Host ''
Write-Host 'To check an installation later, run:'
Write-Host "  & `"$executable`" -version"
Write-Host 'After clicking Open, the steps of that click are recorded in:'
Write-Host "  $logFile"
