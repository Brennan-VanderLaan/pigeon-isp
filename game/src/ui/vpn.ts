// VPN tab: bring real devices onto the pigeon network. Two backends, picked
// by what the device runs:
//   WireGuard — needs the WireGuard app (iOS/Android/desktop), per-peer config,
//               working today.
//   IKEv2     — built into iOS/Android/Windows/macOS (no app), responder up;
//               data plane experimental.
interface VpnPeer {
  name: string; ip: string; config: string; connected: string; qr?: string;
  handshake?: string; // seconds since last WireGuard handshake, or "never"
  rx?: string; tx?: string; // byte counters
  wgPeer?: string; // the device's current source ip:port (its public address)
}

export class Vpn {
  private el = document.getElementById('vpn')!;
  private timer: number | null = null;
  private tab: 'wireguard' | 'ikev2' = 'wireguard';
  private peers: VpnPeer[] = [];
  private endpoint = '';
  private wgErr = '';
  private gwHost = loadGwHost();   // LAN address phones dial; '' = gateway default
  private showKeys = false;        // reveal private keys on screen (off by default)

  show(): void {
    this.refresh(true);
    this.timer = window.setInterval(() => this.refresh(), 4000);
  }
  hide(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(force = false): Promise<void> {
    // Don't let the 4s poll re-render over the address box while it's being
    // typed in — only a forced (user-driven) refresh clobbers focus.
    if (!force && this.el.contains(document.activeElement) &&
        (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    try {
      const q = this.gwHost ? `?host=${encodeURIComponent(this.gwHost)}` : '';
      const r = await fetch(`/vpn/configs${q}`);
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

  // PrivateKey is the one secret on screen — mask it unless explicitly revealed.
  // The QR and the copy button always carry the real key (a phone needs it).
  private maskKey(cfg: string): string {
    if (this.showKeys) return cfg;
    return cfg.replace(/(PrivateKey\s*=\s*)\S+/, '$1••••••••••••••••••••••••••••');
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
          ${wgBadge(p)}
          <button data-copy="${i}" style="margin-left:auto">copy config</button>
        </div>
        ${wgDetail(p)}
        <div style="display:flex;gap:14px;align-items:flex-start;margin-top:8px">
          <div style="text-align:center">
            ${p.qr
              ? `<img class="vpn-qr" src="${esc(p.qr)}" alt="WireGuard QR for ${esc(p.name)}"
                   width="180" height="180" style="background:#fff;border-radius:8px;padding:6px;image-rendering:pixelated"
                   onerror="this.style.display='none'"/>
                 <div class="sub" style="margin:4px 0 0;font-size:11px">scan in the WireGuard app</div>`
              : '<div class="sub" style="font-size:11px">QR needs the updated gateway</div>'}
          </div>
          <pre class="vpn-cfg" id="vpn-cfg-${i}" style="flex:1;margin:0">${esc(this.maskKey(p.config))}</pre>
        </div>
      </div>`).join('');
    const reachable = this.gwHost && !/^(127\.|localhost$|.*\.localhost$)/.test(this.gwHost);
    return `
      <div class="sub"><b>On a phone:</b> open the WireGuard app → <b>＋</b> → <b>Scan from QR code</b>, point it at a code below,
      connect. That device becomes its own host on the factory floor. On desktop, use <b>copy config</b> instead.</div>
      <div class="card" style="max-width:760px">
        <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap">
          <label style="font-size:13px">Gateway address phones dial
            <input id="wg-host" type="text" placeholder="e.g. 192.168.1.50" value="${esc(this.gwHost)}"
              style="margin-left:6px;width:170px"/>
          </label>
          <span class="sub" style="margin:0;font-size:12px">→ endpoint <code>${esc(this.endpoint || '?')}</code></span>
          <label style="margin-left:auto;font-size:13px;cursor:pointer">
            <input id="wg-showkeys" type="checkbox" ${this.showKeys ? 'checked' : ''}/> show private keys
          </label>
        </div>
        <div class="sub" style="margin:6px 0 0;font-size:12px">
          ${reachable
            ? 'Your phone must be on the same network and reach this address on UDP 51820.'
            : '<b>Set your host\'s LAN IP above</b> — phones can\'t reach 127.0.0.1/localhost. UDP 51820 must be published (it is, after <code>cluster\\up.ps1</code>).'}
        </div>
      </div>
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

    const hostInput = this.el.querySelector<HTMLInputElement>('#wg-host');
    if (hostInput) {
      // Re-fetch (so configs + QR carry the new endpoint) only once typing settles.
      const apply = () => {
        const v = hostInput.value.trim();
        if (v === this.gwHost) return;
        this.gwHost = v;
        saveGwHost(v);
        this.refresh();
      };
      hostInput.addEventListener('change', apply);
      hostInput.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') apply(); });
    }
    const showKeys = this.el.querySelector<HTMLInputElement>('#wg-showkeys');
    showKeys?.addEventListener('change', () => { this.showKeys = showKeys.checked; this.render(); });
  }
}

const GW_HOST_KEY = 'pigeon-wg-host';
// Default the dial-in address to however you reached the game, unless that's a
// loopback/localhost (useless to a phone) — then leave it blank to prompt.
function loadGwHost(): string {
  try {
    const saved = localStorage.getItem(GW_HOST_KEY);
    if (saved !== null) return saved;
  } catch { /* storage blocked */ }
  const h = location.hostname;
  return /^(127\.|localhost$|.*\.localhost$|\[?::1)/.test(h) ? '' : h;
}
function saveGwHost(v: string): void {
  try { localStorage.setItem(GW_HOST_KEY, v); } catch { /* storage blocked */ }
}

// A WireGuard peer is "live" only if it handshook recently. WireGuard rekeys
// every ~2 min, so a handshake within ~3 min means an active tunnel.
function hsAge(p: VpnPeer): number | null {
  if (!p.handshake || p.handshake === 'never') return null;
  const n = Number(p.handshake);
  return Number.isFinite(n) ? n : null;
}
function wgBadge(p: VpnPeer): string {
  const age = hsAge(p);
  if (age === null) return `<span style="font-size:12px;color:#888">○ no handshake yet</span>`;
  if (age <= 180) return `<span class="ok" style="font-size:12px">● connected</span>`;
  return `<span style="font-size:12px;color:#d8a253">◌ idle (${fmtAge(age)})</span>`;
}
function wgDetail(p: VpnPeer): string {
  const age = hsAge(p);
  const rx = Number(p.rx ?? 0), tx = Number(p.tx ?? 0);
  if (age === null) {
    return `<div class="sub" style="margin:6px 0 0;font-size:12px">No device has connected to this slot yet —
      scan its QR (or import its config) and connect. The badge turns green the moment a handshake lands.</div>`;
  }
  return `<div class="sub" style="margin:6px 0 0;font-size:12px">
    last handshake <b>${fmtAge(age)}</b> ago${p.wgPeer ? ` · from <code>${esc(p.wgPeer)}</code>` : ''}
    · ↓ ${fmtBytes(rx)} rx · ↑ ${fmtBytes(tx)} tx</div>`;
}
function fmtAge(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h`;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
