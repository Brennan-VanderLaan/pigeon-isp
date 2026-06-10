// Speedtest, but for Pigeon ISP. Two big numbers:
//   baseline — node network, kernel-routed (what the hardware can do)
//   pigeon   — same iperf3 across the loft mesh with a consumer routing
// The gap is the cost of making packets physical. Watch it shrink as the
// fast path lands.

interface RunResult {
  test: string;
  proto: string;
  serverNode?: string;
  rtt?: { avgMs?: number; minMs?: number; maxMs?: number; lossPercent?: number };
  iperf?: Record<string, number | string>;
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

  private async run(test: 'baseline' | 'pigeon'): Promise<void> {
    if (this.running) return;
    this.running = true;
    const proto = (this.el.querySelector('#st-proto') as HTMLSelectElement)?.value ?? 'tcp';
    const seconds = Number((this.el.querySelector('#st-secs') as HTMLInputElement)?.value || 10);
    this.log.unshift(`${new Date().toLocaleTimeString()}  running ${test} ${proto} ${seconds}s…`);
    this.render();
    try {
      const resp = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test, proto, seconds }),
      });
      const body: RunResult = await resp.json();
      if (!resp.ok || body.error) throw new Error(body.error ?? `HTTP ${resp.status}`);
      this.results[test] = body;
      const mbps = body.iperf?.mbps ?? '?';
      this.log.unshift(`${new Date().toLocaleTimeString()}  ${test} ${proto}: ${mbps} Mbps`);
    } catch (e) {
      this.log.unshift(`${new Date().toLocaleTimeString()}  ${test} failed: ${(e as Error).message}`);
    }
    this.running = false;
    this.render();
  }

  private card(kind: 'baseline' | 'pigeon'): string {
    const r = this.results[kind];
    const title = kind === 'baseline'
      ? 'BASELINE — node network, kernel-routed'
      : 'PIGEON — loft mesh, consumer-routed';
    if (!r) {
      return `<div class="card"><h3>${title}</h3><div class="big ${kind}">—</div>
        <div class="small">not run yet</div></div>`;
    }
    const ip = r.iperf ?? {};
    const mbps = typeof ip.mbps === 'number' ? ip.mbps : 0;
    const lines: string[] = [];
    if (r.rtt?.avgMs !== undefined) lines.push(`rtt avg ${r.rtt.avgMs} ms (min ${r.rtt.minMs} / max ${r.rtt.maxMs}), loss ${r.rtt.lossPercent ?? 0}%`);
    if (ip.retransmits !== undefined) lines.push(`tcp retransmits: ${ip.retransmits}`);
    if (ip.jitterMs !== undefined) lines.push(`jitter ${ip.jitterMs} ms · lost ${ip.lostPackets}/${ip.packets} (${ip.lostPercent}%)`);
    if (r.serverNode) lines.push(`server on ${r.serverNode}`);
    const loft = this.loftDelta(r);
    if (loft) lines.push(loft);
    if (ip.error) lines.push(`iperf: ${ip.error}`);
    return `<div class="card"><h3>${title}</h3>
      <div class="big ${kind}">${mbps ? mbps + ' Mbps' : '0 Mbps'}</div>
      <div class="small">${lines.join('\n')}</div></div>`;
  }

  /** Pigeon-network overhead from loft counters: deliver latency delta. */
  private loftDelta(r: RunResult): string | null {
    if (!r.loftStatsBefore || !r.loftStatsAfter) return null;
    let dSum = 0, dCount = 0, maxUs = 0, trunkDrops = 0;
    for (const node of Object.keys(r.loftStatsAfter)) {
      const after = r.loftStatsAfter[node];
      const before = r.loftStatsBefore[node] ?? {};
      trunkDrops += (after.droppedTrunk ?? 0) - (before.droppedTrunk ?? 0);
      for (const pod of Object.keys(after.ports ?? {})) {
        const a = after.ports[pod]?.deliverLatencyUs;
        const b = before.ports?.[pod]?.deliverLatencyUs ?? { sum: 0, count: 0 };
        if (!a) continue;
        dSum += a.sum - (b.sum ?? 0);
        dCount += a.count - (b.count ?? 0);
        maxUs = Math.max(maxUs, a.max ?? 0);
      }
    }
    if (dCount <= 0) return null;
    const avgMs = (dSum / dCount / 1000).toFixed(2);
    let s = `loft verdict latency: avg ${avgMs} ms over ${dCount} frames`;
    if (trunkDrops > 0) s += ` · trunk drops ${trunkDrops}`;
    return s;
  }

  private render(): void {
    const b = this.results.baseline?.iperf?.mbps as number | undefined;
    const p = this.results.pigeon?.iperf?.mbps as number | undefined;
    let bars = '';
    if (b || p) {
      const max = Math.max(b ?? 0, p ?? 0) || 1;
      bars = `<div class="card"><h3>SIDE BY SIDE</h3>
        <div class="small">baseline</div><div class="bar"><div style="width:${((b ?? 0) / max) * 100}%;background:#8ab4ff"></div></div>
        <div class="small">pigeon</div><div class="bar"><div style="width:${((p ?? 0) / max) * 100}%;background:var(--accent)"></div></div>
        <div class="small">${b && p ? `the pigeon network currently delivers ${((p / b) * 100).toFixed(1)}% of baseline` : 'run both to compare'}</div></div>`;
    }
    this.el.innerHTML = `
      <h2>Speedtest</h2>
      <div class="sub">same iperf3, two paths — kernel routing vs the loft mesh with your consumer in the loop.
      keep a router attached (game in autoroute, or <code>node tools/autoroute.mjs</code>) or pigeon reads zero, correctly.</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="st-proto"><option value="tcp">TCP</option><option value="udp">UDP 100M</option></select>
        <input id="st-secs" type="number" min="3" max="60" value="10" style="width:70px" title="seconds"> s
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
