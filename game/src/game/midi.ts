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
