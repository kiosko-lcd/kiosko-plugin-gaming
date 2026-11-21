/**
 * Frame times, without I/O: the CSV the tools write (read as it grows, a
 * chunk at a time), the figures a gamer reads (average FPS, 1 % low) and the
 * thresholds that colour them. Tested on fixture logs.
 */

/** The figures of a run of frame times (ms): average FPS and the 1 % low. */
export function frameStats(ms: readonly number[]): { fps?: number; low1?: number } {
  const ok = ms.filter((v) => Number.isFinite(v) && v > 0);
  if (!ok.length) return {};
  const sum = ok.reduce((a, b) => a + b, 0);
  // 1 % low: the average FPS of the slowest 1 % of frames (at least one frame).
  const slow = [...ok].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(ok.length / 100)));
  const slowSum = slow.reduce((a, b) => a + b, 0);
  return { fps: (1000 * ok.length) / sum, low1: (1000 * slow.length) / slowSum };
}

/** The frames at the end of `ms` that fit in `windowMs` of play (summing frame times backwards). */
export function lastWindow(ms: readonly number[], windowMs: number): number[] {
  let sum = 0;
  let i = ms.length;
  while (i > 0 && sum + ms[i - 1]! <= windowMs) sum += ms[--i]!;
  // A single frame longer than the window (a loading hitch) still counts.
  return ms.slice(i === ms.length && ms.length ? ms.length - 1 : i);
}

/** The middle frame time, ms: the curve's calm line. */
export function median(ms: readonly number[]): number | undefined {
  if (!ms.length) return undefined;
  const s = [...ms].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export type Level = 'normal' | 'warn' | 'alert';

export interface FpsThresholds {
  /** Amber below this many FPS. */
  fpsWarn: number;
  /** Red below this many FPS. */
  fpsAlert: number;
}

export const DEFAULT_FPS_THRESHOLDS: FpsThresholds = { fpsWarn: 50, fpsAlert: 30 };

/** Low FPS is the bad side: amber under `fpsWarn`, red under `fpsAlert`. */
export function fpsLevel(fps: number | undefined, t: FpsThresholds): Level {
  return fps === undefined ? 'normal' : fps < t.fpsAlert ? 'alert' : fps < t.fpsWarn ? 'warn' : 'normal';
}

/** A frame time is a stutter when, on its own, it is a frame of a game running under the thresholds. */
export function frameLevel(ms: number, t: FpsThresholds): Level {
  return fpsLevel(1000 / ms, t);
}

/* ---------- CSV, chunk by chunk ---------- */

/** Splits one CSV line; quotes are honoured (PresentMon never needs them, but a game's name might). */
export function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(',').map((s) => s.trim());
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') out.push(cur.trim()), (cur = '');
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * A CSV read as it grows: lines are only taken once their newline has
 * arrived, everything before the header (MangoHud's system lines) is
 * skipped, and rows come out as records keyed by the header, in lower case.
 */
export class CsvStream {
  private carry = '';
  header: string[] | undefined;

  private readonly isHeader: (cols: string[]) => boolean;

  constructor(isHeader: (cols: string[]) => boolean) {
    this.isHeader = isHeader;
  }

  push(chunk: string): Record<string, string>[] {
    const text = this.carry + chunk;
    const lines = text.split(/\r?\n/);
    this.carry = lines.pop() ?? '';
    const rows: Record<string, string>[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = splitCsv(line);
      if (!this.header) {
        if (this.isHeader(cols.map((c) => c.toLowerCase()))) this.header = cols.map((c) => c.toLowerCase());
        continue;
      }
      // A second header (a log restarted into the same stream) replaces the first.
      if (this.isHeader(cols.map((c) => c.toLowerCase()))) {
        this.header = cols.map((c) => c.toLowerCase());
        continue;
      }
      const r: Record<string, string> = {};
      this.header.forEach((h, i) => (r[h] = cols[i] ?? ''));
      rows.push(r);
    }
    return rows;
  }
}

const num = (s: string | undefined) => {
  if (s === undefined || s === '') return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

/* ---------- MangoHud ---------- */

/** MangoHud's header row: `fps,frametime,cpu_load,…,elapsed`. */
export const isMangoHudHeader = (cols: string[]) => cols[0] === 'fps' || (cols.includes('fps') && cols.includes('frametime'));

/** One MangoHud row → its frame time, ms (from `frametime`, else from `fps`). */
export function mangoHudFrameMs(r: Record<string, string>): number | undefined {
  const ft = num(r.frametime);
  if (ft !== undefined && ft > 0) return ft;
  const fps = num(r.fps);
  return fps && fps > 0 ? 1000 / fps : undefined;
}

/** Every frame time of a whole MangoHud log (tests, and a log read at once). */
export function parseMangoHudCsv(text: string): number[] {
  const s = new CsvStream(isMangoHudHeader);
  return s.push(text.endsWith('\n') ? text : `${text}\n`).map(mangoHudFrameMs).filter((v): v is number => v !== undefined);
}

/** `Cyberpunk2077_2026-11-21_20-14-03.csv` → `Cyberpunk2077`. Summaries (`…_summary.csv`) are not logs. */
export function mangoHudGame(file: string): string {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.csv$/i, '');
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/, '').replace(/_/g, ' ').trim() || base;
}

export const isMangoHudLog = (file: string) => /\.csv$/i.test(file) && !/_summary\.csv$/i.test(file);

/* ---------- PresentMon ---------- */

/** PresentMon's header: `Application,ProcessID,…` with `FrameTime` (2.x) or `MsBetweenPresents` (1.x, 2.x `--v1_metrics`). */
export const isPresentMonHeader = (cols: string[]) => cols.includes('application') && (cols.includes('frametime') || cols.includes('msbetweenpresents'));

/** One PresentMon row → the program and its frame time, ms. */
export function presentMonFrame(r: Record<string, string>): { app: string; ms: number } | undefined {
  const ms = num(r.frametime) ?? num(r.msbetweenpresents);
  const app = r.application;
  if (!app || ms === undefined || !(ms > 0)) return undefined;
  return { app, ms };
}

/** Programs that present frames but are never the game. */
export const NOT_GAMES = new Set(['dwm.exe', 'explorer.exe', 'searchhost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'textinputhost.exe', 'applicationframehost.exe', 'presentmon.exe', '<unknown>', '<error>']);

/** `Cyberpunk2077.exe` → `Cyberpunk2077`. */
export const presentMonGame = (app: string) => app.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');

/** Every frame of a whole PresentMon CSV, by program. */
export function parsePresentMonCsv(text: string): Map<string, number[]> {
  const s = new CsvStream(isPresentMonHeader);
  const out = new Map<string, number[]>();
  for (const r of s.push(text.endsWith('\n') ? text : `${text}\n`)) {
    const f = presentMonFrame(r);
    if (!f) continue;
    const list = out.get(f.app) ?? [];
    list.push(f.ms);
    out.set(f.app, list);
  }
  return out;
}
