# Применение db/schema.sql к PostgreSQL
# Использование: .\scripts\apply-schema.ps1
# Переменные: $env:PGHOST, $env:PGPORT, $env:PGUSER, $env:PGPASSWORD, $env:PGDATABASE

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SchemaFile = Join-Path $Root "db\schema.sql"

$pgHost = if ($env:PGHOST) { $env:PGHOST } else { "localhost" }
$pgPort = if ($env:PGPORT) { $env:PGPORT } else { "5432" }
$pgUser = if ($env:PGUSER) { $env:PGUSER } else { "taskhub" }
$pgDb   = if ($env:PGDATABASE) { $env:PGDATABASE } else { "taskhub" }

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
    Write-Host "psql не найден. Варианты:" -ForegroundColor Yellow
    Write-Host "  1. Установите PostgreSQL: https://www.postgresql.org/download/windows/"
    Write-Host "  2. Запустите Docker Desktop и: docker compose up -d"
    Write-Host "  3. Смотрите схему в plantuml\database-er.puml и docs\database-overview.md"
    exit 1
}

Write-Host "Применяю схему: $SchemaFile -> ${pgUser}@${pgHost}:${pgPort}/${pgDb}"
& psql -h $pgHost -p $pgPort -U $pgUser -d $pgDb -f $SchemaFile
if ($LASTEXITCODE -eq 0) {
    Write-Host "Готово. Таблицы созданы (без тестовых задач)." -ForegroundColor Green
}
