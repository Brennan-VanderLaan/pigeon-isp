# Milestone 1 win condition: alice pings bob THROUGH your factory.
# Run it with no game connected (or no belts built) and watch it fail —
# 100% packet loss is the correct starting state of a router you haven't built.
$ErrorActionPreference = "Continue"

$bobIP = kubectl -n aviary get pod bob -o jsonpath='{.status.podIP}'
if (-not $bobIP) { throw "bob has no IP - is the cluster up? (cluster\up.ps1)" }
$aliceIP = kubectl -n aviary get pod alice -o jsonpath='{.status.podIP}'

Write-Host "alice ($aliceIP) -> bob ($bobIP): releasing the pigeons" -ForegroundColor Cyan
Write-Host "(watch the game: ARP who-has flies first, then ICMP echoes)" -ForegroundColor DarkGray
kubectl -n aviary exec alice -- ping -c 4 -W 5 $bobIP
if ($LASTEXITCODE -eq 0) {
    Write-Host "`nPING SUCCEEDED. You built a router out of conveyor belts." -ForegroundColor Green
} else {
    Write-Host "`nPacket loss. The pigeons need a path - go build one." -ForegroundColor Yellow
}
