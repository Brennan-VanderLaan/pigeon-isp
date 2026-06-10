// DOM HUD: status bar, packet inspector, pod console, toolbar, filter
// programming panel, speed control.
import { FILTER_FIELDS, type FilterConfig } from '../game/filters';
import { hexDump, type Decoded } from '../net/decode';
import type { FrameToken } from '../types';

export type Tool = 'select' | 'belt' | 'filter' | 'erase';

export interface FilterPanelState {
  config: FilterConfig;
  matchToSide: boolean;
  side: 1 | -1;
  error?: string;
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

  setStats(ports: number, pps: number, mbps: number, pigeons: number, drops: number, decideUs: number | null): void {
    this.statPorts.textContent = `ports: ${ports}`;
    this.statRate.textContent = `in: ${pps} pps · ${mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
    this.statPigeons.textContent = `pigeons: ${pigeons}`;
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

  /** Slider is log2-scaled: -2..5.65 → 0.25x..50x. */
  bindSpeed(onChange: (mult: number) => void): void {
    const slider = document.getElementById('speed') as HTMLInputElement;
    const label = document.getElementById('speed-label')!;
    const apply = () => {
      const mult = Math.pow(2, Number(slider.value));
      label.textContent = (mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)) + '×';
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

  openFilterPanel(state: FilterPanelState, onApply: (s: FilterPanelState) => string | undefined): void {
    const fieldOpts = FILTER_FIELDS
      .map((f) => `<option value="${f.id}" ${f.id === state.config.field ? 'selected' : ''}>${f.label}</option>`)
      .join('');
    this.filterPanel.style.display = 'block';
    this.filterPanel.innerHTML = `
      <h3>⚙ filter machine</h3>
      <label>match on</label>
      <select id="fc-field">${fieldOpts}</select>
      <div id="fc-valwrap">
        <label>value</label>
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
      </div>
      <div class="err" id="fc-err"></div>`;

    const fieldSel = this.filterPanel.querySelector<HTMLSelectElement>('#fc-field')!;
    const valInput = this.filterPanel.querySelector<HTMLInputElement>('#fc-value')!;
    const exprInput = this.filterPanel.querySelector<HTMLTextAreaElement>('#fc-expr')!;
    const hint = this.filterPanel.querySelector<HTMLElement>('#fc-hint')!;
    const destSel = this.filterPanel.querySelector<HTMLSelectElement>('#fc-dest')!;
    const sideSel = this.filterPanel.querySelector<HTMLSelectElement>('#fc-side')!;
    const errEl = this.filterPanel.querySelector<HTMLElement>('#fc-err')!;

    const syncMode = () => {
      const f = FILTER_FIELDS.find((x) => x.id === fieldSel.value)!;
      const custom = f.id === 'custom';
      valInput.style.display = custom || f.id === 'broadcast' ? 'none' : 'block';
      exprInput.style.display = custom ? 'block' : 'none';
      hint.textContent = f.hint;
    };
    fieldSel.addEventListener('change', syncMode);
    valInput.value = state.config.field === 'custom' ? '' : state.config.value;
    exprInput.value = state.config.field === 'custom' ? state.config.value : "f.kind.includes('arp')";
    destSel.value = state.matchToSide ? 'side' : 'straight';
    sideSel.value = String(state.side);
    errEl.textContent = state.error ?? '';
    syncMode();

    this.filterPanel.querySelector('#fc-apply')!.addEventListener('click', () => {
      const field = fieldSel.value as FilterConfig['field'];
      const value = field === 'custom' ? exprInput.value : valInput.value;
      const err = onApply({
        config: { field, value },
        matchToSide: destSel.value === 'side',
        side: Number(sideSel.value) as 1 | -1,
      });
      errEl.textContent = err ?? '';
      if (!err) errEl.textContent = '✓ programmed';
    });
    this.filterPanel.querySelector('#fc-close')!.addEventListener('click', () => this.closeFilterPanel());
  }

  closeFilterPanel(): void {
    this.filterPanel.style.display = 'none';
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
