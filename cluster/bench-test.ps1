# Bandwidth + latency through the pigeon network, with the telemetry split:
#   loft-side:     deliverLatencyUs from http://127.0.0.1:9777/stats
#                  (frame arrival -> consumer decision -> writeout)
#   consumer-side: the "decide: X µs" stat in the game HUD
#
# Open the game in benchmark mode FIRST: http://pigeon.localhost/?autoroute=1
# (autoroute = MAC-learning software switch, no physics — the webapp ceiling)
param([int]$Seconds = 10, [string]$UdpRate = "100M")
# Not "Stop": kubectl writes warnings to stderr (PSA), which PS 5.1 would
# otherwise promote to terminating errors when output is redirected.
$ErrorActionPreference = "Continue"

kubectl apply -f "$PSScriptRoot\manifests\aviary\bench.yaml" | Out-Null
kubectl -n aviary wait --for=jsonpath='{.status.phase}'=Running pod/bench-server pod/bench-client --timeout=5m | Out-Null
$serverIP = kubectl -n aviary get pod bench-server -o jsonpath='{.status.podIP}'

function Get-LoftLatency {
    try {
        $stats = Invoke-RestMethod http://127.0.0.1:9777/stats
        foreach ($pod in $stats.ports.PSObject.Properties) {
            $l = $pod.Value.deliverLatencyUs
            if ($l.count -gt 0) {
                $avg = [math]::Round($l.sum / $l.count, 1)
                Write-Host ("  loft  {0,-14} avg {1,8} us   max {2,8} us   ({3} delivered)" -f $pod.Name, $avg, $l.max, $l.count)
            }
            $d = $pod.Value.drops
            if (($d.overflow + $d.ttl + $d.consumer) -gt 0) {
                Write-Host ("  drops {0,-14} overflow={1} ttl={2} consumer={3}" -f $pod.Name, $d.overflow, $d.ttl, $d.consumer)
            }
        }
    } catch { Write-Host "  (loft stats unreachable on 127.0.0.1:9777 - is the cluster up?)" }
}

Write-Host "== RTT baseline (ICMP through your routing) ==" -ForegroundColor Cyan
# alice (busybox) pings the bench server — the iperf3 image carries no ping.
kubectl -n aviary exec alice -- ping -c 10 -W 5 $serverIP

Write-Host "`n== TCP throughput, $Seconds s ==" -ForegroundColor Cyan
kubectl -n aviary exec bench-client -- iperf3 -c $serverIP -t $Seconds

Write-Host "`n== UDP $UdpRate, $Seconds s (jitter + loss) ==" -ForegroundColor Cyan
kubectl -n aviary exec bench-client -- iperf3 -c $serverIP -u -b $UdpRate -t $Seconds

Write-Host "`n== Pigeon network telemetry (loft side) ==" -ForegroundColor Cyan
Get-LoftLatency
Write-Host "`nConsumer-side decide time is in the game HUD ('decide: X us')." -ForegroundColor DarkGray
