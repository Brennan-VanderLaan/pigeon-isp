// VPN tab: bring real devices onto the pigeon network. Two backends, picked
// by what the device runs:
//   WireGuard — needs the WireGuard app (iOS/Android/desktop), per-peer config,
//               working today.
//   IKEv2     — built into iOS/Android/Windows/macOS (no app), responder up;
//               data plane experimental.
interface VpnPeer { name: string; ip: string; config: string; connected: string; }

export class Vpn {
  private el = document.getElementById('vpn')!;
  private timer: number | null = null;
  private tab: 'wireguard' | 'ikev2' = 'wireguard';
  private peers: VpnPeer[] = [];
  private endpoint = '';
  private wgErr = '';

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
      this.wgErr = '';
    } catch (e) {
      this.wgErr = (e as Error).message;
    }
    this.render();
  }

  private wgSection(): string {
    if (this.wgErr) {
      return `<div class="sub bad">WireGuard gateway unreachable: ${esc(this.wgErr)} — needs a cluster created with the
        WireGuard UDP port exposed (re-run cluster\\up.ps1).</div>`;
    }
    const rows = this.peers.map((p, i) => `
      <div class="card" style="max-width:760px">
        <div style="display:flex;align-items:center;gap:10px">
          <h3 style="margin:0">${esc(p.name)} — ${esc(p.ip)}</h3>
          <span class="${p.connected === 'true' ? 'ok' : ''}" style="font-size:12px">${p.connected === 'true' ? '● bridged' : '○ free'}</span>
          <button data-copy="${i}" style="margin-left:auto">copy config</button>
        </div>
        <pre class="vpn-cfg" id="vpn-cfg-${i}">${esc(p.config)}</pre>
      </div>`).join('');
    return `
      <div class="sub">Import a config into the <b>WireGuard app</b> (iOS / Android / Windows / macOS / Linux) and connect —
      that device becomes its own host on the factory floor. Endpoint: <code>${esc(this.endpoint || '?')}</code>.
      The WireGuard UDP port (51820) must be published at cluster-create time (re-run <code>cluster\\up.ps1</code> if needed).</div>
      ${rows || '<div class="sub">no peer slots</div>'}`;
  }

  private ikeSection(): string {
    return `
      <div class="sub">IKEv2 is built into <b>iOS, Android, Windows and macOS</b> — no app to install. Add a VPN of type
      <b>IKEv2</b> with these settings, then connect.</div>
      <div class="card" style="max-width:620px">
        <table class="grid">
          <tr><td>server</td><td>the host that publishes UDP 500/4500 (e.g. <code>127.0.0.1</code> locally)</td></tr>
          <tr><td>remote ID</td><td><code>pigeon.localhost</code></td></tr>
          <tr><td>auth</td><td>EAP (username / password)</td></tr>
          <tr><td>username</td><td><code>pigeon</code></td></tr>
          <tr><td>password</td><td><code>pigeon-vpn</code></td></tr>
          <tr><td>CA cert</td><td>self-signed — trust it on the device, or:<br>
            <code>kubectl -n pigeon-system exec deploy/ikev2-gateway -c charon -- cat /etc/swanctl/x509ca/ca.crt</code></td></tr>
        </table>
      </div>
      <div class="sub" style="color:var(--accent)">Status: the IKE responder is up and the XFRM data plane (ipsec0) is wired,
      but the full handshake is experimental — needs a real device to validate. If a phone connects, it shows up as a host
      (vpn-&lt;ip&gt;) you route like any other. WireGuard is the proven path meanwhile. UDP 500/4500 must be exposed at
      cluster-create time.</div>`;
  }

  private render(): void {
    const tabBtn = (id: string, label: string) =>
      `<button data-vtab="${id}" class="${this.tab === id ? 'active' : ''}">${label}</button>`;
    this.el.innerHTML = `
      <h2>VPN — bring real devices onto the pigeon network</h2>
      <div id="vpn-tabs" style="display:flex;gap:6px;margin-bottom:12px">
        ${tabBtn('wireguard', 'WireGuard (app)')}
        ${tabBtn('ikev2', 'IKEv2 (built-in)')}
      </div>
      <div>${this.tab === 'wireguard' ? this.wgSection() : this.ikeSection()}</div>`;

    this.el.querySelectorAll<HTMLButtonElement>('[data-vtab]').forEach((b) =>
      b.addEventListener('click', () => { this.tab = b.dataset.vtab as 'wireguard' | 'ikev2'; this.render(); }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
      b.addEventListener('click', () => {
        navigator.clipboard?.writeText(this.peers[Number(b.dataset.copy)]?.config ?? '');
        b.textContent = 'copied ✓';
        setTimeout(() => (b.textContent = 'copy config'), 1500);
      }));
  }
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
