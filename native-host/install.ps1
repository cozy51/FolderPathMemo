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
Remove-Item -Force -ErrorAction SilentlyContinue $executable
Add-Type -Path $source -OutputAssembly $executable -OutputType ConsoleApplication `
    -ReferencedAssemblies @(
        (Join-Path $frameworkDirectory 'System.dll'),
        (Join-Path $frameworkDirectory 'System.Core.dll'),
        (Join-Path $frameworkDirectory 'System.Windows.Forms.dll'),
        (Join-Path $frameworkDirectory 'System.Web.Extensions.dll')
    )

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

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Native host executable was not created: $executable"
}
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

Write-Host 'FolderPath Memo native host was installed.' -ForegroundColor Green
Write-Host "Verified executable: $executable" -ForegroundColor Green
Write-Host "Verified extension:  $expectedOrigin" -ForegroundColor Green
Write-Host ''
Write-Host 'Native host installation does not launch the popup.' -ForegroundColor Yellow
Write-Host 'Next: completely restart Chrome, reload the extension at chrome://extensions, then click its toolbar icon.'
Write-Host 'You can also press Alt+Shift+F, or select Extension options from the extension menu.'
