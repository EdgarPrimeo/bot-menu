# Compile le pont WhatsApp pour le VPS (Linux 64 bits) depuis Windows.
# Usage (PowerShell, dans ce dossier) :  powershell -ExecutionPolicy Bypass -File .\build.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  Write-Host "Go n'est pas installé (ou PowerShell n'a pas été rouvert après l'installation)." -ForegroundColor Red
  exit 1
}
go version

$env:GOOS = "linux"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"
$env:GOTOOLCHAIN = "auto"

Write-Host "Compilation en cours (1 à 3 minutes la première fois)..."
go build -trimpath -ldflags="-s -w" -o wa-bridge .
if ($LASTEXITCODE -ne 0) { Write-Host "La compilation a échoué : copie le message d'erreur ci-dessus à Claude." -ForegroundColor Red; exit 1 }

$hash = (Get-FileHash .\wa-bridge -Algorithm SHA256).Hash.ToLower()
Write-Host ""
Write-Host "OK : fichier wa-bridge créé." -ForegroundColor Green
Write-Host "Empreinte SHA256 (à donner à Claude) : $hash"
