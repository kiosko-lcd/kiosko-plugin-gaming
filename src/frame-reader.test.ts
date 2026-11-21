import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { expandHome, FrameReader, presentMonArgs, type FrameDeps, type FrameOptions, type Spawned } from './frame-reader.ts';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kiosko-gaming-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const OPTS: FrameOptions = { backend: 'mangohud', mangohudFolder: '', presentmon: 'PresentMon', presentmonCsv: '', windowMs: 30_000, staleMs: 5_000 };

function clock(start = Date.now()) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const HEADER = 'os,cpu,gpu,ram,kernel,driver,cpuscheduler\nArch,x,y,32,6,Mesa,\n--------------------FRAME METRICS--------------------\nfps,frametime,elapsed\n';

test('MangoHud: the newest log is followed as it grows; no new frame for staleMs means no game', async () => {
  const dir = tmp();
  const c = clock();
  const r = new FrameReader({ ...OPTS, mangohudFolder: dir }, { platform: 'linux', now: c.now, home: '/nohome', spawn: () => assert.fail('no process for MangoHud') });
  assert.equal((await r.poll()).running, false, 'empty folder');
  const log = join(dir, 'Hades_2026-11-21_20-00-00.csv');
  writeFileSync(log, `${HEADER}100,10,10\n100,10,20\n`);
  writeFileSync(join(dir, 'Hades_2026-11-21_20-00-00_summary.csv'), 'whatever\n');
  let s = await r.poll();
  assert.equal(s.running, true);
  assert.equal(s.game, 'Hades');
  assert.equal(s.backend, 'mangohud');
  assert.deepEqual(s.frameTimes, [10, 10]);
  assert.equal(s.fps, 100);
  // A half-written line waits for its end.
  appendFileSync(log, '50,20,40\n25,4');
  c.advance(1_000);
  s = await r.poll();
  assert.deepEqual(s.frameTimes, [10, 10, 20]);
  appendFileSync(log, '0,80\n');
  c.advance(1_000);
  s = await r.poll();
  assert.deepEqual(s.frameTimes, [10, 10, 20, 40]);
  assert.equal(s.low1, 25);
  // The game closes: nothing more is written.
  c.advance(6_000);
  s = await r.poll();
  assert.equal(s.running, false);
  assert.deepEqual(s.frameTimes, []);
  assert.equal(s.fps, undefined);
});

test('MangoHud: a log found already old only counts what it gets from now on; a new game switches log', async () => {
  const dir = tmp();
  const old = join(dir, 'Celeste_2026-11-20_10-00-00.csv');
  writeFileSync(old, `${HEADER}60,16.6,1\n60,16.6,2\n`);
  const past = (Date.now() - 3_600_000) / 1000;
  utimesSync(old, past, past);
  const c = clock();
  const r = new FrameReader({ ...OPTS, mangohudFolder: dir }, { platform: 'linux', now: c.now, home: '/x', spawn: () => assert.fail() });
  assert.equal((await r.poll()).running, false, 'yesterday’s log is no game');
  appendFileSync(old, '60,16.6,3\n');
  c.advance(1_000);
  let s = await r.poll();
  assert.equal(s.running, true, 'it grows again: the game is back');
  assert.deepEqual(s.frameTimes, [16.6]);
  writeFileSync(join(dir, 'Hades_2026-11-21_20-00-00.csv'), `${HEADER}120,8.3,1\n`);
  c.advance(1_000);
  s = await r.poll();
  assert.equal(s.game, 'Hades');
  assert.deepEqual(s.frameTimes, [8.3]);
});

test('MangoHud: a long log already running is read from its last part, from a whole line', async () => {
  const dir = tmp();
  const log = join(dir, 'Cyberpunk2077_2026-11-21_20-14-03.csv');
  const rows = fixture('Cyberpunk2077_2026-11-21_20-14-03.csv').split('\n').slice(4).filter(Boolean);
  let body = '';
  while (body.length < 600_000) body += `${rows.join('\n')}\n`;
  writeFileSync(log, `${HEADER.replace('fps,frametime,elapsed', 'fps,frametime,cpu_load,cpu_power,gpu_load,cpu_temp,gpu_temp,gpu_core_clock,gpu_mem_clock,gpu_vram_used,gpu_power,ram_used,swap_used,process_rss,elapsed')}${body}`);
  const r = new FrameReader({ ...OPTS, mangohudFolder: dir }, { platform: 'linux', now: () => Date.now(), home: '/x', spawn: () => assert.fail() });
  const s = await r.poll();
  assert.equal(s.running, true);
  assert.equal(s.frameTimes.length, 1000, 'kept to the last 1000');
  assert.ok(s.frameTimes.every((v) => v > 5 && v < 45), 'no half line read as a frame');
  assert.ok(s.fps! > 100 && s.fps! < 125);
});

test('MangoHud: a missing folder says so; ~ is the home folder', async () => {
  const r = new FrameReader({ ...OPTS, mangohudFolder: '~/nope-mangohud' }, { platform: 'linux', now: () => 0, home: '/tmp/kiosko-no-home', spawn: () => assert.fail() });
  const s = await r.poll();
  assert.equal(s.running, false);
  assert.equal(s.reason, 'MangoHud log folder not found: /tmp/kiosko-no-home/nope-mangohud');
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('~/a', '/h'), '/h/a');
  assert.equal(expandHome('/a/~', '/h'), '/a/~');
});

/** A PresentMon that prints what the test feeds it. */
function fakePresentMon() {
  const calls: string[][] = [];
  let feed: ((c: string) => void) | undefined;
  let exit: ((why: string) => void) | undefined;
  let killed = 0;
  const spawn = (argv: string[]): Spawned => {
    calls.push(argv);
    return { onData: (fn) => (feed = fn), onExit: (fn) => (exit = fn), kill: () => killed++ };
  };
  return { calls, spawn, feed: (c: string) => feed!(c), exit: (w: string) => exit!(w), killed: () => killed };
}

test('PresentMon (Windows, automatic): run once, its CSV read as it comes; the game is the busiest program but dwm', async () => {
  const pm = fakePresentMon();
  const c = clock(1_000_000);
  const d: FrameDeps = { platform: 'win32', now: c.now, home: 'C:\\Users\\x', spawn: pm.spawn };
  const r = new FrameReader({ ...OPTS, backend: 'auto' }, d);
  assert.equal(r.backend, 'presentmon');
  assert.equal((await r.poll()).running, false);
  assert.deepEqual(pm.calls, [presentMonArgs('PresentMon')]);
  const csv = fixture('presentmon-2.csv');
  pm.feed(csv.slice(0, 20_000));
  pm.feed(csv.slice(20_000));
  const s = await r.poll();
  assert.equal(s.running, true);
  assert.equal(s.backend, 'presentmon');
  assert.equal(s.game, 'EldenRing');
  assert.equal(s.frameTimes.length, 240);
  assert.equal(pm.calls.length, 1, 'one process for the whole run');
  c.advance(10_000);
  assert.equal((await r.poll()).running, false, 'the game closed');
  r.stop();
  assert.equal(pm.killed(), 1);
});

test('PresentMon: not found or stopped says why, and starts again later', async () => {
  const pm = fakePresentMon();
  const c = clock(5_000_000);
  const r = new FrameReader({ ...OPTS, backend: 'presentmon' }, { platform: 'win32', now: c.now, home: '', spawn: pm.spawn });
  await r.poll();
  pm.exit('ENOENT');
  assert.equal((await r.poll()).reason, 'PresentMon not found: PresentMon');
  assert.equal(pm.calls.length, 1);
  c.advance(16_000);
  await r.poll();
  assert.equal(pm.calls.length, 2, 'tried again');
  pm.exit('Access denied: run as administrator or add the user to Performance Log Users');
  assert.match((await r.poll()).reason!, /^PresentMon stopped: Access denied/);
  const off = new FrameReader({ ...OPTS, backend: 'presentmon', presentmon: '' }, { platform: 'win32', now: c.now, home: '', spawn: () => assert.fail('empty: not run') });
  assert.equal((await off.poll()).running, false);
});

test('PresentMon CSV file: followed like a log', async () => {
  const dir = tmp();
  const f = join(dir, 'capture.csv');
  const lines = fixture('presentmon-1.csv').split('\n');
  writeFileSync(f, `${lines.slice(0, 3).join('\n')}\n`);
  const c = clock();
  const r = new FrameReader({ ...OPTS, backend: 'presentmon', presentmonCsv: f }, { platform: 'win32', now: c.now, home: '', spawn: () => assert.fail('a file: no process') });
  let s = await r.poll();
  assert.equal(s.game, 'csgo');
  assert.deepEqual(s.frameTimes, [3.4521, 3.4602]);
  appendFileSync(f, `${lines.slice(3).join('\n')}`);
  c.advance(500);
  s = await r.poll();
  assert.deepEqual(s.frameTimes, [3.4521, 3.4602, 3.4398], 'dwm left out');
  const gone = new FrameReader({ ...OPTS, backend: 'presentmon', presentmonCsv: join(dir, 'none.csv') }, { platform: 'win32', now: c.now, home: '', spawn: () => assert.fail() });
  assert.match((await gone.poll()).reason!, /PresentMon CSV not found/);
});
