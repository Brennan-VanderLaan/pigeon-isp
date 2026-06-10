# Burn it all down. PKI, state, pods, frames in flight — gone. That's the point.
talosctl cluster destroy --name pigeon --provisioner docker
# Drop our talosconfig contexts so the next create lands as "pigeon" again
# (stale ones make talosctl suffix the new context). Never touches non-pigeon
# contexts.
foreach ($ctx in (talosctl config contexts 2>$null | Select-String -Pattern "^\*?\s+(pigeon(-\d+)?)\s" | ForEach-Object { $_.Matches[0].Groups[1].Value })) {
    cmd /c "echo y| talosctl config remove $ctx 2>nul"
}
