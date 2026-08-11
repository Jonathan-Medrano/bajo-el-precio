# Corre seed-catalog.js localmente contra la base de datos de produccion.
# La IP residencial no esta bloqueada por ML, al contrario del servidor de Fly.io.
# Uso: .\scripts\seed-prod.ps1

$root = Split-Path -Parent $PSScriptRoot

Write-Host "[seed-prod] Obteniendo credenciales de produccion desde Fly..." -ForegroundColor Cyan
$dbUrl    = (fly ssh console -a bajoelprecio -C 'printenv DATABASE_URL' 2>&1 | Where-Object { $_ -match "postgresql://" } | Select-Object -Last 1).Trim()
$directUrl = (fly ssh console -a bajoelprecio -C 'printenv DIRECT_URL'  2>&1 | Where-Object { $_ -match "postgresql://" } | Select-Object -Last 1).Trim()

if (-not $dbUrl) {
    Write-Host "[seed-prod] No se pudo obtener DATABASE_URL. Verificar fly auth." -ForegroundColor Red
    exit 1
}

Write-Host "[seed-prod] Conectando a produccion: $($dbUrl.Substring(0,30))..." -ForegroundColor Green

# Copiar env local y pisar solo las URLs de DB
$env:DATABASE_URL = $dbUrl
$env:DIRECT_URL   = $directUrl

Write-Host "[seed-prod] Corriendo seed localmente (IP residencial)..." -ForegroundColor Cyan
node "$root\src\seed-catalog.js"

Write-Host "[seed-prod] Listo. Los productos nuevos ya estan en produccion." -ForegroundColor Green
