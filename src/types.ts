/**
 * What the two sources hand over. Both are plain data, cloned to every
 * widget that reads them: what a tool can't tell is left out and simply not
 * painted.
 */
import type { Localized } from '@kiosko/sdk';

export const FRAMES_SOURCE = 'gaming/frames';
export const COOLING_SOURCE = 'gaming/cooling';

/* ---------- gaming/frames ---------- */

export type FrameBackend = 'mangohud' | 'presentmon';

export interface FrameSnapshot {
  /** A game is presenting frames right now (fresh data within the source's `staleMs`). */
  running: boolean;
  /** The tool the frames came from. */
  backend?: FrameBackend;
  /** The game, as the tool names it (MangoHud: the log's name, PresentMon: the executable). */
  game?: string;
  /** Average FPS over the source's window. */
  fps?: number;
  /** 1 % low: the average FPS of the slowest 1 % of frames in the window. */
  low1?: number;
  /** The last frame times, ms, oldest first. Empty while no game runs. */
  frameTimes: number[];
  /** Why there can't be frames (the tool is missing, the folder doesn't exist), in English. */
  reason?: string;
  /** The same in the user's language, when it's something they can act on. */
  reasonText?: Localized;
  at: number;
}

export function framesOf(sources: Record<string, unknown>): FrameSnapshot | undefined {
  const v = sources[FRAMES_SOURCE];
  return v && typeof v === 'object' && Array.isArray((v as FrameSnapshot).frameTimes) ? (v as FrameSnapshot) : undefined;
}

/* ---------- gaming/cooling ---------- */

export type CoolingBackend = 'liquidctl' | 'sensors' | 'lhm';

export interface FanReading {
  /** Stable across reads: backend, device and channel. */
  id: string;
  kind: 'fan' | 'pump';
  /** The channel (`Pump`, `Fan 1`, `Chassis 2`). */
  name: string;
  /** The device it belongs to, short (`NZXT Kraken X`, `nct6799`). */
  device: string;
  backend: CoolingBackend;
  rpm?: number;
  /** Duty, 0..100 %, when the controller says. */
  duty?: number;
}

export interface CoolantReading {
  id: string;
  /** `Liquid`, `Water`, `Coolant`. */
  name: string;
  device: string;
  backend: CoolingBackend;
  /** °C. */
  temp: number;
}

export interface CoolingSnapshot {
  /** False when none of the tools answered. */
  available: boolean;
  reason?: string;
  reasonText?: Localized;
  /** The tools that answered. */
  backends: CoolingBackend[];
  fans: FanReading[];
  coolant: CoolantReading[];
  at: number;
}

export function coolingOf(sources: Record<string, unknown>): CoolingSnapshot | undefined {
  const v = sources[COOLING_SOURCE];
  return v && typeof v === 'object' && Array.isArray((v as CoolingSnapshot).fans) ? (v as CoolingSnapshot) : undefined;
}
