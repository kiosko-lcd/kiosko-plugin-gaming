/**
 * Where the frames come from, followed live:
 *
 * - MangoHud (Linux): the newest CSV log in its `output_folder`, read as it
 *   grows (MangoHud writes one while logging; `autostart_log` starts it with
 *   the game).
 * - PresentMon (Windows): run with its CSV on stdout for as long as the
 *   source runs, or a CSV it is writing to a file, followed like MangoHud's.
 *
 * Every outside effect goes through `FrameDeps`, so tests drive it with
 * temporary files and a fake process.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Localized } from '@kiosko/sdk';
import { CsvStream, frameStats, isMangoHudHeader, isMangoHudLog, isPresentMonHeader, lastWindow, mangoHudFrameMs, mangoHudGame, NOT_GAMES, presentMonFrame, presentMonGame } from './frames.ts';
import type { FrameBackend, FrameSnapshot } from './types.ts';

export interface FrameOptions {
  backend: 'auto' | FrameBackend;
  /** MangoHud's `output_folder`. `~` is the home folder. */
  mangohudFolder: string;
  /** PresentMon's executable (on the PATH or a full path). Empty: don't run it. */
  presentmon: string;
  /** A CSV PresentMon is writing; set, it is followed instead of running PresentMon. */
  presentmonCsv: string;
  /** Average and 1 % low over this much play. */
  windowMs: number;
  /** No new frame for this long: the game is gone. */
  staleMs: number;
}

export interface Spawned {
  onData(fn: (chunk: string) => void): void;
  onExit(fn: (why: string) => void): void;
  kill(): void;
}

export interface FrameDeps {
  platform: NodeJS.Platform;
  now: () => number;
  home: string;
  spawn: (argv: string[]) => Spawned;
}

/** Frames kept per game: the widget's curve shows at most this many. */
export const MAX_FRAMES = 1000;
/** What is read of a log found already long: its last part is enough for the window. */
const TAIL_BYTES = 256 * 1024;
/** At most this much of a log per poll. */
const MAX_READ = 4 * 1024 * 1024;
/** After PresentMon stops, wait this long before starting it again. */
const RESTART_MS = 15_000;

/** PresentMon 2.x: CSV to stdout, no console table, its own ETW session (replacing a stale one of ours). */
export const presentMonArgs = (exe: string) => [exe, '--output_stdout', '--no_console_stats', '--stop_existing_session', '--session_name', 'KioskoGaming', '--exclude', 'dwm.exe'];

export const TEXT = {
  noFolder: { en: 'MangoHud log folder not found: {path}', es: 'No está la carpeta de registros de MangoHud: {path}', de: 'MangoHud-Protokollordner nicht gefunden: {path}', 'zh-Hant': '找不到 MangoHud 記錄資料夾：{path}', 'zh-Hans': '找不到 MangoHud 日志文件夹：{path}' },
  noPresentMon: { en: 'PresentMon not found: {path}', es: 'No se encuentra PresentMon: {path}', de: 'PresentMon nicht gefunden: {path}', 'zh-Hant': '找不到 PresentMon：{path}', 'zh-Hans': '找不到 PresentMon：{path}' },
  presentMonStopped: { en: 'PresentMon stopped: {why}', es: 'PresentMon se ha parado: {why}', de: 'PresentMon wurde beendet: {why}', 'zh-Hant': 'PresentMon 已停止：{why}', 'zh-Hans': 'PresentMon 已停止：{why}' },
  noCsv: { en: 'PresentMon CSV not found: {path}', es: 'No está el CSV de PresentMon: {path}', de: 'PresentMon-CSV nicht gefunden: {path}', 'zh-Hant': '找不到 PresentMon CSV：{path}', 'zh-Hans': '找不到 PresentMon CSV：{path}' },
} satisfies Record<string, Localized>;

const fillAll = (l: Localized, vars: Record<string, string>): Localized => {
  const f = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  return typeof l === 'string' ? f(l) : Object.fromEntries(Object.entries(l).map(([k, v]) => [k, f(v as string)])) as Localized;
};

export function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.replace(/^~(?=[\\/])/, home);
}

export const defaultSpawn = (argv: string[]): Spawned => {
  let child: ChildProcess | undefined;
  let err = '';
  const exitFns: ((why: string) => void)[] = [];
  const dataFns: ((c: string) => void)[] = [];
  let done = false;
  const finish = (why: string) => {
    if (done) return;
    done = true;
    for (const fn of exitFns) fn(why);
  };
  try {
    child = nodeSpawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout!.setEncoding('utf8').on('data', (c: string) => dataFns.forEach((fn) => fn(c)));
    child.stderr!.setEncoding('utf8').on('data', (c: string) => (err = (err + c).slice(-2000)));
    child.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' ? 'ENOENT' : e.message));
    child.on('exit', (code) => finish(err.trim().split('\n').pop()?.trim() || `exit ${code}`));
  } catch (e) {
    queueMicrotask(() => finish((e as Error).message));
  }
  return {
    onData: (fn) => dataFns.push(fn),
    onExit: (fn) => exitFns.push(fn),
    kill: () => {
      done = true;
      child?.kill();
    },
  };
};

export const DEFAULT_FRAME_DEPS: FrameDeps = { platform: process.platform, now: () => Date.now(), home: homedir(), spawn: defaultSpawn };

/** Frames of one game (or program), and when the last of them arrived. */
interface Track {
  frames: number[];
  lastAt: number;
}

function pushFrames(t: Track, ms: number[], now: number): void {
  if (!ms.length) return;
  t.frames.push(...ms);
  if (t.frames.length > MAX_FRAMES * 2) t.frames.splice(0, t.frames.length - MAX_FRAMES);
  t.lastAt = now;
}

/** A file read as it grows, from where the last read stopped. */
class FileTail {
  offset = 0;
  readonly csv: CsvStream;
  readonly path: string;
  constructor(path: string, isHeader: (cols: string[]) => boolean) {
    this.path = path;
    this.csv = new CsvStream(isHeader);
  }

  /**
   * The rows added since the last call. The first call of a long file reads
   * its header and only its last part; `skipOld` (a log nobody writes to any
   * more) reads just the header, so only rows written from now on count.
   */
  async read(skipOld: boolean): Promise<Record<string, string>[]> {
    const fh = await open(this.path, 'r');
    try {
      const { size } = await fh.stat();
      if (size < this.offset) {
        // Rewritten from the start: read it again.
        this.offset = 0;
        this.csv.header = undefined;
      }
      const rows: Record<string, string>[] = [];
      if (this.offset === 0 && (skipOld || size > TAIL_BYTES)) {
        // The header first, then on from the tail (or the end), from a whole line.
        const head = Buffer.alloc(Math.min(size, 16 * 1024));
        await fh.read(head, 0, head.length, 0);
        const text = head.toString('utf8');
        const lines = text.split('\n');
        let at = 0;
        for (const line of lines.slice(0, -1)) {
          at += Buffer.byteLength(line, 'utf8') + 1;
          this.csv.push(`${line}\n`);
          if (this.csv.header) break;
        }
        const from = skipOld ? size : Math.max(at, size - TAIL_BYTES);
        if (from >= size) {
          // Nothing new; if the last line isn't finished, start at the next whole one.
          this.offset = size;
          return rows;
        }
        const probe = Buffer.alloc(Math.min(4096, size - from));
        await fh.read(probe, 0, probe.length, from);
        const nl = from === at ? -1 : probe.indexOf(10);
        this.offset = nl < 0 ? from : from + nl + 1;
      }
      const len = Math.min(size - this.offset, MAX_READ);
      if (len <= 0) return rows;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.offset);
      // Only whole lines: the last one may still be being written.
      const nl = buf.lastIndexOf(10, bytesRead - 1);
      if (nl < 0) {
        // A line longer than a whole read is no log line: skip it.
        if (bytesRead === MAX_READ) this.offset += bytesRead;
        return rows;
      }
      this.offset += nl + 1;
      rows.push(...this.csv.push(buf.subarray(0, nl + 1).toString('utf8')));
      return rows;
    } finally {
      await fh.close();
    }
  }
}

/**
 * Follows one tool for as long as the source runs: `poll()` once a second
 * says what's playing; `stop()` closes PresentMon.
 */
export class FrameReader {
  private tail: FileTail | undefined;
  private game: string | undefined;
  private track: Track = { frames: [], lastAt: 0 };
  private apps = new Map<string, Track>();
  private proc: Spawned | undefined;
  private procDiedAt = 0;
  private procWhy: string | undefined;
  private stopped = false;

  readonly o: FrameOptions;
  readonly d: FrameDeps;

  constructor(o: FrameOptions, d: FrameDeps = DEFAULT_FRAME_DEPS) {
    this.o = o;
    this.d = d;
  }

  get backend(): FrameBackend {
    return this.o.backend === 'auto' ? (this.d.platform === 'win32' ? 'presentmon' : 'mangohud') : this.o.backend;
  }

  async poll(): Promise<FrameSnapshot> {
    const now = this.d.now();
    if (this.backend === 'mangohud') return this.pollMangoHud(now);
    return this.o.presentmonCsv.trim() ? this.pollPresentMonFile(now) : this.pollPresentMonProcess(now);
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = undefined;
  }

  private snapshot(now: number, t: Track, game: string | undefined, extra: Partial<FrameSnapshot> = {}): FrameSnapshot {
    const running = t.frames.length > 0 && now - t.lastAt <= this.o.staleMs;
    if (!running) {
      t.frames.length = 0;
      return { running: false, backend: this.backend, frameTimes: [], at: now, ...extra };
    }
    const win = lastWindow(t.frames, this.o.windowMs);
    return { running: true, backend: this.backend, ...(game ? { game } : {}), ...frameStats(win), frameTimes: t.frames.slice(-MAX_FRAMES), at: now, ...extra };
  }

  /* ---------- MangoHud ---------- */

  private async pollMangoHud(now: number): Promise<FrameSnapshot> {
    const folder = expandHome(this.o.mangohudFolder.trim() || '~/mangohud', this.d.home);
    let newest: { path: string; mtime: number } | undefined;
    try {
      for (const e of await readdir(folder, { withFileTypes: true })) {
        if (!e.isFile() || !isMangoHudLog(e.name)) continue;
        const p = join(folder, e.name);
        const s = await stat(p).catch(() => undefined);
        if (s && (!newest || s.mtimeMs > newest.mtime)) newest = { path: p, mtime: s.mtimeMs };
      }
    } catch {
      return this.snapshot(now, this.track, undefined, { reason: `MangoHud log folder not found: ${folder}`, reasonText: fillAll(TEXT.noFolder, { path: folder }) });
    }
    if (!newest) return this.snapshot(now, this.track, undefined);
    if (this.tail?.path !== newest.path) {
      this.tail = new FileTail(newest.path, isMangoHudHeader);
      this.track = { frames: [], lastAt: 0 };
      this.game = mangoHudGame(newest.path);
      // A log nobody has written to lately is an old game: only what it gets from now on counts.
      const rows = await this.tail.read(now - newest.mtime > this.o.staleMs).catch(() => []);
      pushFrames(this.track, rows.map(mangoHudFrameMs).filter((v): v is number => v !== undefined), now);
    } else {
      const rows = await this.tail.read(false).catch(() => []);
      pushFrames(this.track, rows.map(mangoHudFrameMs).filter((v): v is number => v !== undefined), now);
    }
    return this.snapshot(now, this.track, this.game);
  }

  /* ---------- PresentMon ---------- */

  private addPresentMonRows(rows: Record<string, string>[], now: number): void {
    const by = new Map<string, number[]>();
    for (const r of rows) {
      const f = presentMonFrame(r);
      if (!f || NOT_GAMES.has(f.app.toLowerCase())) continue;
      const list = by.get(f.app) ?? [];
      list.push(f.ms);
      by.set(f.app, list);
    }
    for (const [app, ms] of by) {
      const t = this.apps.get(app) ?? { frames: [], lastAt: 0 };
      pushFrames(t, ms, now);
      this.apps.set(app, t);
    }
  }

  /** The game: of the programs presenting now, the one with the most frames lately. */
  private presentMonSnapshot(now: number, extra: Partial<FrameSnapshot> = {}): FrameSnapshot {
    let best: [string, Track] | undefined;
    for (const [app, t] of this.apps) {
      if (now - t.lastAt > this.o.staleMs) {
        this.apps.delete(app);
        continue;
      }
      if (!best || lastWindow(t.frames, 2_000).length > lastWindow(best[1].frames, 2_000).length) best = [app, t];
    }
    return best ? this.snapshot(now, best[1], presentMonGame(best[0]), extra) : this.snapshot(now, { frames: [], lastAt: 0 }, undefined, extra);
  }

  private async pollPresentMonFile(now: number): Promise<FrameSnapshot> {
    const path = expandHome(this.o.presentmonCsv.trim(), this.d.home);
    const s = await stat(path).catch(() => undefined);
    if (!s) return this.presentMonSnapshot(now, { reason: `PresentMon CSV not found: ${path}`, reasonText: fillAll(TEXT.noCsv, { path }) });
    const first = this.tail?.path !== path;
    if (first) this.tail = new FileTail(path, isPresentMonHeader);
    const rows = await this.tail!.read(first && now - s.mtimeMs > this.o.staleMs).catch(() => []);
    this.addPresentMonRows(rows, now);
    return this.presentMonSnapshot(now);
  }

  private pollPresentMonProcess(now: number): FrameSnapshot {
    const exe = this.o.presentmon.trim();
    if (!exe) return this.presentMonSnapshot(now);
    if (!this.proc && !this.stopped && now - this.procDiedAt >= RESTART_MS) {
      const csv = new CsvStream(isPresentMonHeader);
      const p = this.d.spawn(presentMonArgs(exe));
      this.proc = p;
      this.procWhy = undefined;
      p.onData((chunk) => this.addPresentMonRows(csv.push(chunk), this.d.now()));
      p.onExit((why) => {
        if (this.proc !== p) return;
        this.proc = undefined;
        this.procDiedAt = this.d.now();
        this.procWhy = why;
      });
    }
    if (this.procWhy === 'ENOENT') return this.presentMonSnapshot(now, { reason: `PresentMon not found: ${exe}`, reasonText: fillAll(TEXT.noPresentMon, { path: exe }) });
    if (this.procWhy) return this.presentMonSnapshot(now, { reason: `PresentMon stopped: ${this.procWhy}`, reasonText: fillAll(TEXT.presentMonStopped, { why: this.procWhy }) });
    return this.presentMonSnapshot(now);
  }
}
