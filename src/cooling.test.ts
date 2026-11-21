import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { channelName, chipName, coolantLevel, coolingLevel, DEFAULT_COOLING_THRESHOLDS as T, fanLevel, lhmDataUrl, MissingTool, parseLhm, parseLiquidctl, parseSensors, readCooling, selectCooling, shortDevice, type CoolingDeps } from './cooling.ts';
import type { CoolingSnapshot } from './types.ts';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('names: channel and device, the way the panel shows them', () => {
  assert.equal(channelName('Fan 1 speed'), 'Fan 1');
  assert.equal(channelName('Fan speed 2'), 'Fan 2');
  assert.equal(channelName('Pump duty'), 'Pump');
  assert.equal(channelName('Liquid temperature'), 'Liquid');
  assert.equal(channelName('Coolant temp'), 'Coolant');
  assert.equal(shortDevice('NZXT Kraken X (X53, X63 or X73)'), 'NZXT Kraken X');
  assert.equal(chipName('nct6799-isa-0290'), 'nct6799');
  assert.equal(chipName('kraken3-hid-3-9'), 'kraken3');
  assert.equal(chipName('amdgpu-pci-0300'), 'amdgpu');
});

test('liquidctl: an NZXT Kraken and a Corsair Commander Core', () => {
  const r = parseLiquidctl(fixture('liquidctl-kraken-commander.json'));
  assert.deepEqual(
    r.coolant.map((c) => [c.device, c.name, c.temp]),
    [
      ['NZXT Kraken X', 'Liquid', 33.6],
      ['Corsair Commander Core', 'Water', 34.1],
    ],
    'a temperature probe is not the coolant',
  );
  const pump = r.fans.find((f) => f.device === 'NZXT Kraken X')!;
  assert.deepEqual([pump.kind, pump.name, pump.rpm, pump.duty], ['pump', 'Pump', 2681, 70]);
  assert.deepEqual(
    r.fans.filter((f) => f.device === 'Corsair Commander Core').map((f) => `${f.kind} ${f.name} ${f.rpm}`),
    ['pump Pump 0', 'fan Fan 1 1187', 'fan Fan 2 1192', 'fan Fan 3 1176', 'fan Fan 4 0'],
  );
});

test('liquidctl: a Hydro Platinum, duty matched to its fan, the firmware left out', () => {
  const r = parseLiquidctl(fixture('liquidctl-hydro-platinum.json'));
  assert.deepEqual(
    r.fans.map((f) => [f.name, f.rpm, f.duty]),
    [
      ['Fan 1', 1012, 38],
      ['Fan 2', 1028, 38],
      ['Pump', 2390, 66],
    ],
  );
  assert.equal(r.coolant[0]!.temp, 31.2);
  assert.deepEqual(parseLiquidctl('[]'), { fans: [], coolant: [] }, 'no device');
});

test('sensors -j: the AIO kernel driver, motherboard headers and a GPU fan; other temperatures left out', () => {
  const r = parseSensors(fixture('sensors-desktop-aio.json'));
  assert.deepEqual(r.coolant, [{ id: 'sensors:kraken3-hid-3-9:Coolant temp', name: 'Coolant', device: 'kraken3', backend: 'sensors', temp: 32.9 }]);
  assert.deepEqual(
    r.fans.map((f) => `${f.device} ${f.kind} ${f.name} ${f.rpm}`),
    ['kraken3 pump Pump 2700', 'kraken3 fan Fan 1150', 'nct6799 fan Fan 1 912', 'nct6799 fan Fan 2 1388', 'nct6799 fan Fan 3 0', 'amdgpu fan Fan 1 1645'],
  );
});

test('sensors -j, real output of a fanless mini PC (lm-sensors 3.6, via Docker): nothing to show, no error', () => {
  assert.deepEqual(parseSensors(fixture('sensors-laptop-real.json')), { fans: [], coolant: [] });
});

test('LibreHardwareMonitor data.json: fans with their control, the pump, the water temperature', () => {
  const r = parseLhm(fixture('lhm-data.json'));
  assert.deepEqual(
    r.fans.map((f) => [f.device, f.kind, f.name, f.rpm, f.duty]),
    [
      ['Nuvoton NCT6799D', 'fan', 'Fan 1', 1123, 48.2],
      ['Nuvoton NCT6799D', 'fan', 'Fan 2', 0, undefined],
      ['Nuvoton NCT6799D', 'pump', 'AIO Pump', 2643, 100],
      ['NVIDIA GeForce RTX 4080 SUPER', 'fan', 'GPU Fan 1', 1490, 52],
    ],
  );
  assert.deepEqual(
    r.coolant.map((c) => [c.name, c.temp]),
    [['Water In', 33]],
    'the CPU temperatures are not the coolant',
  );
  assert.equal(lhmDataUrl('http://localhost:8085/'), 'http://localhost:8085/data.json');
  assert.equal(lhmDataUrl('http://pc:8085/data.json'), 'http://pc:8085/data.json');
});

test('levels: warm coolant and a slowing pump; fans never colour', () => {
  assert.equal(coolantLevel(33, T), 'normal');
  assert.equal(coolantLevel(40, T), 'warn');
  assert.equal(coolantLevel(45, T), 'alert');
  const pump = { id: 'p', kind: 'pump' as const, name: 'Pump', device: 'x', backend: 'liquidctl' as const };
  assert.equal(fanLevel({ ...pump, rpm: 2600 }, T), 'normal');
  assert.equal(fanLevel({ ...pump, rpm: 700 }, T), 'warn');
  assert.equal(fanLevel({ ...pump, rpm: 0 }, T), 'alert');
  assert.equal(fanLevel({ ...pump, kind: 'fan', rpm: 0 }, T), 'normal');
});

test('the widget selection: filter, stopped fans hidden, a stopped pump never', () => {
  const s: CoolingSnapshot = { available: true, backends: ['liquidctl'], ...parseLiquidctl(fixture('liquidctl-kraken-commander.json')), at: 0 };
  const all = selectCooling(s, [], true);
  assert.deepEqual(all.fans.map((f) => f.name), ['Pump', 'Pump', 'Fan 1', 'Fan 2', 'Fan 3']);
  assert.equal(coolingLevel(all, T), 'alert', 'the Commander pump reads 0');
  assert.equal(selectCooling(s, [], false).fans.length, 6);
  const kraken = selectCooling(s, ['NZXT*'], true);
  assert.deepEqual(kraken.fans.map((f) => f.name), ['Pump']);
  assert.equal(coolingLevel(kraken, T), 'normal');
  assert.deepEqual(selectCooling(s, ['!Corsair*', '!Liquid'], true).coolant, []);
  assert.deepEqual(selectCooling(undefined, [], true), { fans: [], coolant: [] });
});

const deps = (over: Partial<CoolingDeps> & { outputs?: Record<string, string | Error> }): CoolingDeps => ({
  platform: 'linux',
  fetch: (async () => new Response(fixture('lhm-data.json'))) as typeof fetch,
  run: async (argv) => {
    const v = over.outputs?.[argv[0]!];
    if (v === undefined) throw new MissingTool(`${argv[0]} not found`);
    if (v instanceof Error) throw v;
    return v;
  },
  ...over,
});

test('reading: every tool set runs, what answered is merged', async () => {
  const s = await readCooling({ liquidctl: 'liquidctl', lmSensors: 'sensors', lhmUrl: '' }, deps({ outputs: { liquidctl: fixture('liquidctl-hydro-platinum.json'), sensors: fixture('sensors-desktop-aio.json') } }), undefined, 5);
  assert.equal(s.available, true);
  assert.deepEqual(s.backends, ['liquidctl', 'sensors']);
  assert.equal(s.fans.length, 9);
  assert.equal(s.coolant.length, 2);
  assert.equal(s.at, 5);
});

test('reading: a missing tool is skipped; none answering says why', async () => {
  const one = await readCooling({ liquidctl: 'liquidctl', lmSensors: 'sensors', lhmUrl: '' }, deps({ outputs: { sensors: fixture('sensors-desktop-aio.json') } }), undefined, 0);
  assert.deepEqual(one.backends, ['sensors']);
  const none = await readCooling({ liquidctl: 'liquidctl', lmSensors: 'sensors', lhmUrl: '' }, deps({ outputs: {} }), undefined, 0);
  assert.equal(none.available, false);
  assert.match(none.reason!, /liquidctl: liquidctl not found; sensors: sensors not found/);
  const empty = await readCooling({ liquidctl: 'liquidctl', lmSensors: 'sensors', lhmUrl: '' }, deps({ outputs: { liquidctl: '[]', sensors: fixture('sensors-laptop-real.json') } }), undefined, 0);
  assert.equal(empty.available, false, 'tools that answer with nothing');
  assert.match(empty.reason!, /\(liquidctl, sensors\)/);
  const off = await readCooling({ liquidctl: '', lmSensors: '', lhmUrl: '' }, deps({}), undefined, 0);
  assert.equal(off.reason, 'no cooling tool set');
});

test('reading: sensors only on Linux; LibreHardwareMonitor on localhost by default on Windows', async () => {
  const urls: string[] = [];
  const fetchSpy = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return new Response(fixture('lhm-data.json'));
  }) as typeof fetch;
  const s = await readCooling({ liquidctl: '', lmSensors: 'sensors', lhmUrl: '' }, deps({ platform: 'win32', fetch: fetchSpy, outputs: { sensors: 'not json' } }), undefined, 0);
  assert.deepEqual(urls, ['http://localhost:8085/data.json']);
  assert.deepEqual(s.backends, ['lhm']);
  assert.equal(s.fans.length, 4);
  urls.length = 0;
  await readCooling({ liquidctl: '', lmSensors: '', lhmUrl: '' }, deps({ fetch: fetchSpy }), undefined, 0);
  assert.deepEqual(urls, [], 'not elsewhere unless set');
  const bad = await readCooling({ liquidctl: '', lmSensors: '', lhmUrl: 'http://pc:8085' }, deps({ fetch: (async () => new Response('nope', { status: 404 })) as typeof fetch }), undefined, 0);
  assert.match(bad.reason!, /HTTP 404/);
});
