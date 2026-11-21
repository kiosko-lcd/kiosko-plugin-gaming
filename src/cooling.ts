/**
 * Fans, pumps and the coolant, from three tools: liquidctl (AIO coolers and
 * Corsair / NZXT controllers, every OS), lm-sensors' `sensors -j` (Linux,
 * motherboard headers and the kernel drivers of AIOs) and
 * LibreHardwareMonitor's web server (`/data.json`, Windows). Parsing is pure
 * and tested on fixtures; the reader runs whichever are set and merges them.
 */
import { execFile } from 'node:child_process';
import { matchFilter, type Filter, type Localized } from '@kiosko/sdk';
import type { CoolantReading, CoolingBackend, CoolingSnapshot, FanReading } from './types.ts';

export interface CoolingReadings {
  fans: FanReading[];
  coolant: CoolantReading[];
}

const COOLANT = /liquid|water|coolant/i;
const PUMP = /pump/i;

/** `Fan 1 speed` → `Fan 1`, `Pump duty` → `Pump`, `Liquid temperature` → `Liquid`, `Fan speed 2` → `Fan 2`. */
export function channelName(key: string): string {
  const s = key
    .replace(/\b(?:speed|duty|temperature|temp|input|rpm)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || key.trim();
}

/** `NZXT Kraken X (X53, X63 or X73)` → `NZXT Kraken X`; `Corsair iCUE H150i Elite (experimental)` → `Corsair iCUE H150i Elite`. */
export function shortDevice(d: string): string {
  return d.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim() || d.trim();
}

const toNum = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v.replace(/ /g, ' '));
  return m ? Number(m[0].replace(',', '.')) : undefined;
};

/* ---------- liquidctl status --json ---------- */

interface LiquidctlDevice {
  bus?: string;
  address?: string;
  description?: string;
  status?: { key?: string; value?: unknown; unit?: string }[];
}

export function parseLiquidctl(json: string): CoolingReadings {
  const out: CoolingReadings = { fans: [], coolant: [] };
  const list = JSON.parse(json) as LiquidctlDevice[];
  if (!Array.isArray(list)) return out;
  for (const dev of list) {
    const device = shortDevice(dev.description ?? 'liquidctl');
    const base = `liquidctl:${dev.address ?? dev.description}`;
    const fans = new Map<string, FanReading>();
    const fan = (name: string) => {
      let f = fans.get(name);
      if (!f) fans.set(name, (f = { id: `${base}:${name}`, kind: PUMP.test(name) ? 'pump' : 'fan', name, device, backend: 'liquidctl' }));
      return f;
    };
    for (const s of dev.status ?? []) {
      const key = s.key ?? '';
      const unit = (s.unit ?? '').toLowerCase();
      const v = toNum(s.value);
      if (v === undefined) continue;
      if (unit === 'rpm') fan(channelName(key)).rpm = v;
      else if (unit === '%' && /duty/i.test(key)) fan(channelName(key)).duty = v;
      else if (unit === '°c' && COOLANT.test(key)) out.coolant.push({ id: `${base}:${channelName(key)}`, name: channelName(key), device, backend: 'liquidctl', temp: v });
    }
    out.fans.push(...fans.values());
  }
  return out;
}

/* ---------- sensors -j ---------- */

/** `nct6799-isa-0290` → `nct6799`, `kraken3-hid-3-9` → `kraken3`. */
export const chipName = (chip: string) => chip.replace(/-(?:isa|pci|hid|i2c|acpi|virtual|usb|platform|spi|mdio|scsi|sdio|host)-.*$/i, '');

/** Chips that are a water-cooling part: their temperatures are of the coolant. */
const AIO_CHIP = /kraken|d5next|highflow|aquacomputer|quadro|octo|aquaero|farbwerk|corsair_cpro|commander|hydro|asetek|leakshield/i;

export function parseSensors(json: string): CoolingReadings {
  const out: CoolingReadings = { fans: [], coolant: [] };
  const chips = JSON.parse(json) as Record<string, Record<string, unknown>>;
  for (const [chip, features] of Object.entries(chips ?? {})) {
    if (!features || typeof features !== 'object') continue;
    const device = chipName(chip);
    for (const [label, sub] of Object.entries(features)) {
      if (!sub || typeof sub !== 'object') continue;
      const keys = sub as Record<string, unknown>;
      const fanKey = Object.keys(keys).find((k) => /^fan\d+_input$/.test(k));
      const tempKey = Object.keys(keys).find((k) => /^temp\d+_input$/.test(k));
      if (fanKey) {
        const rpm = toNum(keys[fanKey]);
        if (rpm === undefined) continue;
        const name = /^fan\d+$/i.test(label) ? label.replace(/^fan/i, 'Fan ') : channelName(label);
        out.fans.push({ id: `sensors:${chip}:${label}`, kind: PUMP.test(label) ? 'pump' : 'fan', name, device, backend: 'sensors', rpm });
      } else if (tempKey && (COOLANT.test(label) || (AIO_CHIP.test(chip) && !/cpu|core|board|vrm|chipset/i.test(label)))) {
        const temp = toNum(keys[tempKey]);
        // A probe that isn't plugged in reads absurd values.
        if (temp === undefined || temp <= -50 || temp >= 125) continue;
        out.coolant.push({ id: `sensors:${chip}:${label}`, name: COOLANT.test(label) ? channelName(label) : 'Coolant', device, backend: 'sensors', temp });
      }
    }
  }
  return out;
}

/* ---------- LibreHardwareMonitor data.json ---------- */

interface LhmNode {
  Text?: string;
  Value?: string;
  RawValue?: string | number;
  Type?: string;
  SensorId?: string;
  Children?: LhmNode[];
}

/** The groups LibreHardwareMonitor puts sensors in, by type. */
const LHM_GROUP: Record<string, 'Fan' | 'Temperature' | 'Control' | 'other'> = {
  fans: 'Fan',
  temperatures: 'Temperature',
  controls: 'Control',
};
const LHM_OTHER_GROUPS = /^(?:voltages|clocks|load|powers|data|small data|throughput|levels|factors|flows|currents|timings|energy|noise|conductivities|humidities)$/i;

export function parseLhm(json: string): CoolingReadings {
  const out: CoolingReadings = { fans: [], coolant: [] };
  const root = JSON.parse(json) as LhmNode;
  const fans = new Map<string, FanReading>();
  const duties = new Map<string, number>();
  const walk = (n: LhmNode, hardware: string, group: string | undefined, path: string) => {
    const text = (n.Text ?? '').trim();
    const kids = n.Children ?? [];
    const isGroup = !!LHM_GROUP[text.toLowerCase()] || LHM_OTHER_GROUPS.test(text);
    if (kids.length) {
      // Groups stay out of the path: a fan and the control driving it share one.
      const p = isGroup ? path : `${path}/${text}`;
      for (const k of kids) walk(k, isGroup ? hardware : text || hardware, isGroup ? text.toLowerCase() : undefined, p);
      return;
    }
    const type = (n.Type && ['Fan', 'Temperature', 'Control'].includes(n.Type) ? n.Type : group ? LHM_GROUP[group] : undefined) ?? 'other';
    if (type === 'other') return;
    const v = toNum(n.RawValue ?? n.Value);
    if (v === undefined) return;
    const device = shortDevice(hardware);
    const key = `${path}:${text}`;
    if (type === 'Fan') fans.set(key, { id: `lhm:${n.SensorId ?? key}`, kind: PUMP.test(text) ? 'pump' : 'fan', name: text.replace(/\s*#\s*/, ' '), device, backend: 'lhm', rpm: v });
    else if (type === 'Control') duties.set(key, v);
    else if (COOLANT.test(text) || (AIO_CHIP.test(hardware) && !/cpu|core|board/i.test(text))) out.coolant.push({ id: `lhm:${n.SensorId ?? key}`, name: COOLANT.test(text) ? channelName(text) : 'Coolant', device, backend: 'lhm', temp: v });
  };
  walk(root, 'LibreHardwareMonitor', undefined, '');
  // A control has the name of the fan it drives, in the same hardware.
  for (const [key, f] of fans) {
    const d = duties.get(key);
    if (d !== undefined) f.duty = d;
  }
  out.fans.push(...fans.values());
  return out;
}

/* ---------- Levels ---------- */

export type Level = 'normal' | 'warn' | 'alert';

export interface CoolingThresholds {
  /** Coolant, °C: amber from `tempWarn`, red from `tempAlert`. */
  tempWarn: number;
  tempAlert: number;
  /** Pump, rpm: amber under `pumpWarn`, red under `pumpAlert`. */
  pumpWarn: number;
  pumpAlert: number;
}

export const DEFAULT_COOLING_THRESHOLDS: CoolingThresholds = { tempWarn: 40, tempAlert: 45, pumpWarn: 800, pumpAlert: 300 };

export function coolantLevel(c: number | undefined, t: CoolingThresholds): Level {
  return c === undefined ? 'normal' : c >= t.tempAlert ? 'alert' : c >= t.tempWarn ? 'warn' : 'normal';
}

/** A pump that slows down is the one that fails: under `pumpAlert` rpm it's red. */
export function fanLevel(f: FanReading, t: CoolingThresholds): Level {
  if (f.kind !== 'pump' || f.rpm === undefined) return 'normal';
  return f.rpm < t.pumpAlert ? 'alert' : f.rpm < t.pumpWarn ? 'warn' : 'normal';
}

export const worst = (...l: Level[]): Level => (l.includes('alert') ? 'alert' : l.includes('warn') ? 'warn' : 'normal');

/** What the widget shows of a snapshot: through its `sensors` filter, stopped fans left out unless asked. */
export function selectCooling(s: CoolingSnapshot | undefined, filter: Filter, hideStopped: boolean): CoolingReadings {
  if (!s?.available) return { fans: [], coolant: [] };
  const passes = (r: { name: string; device: string }) => matchFilter([r.name, r.device, `${r.device}/${r.name}`], filter);
  return {
    // A stopped pump is never hidden: it's the alarm.
    fans: s.fans.filter((f) => passes(f) && !(hideStopped && f.kind === 'fan' && !f.rpm)),
    coolant: s.coolant.filter(passes),
  };
}

export function coolingLevel(r: CoolingReadings, t: CoolingThresholds): Level {
  return worst(...r.coolant.map((c) => coolantLevel(c.temp, t)), ...r.fans.map((f) => fanLevel(f, t)));
}

/* ---------- Reading ---------- */

export interface CoolingOptions {
  /** liquidctl's executable; empty: don't run it. */
  liquidctl: string;
  /** lm-sensors' `sensors`; empty: don't run it. Linux only. */
  lmSensors: string;
  /** LibreHardwareMonitor's web server; empty: http://localhost:8085 on Windows, off elsewhere. */
  lhmUrl: string;
}

export type Runner = (argv: string[], signal?: AbortSignal) => Promise<string>;

export interface CoolingDeps {
  run: Runner;
  fetch: typeof fetch;
  platform: NodeJS.Platform;
}

/** An error saying the tool isn't there, as opposed to the tool failing. */
export class MissingTool extends Error {}

export const defaultRunner: Runner = (argv, signal) =>
  new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { timeout: 10_000, maxBuffer: 4_000_000, signal, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new MissingTool(`${argv[0]} not found`));
      // liquidctl exits 1 when it finds no device: that's an answer, not a failure.
      if (/no device matches/i.test(String(stderr))) return resolve('[]');
      reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
    });
  });

export const DEFAULT_COOLING_DEPS: CoolingDeps = { run: defaultRunner, fetch: (...a) => fetch(...a), platform: process.platform };

export const LHM_DEFAULT = 'http://localhost:8085';

/** `http://host:8085` → `http://host:8085/data.json`; a URL that already names a file is kept. */
export function lhmDataUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  return /\.json(?:\?.*)?$/i.test(u) ? u : `${u}/data.json`;
}

export const TEXT = {
  nothing: { en: 'no fan, pump or coolant sensor found ({tried})', es: 'no se encuentra ningún ventilador, bomba ni sensor de líquido ({tried})', de: 'kein Lüfter, keine Pumpe und kein Kühlmittelsensor gefunden ({tried})', 'zh-Hant': '找不到風扇、水泵或冷卻液感測器（{tried}）', 'zh-Hans': '找不到风扇、水泵或冷却液传感器（{tried}）' },
  noTool: { en: 'no cooling tool set (liquidctl, sensors or LibreHardwareMonitor)', es: 'ninguna herramienta de refrigeración configurada (liquidctl, sensors o LibreHardwareMonitor)', de: 'kein Kühlungswerkzeug eingestellt (liquidctl, sensors oder LibreHardwareMonitor)', 'zh-Hant': '未設定任何散熱工具（liquidctl、sensors 或 LibreHardwareMonitor）', 'zh-Hans': '未设置任何散热工具（liquidctl、sensors 或 LibreHardwareMonitor）' },
} satisfies Record<string, Localized>;

const fillAll = (l: Localized, vars: Record<string, string>): Localized => {
  const f = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  return typeof l === 'string' ? f(l) : (Object.fromEntries(Object.entries(l).map(([k, v]) => [k, f(v as string)])) as Localized);
};

/** Runs every tool that is set (at once), keeps what answered, and says why when none did. */
export async function readCooling(o: CoolingOptions, d: CoolingDeps, signal: AbortSignal | undefined, now: number): Promise<CoolingSnapshot> {
  const jobs: [CoolingBackend, () => Promise<CoolingReadings>][] = [];
  if (o.liquidctl.trim()) jobs.push(['liquidctl', async () => parseLiquidctl(await d.run([o.liquidctl.trim(), 'status', '--json'], signal))]);
  if (o.lmSensors.trim() && d.platform === 'linux') jobs.push(['sensors', async () => parseSensors(await d.run([o.lmSensors.trim(), '-j'], signal))]);
  const lhm = o.lhmUrl.trim() || (d.platform === 'win32' ? LHM_DEFAULT : '');
  if (lhm)
    jobs.push([
      'lhm',
      async () => {
        const res = await d.fetch(lhmDataUrl(lhm), { signal: signal ?? AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error(`LibreHardwareMonitor: HTTP ${res.status}`);
        return parseLhm(await res.text());
      },
    ]);
  if (!jobs.length) return { available: false, reason: 'no cooling tool set', reasonText: TEXT.noTool, backends: [], fans: [], coolant: [], at: now };
  const results = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const snap: CoolingSnapshot = { available: false, backends: [], fans: [], coolant: [], at: now };
  const errors: string[] = [];
  results.forEach((r, i) => {
    const name = jobs[i]![0];
    if (r.status === 'rejected') {
      errors.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return;
    }
    snap.backends.push(name);
    snap.fans.push(...r.value.fans);
    snap.coolant.push(...r.value.coolant);
  });
  snap.available = snap.fans.length + snap.coolant.length > 0;
  if (!snap.available) {
    const tried = errors.length ? errors.join('; ') : jobs.map(([n]) => n).join(', ');
    snap.reason = `no fan, pump or coolant sensor found (${tried})`;
    snap.reasonText = fillAll(TEXT.nothing, { tried });
  }
  return snap;
}
