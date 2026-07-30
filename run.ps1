Set-Location $PSScriptRoot
Write-Host "Building plan tracker..." -ForegroundColor Cyan
node coach-scripts/render.mjs
Write-Host "Publishing to GitHub Pages..." -ForegroundColor Magenta
git add half-marathon-sep-2026.html
git commit -m "coach: build plan $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | Out-Null
git push origin main
Write-Host "Published → https://tomasbogalho.github.io/coach" -ForegroundColor Green
Write-Host "Opening locally..." -ForegroundColor Green
Start-Process "$PSScriptRoot\half-marathon-sep-2026.html"
