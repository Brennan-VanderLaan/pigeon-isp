// DOM HUD: status bar, packet inspector, pod console, toolbar, filter
// programming panel, speed control.
import {
  FILTER_FIELDS, KIND_OPTIONS, fieldByteRanges, sampleFrame,
  type FilterConfig, type FilterStats,
} from '../game/filters';
import { hexDump, type Decoded } from '../net/decode';
import type { FrameToken } from '../types';

export type Tool = 'select' | 'belt' | 'filter' | 'erase';

export interface FilterPanelState {
  config: FilterConfig;
  matchToSide: boolean;
  side: 1 | -1;
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
            <label style="margin:0">matching frames go</label>
            <select id="fc-dest" style="width:auto">
              <option value="side">out the side</option>
              <option value="straight">straight ahead</option>
            </select>
          </div>
          <div class="row">
            <label style="margin:0">eject side</label>
            <select id="fc-side" style="width:auto">
              <option value="1">right</option>
              <option value="-1">left</option>
            </select>
          </div>
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
    const destSel = q<HTMLSelectElement>('#fc-dest');
    const sideSel = q<HTMLSelectElement>('#fc-side');
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

    const renderVerdicts = () => {
      const lv = live();
      if (!lv) return;
      const { stats } = lv;
      q('#fc-score').textContent = ` — matched ${stats.hits} · passed ${stats.misses}`;
      const items: string[] = [];
      for (let i = 1; i <= stats.recent.length; i++) {
        const r = stats.recent[(stats.ptr - i + stats.recent.length * 1000) % stats.recent.length];
        if (!r) continue;
        items.push(
          `<div class="${r.matched ? 'v-hit' : 'v-miss'}">${r.matched ? '◤ eject' : '→ pass '} ${esc(r.summary)}</div>`,
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
    };
    fieldSel.addEventListener('change', syncMode);
    kindSel.addEventListener('change', renderHex);
    valInput.addEventListener('input', renderHex);
    exprInput.addEventListener('input', renderHex);
    valInput.value = state.config.field === 'custom' || state.config.field === 'kind' ? '' : state.config.value;
    exprInput.value = state.config.field === 'custom' ? state.config.value : "f.kind.includes('arp')";
    destSel.value = state.matchToSide ? 'side' : 'straight';
    sideSel.value = String(state.side);
    errEl.textContent = state.error ?? '';
    syncMode();
    renderVerdicts();

    q('#fc-apply').addEventListener('click', () => {
      const field = fieldSel.value as FilterConfig['field'];
      const err = onApply({
        config: { field, value: currentValue() },
        matchToSide: destSel.value === 'side',
        side: Number(sideSel.value) as 1 | -1,
      });
      errEl.textContent = err ?? '✓ programmed';
      renderHex();
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
