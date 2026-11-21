import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CsvStream, DEFAULT_FPS_THRESHOLDS as T, fpsLevel, frameLevel, frameStats, isMangoHudHeader, isMangoHudLog, lastWindow, mangoHudGame, median, parseMangoHudCsv, parsePresentMonCsv, presentMonGame, splitCsv } from './frames.ts';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('stats: average FPS over the frames, 1 % low as the average of the slowest 1 %', () => {
  assert.deepEqual(frameStats([]), {});
  const s = frameStats([10, 10, 10, 10]);
  assert.equal(s.fps, 100);
  assert.equal(s.low1, 100);
  // 99 frames at 10 ms and one at 50 ms: the 1 % low is that frame.
  const t = frameStats([...Array(99).fill(10), 50]);
  assert.equal(Math.round(t.fps!), 96);
  assert.equal(t.low1, 20);
  // 200 frames: the slowest two count.
  assert.equal(frameStats([...Array(198).fill(5), 40, 60]).low1, 20);
  assert.deepEqual(frameStats([0, -1, Number.NaN]), {}, 'no real frame, no figure');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('the window is counted in play time, backwards from the last frame', () => {
  assert.deepEqual(lastWindow([10, 10, 10, 10], 25), [10, 10]);
  assert.deepEqual(lastWindow([10, 10, 10], 1000), [10, 10, 10]);
  assert.deepEqual(lastWindow([10, 2000], 1000), [2000], 'a hitch longer than the window still counts');
  assert.deepEqual(lastWindow([], 1000), []);
});

test('levels: low FPS is amber under fpsWarn and red under fpsAlert; a frame by its own rate', () => {
  assert.equal(fpsLevel(120, T), 'normal');
  assert.equal(fpsLevel(50, T), 'normal');
  assert.equal(fpsLevel(49.9, T), 'warn');
  assert.equal(fpsLevel(29, T), 'alert');
  assert.equal(fpsLevel(undefined, T), 'normal');
  assert.equal(frameLevel(8.3, T), 'normal');
  assert.equal(frameLevel(25, T), 'warn', '40 fps');
  assert.equal(frameLevel(41.7, T), 'alert', '24 fps');
});

test('MangoHud 0.7 log: system lines and the separator skipped, every frame read', () => {
  const ms = parseMangoHudCsv(fixture('Cyberpunk2077_2026-11-21_20-14-03.csv'));
  assert.equal(ms.length, 400);
  assert.equal(ms[0], 8.485);
  assert.equal(Math.max(...ms), 41.7, 'the stutter');
  const s = frameStats(ms);
  assert.ok(s.fps! > 115 && s.fps! < 121, `${s.fps}`);
  assert.ok(s.low1! < 60, 'the stutters pull the 1 % low down');
});

test('MangoHud 0.6 log (no separator, fewer columns)', () => {
  assert.deepEqual(parseMangoHudCsv(fixture('mangohud-0.6.csv')), [16.6716, 16.6627, 16.7, 33.3]);
  // Only fps: the frame time comes from it.
  assert.deepEqual(parseMangoHudCsv('fps,cpu_load\n50,10\n'), [20]);
});

test('MangoHud file names: the game, and summaries are not logs', () => {
  assert.equal(mangoHudGame('/home/x/mangohud/Cyberpunk2077_2026-11-21_20-14-03.csv'), 'Cyberpunk2077');
  assert.equal(mangoHudGame('Hollow_Knight_2026-01-02_03-04-05.csv'), 'Hollow Knight');
  assert.equal(mangoHudGame('wine64-preloader.csv'), 'wine64-preloader');
  assert.equal(isMangoHudLog('Cyberpunk2077_2026-11-21_20-14-03.csv'), true);
  assert.equal(isMangoHudLog('Cyberpunk2077_2026-11-21_20-14-03_summary.csv'), false);
  assert.equal(isMangoHudLog('MangoHud.conf'), false);
});

test('PresentMon 2.x CSV: frames by program, dwm included (the reader leaves it out)', () => {
  const by = parsePresentMonCsv(fixture('presentmon-2.csv'));
  assert.deepEqual([...by.keys()], ['EldenRing.exe', 'dwm.exe']);
  const ms = by.get('EldenRing.exe')!;
  assert.equal(ms.length, 240);
  assert.equal(Math.max(...ms), 38.4);
  assert.ok(frameStats(ms).fps! > 135);
  assert.equal(presentMonGame('EldenRing.exe'), 'EldenRing');
  assert.equal(presentMonGame('C:\\Games\\Witcher3.EXE'), 'Witcher3');
});

test('PresentMon 1.x CSV: msBetweenPresents', () => {
  const by = parsePresentMonCsv(fixture('presentmon-1.csv'));
  assert.deepEqual(by.get('csgo.exe'), [3.4521, 3.4602, 3.4398]);
  assert.deepEqual(by.get('dwm.exe'), [16.6692]);
});

test('CSV read in chunks: only whole lines, quotes honoured, a new header replaces the old', () => {
  const s = new CsvStream(isMangoHudHeader);
  assert.deepEqual(s.push('os,cpu\nArch,x\nfps,frame'), []);
  assert.deepEqual(s.push('time\n100,10\n50,2'), [{ fps: '100', frametime: '10' }]);
  assert.deepEqual(s.push('0\n'), [{ fps: '50', frametime: '20' }]);
  assert.deepEqual(s.push('frametime,fps\n5,200\n'), [{ frametime: '5', fps: '200' }]);
  assert.deepEqual(splitCsv('"Hello, world",2,"say ""hi"""'), ['Hello, world', '2', 'say "hi"']);
});
