// DOM HUD: status bar, packet inspector, pod console, toolbar, filter
// programming panel, speed control.
import {
  DIR_ARROWS, DIR_NAMES, FILTER_FIELDS, KIND_OPTIONS, fieldByteRanges, routingSummary, sampleFrame,
  type FilterConfig, type FilterStats,
} from '../game/filters';
import { hexDump, type Decoded } from '../net/decode';
import type { FrameToken } from '../types';

export type Tool = 'select' | 'belt' | 'filter' | 'hub' | 'switch' | 'meter' | 'erase';

export interface FilterPanelState {
  config: FilterConfig;
  matchDir: number;
  defaultDir: number;
  error?: string;
}

/** Live data the panel polls while open. */
export interface FilterLive {
  stats: FilterStats;
  lastFrame?: Uint8Array;
}

export class Hud {
  private mode = document.getElementById('mode')!;
  private statPorts = document.getElementById('stat-ports')!;
  private statRate = document.getElementById('stat-rate')!;
  private statPigeons = document.getElementById('stat-pigeons')!;
  private statDrops = document.getElementById('stat-drops')!;
  private statDecide = document.getElementById('stat-decide')!;
  private statFps = document.getElementById('stat-fps')!;
  private inspector = document.getElementById('inspector')!;
  private consoleEl = document.getElementById('console')!;
  private banner = document.getElementById('banner')!;
  private toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#toolbar button'));

  onToolChange: (tool: Tool) => void = () => {};

  constructor() {
    for (const btn of this.toolButtons) {
      btn.addEventListener('click', () => this.setTool(btn.dataset.tool as Tool));
    }
  }

  setTool(tool: Tool): void {
    for (const btn of this.toolButtons) {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    }
    this.onToolChange(tool);
  }

  setMode(state: 'connecting' | 'live' | 'sim' | 'down'): void {
    this.mode.className = 'mode ' + (state === 'live' ? 'live' : state === 'sim' ? 'sim' : 'down');
    this.mode.textContent =
      state === 'live' ? '● LIVE (cluster)' :
      state === 'sim' ? '● SIM (fake pods)' :
      state === 'down' ? '● loft unreachable' : 'connecting…';
  }

  setBanner(text: string | null): void {
    this.banner.style.display = text ? 'block' : 'none';
    this.banner.textContent = text ?? '';
  }

  setStats(ports: number, pps: number, mbps: number, pigeons: number, queued: number, drops: number, decideUs: number | null): void {
    this.statPorts.textContent = `ports: ${ports}`;
    this.statRate.textContent = `in: ${pps} pps · ${mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
    this.statPigeons.textContent = queued > 0 ? `pigeons: ${pigeons} (+${queued} queued)` : `pigeons: ${pigeons}`;
    this.statDrops.textContent = `drops: ${drops}`;
    if (decideUs !== null) {
      this.statDecide.style.display = '';
      this.statDecide.textContent = `decide: ${decideUs.toFixed(1)} µs`;
    }
  }

  setFps(fps: number): void {
    this.statFps.textContent = `fps: ${fps}`;
  }

  log(who: string, line: string): void {
    const div = document.createElement('div');
    div.className = 'line';
    const whoSpan = document.createElement('span');
    whoSpan.className = 'who';
    whoSpan.textContent = `[${who}] `;
    div.appendChild(whoSpan);
    div.appendChild(document.createTextNode(line));
    this.consoleEl.appendChild(div);
    while (this.consoleEl.childElementCount > 200) this.consoleEl.firstElementChild!.remove();
    this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }

  inspect(decoded: Decoded, token: FrameToken): void {
    this.inspector.style.display = 'block';
    const rows = decoded.fields
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
      .join('');
    this.inspector.innerHTML =
      `<h3>${esc(decoded.summary)}</h3>` +
      `<table>${rows}<tr><td>frame.id</td><td>${token.id}</td></tr></table>` +
      `<div class="hex">${esc(hexDump(token.snapshot))}${token.fullLen > token.snapshot.length ? `\n… +${token.fullLen - token.snapshot.length} bytes held in the loft` : ''}</div>`;
  }

  closeInspector(): void {
    this.inspector.style.display = 'none';
  }

  // ---- speed control --------------------------------------------------------

  /** Slider is log2-scaled: -2..12.29 → 0.25x..5000x. */
  bindSpeed(onChange: (mult: number) => void): void {
    const slider = document.getElementById('speed') as HTMLInputElement;
    const label = document.getElementById('speed-label')!;
    const apply = () => {
      const mult = Math.min(Math.pow(2, Number(slider.value)), 5000);
      label.textContent =
        mult >= 1000 ? (mult / 1000).toFixed(1) + 'k×' :
        mult >= 10 ? mult.toFixed(0) + '×' : mult.toFixed(1) + '×';
      onChange(mult);
    };
    slider.addEventListener('input', apply);
    apply();
  }

  bindClearFloor(onClear: () => void): void {
    document.getElementById('clear-floor')!.addEventListener('click', () => {
      if (confirm('Bulldoze every belt and filter on the floor?')) onClear();
    });
  }

  // ---- filter programming panel ----------------------------------------------

  private filterPanel = document.getElementById('filtercfg')!;
  private filterTimer: number | null = null;

  openFilterPanel(
    state: FilterPanelState,
    onApply: (s: FilterPanelState) => string | undefined,
    live: () => FilterLive | null,
  ): void {
    this.closeFilterPanel();
    const fieldOpts = FILTER_FIELDS
      .map((f) => `<option value="${f.id}" ${f.id === state.config.field ? 'selected' : ''}>${f.label}</option>`)
      .join('');
    const kindOpts = KIND_OPTIONS
      .map((k) => `<option value="${k}" ${k === state.config.value ? 'selected' : ''}>${k}</option>`)
      .join('');
    this.filterPanel.style.display = 'block';
    this.filterPanel.innerHTML = `
      <h3>⚙ filter machine</h3>
      <div class="fc-grid">
        <div>
          <label>match on</label>
          <select id="fc-field">${fieldOpts}</select>
          <div id="fc-valwrap">
            <label>value</label>
            <select id="fc-kind" style="display:none">${kindOpts}</select>
            <input type="text" id="fc-value">
            <textarea id="fc-expr" style="display:none" spellcheck="false"></textarea>
            <div class="hint2" id="fc-hint"></div>
          </div>
          <div class="row">
            <label style="margin:0">matching traffic exits</label>
            <select id="fc-matchdir" style="width:auto">
              ${DIR_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}
            </select>
          </div>
          <div class="row">
            <label style="margin:0">default exit (everything else)</label>
            <select id="fc-defaultdir" style="width:auto">
              ${DIR_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}
            </select>
          </div>
          <div class="route" id="fc-route"></div>
          <div class="row">
            <button id="fc-apply">Apply</button>
            <button id="fc-close">Close</button>
            <span class="err" id="fc-err"></span>
          </div>
        </div>
        <div>
          <label id="fc-hexlabel">datagram — inspected bytes</label>
          <div class="hexview" id="fc-hex"></div>
          <div class="hint2" id="fc-bytenote"></div>
          <label style="margin-top:10px">live verdicts <span id="fc-score" style="color:var(--text)"></span></label>
          <div id="fc-verdicts" class="verdicts"></div>
        </div>
      </div>`;

    const q = <T extends HTMLElement>(sel: string) => this.filterPanel.querySelector<T>(sel)!;
    const fieldSel = q<HTMLSelectElement>('#fc-field');
    const kindSel = q<HTMLSelectElement>('#fc-kind');
    const valInput = q<HTMLInputElement>('#fc-value');
    const exprInput = q<HTMLTextAreaElement>('#fc-expr');
    const hint = q<HTMLElement>('#fc-hint');
    const matchDirSel = q<HTMLSelectElement>('#fc-matchdir');
    const defaultDirSel = q<HTMLSelectElement>('#fc-defaultdir');
    const errEl = q<HTMLElement>('#fc-err');

    const currentValue = (): string =>
      fieldSel.value === 'custom' ? exprInput.value :
      fieldSel.value === 'kind' ? kindSel.value : valInput.value;

    const renderHex = () => {
      const lv = live();
      const frame = lv?.lastFrame ?? sampleFrame();
      const fromTraffic = !!lv?.lastFrame;
      const field = fieldSel.value as FilterConfig['field'];
      const { ranges, note } = fieldByteRanges(field, frame);
      q('#fc-hexlabel').textContent = fromTraffic
        ? 'last frame through this machine — inspected bytes'
        : 'mock datagram (icmp echo) — inspected bytes';
      q('#fc-hex').innerHTML = renderHexView(frame, ranges);
      q('#fc-bytenote').textContent =
        ranges.length > 0
          ? `${note} · bytes ${ranges.map(([a, b]) => (b - a > 1 ? `${a}–${b - 1}` : `${a}`)).join(', ')} · looking for “${currentValue() || '…'}”`
          : note;
    };

    const renderRoute = () => {
      q('#fc-route').textContent = '⮕ ' + routingSummary(
        { field: fieldSel.value as FilterConfig['field'], value: currentValue() },
        Number(matchDirSel.value),
        Number(defaultDirSel.value),
      );
    };

    const renderVerdicts = () => {
      const lv = live();
      if (!lv) return;
      const { stats } = lv;
      q('#fc-score').textContent = ` — matched ${stats.hits} · unmatched ${stats.misses}`;
      const items: string[] = [];
      for (let i = 1; i <= stats.recent.length; i++) {
        const r = stats.recent[(stats.ptr - i + stats.recent.length * 1000) % stats.recent.length];
        if (!r) continue;
        // Two facts, never conflated: did the rule match, and which compass
        // direction the pigeon PHYSICALLY left by.
        items.push(
          `<div class="${r.matched ? 'v-hit' : 'v-miss'}">${r.matched ? '✓ match' : '· no-match'} ${DIR_ARROWS[r.exit]} ${DIR_NAMES[r.exit]}  ${esc(r.summary)}</div>`,
        );
      }
      q('#fc-verdicts').innerHTML = items.join('') || '<div class="hint2">no frames yet — send some traffic through</div>';
    };

    const syncMode = () => {
      const f = FILTER_FIELDS.find((x) => x.id === fieldSel.value)!;
      kindSel.style.display = f.id === 'kind' ? 'block' : 'none';
      valInput.style.display = f.id === 'kind' || f.id === 'custom' || f.id === 'broadcast' ? 'none' : 'block';
      exprInput.style.display = f.id === 'custom' ? 'block' : 'none';
      hint.textContent = f.hint;
      renderHex();
      renderRoute();
    };
    fieldSel.addEventListener('change', syncMode);
    kindSel.addEventListener('change', () => { renderHex(); renderRoute(); });
    valInput.addEventListener('input', () => { renderHex(); renderRoute(); });
    exprInput.addEventListener('input', () => { renderHex(); renderRoute(); });
    matchDirSel.addEventListener('change', renderRoute);
    defaultDirSel.addEventListener('change', renderRoute);
    valInput.value = state.config.field === 'custom' || state.config.field === 'kind' ? '' : state.config.value;
    exprInput.value = state.config.field === 'custom' ? state.config.value : "f.kind.includes('arp')";
    matchDirSel.value = String(state.matchDir);
    defaultDirSel.value = String(state.defaultDir);
    errEl.textContent = state.error ?? '';
    syncMode();
    renderRoute();
    renderVerdicts();

    q('#fc-apply').addEventListener('click', () => {
      const field = fieldSel.value as FilterConfig['field'];
      const err = onApply({
        config: { field, value: currentValue() },
        matchDir: Number(matchDirSel.value),
        defaultDir: Number(defaultDirSel.value),
      });
      errEl.textContent = err ?? '✓ programmed';
      renderHex();
      renderRoute();
    });
    q('#fc-close').addEventListener('click', () => this.closeFilterPanel());

    // Live refresh while open: verdicts + the latest captured frame.
    this.filterTimer = window.setInterval(() => {
      renderVerdicts();
      renderHex();
    }, 600);
  }

  closeFilterPanel(): void {
    this.filterPanel.style.display = 'none';
    if (this.filterTimer !== null) {
      clearInterval(this.filterTimer);
      this.filterTimer = null;
    }
  }

  // ---- machine inspectors (switch CAM table, meter, hub) -----------------------

  /** Live CAM table view — the switch's brain, visible. */
  openSwitchPanel(live: () => { rows: { mac: string; dir: number; ageS: number; hits: number }[]; floods: number; forwards: number; ttlMs: number } | null): void {
    this.closeFilterPanel();
    this.filterPanel.style.display = 'block';
    const render = () => {
      const lv = live();
      if (!lv) return;
      const rows = lv.rows
        .map((r) => `<tr><td>${esc(r.mac)}</td><td>${DIR_ARROWS[r.dir]} ${DIR_NAMES[r.dir]}</td><td>${r.ageS}s</td><td>${r.hits}</td></tr>`)
        .join('');
      this.filterPanel.innerHTML = `
        <h3>⇄ switch — CAM table</h3>
        <div class="hint2">learns src MAC → entry side · forwards known dst · floods unknown/broadcast · TTL ${lv.ttlMs / 1000}s</div>
        <table class="grid"><tr><th>mac</th><th>exit</th><th>age</th><th>hits</th></tr>${rows || ''}</table>
        ${rows ? '' : '<div class="hint2">empty — no frames learned yet</div>'}
        <div class="hint2" style="margin-top:8px">forwards ${lv.forwards} · floods ${lv.floods}</div>
        <div class="row"><button id="fc-close">Close</button></div>`;
      this.filterPanel.querySelector('#fc-close')!.addEventListener('click', () => this.closeFilterPanel());
    };
    render();
    this.filterTimer = window.setInterval(render, 800);
  }

  openMeterPanel(
    state: { thresholdPps: number; defaultDir: number; overflowDir: number },
    onApply: (thresholdPps: number, defaultDir: number, overflowDir: number) => void,
    live: () => { rate: number; total: number; overTotal: number } | null,
  ): void {
    this.closeFilterPanel();
    this.filterPanel.style.display = 'block';
    const dirOpts = (sel: number) => DIR_NAMES.map((n, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${n}</option>`).join('');
    this.filterPanel.innerHTML = `
      <h3>◔ meter — rate limiter</h3>
      <div class="hint2">frames within the rate take the normal exit; over-threshold traffic takes the overflow exit</div>
      <div class="row">
        <label style="margin:0">threshold</label>
        <input type="number" id="mt-th" value="${state.thresholdPps}" min="1" style="width:90px"> pps
      </div>
      <div class="row">
        <label style="margin:0">normal exit</label><select id="mt-dd" style="width:auto">${dirOpts(state.defaultDir)}</select>
        <label style="margin:0">overflow exit</label><select id="mt-od" style="width:auto">${dirOpts(state.overflowDir)}</select>
      </div>
      <div class="row"><button id="mt-apply">Apply</button><button id="fc-close">Close</button><span class="err" id="mt-ok"></span></div>
      <div class="hint2" id="mt-live" style="margin-top:8px"></div>`;
    const q = <T extends HTMLElement>(s: string) => this.filterPanel.querySelector<T>(s)!;
    q('#mt-apply').addEventListener('click', () => {
      onApply(
        Math.max(1, Number(q<HTMLInputElement>('#mt-th').value)),
        Number(q<HTMLSelectElement>('#mt-dd').value),
        Number(q<HTMLSelectElement>('#mt-od').value),
      );
      q('#mt-ok').textContent = '✓ set';
    });
    q('#fc-close').addEventListener('click', () => this.closeFilterPanel());
    const renderLive = () => {
      const lv = live();
      if (lv) q('#mt-live').textContent = `rate ${lv.rate} pps · total ${lv.total} · over-rate ${lv.overTotal}`;
    };
    renderLive();
    this.filterTimer = window.setInterval(renderLive, 600);
  }

  openHubPanel(live: () => number | null): void {
    this.closeFilterPanel();
    this.filterPanel.style.display = 'block';
    const render = () => {
      this.filterPanel.innerHTML = `
        <h3>✳ hub — dumb repeater</h3>
        <div class="hint2">every frame is duplicated out every exit except the one it came in. The 90s called; they want their collision domain back.</div>
        <div class="hint2" style="margin-top:8px">frames repeated: ${live() ?? '?'}</div>
        <div class="row"><button id="fc-close">Close</button></div>`;
      this.filterPanel.querySelector('#fc-close')!.addEventListener('click', () => this.closeFilterPanel());
    };
    render();
    this.filterTimer = window.setInterval(render, 1000);
  }
}

/** Hex grid with inspected-byte highlighting. */
function renderHexView(frame: Uint8Array, ranges: [number, number][]): string {
  const hot = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const rows: string[] = [];
  const len = Math.min(frame.length, 64);
  for (let off = 0; off < len; off += 8) {
    const cells: string[] = [];
    let ascii = '';
    for (let i = off; i < Math.min(off + 8, len); i++) {
      const h = frame[i].toString(16).padStart(2, '0');
      cells.push(hot(i) ? `<span class="hl">${h}</span>` : h);
      const c = frame[i];
      ascii += c >= 32 && c < 127 ? String.fromCharCode(c) : '·';
    }
    rows.push(
      `<div><span class="off">${off.toString(16).padStart(4, '0')}</span> ${cells.join(' ')}  <span class="asc">${esc(ascii)}</span></div>`,
    );
  }
  return rows.join('');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
