// DOM HUD: status bar, packet inspector, pod console, toolbar, filter
// programming panel, speed control.
import {
  DIR_ARROWS, DIR_NAMES, FILTER_FIELDS, KIND_OPTIONS, fieldByteRanges, routingSummary, sampleFrame,
  type FilterConfig, type FilterStats,
} from '../game/filters';
import { CHORDS, FRAME_SOURCES, SCALES, noteName, type MidiCfg } from '../game/midi';
import { KEY_FIELDS, type KeyField } from '../game/tables';
import { hexDump, type Decoded } from '@pigeon/protocol';
import type { FrameToken } from '@pigeon/protocol';

export type Tool = 'select' | 'belt' | 'cross' | 'filter' | 'hub' | 'switch' | 'meter' | 'midi' | 'learn' | 'lookup' | 'erase';

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

  /** Live FDB view — the multi-port switch's brain, visible. IEEE 802.1D. */
  openSwitchPanel(
    _applianceId: number,
    live: () => { ports: number; rows: { mac: string; port: number; ageS: number; hits: number }[]; floods: number; forwards: number; filters: number; ttlMs: number } | null,
  ): void {
    this.closeFilterPanel();
    this.filterPanel.style.display = 'block';
    const render = () => {
      const lv = live();
      if (!lv) { this.closeFilterPanel(); return; }
      const rows = lv.rows
        .map((r) => `<tr><td>${esc(r.mac)}</td><td>P${r.port}</td><td>${r.ageS}s</td><td>${r.hits}</td></tr>`)
        .join('');
      this.filterPanel.innerHTML = `
        <h3>⇄ switch — ${lv.ports} port(s)</h3>
        <div class="hint2">IEEE 802.1D transparent bridge. Learns src MAC → ingress port (§7.8),
        forwards known unicast, floods unknown/broadcast out all other ports (§7.7), ages out at ${lv.ttlMs / 1000}s (§7.9).
        ARP discovery (RFC 826) relies on that flood.</div>
        <div class="route" style="margin-top:8px">↪ each port is two lanes (belts are one-way): click an edge cell for the
        <span style="color:#6fdc8c">IN</span> lane (host → switch), then another for the
        <span style="color:#53d8e8">OUT</span> lane (switch → host's landing). Wire a host's roost to IN and its landing from OUT.</div>
        <label style="margin-top:10px">filtering database (CAM)</label>
        <table class="grid"><tr><th>mac</th><th>port</th><th>age</th><th>hits</th></tr>${rows}</table>
        ${rows ? '' : '<div class="hint2">empty — no frames learned yet</div>'}
        <div class="hint2" style="margin-top:8px">forwards ${lv.forwards} · floods ${lv.floods} · filtered ${lv.filters}</div>
        <div class="row"><button id="fc-close">Close</button></div>`;
      this.filterPanel.querySelector('#fc-close')!.addEventListener('click', () => this.closeFilterPanel());
    };
    render();
    this.filterTimer = window.setInterval(render, 700);
  }

  openMeterPanel(
    state: { limit: number; mode: 'pps' | 'bps'; defaultDir: number; overflowDir: number },
    onApply: (limit: number, mode: 'pps' | 'bps', defaultDir: number, overflowDir: number) => void,
    live: () => { rate: number; total: number; diverted: number; mode: 'pps' | 'bps' } | null,
  ): void {
    this.closeFilterPanel();
    this.filterPanel.style.display = 'block';
    const dirOpts = (sel: number) => DIR_NAMES.map((n, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${n}</option>`).join('');
    // bps mode shows a unit picker; the stored limit is always bytes/sec.
    const asUnit = state.mode === 'bps' ? bytesToUnit(state.limit) : { val: state.limit, unit: 'pps' };
    this.filterPanel.innerHTML = `
      <h3>◔ meter — token-bucket rate limiter</h3>
      <div class="hint2">passes UP TO the limit (allowed traffic flows on the normal exit); the EXCESS spills to
      the overflow exit. Token bucket, burst = 1s. Limit by packets/sec or by bandwidth.</div>
      <div class="row">
        <label style="margin:0">limit</label>
        <input type="number" id="mt-val" value="${asUnit.val}" min="1" style="width:90px">
        <select id="mt-unit" style="width:auto">
          <option value="pps" ${state.mode === 'pps' ? 'selected' : ''}>pps</option>
          <option value="kbps" ${asUnit.unit === 'kbps' ? 'selected' : ''}>kbps</option>
          <option value="mbps" ${asUnit.unit === 'mbps' ? 'selected' : ''}>mbps</option>
          <option value="gbps" ${asUnit.unit === 'gbps' ? 'selected' : ''}>gbps</option>
          <option value="bps" ${asUnit.unit === 'bps' ? 'selected' : ''}>bps</option>
        </select>
      </div>
      <div class="row">
        <label style="margin:0">normal exit</label><select id="mt-dd" style="width:auto">${dirOpts(state.defaultDir)}</select>
        <label style="margin:0">overflow exit</label><select id="mt-od" style="width:auto">${dirOpts(state.overflowDir)}</select>
      </div>
      <div class="row"><button id="mt-apply">Apply</button><button id="fc-close">Close</button><span class="err" id="mt-ok"></span></div>
      <div class="hint2" id="mt-live" style="margin-top:8px"></div>`;
    const q = <T extends HTMLElement>(s: string) => this.filterPanel.querySelector<T>(s)!;
    q('#mt-apply').addEventListener('click', () => {
      const unit = q<HTMLSelectElement>('#mt-unit').value;
      const val = Math.max(1, Number(q<HTMLInputElement>('#mt-val').value));
      const mode: 'pps' | 'bps' = unit === 'pps' ? 'pps' : 'bps';
      const limit = unit === 'pps' ? val : unitToBytes(val, unit);
      onApply(limit, mode, Number(q<HTMLSelectElement>('#mt-dd').value), Number(q<HTMLSelectElement>('#mt-od').value));
      q('#mt-ok').textContent = '✓ set';
    });
    q('#fc-close').addEventListener('click', () => this.closeFilterPanel());
    const renderLive = () => {
      const lv = live();
      if (!lv) return;
      const r = lv.mode === 'pps' ? `${lv.rate} pps` : bytesRate(lv.rate);
      q('#mt-live').textContent = `passing ${r} · total ${lv.total} · diverted ${lv.diverted}`;
    };
    renderLive();
    this.filterTimer = window.setInterval(renderLive, 600);
  }

  openMidiPanel(
    cfg: MidiCfg,
    onApply: (cfg: MidiCfg) => void,
    enableMidi: () => Promise<void>,
    midiState: () => { ready: boolean; error: string; outputs: { id: string; name: string }[] },
    live: () => { fired: number; lastNotes: number[] } | null,
  ): void {
    this.closeFilterPanel();
    this.filterPanel.style.display = 'block';
    const render = () => {
      const st = midiState();
      const opt = (v: string, sel: string, label: string) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${label}</option>`;
      const devOpts = st.outputs.map((o) => opt(o.id, cfg.deviceId, esc(o.name))).join('');
      const noteOpts = Array.from({ length: 73 }, (_, i) => i + 24)
        .map((n) => `<option value="${n}" ${n === cfg.root ? 'selected' : ''}>${noteName(n)} (${n})</option>`).join('');
      const srcOpts = (sel: string) => FRAME_SOURCES.map((s) => opt(s.id, sel, s.label)).join('');
      const scaleOpts = Object.keys(SCALES).map((s) => opt(s, cfg.scale, s)).join('');
      const chordOpts = Object.keys(CHORDS).map((c) => opt(c, cfg.chord, c)).join('');
      const modeOpts = ['single', 'chord', 'arp'].map((m) => opt(m, cfg.mode, m)).join('');
      const arpOpts = ['up', 'down', 'updown', 'random'].map((a) => opt(a, cfg.arpPattern, a)).join('');
      this.filterPanel.innerHTML = `
        <h3>♪ MIDI block — frame sequencer</h3>
        <div class="hint2">every frame becomes music: pick what part of the frame drives pitch and velocity,
        quantize to a scale, and play single notes, chords, or arpeggios. Rate-limited so 5000× won't jam the port.</div>
        ${st.ready
          ? `<div class="hint2" style="color:var(--good)">● MIDI enabled · ${st.outputs.length} output(s)</div>`
          : `<div class="row"><button id="mi-enable">Enable MIDI</button><span class="err" style="color:${st.error ? 'var(--bad)' : 'var(--dim)'}">${esc(st.error || 'click to grant access')}</span></div>`}
        <div class="fc-grid">
          <div>
            <label>output device</label><select id="mi-dev">${devOpts || '<option>(enable MIDI / connect a device)</option>'}</select>
            <div class="row">
              <label style="margin:0">channel</label><input type="number" id="mi-ch" min="1" max="16" value="${cfg.channel + 1}" style="width:54px">
              <label style="margin:0">cooldown</label><input type="number" id="mi-cd" min="0" max="2000" value="${cfg.cooldownMs}" style="width:60px">ms
              <label style="margin:0">gate</label><input type="number" id="mi-gate" min="20" max="2000" value="${cfg.gateMs}" style="width:60px">ms
            </div>
            <label>key / scale / range</label>
            <div class="row">
              <select id="mi-root" style="width:auto">${noteOpts}</select>
              <select id="mi-scale" style="width:auto">${scaleOpts}</select>
              <input type="number" id="mi-oct" min="1" max="5" value="${cfg.octaves}" style="width:46px" title="octaves"> oct
            </div>
          </div>
          <div>
            <label>pitch from</label>
            <select id="mi-nsrc">${srcOpts(cfg.noteSource)}</select>
            <span id="mi-bytewrap" style="display:${cfg.noteSource === 'byte' ? 'block' : 'none'}">
              <label>byte offset</label><input type="number" id="mi-byte" min="0" max="127" value="${cfg.byteOffset}" style="width:64px">
            </span>
            <label>velocity from</label>
            <div class="row">
              <select id="mi-vsrc" style="width:auto">${opt('fixed', cfg.velSource, 'fixed')}${srcOpts(cfg.velSource).replace('selected', cfg.velSource === 'fixed' ? '' : 'selected')}</select>
              <input type="number" id="mi-vel" min="1" max="127" value="${cfg.velocity}" style="width:54px" title="fixed velocity">
            </div>
            <label>play</label>
            <div class="row">
              <select id="mi-mode" style="width:auto">${modeOpts}</select>
              <select id="mi-chord" style="width:auto" title="chord">${chordOpts}</select>
            </div>
            <div class="row" id="mi-arpwrap" style="display:${cfg.mode === 'arp' ? 'flex' : 'none'}">
              <select id="mi-arp" style="width:auto">${arpOpts}</select>
              <input type="number" id="mi-steps" min="1" max="16" value="${cfg.arpSteps}" style="width:46px" title="steps">
              <input type="number" id="mi-arprate" min="10" max="1000" value="${cfg.arpRateMs}" style="width:60px" title="ms/step">ms
            </div>
          </div>
        </div>
        <div class="row"><button id="mi-apply">Apply</button><button id="mi-test">Test ♪</button><button id="fc-close">Close</button><span class="err" id="mi-ok"></span></div>
        <div class="hint2" id="mi-live"></div>`;
      const q = <T extends HTMLElement>(s: string) => this.filterPanel.querySelector<T>(s)!;
      this.filterPanel.querySelector('#mi-enable')?.addEventListener('click', async () => { await enableMidi(); render(); });
      q('#mi-nsrc').addEventListener('change', () => {
        q('#mi-bytewrap').style.display = q<HTMLSelectElement>('#mi-nsrc').value === 'byte' ? 'block' : 'none';
      });
      q('#mi-mode').addEventListener('change', () => {
        q('#mi-arpwrap').style.display = q<HTMLSelectElement>('#mi-mode').value === 'arp' ? 'flex' : 'none';
      });
      const collect = (): MidiCfg => ({
        deviceId: q<HTMLSelectElement>('#mi-dev').value,
        channel: Math.max(0, Math.min(15, Number(q<HTMLInputElement>('#mi-ch').value) - 1)),
        cooldownMs: Number(q<HTMLInputElement>('#mi-cd').value),
        gateMs: Number(q<HTMLInputElement>('#mi-gate').value),
        root: Number(q<HTMLSelectElement>('#mi-root').value),
        scale: q<HTMLSelectElement>('#mi-scale').value as MidiCfg['scale'],
        octaves: Number(q<HTMLInputElement>('#mi-oct').value),
        noteSource: q<HTMLSelectElement>('#mi-nsrc').value as MidiCfg['noteSource'],
        byteOffset: Number(q<HTMLInputElement>('#mi-byte')?.value ?? cfg.byteOffset),
        velSource: q<HTMLSelectElement>('#mi-vsrc').value as MidiCfg['velSource'],
        velocity: Number(q<HTMLInputElement>('#mi-vel').value),
        mode: q<HTMLSelectElement>('#mi-mode').value as MidiCfg['mode'],
        chord: q<HTMLSelectElement>('#mi-chord').value as MidiCfg['chord'],
        arpPattern: q<HTMLSelectElement>('#mi-arp').value as MidiCfg['arpPattern'],
        arpSteps: Number(q<HTMLInputElement>('#mi-steps').value),
        arpRateMs: Number(q<HTMLInputElement>('#mi-arprate').value),
      });
      q('#mi-apply').addEventListener('click', () => { onApply(collect()); q('#mi-ok').textContent = '✓ set'; });
      q('#mi-test').addEventListener('click', () => { onApply(collect()); this.midiTest?.(); });
      q('#fc-close').addEventListener('click', () => this.closeFilterPanel());
    };
    render();
    this.filterTimer = window.setInterval(() => {
      const lv = live();
      const el = this.filterPanel.querySelector('#mi-live');
      if (el && lv) el.textContent = `notes fired: ${lv.fired}${lv.lastNotes.length ? ' · last: ' + lv.lastNotes.map(noteName).join(' ') : ''}`;
    }, 500);
  }

  midiTest?: () => void;

  /** Learn / Lookup primitive config + live named-table view. */
  openTablePanel(
    kind: 'learn' | 'lookup',
    state: { table: string; keyField: KeyField; missDir: number },
    tableNames: () => string[],
    onApply: (table: string, keyField: KeyField, missDir: number) => void,
    live: () => { rows: { key: string; dir: number; ageS: number; hits: number }[]; writes?: number; hits?: number; misses?: number } | null,
  ): void {
    this.closeFilterPanel();
    this.filterPanel.style.display = 'block';
    const kfOpts = KEY_FIELDS.map((f) => `<option value="${f.id}" ${f.id === state.keyField ? 'selected' : ''}>${f.label}</option>`).join('');
    const dirOpts = (sel: number) => DIR_NAMES.map((n, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${n}</option>`).join('');
    const render = () => {
      const lv = live();
      const tbls = new Set([...tableNames(), state.table]);
      const tblOpts = [...tbls].map((t) => `<option value="${t}" ${t === state.table ? 'selected' : ''}>${esc(t)}</option>`).join('');
      const rows = (lv?.rows ?? [])
        .map((r) => `<tr><td>${esc(r.key)}</td><td>${DIR_ARROWS[r.dir]} ${DIR_NAMES[r.dir]}</td><td>${r.ageS}s</td><td>${r.hits}</td></tr>`).join('');
      const counter = kind === 'learn'
        ? `wrote ${lv?.writes ?? 0} entries`
        : `hits ${lv?.hits ?? 0} · misses ${lv?.misses ?? 0}`;
      this.filterPanel.innerHTML = `
        <h3>${kind === 'learn' ? '✎ Learn' : '🔍 Lookup'} — ${kind === 'learn' ? 'writes' : 'reads'} a named table</h3>
        <div class="hint2">${kind === 'learn'
          ? 'records key → the direction the frame came from, then passes it through. Point src-MAC at it and it learns where each host lives.'
          : 'reads key → stored direction (hit routes there); a miss takes the orange exit. Wire the miss exit to a hub to flood, and you have built a switch.'}</div>
        <div class="row">
          <label style="margin:0">table</label>
          <input list="fc-tbls" id="tb-name" value="${esc(state.table)}" style="width:90px">
          <datalist id="fc-tbls">${tblOpts}</datalist>
          <label style="margin:0">key</label><select id="tb-kf" style="width:auto">${kfOpts}</select>
          ${kind === 'lookup' ? `<label style="margin:0">miss →</label><select id="tb-miss" style="width:auto">${dirOpts(state.missDir)}</select>` : ''}
        </div>
        <div class="row"><button id="tb-apply">Apply</button><button id="fc-close">Close</button><span class="err" id="tb-ok"></span></div>
        <label style="margin-top:8px">table <b>${esc(state.table)}</b> — ${counter}</label>
        <table class="grid"><tr><th>key</th><th>dir</th><th>age</th><th>hits</th></tr>${rows}</table>
        ${rows ? '' : '<div class="hint2">empty — no entries yet</div>'}`;
      const q = <T extends HTMLElement>(s: string) => this.filterPanel.querySelector<T>(s)!;
      q('#tb-apply').addEventListener('click', () => {
        state.table = q<HTMLInputElement>('#tb-name').value.trim() || 'mac0';
        state.keyField = q<HTMLSelectElement>('#tb-kf').value as KeyField;
        state.missDir = kind === 'lookup' ? Number(q<HTMLSelectElement>('#tb-miss').value) : state.missDir;
        onApply(state.table, state.keyField, state.missDir);
        q('#tb-ok').textContent = '✓ set';
      });
      q('#fc-close').addEventListener('click', () => this.closeFilterPanel());
    };
    render();
    this.filterTimer = window.setInterval(render, 800);
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

// Meter limits are stored as BYTES/sec; the UI works in bit-rate units.
function unitToBytes(val: number, unit: string): number {
  const bits = unit === 'gbps' ? val * 1e9 : unit === 'mbps' ? val * 1e6 : unit === 'kbps' ? val * 1e3 : val;
  return Math.max(1, Math.round(bits / 8));
}
function bytesToUnit(bytes: number): { val: number; unit: string } {
  const bits = bytes * 8;
  if (bits >= 1e9) return { val: +(bits / 1e9).toFixed(2), unit: 'gbps' };
  if (bits >= 1e6) return { val: +(bits / 1e6).toFixed(2), unit: 'mbps' };
  if (bits >= 1e3) return { val: +(bits / 1e3).toFixed(2), unit: 'kbps' };
  return { val: bits, unit: 'bps' };
}
function bytesRate(bytesPerSec: number): string {
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} kbps`;
  return `${bits} bps`;
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
