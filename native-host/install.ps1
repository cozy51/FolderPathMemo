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

@(
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\jp.folderpath.memo',
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\jp.folderpath.memo'
) | ForEach-Object {
    New-Item -Force -Path $_ | Out-Null
    Set-Item -Path $_ -Value $manifestPath
}

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Native host executable was not created: $executable"
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Native host manifest was not created: $manifestPath"
}
$registeredManifest = (Get-Item 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\jp.folderpath.memo').GetValue('')
if ($registeredManifest -ne $manifestPath) {
    throw "Edge native host registration does not match: $registeredManifest"
}
$installedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expectedOrigin = "chrome-extension://$ExtensionId/"
if ($installedManifest.allowed_origins -notcontains $expectedOrigin) {
    throw "Extension ID was not registered: $expectedOrigin"
}

Write-Host 'FolderPath Memo native host was installed.' -ForegroundColor Green
Write-Host "Verified executable: $executable" -ForegroundColor Green
Write-Host "Verified extension:  $expectedOrigin" -ForegroundColor Green
Write-Host 'Restart Edge before using the Open button.'
