# GitOps (ArgoCD)

`up.ps1` installs ArgoCD but applies `cluster/manifests/` directly until this
repo has a remote ArgoCD can reach:

```powershell
git remote add origin https://github.com/<you>/pigeon-isp.git
git push -u origin main
.\cluster\up.ps1 -GitRepo https://github.com/<you>/pigeon-isp.git
```

That applies `root.yaml` (with `__REPO_URL__` substituted), an app-of-apps
over `gitops/apps/`, which in turn syncs `cluster/manifests/{infra,loft,web,aviary}`.

Caveat: the `loft-src` / `game-src` ConfigMaps are tarballs generated from the
working tree by `up.ps1` — ArgoCD doesn't own those. When the project gains a
real image registry, the DaemonSet/Deployment switch to images and the
ConfigMap step disappears.

ArgoCD UI: http://argocd.localhost — user `admin`, password:

```powershell
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' |
  %{ [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) }
```
