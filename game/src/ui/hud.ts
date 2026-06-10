// DOM HUD: status bar, packet inspector, pod console, toolbar.
import { hexDump, type Decoded } from '../net/decode';
import type { FrameToken } from '../types';

export type Tool = 'select' | 'belt' | 'erase';

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
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
