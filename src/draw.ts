/**
 * Painting. The normal state is darkness: figures in ink, curves and labels
 * dim or faint. Amber and red appear only past the thresholds: a game that
 * drops under its FPS, a stutter in the curve, warm coolant, a slowing pump.
 */
import type { Graphics, Localized, RenderContext, ThemeColors } from '@kiosko/sdk';
import { coolantLevel, fanLevel, type CoolingReadings, type CoolingThresholds } from './cooling.ts';
import { fpsLevel, frameLevel, median, type FpsThresholds, type Level } from './frames.ts';
import type { CoolantReading, FanReading, FrameSnapshot } from './types.ts';

type Ctx = Pick<RenderContext<unknown, unknown>, 'box' | 'theme' | 'kit' | 't' | 'now'>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

export const TEXT = {
  fps: { en: 'fps', es: 'fps', de: 'fps', 'zh-Hant': 'fps', 'zh-Hans': 'fps' },
  avg: { en: 'average', es: 'media', de: 'Schnitt', 'zh-Hant': '平均', 'zh-Hans': '平均' },
  low1: { en: '1% low', es: '1% bajo', de: '1% Tief', 'zh-Hant': '1% 低', 'zh-Hans': '1% 低' },
  frameTime: { en: 'frame time', es: 'tiempo de fotograma', de: 'Frametime', 'zh-Hant': '影格時間', 'zh-Hans': '帧时间' },
  worst: { en: 'worst {ms} ms', es: 'peor {ms} ms', de: 'max. {ms} ms', 'zh-Hant': '最慢 {ms} ms', 'zh-Hans': '最慢 {ms} ms' },
  noGame: { en: 'no game running', es: 'ningún juego en marcha', de: 'kein Spiel läuft', 'zh-Hant': '沒有執行中的遊戲', 'zh-Hans': '没有正在运行的游戏' },
  noFrames: { en: 'no frame data (needs the gaming/frames source)', es: 'sin datos de fotogramas (necesita la fuente gaming/frames)', de: 'keine Frame-Daten (braucht die Datenquelle gaming/frames)', 'zh-Hant': '無影格資料（需要 gaming/frames 資料來源）', 'zh-Hans': '无帧数据（需要 gaming/frames 数据源）' },
  noCooling: { en: 'no cooling data (needs the gaming/cooling source)', es: 'sin datos de refrigeración (necesita la fuente gaming/cooling)', de: 'keine Kühlungsdaten (braucht die Datenquelle gaming/cooling)', 'zh-Hant': '無散熱資料（需要 gaming/cooling 資料來源）', 'zh-Hans': '无散热数据（需要 gaming/cooling 数据源）' },
  noMatch: { en: 'no sensor matches the filter', es: 'ningún sensor coincide con el filtro', de: 'kein Sensor passt zum Filter', 'zh-Hant': '沒有符合篩選條件的感測器', 'zh-Hans': '没有符合筛选条件的传感器' },
  more: { en: '+{n} more', es: '+{n} más', de: '+{n} weitere', 'zh-Hant': '還有 {n} 個', 'zh-Hans': '还有 {n} 个' },
  rpm: { en: 'rpm', es: 'rpm', de: 'U/min', 'zh-Hant': '轉/分', 'zh-Hans': '转/分' },
  duty: { en: 'duty', es: 'carga', de: 'Last', 'zh-Hant': '負載', 'zh-Hans': '负载' },
} satisfies Record<string, Localized>;

/** The words the tools start channel names with, in the user's language. */
const CHANNEL: Record<string, Localized> = {
  pump: { en: 'Pump', es: 'Bomba', de: 'Pumpe', 'zh-Hant': '水泵', 'zh-Hans': '水泵' },
  fan: { en: 'Fan', es: 'Ventilador', de: 'Lüfter', 'zh-Hant': '風扇', 'zh-Hans': '风扇' },
  liquid: { en: 'Liquid', es: 'Líquido', de: 'Flüssigkeit', 'zh-Hant': '冷卻液', 'zh-Hans': '冷却液' },
  water: { en: 'Water', es: 'Agua', de: 'Wasser', 'zh-Hant': '水溫', 'zh-Hans': '水温' },
  coolant: { en: 'Coolant', es: 'Líquido', de: 'Kühlmittel', 'zh-Hant': '冷卻液', 'zh-Hans': '冷却液' },
};

/** `Fan 2` → `Ventilador 2`; names of the user's own (`Chassis 1`, `AIO Pump`) stay. */
export function channelLabel(name: string, t: (l: Localized) => string): string {
  const m = /^(pump|fan|liquid|water|coolant)\b(.*)$/i.exec(name);
  return m ? `${t(CHANNEL[m[1]!.toLowerCase()]!)}${m[2]}` : name;
}

export function levelColor(l: Level, c: ThemeColors, normal = c.inkDim): string {
  return l === 'alert' ? c.alert : l === 'warn' ? c.warn : normal;
}

/** Why there's nothing to draw, faint, wrapped in the box. */
function drawMessage(g: Graphics, ctx: Ctx, msg: string): void {
  const { box, kit, theme } = ctx;
  const size = Math.max(10, Math.round(clamp(box.h / 16, 10, 18)));
  const lines = kit.wrapLines(g, msg, box.w, Math.max(1, Math.floor(box.h / (size * 1.25))), { size, family: theme.fonts.mono });
  lines.forEach((l, i) => kit.drawTracked(g, l, box.x, box.y + size * 1.2 * (i + 1), { size, family: theme.fonts.mono, color: theme.colors.inkFaint }));
}

const fpsText = (v: number | undefined) => (v === undefined ? '–' : String(Math.round(v)));

/* ---------- gaming/fps ---------- */

export interface FpsDrawOptions extends FpsThresholds {
  frames: number;
  showGame: boolean;
}

export function drawFps(g: Graphics, ctx: Ctx, s: FrameSnapshot | undefined, o: FpsDrawOptions): void {
  const { box, kit, theme, t } = ctx;
  if (!s) return drawMessage(g, ctx, t(TEXT.noFrames));
  if (!s.running) return drawMessage(g, ctx, s.reasonText ? t(s.reasonText) : s.reason ? `${t(TEXT.noGame)} · ${s.reason}` : t(TEXT.noGame));
  const c = theme.colors;
  const f = theme.fonts;
  const level = fpsLevel(s.fps, o);
  const lowLevel = fpsLevel(s.low1, o);

  // A strip too small for a curve: one line.
  if (box.h < 70 || box.w < 150) {
    const size = kit.fitSize(g, `${fpsText(s.fps)} fps · 1% ${fpsText(s.low1)}`, box.w, { size: Math.min(box.h * 0.6, 40), family: f.monoBold }, 9);
    const y = box.y + box.h / 2 + size * 0.36;
    const w = kit.drawTracked(g, fpsText(s.fps), box.x, y, { size, family: f.monoBold, color: levelColor(level, c, c.ink) });
    kit.drawClipped(g, ` ${t(TEXT.fps)} · ${t(TEXT.low1)} ${fpsText(s.low1)}`, box.x + w, y, box.w - w, { size: size * 0.6, family: f.mono, color: levelColor(lowLevel, c, c.inkDim) });
    return;
  }

  const wide = box.w >= box.h * 1.45;
  const statW = wide ? clamp(box.h * 1.05, 150, box.w * 0.42) : box.w;
  const statH = wide ? box.h : clamp(box.h * 0.46, 70, box.h - 50);
  const sc = clamp(Math.min(statW / 260, statH / 230), 0.45, 2.2);
  const label = { size: Math.max(9, Math.round(13 * sc)), family: f.sansBold, tracking: 2 * sc, smallCaps: true, color: c.inkFaint };

  // The game's name, the big average and the 1 % low, as one block centred in its room.
  const nameH = o.showGame && s.game && statH > 110 ? label.size * 1.9 : 0;
  const avgText = fpsText(s.fps);
  // The 1 % low is a third of the average's size; between them, a fifth of it.
  const bigFit = (statH - nameH) / (0.78 + 0.2 + 0.36 * 0.78);
  const big = kit.fitSize(g, avgText, statW * 0.68, { size: Math.min(bigFit, 200 * sc), family: f.monoBold, tracking: -1 * sc }, 14);
  const low = Math.max(11, Math.round(big * 0.36));
  const blockH = nameH + big * 0.78 + big * 0.2 + low * 0.78;
  let y = box.y + Math.max(0, (statH - blockH) / 2);
  if (nameH) {
    y += label.size;
    kit.drawClipped(g, s.game!, box.x, y, statW, { ...label, color: c.inkDim });
    y += nameH - label.size;
  }
  y += big * 0.78;
  const bw = kit.drawTracked(g, avgText, box.x, y, { size: big, family: f.monoBold, tracking: -1 * sc, color: levelColor(level, c, c.ink) });
  // Beside it: "FPS" over "average".
  const unit = { ...label, size: Math.max(10, Math.round(big * 0.17)) };
  const ux = box.x + bw + Math.max(6, big * 0.08);
  const uw = Math.max(0, box.x + statW - ux);
  kit.drawClipped(g, t(TEXT.fps), ux, y - big * 0.78 + unit.size * 1.1, uw, { ...unit, color: c.inkDim });
  kit.drawClipped(g, t(TEXT.avg), ux, y - big * 0.78 + unit.size * 1.1 + label.size * 1.5, uw, label);
  y += big * 0.2 + low * 0.78;
  const lw = kit.drawTracked(g, fpsText(s.low1), box.x, y, { size: low, family: f.monoBold, color: levelColor(lowLevel, c, c.inkDim) });
  kit.drawClipped(g, t(TEXT.low1), box.x + lw + Math.max(6, low * 0.25), y, Math.max(0, statW - lw - low * 0.25), { ...label, size: Math.max(9, Math.round(low * 0.42)) });

  // The frame-time curve.
  const gap = Math.round(clamp(16 * sc, 8, 28));
  const area = wide ? { x: box.x + statW + gap, y: box.y, w: box.w - statW - gap, h: box.h } : { x: box.x, y: box.y + statH + gap, w: box.w, h: box.h - statH - gap };
  if (area.w >= 60 && area.h >= 30) drawCurve(g, ctx, s.frameTimes.slice(-o.frames), o, area);
}

function drawCurve(g: Graphics, ctx: Ctx, ms: number[], o: FpsThresholds, r: { x: number; y: number; w: number; h: number }): void {
  const { kit, theme, t } = ctx;
  const c = theme.colors;
  const f = theme.fonts;
  const sc = clamp(Math.min(r.w / 600, r.h / 200), 0.5, 1.8);
  const lbl = { size: Math.max(10, Math.round(13 * sc)), family: f.sansBold, tracking: 2 * sc, smallCaps: true, color: c.inkFaint };
  const footH = r.h >= 80 ? Math.round(lbl.size * 1.7) : 0;
  const ch = r.h - footH;
  const cx = r.x;
  const cw = r.w;
  g.fillStyle = c.bg;
  g.fillRect(cx, r.y, cw, ch);
  const n = ms.length;
  const med = median(ms) ?? 16.7;
  // The scale: the usual frame at 40 % of the height, so a stutter stands out above it.
  const yMax = Math.max(med * 2.5, 2);
  const py = (v: number) => r.y + ch - (clamp(v, 0, yMax) / yMax) * (ch - 2);
  // The thresholds, faint and dashed, with their FPS.
  g.setLineDash([4, 4]);
  g.lineWidth = 1;
  for (const [fps, color] of [
    [o.fpsWarn, c.warn],
    [o.fpsAlert, c.alert],
  ] as const) {
    const v = 1000 / fps;
    if (v > yMax) continue;
    const yy = Math.round(py(v)) + 0.5;
    g.strokeStyle = c.surfaceEdge;
    g.beginPath();
    g.moveTo(cx, yy);
    g.lineTo(cx + cw, yy);
    g.stroke();
    if (ch > 50) kit.drawTracked(g, `${fps}`, cx + cw - 4, yy - 3, { size: Math.max(9, Math.round(11 * sc)), family: f.mono, color: color, align: 'right' });
  }
  g.setLineDash([]);
  if (n >= 2) {
    const px = (i: number) => cx + (i / (n - 1)) * cw;
    g.save();
    g.beginPath();
    g.rect(cx, r.y, cw, ch);
    g.clip();
    // Area under the curve, faint; the curve, dim; stutters as bars of their colour.
    g.globalAlpha = 0.45;
    g.fillStyle = c.inkFaint;
    g.beginPath();
    g.moveTo(cx, r.y + ch);
    ms.forEach((v, i) => g.lineTo(px(i), py(v)));
    g.lineTo(cx + cw, r.y + ch);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = c.inkDim;
    g.lineWidth = Math.max(1, 1.6 * sc);
    g.lineJoin = 'round';
    g.beginPath();
    ms.forEach((v, i) => (i ? g.lineTo(px(i), py(v)) : g.moveTo(px(i), py(v))));
    g.stroke();
    const bar = Math.max(2, Math.min(6 * sc, cw / n));
    ms.forEach((v, i) => {
      const l = frameLevel(v, o);
      if (l === 'normal') return;
      g.fillStyle = levelColor(l, c);
      g.fillRect(Math.round(px(i) - bar / 2), py(v), Math.ceil(bar), r.y + ch - py(v));
    });
    g.restore();
  }
  g.strokeStyle = c.surfaceEdge;
  g.lineWidth = 1;
  g.strokeRect(cx + 0.5, r.y + 0.5, cw - 1, ch - 1);
  if (footH) {
    const fy = r.y + ch + lbl.size * 1.35;
    const worst = n ? Math.max(...ms) : 0;
    const right = n ? fill(t(TEXT.worst), { ms: worst >= 100 ? Math.round(worst) : worst.toFixed(1) }) : '';
    const rw = right ? kit.drawTracked(g, right, cx + cw, fy, { ...lbl, color: levelColor(frameLevel(worst, o), c, c.inkFaint), align: 'right' }) : 0;
    kit.drawClipped(g, `${t(TEXT.frameTime)} · ${med.toFixed(1)} ms`, cx, fy, Math.max(0, cw - rw - 12), lbl);
  }
}

/* ---------- gaming/cooling ---------- */

type Cell = { kind: 'coolant'; r: CoolantReading } | { kind: 'fan'; r: FanReading } | { kind: 'more'; n: number };

/** The grid that makes the cells biggest: rows and columns for `n` cells in w×h. */
export function grid(n: number, w: number, h: number, cellW: number, cellH: number, gap: number): { rows: number; cols: number; scale: number } {
  let best = { rows: 1, cols: Math.max(1, n), scale: 0 };
  for (let rows = 1; rows <= Math.max(1, n); rows++) {
    const cols = Math.ceil(n / rows);
    const s = Math.min((w - gap * (cols - 1)) / cols / cellW, (h - gap * (rows - 1)) / rows / cellH);
    if (s > best.scale) best = { rows, cols, scale: s };
  }
  return best;
}

export function drawCooling(g: Graphics, ctx: Ctx, rd: CoolingReadings | undefined, th: CoolingThresholds, reason: string | undefined): void {
  const { box, t } = ctx;
  if (!rd) return drawMessage(g, ctx, reason ?? t(TEXT.noCooling));
  const all: Cell[] = [
    ...rd.coolant.map((r): Cell => ({ kind: 'coolant', r })),
    ...rd.fans.filter((f) => f.kind === 'pump').map((r): Cell => ({ kind: 'fan', r })),
    ...rd.fans.filter((f) => f.kind === 'fan').map((r): Cell => ({ kind: 'fan', r })),
  ];
  if (!all.length) return drawMessage(g, ctx, reason ?? t(TEXT.noMatch));
  const gap = Math.round(clamp(box.h / 24, 6, 18));
  const CW = 200;
  const CH = 118;
  let cells = all;
  let fit = grid(cells.length, box.w, box.h, CW, CH, gap);
  // Too many to read: as many as fit at a readable size, the last saying how many more.
  while (fit.scale < 0.42 && cells.length > 2) {
    const keep = (cells[cells.length - 1]!.kind === 'more' ? cells.length - 1 : cells.length) - 1;
    cells = [...all.slice(0, keep), { kind: 'more', n: all.length - keep }];
    fit = grid(cells.length, box.w, box.h, CW, CH, gap);
  }
  const cw = (box.w - gap * (fit.cols - 1)) / fit.cols;
  const chh = (box.h - gap * (fit.rows - 1)) / fit.rows;
  // Two channels of the same name (each AIO has its "Pump"): say whose each is.
  const names = new Map<string, number>();
  for (const r of [...rd.coolant, ...rd.fans]) names.set(r.name.toLowerCase(), (names.get(r.name.toLowerCase()) ?? 0) + 1);
  cells.forEach((cell, i) => {
    const r = { x: box.x + (i % fit.cols) * (cw + gap), y: box.y + Math.floor(i / fit.cols) * (chh + gap), w: cw, h: chh };
    // Big digits overhang their left edge by a pixel or two: keep each cell to itself.
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    drawCell(g, ctx, cell, r, th, cell.kind !== 'more' && (names.get(cell.r.name.toLowerCase()) ?? 0) > 1);
    g.restore();
  });
}

function drawCell(g: Graphics, ctx: Ctx, cell: Cell, r: { x: number; y: number; w: number; h: number }, th: CoolingThresholds, showDevice: boolean): void {
  const { kit, theme, t } = ctx;
  const c = theme.colors;
  const f = theme.fonts;
  const s = clamp(Math.min(r.w / 200, r.h / 118), 0.35, 2.4);
  const label = { size: Math.max(9, Math.round(13 * s)), family: f.sansBold, tracking: 1.8 * s, smallCaps: true, color: c.inkFaint };
  if (cell.kind === 'more') {
    kit.drawClipped(g, fill(t(TEXT.more), { n: cell.n }), r.x, r.y + r.h / 2 + label.size * 0.4, r.w, { ...label, color: c.inkDim });
    return;
  }
  const level = cell.kind === 'coolant' ? coolantLevel(cell.r.temp, th) : fanLevel(cell.r, th);
  const color = levelColor(level, c, c.inkDim);
  // Title row: icon and the channel's name.
  const icon = label.size * 1.1;
  const ty = r.y + label.size * 1.05;
  const iconColor = level === 'normal' ? c.inkFaint : color;
  if (cell.kind === 'coolant') drawDrop(g, r.x + icon / 2, ty - label.size * 0.42, icon, iconColor);
  else if (cell.r.kind === 'pump') drawPump(g, r.x + icon / 2, ty - label.size * 0.4, icon, iconColor);
  else drawFanIcon(g, r.x + icon / 2, ty - label.size * 0.4, icon, iconColor);
  const tx = r.x + icon + 6 * s;
  const title = showDevice ? `${channelLabel(cell.r.name, t)} · ${cell.r.device}` : channelLabel(cell.r.name, t);
  kit.drawClipped(g, title, tx, ty, r.w - icon - 6 * s, { ...label, color: level === 'normal' ? c.inkDim : color });

  // The figure, and under it the duty when the controller says.
  const duty = cell.kind === 'fan' ? cell.r.duty : undefined;
  const dutyH = duty !== undefined && r.h > 60 ? label.size * 1.3 + Math.max(3, Math.round(5 * s)) + 6 * s : 0;
  const room = r.y + r.h - ty - dutyH - 6 * s;
  const value = cell.kind === 'coolant' ? cell.r.temp.toFixed(1) : cell.r.rpm === undefined ? '–' : String(Math.round(cell.r.rpm));
  const unit = cell.kind === 'coolant' ? '°C' : t(TEXT.rpm);
  const unitSize = Math.max(9, Math.round(15 * s));
  const uw = kit.measureTracked(g, unit, { size: unitSize, family: f.mono });
  const big = kit.fitSize(g, value, Math.max(10, r.w - uw - 8 * s), { size: Math.min(room / 0.95, 62 * s), family: f.monoBold, tracking: -0.5 * s }, 10);
  const vy = ty + 6 * s + big * 0.8;
  const valueColor = level === 'normal' ? (cell.kind === 'coolant' ? c.ink : c.inkDim) : color;
  const vw = kit.drawTracked(g, value, r.x, vy, { size: big, family: f.monoBold, tracking: -0.5 * s, color: valueColor });
  kit.drawClipped(g, unit, r.x + vw + 5 * s, vy, Math.max(0, r.w - vw - 5 * s), { size: unitSize, family: f.mono, color: c.inkFaint });
  if (!dutyH) return;
  const d = clamp(duty!, 0, 100);
  const ly = vy + big * 0.2 + label.size * 1.1;
  const dw = kit.drawTracked(g, `${Math.round(d)}%`, r.x + r.w, ly, { size: label.size, family: f.mono, color: c.inkDim, align: 'right' });
  kit.drawClipped(g, t(TEXT.duty), r.x, ly, Math.max(0, r.w - dw - 8 * s), label);
  const bh = Math.max(3, Math.round(5 * s));
  const by = ly + 5 * s;
  g.fillStyle = c.bg;
  g.fillRect(r.x, by, r.w, bh);
  g.fillStyle = level === 'normal' ? c.inkFaint : color;
  g.fillRect(r.x, by, Math.max(d > 0 ? 2 : 0, Math.round((r.w * d) / 100)), bh);
}

/* ---------- Icons, drawn: the fonts have no emoji ---------- */

function drawFanIcon(g: Graphics, x: number, y: number, size: number, color: string): void {
  const rr = size / 2;
  g.save();
  g.translate(x, y);
  g.fillStyle = color;
  for (let k = 0; k < 3; k++) {
    g.rotate((Math.PI * 2) / 3);
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(rr * 0.2, -rr * 0.5, rr * 0.9, -rr * 0.7, rr * 0.95, -rr * 0.1);
    g.bezierCurveTo(rr * 0.6, rr * 0.05, rr * 0.25, 0, 0, 0);
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0, rr * 0.18, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawDrop(g: Graphics, x: number, y: number, size: number, color: string): void {
  const rr = size * 0.32;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x, y - size * 0.5);
  g.bezierCurveTo(x + rr * 0.4, y - size * 0.2, x + rr, y, x + rr, y + rr * 0.45);
  g.arc(x, y + rr * 0.45, rr, 0, Math.PI);
  g.bezierCurveTo(x - rr, y, x - rr * 0.4, y - size * 0.2, x, y - size * 0.5);
  g.fill();
}

function drawPump(g: Graphics, x: number, y: number, size: number, color: string): void {
  const rr = size * 0.46;
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, size * 0.12);
  g.beginPath();
  g.arc(x, y, rr, 0, Math.PI * 2);
  g.stroke();
  drawDrop(g, x, y + size * 0.05, size * 0.62, color);
}
