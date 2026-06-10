// Speedtest, but for Pigeon ISP. Now bidirectional: up (host transmits) and
// down (-R, server transmits) measured separately, because the pigeon path
// can be ASYMMETRIC — your belts/filters for each direction are independent,
// so the two numbers can genuinely differ. Baseline (kernel-routed) vs
// pigeon (your fabric); the gap, and its asymmetry, is the product.

interface DirResult {
  direction: 'up' | 'down';
  iperf: Record<string, number | string>;
}
interface RunResult {
  test: string;
  proto: string;
  parallel?: number;
  serverNode?: string;
  rtt?: { avgMs?: number; minMs?: number; maxMs?: number; lossPercent?: number };
  directions?: DirResult[];
  loftStatsBefore?: Record<string, any>;
  loftStatsAfter?: Record<string, any>;
  error?: string;
}

export class Speedtest {
  private el = document.getElementById('speedtest')!;
  private results: { baseline?: RunResult; pigeon?: RunResult } = {};
  private running = false;
  private log: string[] = [];

  constructor() {
    this.render();
  }

  private cfg() {
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s);
    return {
      proto: q<HTMLSelectElement>('#st-proto')?.value ?? 'tcp',
      seconds: Number(q<HTMLInputElement>('#st-secs')?.value || 10),
      direction: q<HTMLSelectElement>('#st-dir')?.value ?? 'both',
      parallel: Number(q<HTMLInputElement>('#st-par')?.value || 1),
    };
  }

  private async run(test: 'baseline' | 'pigeon'): Promise<void> {
    if (this.running) return;
    this.running = true;
    const c = this.cfg();
    this.log.unshift(`${new Date().toLocaleTimeString()}  ${test} ${c.proto} ${c.direction} ${c.seconds}s x${c.parallel}…`);
    this.render();
    try {
      const resp = await fetch('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test, ...c }),
      });
      const body: RunResult = await resp.json();
      if (!resp.ok || body.error) throw new Error(body.error ?? `HTTP ${resp.status}`);
      this.results[test] = body;
      const up = mbpsOf(body, 'up'), down = mbpsOf(body, 'down');
      this.log.unshift(`${new Date().toLocaleTimeString()}  ${test}: ↑${up ?? '—'} ↓${down ?? '—'} Mbps`);
    } catch (e) {
      this.log.unshift(`${new Date().toLocaleTimeString()}  ${test} failed: ${(e as Error).message}`);
    }
    this.running = false;
    this.render();
  }

  private card(kind: 'baseline' | 'pigeon'): string {
    const r = this.results[kind];
    const title = kind === 'baseline' ? 'BASELINE — node network' : 'PIGEON — your fabric';
    if (!r) {
      return `<div class="card"><h3>${title}</h3><div class="big ${kind}">—</div><div class="small">not run yet</div></div>`;
    }
    const up = mbpsOf(r, 'up'), down = mbpsOf(r, 'down');
    const lines: string[] = [];
    if (r.rtt?.avgMs !== undefined) lines.push(`rtt avg ${r.rtt.avgMs} ms · loss ${r.rtt.lossPercent ?? 0}%`);
    const ud = r.directions ?? [];
    for (const d of ud) {
      const ip = d.iperf;
      const extra = ip.retransmits !== undefined ? ` · retr ${ip.retransmits}`
        : ip.jitterMs !== undefined ? ` · jitter ${ip.jitterMs}ms · loss ${ip.lostPercent}%` : '';
      lines.push(`${d.direction === 'up' ? '↑ up  ' : '↓ down'} ${typeof ip.mbps === 'number' ? ip.mbps.toFixed(1) : '0'} Mbps${extra}`);
      if (ip.error) lines.push(`   ${ip.error}`);
    }
    if (r.serverNode) lines.push(`server on ${r.serverNode}${r.parallel && r.parallel > 1 ? ` · ${r.parallel} streams` : ''}`);
    const loft = this.loftDelta(r);
    if (loft) lines.push(loft);
    // asymmetry callout
    if (up && down) {
      const ratio = Math.max(up, down) / Math.min(up, down);
      if (ratio >= 1.15) lines.push(`⚠ asymmetric: ${up > down ? 'up' : 'down'} is ${ratio.toFixed(1)}× the other`);
      else lines.push(`symmetric (${(100 / ratio).toFixed(0)}% balanced)`);
    }
    const headline = up && down ? `↑${up.toFixed(0)} ↓${down.toFixed(0)}` : `${(up ?? down ?? 0).toFixed(0)} Mbps`;
    return `<div class="card"><h3>${title}</h3>
      <div class="big ${kind}" style="font-size:26px">${headline}</div>
      <div class="small">${lines.join('\n')}</div></div>`;
  }

  private loftDelta(r: RunResult): string | null {
    if (!r.loftStatsBefore || !r.loftStatsAfter) return null;
    let dSum = 0, dCount = 0, trunkDrops = 0;
    for (const node of Object.keys(r.loftStatsAfter)) {
      const after = r.loftStatsAfter[node], before = r.loftStatsBefore[node] ?? {};
      trunkDrops += (after.droppedTrunk ?? 0) - (before.droppedTrunk ?? 0);
      for (const pod of Object.keys(after.ports ?? {})) {
        const a = after.ports[pod]?.deliverLatencyUs;
        const b = before.ports?.[pod]?.deliverLatencyUs ?? { sum: 0, count: 0 };
        if (!a) continue;
        dSum += a.sum - (b.sum ?? 0);
        dCount += a.count - (b.count ?? 0);
      }
    }
    if (dCount <= 0) return null;
    let s = `loft verdict latency: avg ${(dSum / dCount / 1000).toFixed(2)} ms over ${dCount} frames`;
    if (trunkDrops > 0) s += ` · trunk drops ${trunkDrops}`;
    return s;
  }

  private render(): void {
    const b = this.results.baseline, p = this.results.pigeon;
    let bars = '';
    const bUp = b && mbpsOf(b, 'up'), bDown = b && mbpsOf(b, 'down');
    const pUp = p && mbpsOf(p, 'up'), pDown = p && mbpsOf(p, 'down');
    if (bUp || pUp || bDown || pDown) {
      const max = Math.max(bUp || 0, bDown || 0, pUp || 0, pDown || 0) || 1;
      const bar = (label: string, v: number | undefined | null, color: string) =>
        `<div class="small">${label} ${v ? v.toFixed(0) + ' Mbps' : '—'}</div><div class="bar"><div style="width:${((v || 0) / max) * 100}%;background:${color}"></div></div>`;
      bars = `<div class="card"><h3>SIDE BY SIDE</h3>
        ${bar('baseline ↑', bUp, '#8ab4ff')}${bar('baseline ↓', bDown, '#6f9fff')}
        ${bar('pigeon ↑', pUp, 'var(--accent)')}${bar('pigeon ↓', pDown, '#ff9a52')}
        ${(pUp && bUp) ? `<div class="small">pigeon up = ${((pUp / bUp) * 100).toFixed(1)}% of baseline${pDown && bDown ? ` · down = ${((pDown / bDown) * 100).toFixed(1)}%` : ''}</div>` : ''}</div>`;
    }
    this.el.innerHTML = `
      <h2>Speedtest</h2>
      <div class="sub">up (you transmit) and down (server transmits, iperf3 -R) measured separately — the pigeon path
      is asymmetric if your belts differ per direction. Keep a router attached or pigeon reads zero, correctly.</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="st-proto"><option value="tcp">TCP</option><option value="udp">UDP 100M</option></select>
        <select id="st-dir"><option value="both">both ↕</option><option value="up">up ↑</option><option value="down">down ↓</option></select>
        <input id="st-secs" type="number" min="3" max="60" value="10" style="width:64px" title="seconds"> s
        <input id="st-par" type="number" min="1" max="32" value="1" style="width:64px" title="parallel streams">×streams
        <button id="st-base" ${this.running ? 'disabled' : ''}>Run baseline</button>
        <button id="st-pigeon" ${this.running ? 'disabled' : ''}>Run pigeon</button>
        <button id="st-both" ${this.running ? 'disabled' : ''}>Run both</button>
      </div>
      <div class="cards">${this.card('baseline')}${this.card('pigeon')}${bars}</div>
      <div class="small" style="color:var(--dim);white-space:pre-line">${this.log.slice(0, 8).join('\n')}</div>`;
    this.el.querySelector('#st-base')?.addEventListener('click', () => this.run('baseline'));
    this.el.querySelector('#st-pigeon')?.addEventListener('click', () => this.run('pigeon'));
    this.el.querySelector('#st-both')?.addEventListener('click', async () => {
      await this.run('baseline');
      await this.run('pigeon');
    });
  }
}

function mbpsOf(r: RunResult, dir: 'up' | 'down'): number | null {
  const d = r.directions?.find((x) => x.direction === dir);
  return d && typeof d.iperf.mbps === 'number' ? d.iperf.mbps : null;
}
