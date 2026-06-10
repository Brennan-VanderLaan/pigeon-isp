// Network tab: the host inventory. See every host the game knows (on the
// board, shelved, or offline), shelve/unshelve them, and set placement zones
// so new/VPN hosts land pre-wired in an area you've built out.
import type { Board, HostInfo } from '../game/board';

export class Network {
  private el = document.getElementById('network')!;
  private timer: number | null = null;

  constructor(private board: Board) {
    board.onHosts = () => { if (this.timer !== null) this.render(); };
  }

  show(): void {
    this.render();
    // Don't clobber a zone-rule field mid-type on the periodic refresh.
    this.timer = window.setInterval(() => {
      const a = document.activeElement;
      if (!(a && this.el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT'))) this.render();
    }, 2000);
  }
  hide(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private statusOf(h: HostInfo): string {
    if (h.shelved) return '<span style="color:var(--dim)">shelved</span>';
    if (!h.present) return '<span style="color:var(--dim)">offline</span>';
    return h.slot !== undefined ? `<span class="ok">slot ${h.slot}</span>` : 'on board';
  }

  private render(): void {
    const hosts = this.board.hostInventory();
    const rows = hosts.map((h) => `
      <tr>
        <td>${esc(h.port.pod)}</td>
        <td>${esc(h.port.ip)}</td>
        <td>${esc((h.port.node ?? '').replace(/^pigeon-/, ''))}</td>
        <td>${this.statusOf(h)}</td>
        <td>
          ${h.shelved
            ? `<button data-unshelve="${esc(h.ident)}">place</button>`
            : `<button data-shelve="${esc(h.ident)}">shelve</button>`}
        </td>
      </tr>`).join('');

    const rules = this.board.getPlacementRules();
    const ruleRows = rules.map((r, i) => `
      <tr>
        <td><input data-rp="${i}" value="${esc(r.pattern)}" style="width:120px" placeholder="name contains…"></td>
        <td><input data-rs="${i}" value="${r.slots.join(',')}" style="width:160px" placeholder="slots e.g. 8,9,10"></td>
        <td><button data-rdel="${i}">✕</button></td>
      </tr>`).join('');

    this.el.innerHTML = `
      <h2>Network — host inventory</h2>
      <div class="sub">every host the game knows. <b>Shelve</b> takes a host off the board (its traffic is then dropped);
      <b>place</b> puts it back. Placement zones below decide where matching new hosts land, so VPN/sandbox hosts show up
      already wired into an area you built.</div>
      <table class="grid">
        <tr><th>pod</th><th>ip</th><th>node</th><th>status</th><th></th></tr>
        ${rows || '<tr><td colspan="5" class="small">no hosts known yet</td></tr>'}
      </table>

      <h3 style="margin-top:20px;color:var(--accent)">placement zones</h3>
      <div class="sub">a new host whose pod name contains <i>pattern</i> takes the lowest free slot from <i>slots</i>
      (0–${this.board.slotCount() - 1}). Lowest indices are the original spots; higher ones ring the rest of the perimeter.</div>
      <table class="grid">
        <tr><th>pattern</th><th>slots (zone)</th><th></th></tr>
        ${ruleRows}
        <tr><td colspan="3"><button id="net-addrule">+ add zone</button></td></tr>
      </table>`;

    this.el.querySelectorAll<HTMLButtonElement>('[data-shelve]').forEach((b) =>
      b.addEventListener('click', () => this.board.shelveHost(b.dataset.shelve!)));
    this.el.querySelectorAll<HTMLButtonElement>('[data-unshelve]').forEach((b) =>
      b.addEventListener('click', () => this.board.unshelveHost(b.dataset.unshelve!)));
    this.el.querySelector('#net-addrule')?.addEventListener('click', () => {
      const r = this.board.getPlacementRules();
      r.push({ pattern: '', slots: [] });
      this.board.setPlacementRules(r);
      this.render();
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-rdel]').forEach((b) =>
      b.addEventListener('click', () => {
        const r = this.board.getPlacementRules();
        r.splice(Number(b.dataset.rdel), 1);
        this.board.setPlacementRules(r);
        this.render();
      }));
    const commitRules = () => {
      const r = this.board.getPlacementRules();
      this.el.querySelectorAll<HTMLInputElement>('[data-rp]').forEach((inp) => {
        const i = Number(inp.dataset.rp);
        if (r[i]) r[i].pattern = inp.value.trim();
      });
      this.el.querySelectorAll<HTMLInputElement>('[data-rs]').forEach((inp) => {
        const i = Number(inp.dataset.rs);
        if (r[i]) r[i].slots = inp.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      });
      this.board.setPlacementRules(r);
    };
    this.el.querySelectorAll<HTMLInputElement>('[data-rp],[data-rs]').forEach((inp) =>
      inp.addEventListener('change', commitRules));
  }
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
