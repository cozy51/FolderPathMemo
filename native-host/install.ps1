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

Write-Host 'FolderPath Memo native host was installed.' -ForegroundColor Green
Write-Host 'Restart Edge before using the Open button.'
