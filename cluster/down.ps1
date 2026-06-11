# Burn it all down. PKI, state, pods, frames in flight — gone. That's the
# point: every cluster is a throwaway. Your FACTORY (belts, machines, host
# slots) lives in the browser's localStorage, so it survives a rebuild — the
# same hosts come back to the same roosts and your routes still line up.
$ErrorActionPreference = "Continue"
$clusterName = "pigeon"

talosctl cluster destroy --name $clusterName --provisioner docker 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "(no '$clusterName' cluster to destroy, or already gone)" -ForegroundColor DarkGray
}

# Drop our talosconfig contexts so the next create lands as "pigeon" again
# (stale ones make talosctl suffix the new context). Never touches non-pigeon
# contexts.
foreach ($ctx in (talosctl config contexts 2>$null | Select-String -Pattern "^\*?\s+(pigeon(-\d+)?)\s" | ForEach-Object { $_.Matches[0].Groups[1].Value })) {
    cmd /c "echo y| talosctl config remove $ctx 2>nul"
}

# Tidy the kubeconfig too, so `kubectl` doesn't linger pointing at a dead API.
cmd /c "kubectl config delete-context admin@$clusterName 2>nul"
cmd /c "kubectl config delete-cluster $clusterName 2>nul"
cmd /c "kubectl config unset users.admin@$clusterName 2>nul"

Write-Host "down: the loft is empty." -ForegroundColor Green
