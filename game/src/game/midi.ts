// Web MIDI access for the game. pigeon.localhost is a secure context
// (browsers treat *.localhost as potentially-trustworthy), so
// navigator.requestMIDIAccess works without HTTPS. One shared manager;
// midi blocks on the floor send note-on/off through it.
//
// Frames can arrive at 5000x — thousands/sec would jam a MIDI port — so each
// block rate-limits itself (see board 'midi' cell cooldown).

type MIDIOutputMap = Map<string, MIDIOutput>;
interface MIDIOutput {
  id: string;
  name?: string;
  send(data: number[] | Uint8Array, timestamp?: number): void;
}
interface MIDIAccess {
  outputs: MIDIOutputMap;
  onstatechange: ((e: unknown) => void) | null;
}

class MidiManager {
  private access: MIDIAccess | null = null;
  private requested = false;
  enabled = false;
  error = '';
  onChange: () => void = () => {};

  /** Ask the browser for MIDI. Must be triggered by a user gesture. */
  async enable(): Promise<void> {
    if (this.enabled) return;
    this.requested = true;
    const nav = navigator as unknown as { requestMIDIAccess?: (o?: { sysex: boolean }) => Promise<MIDIAccess> };
    if (!nav.requestMIDIAccess) {
      this.error = 'Web MIDI not supported in this browser (try Chrome/Edge)';
      this.onChange();
      return;
    }
    try {
      this.access = await nav.requestMIDIAccess({ sysex: false });
      this.enabled = true;
      this.error = '';
      this.access.onstatechange = () => this.onChange();
      this.onChange();
    } catch (e) {
      this.error = 'MIDI access denied: ' + (e as Error).message;
      this.onChange();
    }
  }

  get ready(): boolean {
    return this.enabled && !!this.access;
  }

  outputs(): { id: string; name: string }[] {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((o) => ({ id: o.id, name: o.name ?? o.id }));
  }

  /** note-on then a scheduled note-off. channel 0-15, note 0-127. */
  play(deviceId: string, channel: number, note: number, velocity: number, durationMs = 200): void {
    if (!this.access) return;
    const out = this.firstOrById(deviceId);
    if (!out) return;
    const ch = channel & 0x0f;
    out.send([0x90 | ch, note & 0x7f, velocity & 0x7f]);
    // note-off via setTimeout (no need for precise MIDI timestamps here).
    setTimeout(() => out.send([0x80 | ch, note & 0x7f, 0]), durationMs);
  }

  private firstOrById(deviceId: string): MIDIOutput | undefined {
    if (!this.access) return undefined;
    if (deviceId && this.access.outputs.has(deviceId)) return this.access.outputs.get(deviceId);
    return [...this.access.outputs.values()][0];
  }

  wasRequested(): boolean {
    return this.requested;
  }
}

export const midi = new MidiManager();

/** General-MIDI-ish note names for the picker. */
export function noteName(n: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[n % 12] + (Math.floor(n / 12) - 1);
}

// ===========================================================================
// The music engine: turn a frame into notes. Pick what frame field drives
// pitch and velocity, quantize to a scale + key, and play it as a single
// note, a chord, or an arpeggio.
// ===========================================================================

import type { Decoded } from '../net/decode';

export interface MidiCfg {
  deviceId: string;
  channel: number; // 0-15
  cooldownMs: number; // min gap between triggers (5000x would jam the port)

  // musical
  root: number; // root MIDI note of the key (e.g. 48 = C3)
  scale: ScaleName;
  octaves: number; // spread frame values across this many octaves
  gateMs: number; // note length

  // what drives pitch / velocity
  noteSource: FrameSource;
  byteOffset: number; // for the 'byte' source
  velSource: FrameSource | 'fixed';
  velocity: number; // base velocity (when velSource = fixed)

  // single note, chord, or arpeggio
  mode: 'single' | 'chord' | 'arp';
  chord: ChordName;
  arpPattern: 'up' | 'down' | 'updown' | 'random';
  arpSteps: number;
  arpRateMs: number;
}

export function defaultMidiCfg(): MidiCfg {
  return {
    deviceId: '', channel: 0, cooldownMs: 80,
    root: 48, scale: 'minorPent', octaves: 2, gateMs: 220,
    noteSource: 'ip.dst', byteOffset: 19, velSource: 'fixed', velocity: 100,
    mode: 'single', chord: 'triad', arpPattern: 'up', arpSteps: 4, arpRateMs: 90,
  };
}

export type FrameSource =
  | 'fixed' | 'ip.dst' | 'ip.src' | 'l4.dst' | 'l4.src' | 'len' | 'kind' | 'srcmac' | 'byte';

export const FRAME_SOURCES: { id: FrameSource; label: string }[] = [
  { id: 'fixed', label: 'fixed (root note)' },
  { id: 'ip.dst', label: 'dst IP (last octet)' },
  { id: 'ip.src', label: 'src IP (last octet)' },
  { id: 'l4.dst', label: 'dst port' },
  { id: 'l4.src', label: 'src port' },
  { id: 'len', label: 'frame length' },
  { id: 'kind', label: 'frame kind' },
  { id: 'srcmac', label: 'src MAC (last byte)' },
  { id: 'byte', label: 'a frame byte…' },
];

export type ScaleName =
  | 'chromatic' | 'major' | 'minor' | 'minorPent' | 'majorPent' | 'dorian' | 'blues' | 'phrygian';

export const SCALES: Record<ScaleName, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  minorPent: [0, 3, 5, 7, 10],
  majorPent: [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  blues: [0, 3, 5, 6, 7, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

export type ChordName = 'triad' | 'minor' | 'maj7' | 'min7' | 'power' | 'octave' | 'sus4' | 'add9';

export const CHORDS: Record<ChordName, number[]> = {
  triad: [0, 4, 7],
  minor: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  power: [0, 7],
  octave: [0, 12],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
};

const KIND_INDEX: Record<string, number> = {
  'arp-request': 0, 'arp-reply': 1, 'icmp-echo': 2, 'icmp-reply': 3,
  'icmp-other': 4, tcp: 5, udp: 6, other: 7,
};

function frameValue(src: FrameSource, d: Decoded, snap: Uint8Array, byteOffset: number): number {
  const ipLast = (ip?: string) => (ip ? Number(ip.split('.')[3] || 0) : 0);
  switch (src) {
    case 'fixed': return 0;
    case 'ip.dst': return ipLast(d.ip?.dst);
    case 'ip.src': return ipLast(d.ip?.src);
    case 'l4.dst': return d.l4?.dst ?? 0;
    case 'l4.src': return d.l4?.src ?? 0;
    case 'len': return d.len;
    case 'kind': return KIND_INDEX[d.kind] ?? 7;
    case 'srcmac': return snap.length > 11 ? snap[11] : 0;
    case 'byte': return snap.length > byteOffset ? snap[byteOffset] : 0;
  }
}

/** Snap a frame-derived value to a note in the chosen scale + key. */
function quantize(value: number, cfg: MidiCfg): number {
  const scl = SCALES[cfg.scale];
  const span = scl.length * Math.max(1, cfg.octaves);
  const deg = ((Math.round(value) % span) + span) % span;
  const oct = Math.floor(deg / scl.length);
  const note = cfg.root + oct * 12 + scl[deg % scl.length];
  return Math.max(0, Math.min(127, note));
}

function chordNotes(rootNote: number, cfg: MidiCfg): number[] {
  if (cfg.mode === 'single') return [rootNote];
  const ivs = CHORDS[cfg.chord] ?? CHORDS.triad;
  let notes = ivs.map((iv) => Math.max(0, Math.min(127, rootNote + iv)));
  if (cfg.mode === 'arp') notes = arpOrder(notes, cfg);
  return notes;
}

function arpOrder(notes: number[], cfg: MidiCfg): number[] {
  let seq = [...notes];
  if (cfg.arpPattern === 'down') seq.reverse();
  else if (cfg.arpPattern === 'updown') seq = [...notes, ...[...notes].reverse().slice(1, -1)];
  else if (cfg.arpPattern === 'random') seq = shuffle(notes, cfg);
  // extend/truncate to arpSteps by cycling (with rising octaves on wrap)
  const out: number[] = [];
  for (let i = 0; i < cfg.arpSteps; i++) {
    const base = seq[i % seq.length];
    const wrap = Math.floor(i / seq.length);
    out.push(Math.min(127, base + wrap * 12));
  }
  return out;
}

// Deterministic-ish shuffle (no Math.random dependency for reproducibility).
let shuffleSeed = 1;
function shuffle(arr: number[], _cfg: MidiCfg): number[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    shuffleSeed = (shuffleSeed * 1103515245 + 12345) & 0x7fffffff;
    const j = shuffleSeed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The whole pipeline: frame -> notes -> MIDI. Returns the notes played (for
 *  the live readout). */
export function triggerMidi(cfg: MidiCfg, d: Decoded, snap: Uint8Array): number[] {
  if (!midi.ready) return [];
  const pitchVal = frameValue(cfg.noteSource, d, snap, cfg.byteOffset);
  const rootNote = cfg.noteSource === 'fixed' ? cfg.root : quantize(pitchVal, cfg);
  const vel = cfg.velSource === 'fixed'
    ? cfg.velocity
    : 1 + (frameValue(cfg.velSource as FrameSource, d, snap, cfg.byteOffset) % 127);

  const notes = chordNotes(rootNote, cfg);
  if (cfg.mode === 'arp') {
    notes.forEach((n, i) => setTimeout(() => midi.play(cfg.deviceId, cfg.channel, n, vel, cfg.gateMs), i * cfg.arpRateMs));
  } else {
    for (const n of notes) midi.play(cfg.deviceId, cfg.channel, n, vel, cfg.gateMs);
  }
  return notes;
}
