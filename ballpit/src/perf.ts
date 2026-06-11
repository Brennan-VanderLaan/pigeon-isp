// Telemetry overlay: where is the frame going? Splits each frame into physics
// step vs render vs other, tracks FPS, and — crucially for a ball pit — how
// many bodies are AWAKE (the solver only pays for those; a sleeping pit is
// nearly free). If physics ms dominates and awake is high, you're solver-bound
// (→ Web Worker, fewer active balls, sleep tuning). If render ms dominates,
// it's the GPU/instancing side.
export interface PerfInput {
  dtMs: number;       // wall time since last main-thread frame
  workerMs: number;   // worker's last physics step (off-thread)
  renderMs: number;   // renderer.render() on the main thread
  active: number;     // balls in play
  awake: number;      // non-sleeping balls (what the solver pays for)
  spawnedTotal: number;
  deliveredTotal: number;
  droppedTotal: number;
}

const ewma = (prev: number, v: number, a = 0.1) => prev + a * (v - prev);

export class Perf {
  private el: HTMLElement;
  private fps = 60;
  private phys = 0;
  private rend = 0;
  private other = 0;
  private worst = 0;        // worst frame ms in the last second
  private worstAcc = 0;
  private hist: number[] = []; // frame ms history for a sparkline
  private lastRender = 0;
  private secMark = performance.now();
  private snap = { spawned: 0, delivered: 0, dropped: 0 };
  private rate = { spawn: 0, deliver: 0, drop: 0 };

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.el.style.cssText =
      'position:fixed;top:12px;right:12px;padding:10px 12px;border-radius:10px;' +
      'background:rgba(16,22,32,.82);border:1px solid #243044;font:12px/1.5 ui-monospace,Menlo,monospace;' +
      'color:#cdd8e6;white-space:pre;text-align:right;pointer-events:none;min-width:210px';
    document.body.appendChild(this.el);
  }

  frame(now: number, p: PerfInput): void {
    this.fps = ewma(this.fps, 1000 / Math.max(p.dtMs, 0.0001));
    this.phys = ewma(this.phys, p.workerMs);
    this.rend = ewma(this.rend, p.renderMs);
    // main-thread time NOT in render = controls + reading the transform buffer.
    this.other = ewma(this.other, Math.max(0, p.dtMs - p.renderMs));
    this.worstAcc = Math.max(this.worstAcc, p.dtMs);
    this.hist.push(p.dtMs);
    if (this.hist.length > 60) this.hist.shift();

    if (now - this.secMark >= 1000) {
      const dt = (now - this.secMark) / 1000;
      this.rate.spawn = Math.round((p.spawnedTotal - this.snap.spawned) / dt);
      this.rate.deliver = Math.round((p.deliveredTotal - this.snap.delivered) / dt);
      this.rate.drop = Math.round((p.droppedTotal - this.snap.dropped) / dt);
      this.snap = { spawned: p.spawnedTotal, delivered: p.deliveredTotal, dropped: p.droppedTotal };
      this.worst = this.worstAcc;
      this.worstAcc = 0;
      this.secMark = now;
    }

    if (now - this.lastRender < 200) return; // repaint the panel ~5 Hz
    this.lastRender = now;
    this.render(p);
  }

  private render(p: PerfInput): void {
    const fpsC = this.fps >= 55 ? '#6fdc8c' : this.fps >= 30 ? '#ffd479' : '#ff6b6b';
    // physics is the usual bottleneck — flag it red as it eats the 16.7ms budget
    const physC = this.phys > 12 ? '#ff6b6b' : this.phys > 7 ? '#ffd479' : '#9fb0c4';
    const bar = sparkline(this.hist);
    const row = (k: string, v: string, c = '#cdd8e6') =>
      `<div><span style="color:#7b8aa0">${k}</span>  <span style="color:${c}">${v}</span></div>`;
    this.el.innerHTML =
      row('fps', this.fps.toFixed(0), fpsC) +
      row('frame', `${(1000 / Math.max(this.fps, 1)).toFixed(1)} ms`) +
      row('  worst/s', `${this.worst.toFixed(1)} ms`, this.worst > 33 ? '#ff6b6b' : '#9fb0c4') +
      `<div style="color:#53607a;margin:2px 0">${bar}</div>` +
      row('physics⚙', `${this.phys.toFixed(1)} ms`, physC) +
      row('render', `${this.rend.toFixed(1)} ms`) +
      row('main-other', `${this.other.toFixed(1)} ms`) +
      `<hr style="border:0;border-top:1px solid #243044;margin:5px 0">` +
      row('balls', `${p.awake} awake / ${p.active}`, p.awake > 1500 ? '#ffd479' : '#cdd8e6') +
      `<hr style="border:0;border-top:1px solid #243044;margin:5px 0">` +
      row('spawn/s', `${this.rate.spawn}`) +
      row('deliver/s', `${this.rate.deliver}`, '#6fdc8c') +
      row('drop/s', `${this.rate.drop}`, this.rate.drop > 0 ? '#ffb86b' : '#9fb0c4');
  }
}

// A compact unicode bar chart of recent frame times (taller = slower).
function sparkline(hist: number[]): string {
  if (!hist.length) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(33, ...hist); // scale so 33ms (30fps) is near the top
  return hist.map((v) => blocks[Math.min(7, Math.floor((v / max) * 7))]).join('');
}
