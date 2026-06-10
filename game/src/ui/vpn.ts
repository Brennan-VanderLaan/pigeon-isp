// VPN tab: per-peer WireGuard slots. Each desktop that imports a config and
// connects becomes its OWN host on the pigeon network (its own roost/landing),
// so you can route it like any pod. Configs come from the wg-gateway via the
// /vpn/configs ingress path.
interface VpnPeer {
  name: string;
  ip: string;
  config: string;
  connected: string;
}

export class Vpn {
  private el = document.getElementById('vpn')!;
  private timer: number | null = null;
  private peers: VpnPeer[] = [];
  private endpoint = '';
  private err = '';

  show(): void {
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 4000);
  }
  hide(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    try {
      const r = await fetch('/vpn/configs');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      this.peers = body.peers ?? [];
      this.endpoint = body.endpoint ?? '';
      this.err = '';
    } catch (e) {
      this.err = (e as Error).message;
    }
    this.render();
  }

  private render(): void {
    const rows = this.peers.map((p, i) => `
      <div class="card" style="max-width:760px">
        <div style="display:flex;align-items:center;gap:10px">
          <h3 style="margin:0">${esc(p.name)} — ${esc(p.ip)}</h3>
          <span class="${p.connected === 'true' ? 'ok' : ''}" style="font-size:12px">${p.connected === 'true' ? '● connected' : '○ free'}</span>
          <button data-copy="${i}" style="margin-left:auto">copy config</button>
        </div>
        <pre class="vpn-cfg" id="vpn-cfg-${i}">${esc(p.config)}</pre>
      </div>`).join('');

    this.el.innerHTML = `
      <h2>VPN — bring real desktops onto the pigeon network</h2>
      <div class="sub">Each slot is a per-peer WireGuard config. Import one into the
      <b>stock WireGuard client</b> (Windows / macOS / Linux / iOS / Android) and connect —
      that desktop becomes its own host (its own roost + landing) on the factory floor, and
      its real traffic routes through whatever you build. Endpoint: <code>${esc(this.endpoint || '?')}</code>.</div>
      ${this.err ? `<div class="sub bad">gateway unreachable: ${esc(this.err)} — the VPN gateway needs a cluster created with the WireGuard UDP port exposed (re-run cluster\\up.ps1).</div>` : ''}
      <div class="sub" style="color:var(--dim)">Note: the WireGuard UDP port (51820) must be published at cluster-create time. If you spun this
      cluster up before VPN existed, re-run <code>cluster\\up.ps1</code> to expose it.</div>
      ${rows}`;

    this.el.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => {
      b.addEventListener('click', () => {
        const cfg = this.peers[Number(b.dataset.copy)]?.config ?? '';
        navigator.clipboard?.writeText(cfg);
        b.textContent = 'copied ✓';
        setTimeout(() => (b.textContent = 'copy config'), 1500);
      });
    });
  }
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
