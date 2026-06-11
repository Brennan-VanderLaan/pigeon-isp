# Spins up an ephemeral Talos cluster (docker provisioner, throwaway PKI) with
# NO CNI, then installs the pigeon stack: dual-mode pigeon-cni, loft data
# plane, Traefik ingress, the game served in-cluster, ArgoCD, and the aviary
# test pods. Tear down with down.ps1; nothing is left behind.
#
#   .\cluster\up.ps1                       # everything, manifests applied directly
#   .\cluster\up.ps1 -SkipArgoCD           # skip argocd (faster)
#   .\cluster\up.ps1 -GitRepo https://...  # also point ArgoCD at your remote
param(
    [int]$Workers = 2,
    [string]$GitRepo = "",
    [switch]$SkipArgoCD,
    [switch]$WithIKEv2   # also publish UDP 500/4500 for IKEv2 — OFF by default
                         # because the host OS (Windows IPsec) often already
                         # binds them, which would fail the whole cluster create.
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$clusterName = "pigeon"

foreach ($tool in "talosctl", "kubectl", "docker", "tar") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool not found on PATH"
    }
}

# Default docker-provisioner CIDR puts the (single) control plane at 10.5.0.2.
$nodeIP = "10.5.0.2"

# Stale talosconfig contexts from destroyed clusters make talosctl suffix the
# new context (pigeon -> pigeon-1) and point --context pigeon at a dead
# endpoint. Clean ours up front; never touch non-pigeon contexts.
foreach ($ctx in (talosctl config contexts 2>$null | Select-String -Pattern "^\*?\s+(pigeon(-\d+)?)\s" | ForEach-Object { $_.Matches[0].Groups[1].Value })) {
    cmd /c "echo y| talosctl config remove $ctx 2>nul"
}

$existing = cmd /c "docker ps -q -f name=$clusterName-controlplane-1 2>nul"
if ($existing) {
    Write-Host "==> cluster '$clusterName' already running, skipping create" -ForegroundColor Yellow
    # Re-adopt its talosconfig so --context pigeon resolves.
    cmd /c "talosctl config merge `"$env:USERPROFILE\.talos\clusters\$clusterName\talosconfig`" 2>nul"
} else {
    Write-Host "==> creating Talos cluster '$clusterName' (fresh PKI, no CNI)" -ForegroundColor Cyan
    # 80=ingress, 9777=loft ws, 51820/udp=WireGuard. IKEv2 (500/4500) only with
    # -WithIKEv2, since the host often already uses those.
    $ports = "80:80/tcp,9777:9777/tcp,51820:51820/udp"
    if ($WithIKEv2) { $ports += ",500:500/udp,4500:4500/udp" }
    # --wait=false: with no CNI the health check would wait forever for Ready
    # nodes; WE are the thing that makes them Ready.
    talosctl cluster create `
        --name $clusterName `
        --provisioner docker `
        --workers $Workers `
        --exposed-ports $ports `
        --config-patch "@$PSScriptRoot\talos-patch.yaml" `
        --wait=false
    if ($LASTEXITCODE -ne 0) { throw "talosctl cluster create failed" }
}

Write-Host "==> fetching kubeconfig" -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(5)
while ($true) {
    cmd /c "talosctl --context $clusterName kubeconfig --nodes $nodeIP --force 2>nul"
    if ($LASTEXITCODE -eq 0) { break }
    if ((Get-Date) -gt $deadline) { throw "could not fetch kubeconfig" }
    Start-Sleep 5
}
# The kubeconfig points at the container IP, which Docker Desktop can't route
# from the host. The API server is published on a localhost port — rewrite.
$portLine = (cmd /c "docker port $clusterName-controlplane-1 6443") | Select-Object -First 1
$apiPort = $portLine.Split(":")[-1].Trim()
kubectl config set-cluster $clusterName --server="https://127.0.0.1:$apiPort" | Out-Null
Write-Host "    api server: https://127.0.0.1:$apiPort"

Write-Host "==> waiting for the API server and node registration" -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(5)
while ($true) {
    $nodes = cmd /c "kubectl get nodes -o name 2>nul"
    if ($LASTEXITCODE -eq 0 -and $nodes -and ($nodes | Measure-Object).Count -ge (1 + $Workers)) { break }
    if ((Get-Date) -gt $deadline) { throw "nodes never registered" }
    Start-Sleep 5
}
kubectl get nodes

Write-Host "==> packaging source tarballs (the cluster builds its own binaries)" -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP "pigeon-src"
New-Item -ItemType Directory -Force $tmp | Out-Null
tar -czf "$tmp\loft-src.tgz" -C "$repo\bridge" go.mod go.sum cmd
if ($LASTEXITCODE -ne 0) { throw "failed to tar bridge source" }
tar -czf "$tmp\game-src.tgz" -C "$repo\game" package.json index.html tsconfig.json vite.config.ts src
if ($LASTEXITCODE -ne 0) { throw "failed to tar game source" }
# Tar every .go file (tower grew past a single main.go).
$towerGo = Get-ChildItem "$repo\tower" -Filter *.go | Select-Object -ExpandProperty Name
tar -czf "$tmp\tower-src.tgz" -C "$repo\tower" go.mod go.sum @towerGo
if ($LASTEXITCODE -ne 0) { throw "failed to tar tower source" }

Write-Host "==> deploying the loft (builds loftd + pigeon-cni in-cluster)" -ForegroundColor Cyan
kubectl apply -f "$PSScriptRoot\manifests\loft\namespace.yaml"
kubectl -n pigeon-system create configmap loft-src --from-file="$tmp\loft-src.tgz" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n pigeon-system create configmap game-src --from-file="$tmp\game-src.tgz" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$PSScriptRoot\manifests\loft\"

Write-Host "==> waiting for loft pods (first build pulls Go modules, ~1-2 min)" -ForegroundColor Cyan
kubectl -n pigeon-system rollout status daemonset/loft --timeout=10m
if ($LASTEXITCODE -ne 0) { throw "loft daemonset did not come up" }

Write-Host "==> waiting for nodes to go Ready (pigeon-cni installed)" -ForegroundColor Cyan
kubectl wait --for=condition=Ready nodes --all --timeout=5m

Write-Host "==> deploying Traefik, the game web app, and the tower" -ForegroundColor Cyan
kubectl apply -f "$PSScriptRoot\manifests\infra\"
kubectl apply -f "$PSScriptRoot\manifests\web\"
kubectl -n pigeon-system create configmap tower-src --from-file="$tmp\tower-src.tgz" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$PSScriptRoot\manifests\tower\"

Write-Host "==> deploying the WireGuard VPN gateway" -ForegroundColor Cyan
# Plant a stable random seed (once per cluster) so the gateway's WireGuard keys
# survive restarts — a scanned QR keeps working across redeploys. Only created
# if absent, so re-running up.ps1 never rotates it out from under live clients.
$haveSeed = cmd /c "kubectl -n pigeon-system get secret wg-seed 2>nul"
if (-not $haveSeed) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $seed = [Convert]::ToBase64String($bytes)
    kubectl -n pigeon-system create secret generic wg-seed --from-literal=seed=$seed | Out-Null
}
kubectl apply -f "$PSScriptRoot\manifests\vpn\wg-gateway.yaml"
if ($WithIKEv2) {
    Write-Host "==> deploying the IKEv2 gateway (experimental)" -ForegroundColor Cyan
    kubectl apply -f "$PSScriptRoot\manifests\vpn\ikev2.yaml"
}

Write-Host "==> deploying the uplink gateway (aviary -> the world, when you route it)" -ForegroundColor Cyan
kubectl apply -f "$PSScriptRoot\manifests\uplink\"

Write-Host "==> releasing the aviary (alice and bob)" -ForegroundColor Cyan
kubectl apply -f "$PSScriptRoot\manifests\aviary\"

if (-not $SkipArgoCD) {
    Write-Host "==> installing ArgoCD" -ForegroundColor Cyan
    kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
    # Plain http behind traefik:
    kubectl -n argocd patch configmap argocd-cmd-params-cm --type merge -p '{\"data\":{\"server.insecure\":\"true\"}}'
    kubectl -n argocd rollout restart deployment argocd-server
    @"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd
  namespace: argocd
spec:
  ingressClassName: traefik
  rules:
    - host: argocd.localhost
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: argocd-server
                port:
                  number: 80
"@ | kubectl apply -f -

    if ($GitRepo) {
        Write-Host "==> pointing ArgoCD at $GitRepo (app-of-apps)" -ForegroundColor Cyan
        foreach ($f in "$repo\gitops\root.yaml") {
            (Get-Content $f -Raw).Replace("__REPO_URL__", $GitRepo) | kubectl apply -f -
        }
    } else {
        Write-Host "    (no -GitRepo: manifests applied directly; push the repo and re-run with -GitRepo for GitOps)" -ForegroundColor DarkGray
    }
}

Write-Host "==> waiting for the game web build (npm install in-cluster, ~2-3 min)" -ForegroundColor Cyan
kubectl -n pigeon-system rollout status deployment/game-web --timeout=10m
kubectl -n aviary wait --for=jsonpath='{.status.phase}'=Running pod/alice pod/bob --timeout=5m

kubectl get pods -A -o wide
Write-Host ""
Write-Host "The loft is open." -ForegroundColor Green
Write-Host "  game:    http://pigeon.localhost          (served from the cluster)"
Write-Host "  bridge:  ws://pigeon.localhost/ws         (direct dev: ws://127.0.0.1:9777/ws)"
if (-not $SkipArgoCD) {
    Write-Host "  argocd:  http://argocd.localhost          (admin / see below)"
    Write-Host "           kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | %{ [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(`$_)) }"
}
Write-Host "  test:    .\cluster\ping-test.ps1          (fails until YOU build the route)"
