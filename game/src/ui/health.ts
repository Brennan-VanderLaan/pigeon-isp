// Health: the admin view. Node readiness + usage (kubelet stats via tower),
// per-node loft/trunk state, and anything unhappy in the cluster.

export class Health {
  private el = document.getElementById('health')!;
  private timer: number | null = null;

  show(): void {
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 5000);
  }

  hide(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    try {
      const [health, usage] = await Promise.all([
        fetch('/api/health').then((r) => r.json()),
        fetch('/api/usage').then((r) => r.json()),
      ]);
      this.render(health, usage);
    } catch (e) {
      this.el.innerHTML = `<h2>Health</h2><div class="sub bad">tower unreachable: ${(e as Error).message}</div>
        <div class="small" style="color:var(--dim)">is the cluster up, and are you on http://pigeon.localhost ?</div>`;
    }
  }

  private render(health: any, usage: any): void {
    const usageByNode: Record<string, any> = {};
    for (const n of usage.nodes ?? []) usageByNode[n.name] = n;

    const nodeCards = (health.nodes ?? []).map((n: any) => {
      const u = usageByNode[n.name] ?? {};
      const cpuPct = u.cpuMillicores && u.cpuCapacityMillicores
        ? Math.round((u.cpuMillicores / u.cpuCapacityMillicores) * 100) : null;
      const memPct = u.memBytes && u.memCapacityBytes
        ? Math.round((u.memBytes / u.memCapacityBytes) * 100) : null;
      const loft = n.loft ?? {};
      const loftLine = loft.role
        ? `loft: ${loft.role} · ${loft.ports ?? 0} local ports${loft.remotePorts ? ` + ${loft.remotePorts} remote` : ''}${loft.edges ? ` · ${loft.edges} edge(s) trunked` : ''}
buffered ${loft.buffered ?? 0} · noConsumer ${loft.droppedNoConsumer ?? 0} · trunk drops ${loft.droppedTrunk ?? 0}`
        : 'loft: unreachable';
      return `<div class="card">
        <h3>${n.name} ${n.ready ? '<span class="ok">● Ready</span>' : '<span class="bad">● NotReady</span>'}</h3>
        <div class="small">${n.ip} · ${n.kubelet}</div>
        ${cpuPct !== null ? `<div class="small">cpu ${u.cpuMillicores}m (${cpuPct}%)</div><div class="bar"><div style="width:${cpuPct}%;background:${cpuPct > 80 ? 'var(--bad)' : '#8ab4ff'}"></div></div>` : ''}
        ${memPct !== null ? `<div class="small">mem ${(u.memBytes / 1048576).toFixed(0)} MiB (${memPct}%)</div><div class="bar"><div style="width:${memPct}%;background:${memPct > 85 ? 'var(--bad)' : '#6fdc8c'}"></div></div>` : ''}
        <div class="small" style="margin-top:8px">${loftLine}</div>
      </div>`;
    }).join('');

    const nsRows = Object.entries(health.namespaces ?? {}).map(([ns, phases]: [string, any]) => {
      const total = Object.values(phases as Record<string, number>).reduce((a, b) => a + b, 0);
      const running = (phases as any).Running ?? 0;
      const cls = running === total ? 'ok' : 'bad';
      return `<tr><td>${ns}</td><td class="${cls}">${running}/${total} running</td>
        <td>${Object.entries(phases).map(([p, c]) => `${p}:${c}`).join(' ')}</td></tr>`;
    }).join('');

    const problems = (health.problems ?? []).length
      ? `<h3 class="bad" style="margin-top:18px">problems</h3><table class="grid">
         ${(health.problems as any[]).map((p) => `<tr><td>${p.pod}</td><td class="bad">${p.phase}</td><td>${p.node ?? ''}</td></tr>`).join('')}</table>`
      : `<div class="small ok" style="margin-top:18px">no unhappy pods</div>`;

    this.el.innerHTML = `
      <h2>Health</h2>
      <div class="sub">cluster + loft telemetry via the tower · refreshes every 5s · ${health.time ?? ''}</div>
      <div class="cards">${nodeCards}</div>
      <table class="grid"><tr><th>namespace</th><th>pods</th><th>phases</th></tr>${nsRows}</table>
      ${problems}`;
  }
}
