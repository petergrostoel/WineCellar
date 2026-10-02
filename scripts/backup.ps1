# Wine Cellar – fuld backup af vine, smagninger og etiketbilleder.
# Kun læsning: ændrer intet i databasen.
#
# Brug:  powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
# Backuppen lægges i Dokumenter\WineCellar-backup\<dato_tid>\ (uden for projektet,
# da projektet er offentligt på GitHub).

# (Supabase-værktøjet skriver statusbeskeder til stderr; de må ikke stoppe scriptet.)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root "tools\supabase.exe"
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$dest = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "WineCellar-backup\$stamp"
New-Item -ItemType Directory -Force $dest | Out-Null
Push-Location $root

function Export-Table($table, $order) {
    $raw = & $cli db query --linked "select * from public.$table order by $order" -o json 2>$null | Out-String
    $parsed = $raw | ConvertFrom-Json
    if ($null -eq $parsed -or $null -eq $parsed.PSObject.Properties["rows"]) {
        throw "Kunne ikke hente tabellen $table. Er Supabase CLI logget ind?"
    }
    $rows = $parsed.rows
    if ($null -eq $rows) { $rows = @() }
    $json = ConvertTo-Json -InputObject @($rows) -Depth 10
    [IO.File]::WriteAllText((Join-Path $dest "$table.json"), $json, [Text.UTF8Encoding]::new($false))
    Write-Host ("{0,-10} {1} rækker" -f $table, @($rows).Count)
    return @($rows).Count
}

try {
    $wines = Export-Table "wines" "created_at"
    $tastings = Export-Table "tastings" "drunk_at"

    # Billeder hentes enkeltvis (CLI'en kræver en relativ destination).
    $imgDir = Join-Path $dest "labels"
    New-Item -ItemType Directory -Force $imgDir | Out-Null
    $list = & $cli storage ls -r "ss:///labels/" --linked --experimental 2>$null | Out-String
    $paths = @(($list | ConvertFrom-Json).paths | Where-Object { $_ -like "*.jpg" -or $_ -like "*.png" -or $_ -like "*.webp" })
    Push-Location $imgDir
    foreach ($p in $paths) {
        $name = Split-Path $p -Leaf
        & $cli storage cp "ss://$p" $name --linked --experimental --workdir $root 2>&1 | Out-Null
    }
    Pop-Location
    $images = (Get-ChildItem $imgDir -Recurse -File | Measure-Object).Count
    Write-Host ("{0,-10} {1} filer" -f "billeder", $images)

    Write-Host ""
    Write-Host "Backup gemt i: $dest"
} finally {
    Pop-Location
}
