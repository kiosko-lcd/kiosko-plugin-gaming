/**
 * The game on the panel: FPS and frame times while one runs (MangoHud on
 * Linux, PresentMon on Windows), and the cooling that keeps it going (fans,
 * pumps and coolant from liquidctl, lm-sensors or LibreHardwareMonitor).
 * Two shared sources, two widgets and a "Gaming" page.
 */
import { defineSource, definePlugin, defineWidget, t, type Filter } from '@kiosko/sdk';
import { DEFAULT_COOLING_DEPS, coolingLevel, readCooling, selectCooling, type CoolingDeps, type CoolingThresholds } from './cooling.ts';
import { drawCooling, drawFps } from './draw.ts';
import { DEFAULT_FRAME_DEPS, FrameReader, type FrameDeps } from './frame-reader.ts';
import { frameStats, lastWindow, type FpsThresholds } from './frames.ts';
import { COOLING_SOURCE, FRAMES_SOURCE, coolingOf, framesOf, type CoolingSnapshot, type FrameSnapshot } from './types.ts';

export type { CoolantReading, CoolingSnapshot, FanReading, FrameSnapshot } from './types.ts';
export { parseLhm, parseLiquidctl, parseSensors, readCooling } from './cooling.ts';
export { parseMangoHudCsv, parsePresentMonCsv, frameStats } from './frames.ts';
export { FrameReader } from './frame-reader.ts';

/* ---------- Demo: a 7800X3D and a 7900 XTX at 1440p, an AIO and three case fans ---------- */

/** Frame times of a game near 120 FPS, with the small stutters of a busy street and one real hitch. Deterministic. */
export function demoFrameTimes(n = 1000): number[] {
  let seed = 20_261_121;
  const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  return Array.from({ length: n }, (_, i) => {
    const k = i / n;
    // A slow swell (a crowded part of the map), the frame-to-frame jitter and the odd shader compile.
    const base = 8.1 + 1.3 * Math.sin(k * Math.PI * 3) ** 2;
    const jitter = (rnd() - 0.5) * 1.4;
    const spike = i === Math.round(n * 0.62) ? 34 : i === Math.round(n * 0.83) ? 21.5 : rnd() < 0.008 ? 6 + rnd() * 5 : 0;
    return Math.round((base + jitter + spike) * 100) / 100;
  });
}

export function demoFrames(now: number): FrameSnapshot {
  const ms = demoFrameTimes();
  return { running: true, backend: 'mangohud', game: 'Cyberpunk2077', ...frameStats(lastWindow(ms, 30_000)), frameTimes: ms, at: now };
}

export function demoCooling(now: number): CoolingSnapshot {
  const kraken = 'NZXT Kraken Elite';
  return {
    available: true,
    backends: ['liquidctl', 'sensors'],
    coolant: [{ id: 'liquidctl:kraken:Liquid', name: 'Liquid', device: kraken, backend: 'liquidctl', temp: 33.4 }],
    fans: [
      { id: 'liquidctl:kraken:Pump', kind: 'pump', name: 'Pump', device: kraken, backend: 'liquidctl', rpm: 2650, duty: 70 },
      { id: 'liquidctl:kraken:Fan', kind: 'fan', name: 'Fan', device: kraken, backend: 'liquidctl', rpm: 1240, duty: 45 },
      { id: 'sensors:nct6799:fan1', kind: 'fan', name: 'Rear', device: 'nct6799', backend: 'sensors', rpm: 870 },
      { id: 'sensors:nct6799:fan2', kind: 'fan', name: 'Front 1', device: 'nct6799', backend: 'sensors', rpm: 912 },
      { id: 'sensors:nct6799:fan3', kind: 'fan', name: 'Front 2', device: 'nct6799', backend: 'sensors', rpm: 905 },
    ],
    at: now,
  };
}

const LANGS = ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'];

/* ---------- gaming/frames ---------- */

const framesOptions = t.object({
  backend: t.enum(['auto', 'mangohud', 'presentmon'] as const, {
    label: { en: 'Tool', es: 'Herramienta', de: 'Werkzeug', 'zh-Hant': '工具', 'zh-Hans': '工具' },
    help: { en: 'auto: PresentMon on Windows, MangoHud elsewhere.', es: 'auto: PresentMon en Windows, MangoHud en el resto.', de: 'auto: PresentMon unter Windows, sonst MangoHud.', 'zh-Hant': 'auto：Windows 上用 PresentMon，其他系統用 MangoHud。', 'zh-Hans': 'auto：Windows 上用 PresentMon，其他系统用 MangoHud。' },
    labels: { auto: { en: 'Automatic', es: 'Automático', de: 'Automatisch', 'zh-Hant': '自動', 'zh-Hans': '自动' }, mangohud: 'MangoHud', presentmon: 'PresentMon' },
  }),
  mangohudFolder: t.string({
    default: '~/mangohud',
    format: 'path',
    risk: 'path',
    label: { en: 'MangoHud log folder', es: 'Carpeta de registros de MangoHud', de: 'MangoHud-Protokollordner', 'zh-Hant': 'MangoHud 記錄資料夾', 'zh-Hans': 'MangoHud 日志文件夹' },
    help: {
      en: "MangoHud's output_folder. In MangoHud.conf: output_folder=/home/you/mangohud, autostart_log=1 and log_interval=0 (every frame). The newest log there is followed while it grows.",
      es: 'El output_folder de MangoHud. En MangoHud.conf: output_folder=/home/tú/mangohud, autostart_log=1 y log_interval=0 (cada fotograma). Se sigue el registro más reciente mientras crece.',
      de: 'Der output_folder von MangoHud. In MangoHud.conf: output_folder=/home/du/mangohud, autostart_log=1 und log_interval=0 (jedes Frame). Das neueste Protokoll dort wird verfolgt, solange es wächst.',
      'zh-Hant': 'MangoHud 的 output_folder。在 MangoHud.conf 中設定：output_folder=/home/你/mangohud、autostart_log=1 與 log_interval=0（每個影格）。會跟隨其中最新的記錄檔增長。',
      'zh-Hans': 'MangoHud 的 output_folder。在 MangoHud.conf 中设置：output_folder=/home/你/mangohud、autostart_log=1 和 log_interval=0（每一帧）。会跟随其中最新的日志文件增长。',
    },
  }),
  presentmon: t.string({
    default: 'PresentMon',
    risk: 'exec',
    label: { en: 'PresentMon program', es: 'Programa PresentMon', de: 'PresentMon-Programm', 'zh-Hant': 'PresentMon 程式', 'zh-Hans': 'PresentMon 程序' },
    help: {
      en: 'PresentMon 2 (the console one), on the PATH or a full path. Run while the source runs, with its CSV on stdout. Needs an administrator or a member of Performance Log Users. Empty: don\'t run it.',
      es: 'PresentMon 2 (el de consola), en el PATH o con su ruta completa. Se ejecuta mientras la fuente funciona, con su CSV por la salida estándar. Necesita un administrador o un miembro de Performance Log Users. Vacío: no se ejecuta.',
      de: 'PresentMon 2 (die Konsolenversion), im PATH oder mit vollem Pfad. Läuft, solange die Datenquelle läuft, mit CSV auf stdout. Braucht einen Administrator oder ein Mitglied von „Leistungsprotokollbenutzer“. Leer: nicht starten.',
      'zh-Hant': 'PresentMon 2（主控台版），在 PATH 中或填完整路徑。資料來源運作時執行，CSV 輸出到標準輸出。需要系統管理員或 Performance Log Users 群組成員。留空：不執行。',
      'zh-Hans': 'PresentMon 2（控制台版），在 PATH 中或填完整路径。数据源运行时执行，CSV 输出到标准输出。需要管理员或 Performance Log Users 组成员。留空：不运行。',
    },
  }),
  presentmonCsv: t.string({
    format: 'path',
    risk: 'path',
    advanced: true,
    placeholder: 'C:\\PresentMon\\capture.csv',
    label: { en: 'PresentMon CSV file', es: 'Fichero CSV de PresentMon', de: 'PresentMon-CSV-Datei', 'zh-Hant': 'PresentMon CSV 檔', 'zh-Hans': 'PresentMon CSV 文件' },
    help: {
      en: 'Set, this file is followed while it grows (PresentMon --output_file) instead of running PresentMon.',
      es: 'Si se pone, se sigue este fichero mientras crece (PresentMon --output_file) en vez de ejecutar PresentMon.',
      de: 'Gesetzt, wird diese Datei verfolgt, solange sie wächst (PresentMon --output_file), statt PresentMon zu starten.',
      'zh-Hant': '設定後會跟隨此檔案的增長（PresentMon --output_file），而不執行 PresentMon。',
      'zh-Hans': '设置后会跟随此文件的增长（PresentMon --output_file），而不运行 PresentMon。',
    },
  }),
  windowMs: t.duration({
    default: 30_000,
    min: 2_000,
    max: 600_000,
    label: { en: 'Average over', es: 'Media de los últimos', de: 'Mittel über', 'zh-Hant': '平均時段', 'zh-Hans': '平均时段' },
    help: { en: 'Of play, for the average FPS and the 1 % low.', es: 'De juego, para los FPS medios y el 1 % bajo.', de: 'Spielzeit, für die mittleren FPS und das 1-%-Tief.', 'zh-Hant': '遊戲時間，用於計算平均 FPS 與 1% 低。', 'zh-Hans': '游戏时间，用于计算平均 FPS 和 1% 低。' },
  }),
  staleMs: t.duration({
    default: 5_000,
    min: 1_000,
    max: 120_000,
    advanced: true,
    label: { en: 'Game gone after', es: 'Juego cerrado tras', de: 'Spiel beendet nach', 'zh-Hant': '判定遊戲結束的時間', 'zh-Hans': '判定游戏结束的时间' },
    help: { en: 'Without a new frame for this long, no game is running.', es: 'Sin un fotograma nuevo durante este tiempo, no hay juego en marcha.', de: 'So lange ohne neues Frame: kein Spiel läuft.', 'zh-Hant': '這麼久沒有新影格，就視為沒有遊戲在執行。', 'zh-Hans': '这么久没有新帧，就视为没有游戏在运行。' },
  }),
});

/** Overridable for tests: the platform, the clock, the home folder and how PresentMon is started. */
export const frameDeps: FrameDeps = { ...DEFAULT_FRAME_DEPS };

/** How often the followed log or PresentMon's output is summed up. */
const FRAME_POLL_MS = 1_000;

export const frames = defineSource({
  id: 'frames',
  name: { en: 'Game frames', es: 'Fotogramas del juego', de: 'Spiel-Frames', 'zh-Hant': '遊戲影格', 'zh-Hans': '游戏帧' },
  description: {
    en: 'FPS, 1 % low and frame times of the game being played, from MangoHud (Linux) or PresentMon (Windows). Only while a game runs.',
    es: 'FPS, 1 % bajo y tiempos de fotograma del juego en marcha, de MangoHud (Linux) o PresentMon (Windows). Solo mientras hay un juego abierto.',
    de: 'FPS, 1-%-Tief und Frametimes des laufenden Spiels, von MangoHud (Linux) oder PresentMon (Windows). Nur solange ein Spiel läuft.',
    'zh-Hant': '正在遊玩的遊戲之 FPS、1% 低與影格時間，來自 MangoHud（Linux）或 PresentMon（Windows）。僅在遊戲執行時。',
    'zh-Hans': '正在玩的游戏的 FPS、1% 低和帧时间，来自 MangoHud（Linux）或 PresentMon（Windows）。仅在游戏运行时。',
  },
  options: framesOptions,
  watch(ctx, emit) {
    const reader = new FrameReader(ctx.options, frameDeps);
    let last = '';
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const snap = await reader.poll();
        // While nothing plays, only a change is worth a repaint.
        const key = snap.running ? String(snap.at) : JSON.stringify({ ...snap, at: 0 });
        if (key !== last) emit(snap);
        last = key;
      } catch (e) {
        ctx.log(`gaming/frames: ${(e as Error).message}`);
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(tick, FRAME_POLL_MS);
    return () => {
      clearInterval(timer);
      reader.stop();
    };
  },
  demo: ({ now }) => demoFrames(now),
});

/* ---------- gaming/cooling ---------- */

const coolingOptions = t.object({
  liquidctl: t.string({
    default: 'liquidctl',
    risk: 'exec',
    label: { en: 'liquidctl program', es: 'Programa liquidctl', de: 'liquidctl-Programm', 'zh-Hant': 'liquidctl 程式', 'zh-Hans': 'liquidctl 程序' },
    help: { en: 'Runs liquidctl status --json: AIO coolers and Corsair / NZXT controllers. Initialize them once (liquidctl initialize all) after boot if your device asks for it. Empty: off.', es: 'Ejecuta liquidctl status --json: AIO y controladores de Corsair / NZXT. Inicialízalos una vez (liquidctl initialize all) tras arrancar si tu aparato lo pide. Vacío: no se usa.', de: 'Führt liquidctl status --json aus: AIO-Kühler und Corsair-/NZXT-Controller. Nach dem Start einmal initialisieren (liquidctl initialize all), wenn dein Gerät das verlangt. Leer: aus.', 'zh-Hant': '執行 liquidctl status --json：一體式水冷與 Corsair / NZXT 控制器。若裝置需要，開機後先初始化一次（liquidctl initialize all）。留空：關閉。', 'zh-Hans': '运行 liquidctl status --json：一体式水冷和 Corsair / NZXT 控制器。若设备需要，开机后先初始化一次（liquidctl initialize all）。留空：关闭。' },
  }),
  lmSensors: t.string({
    default: 'sensors',
    risk: 'exec',
    label: { en: 'lm-sensors program', es: 'Programa de lm-sensors', de: 'lm-sensors-Programm', 'zh-Hant': 'lm-sensors 程式', 'zh-Hans': 'lm-sensors 程序' },
    help: { en: 'Runs sensors -j (Linux): motherboard fan headers and the kernel drivers of AIOs. Empty: off.', es: 'Ejecuta sensors -j (Linux): los conectores de ventilador de la placa y los drivers del kernel de las AIO. Vacío: no se usa.', de: 'Führt sensors -j aus (Linux): Lüfteranschlüsse des Mainboards und die Kernel-Treiber von AIOs. Leer: aus.', 'zh-Hant': '執行 sensors -j（Linux）：主機板風扇接頭與一體式水冷的核心驅動程式。留空：關閉。', 'zh-Hans': '运行 sensors -j（Linux）：主板风扇接口和一体式水冷的内核驱动。留空：关闭。' },
  }),
  lhmUrl: t.string({
    format: 'url',
    risk: 'network',
    placeholder: 'http://localhost:8085',
    label: { en: 'LibreHardwareMonitor web server', es: 'Servidor web de LibreHardwareMonitor', de: 'Webserver von LibreHardwareMonitor', 'zh-Hant': 'LibreHardwareMonitor 網頁伺服器', 'zh-Hans': 'LibreHardwareMonitor 网页服务器' },
    help: { en: 'Its /data.json (Options → Remote Web Server → Run). Empty: http://localhost:8085 on Windows, off elsewhere.', es: 'Su /data.json (Options → Remote Web Server → Run). Vacío: http://localhost:8085 en Windows, nada en el resto.', de: 'Sein /data.json (Options → Remote Web Server → Run). Leer: http://localhost:8085 unter Windows, sonst aus.', 'zh-Hant': '它的 /data.json（Options → Remote Web Server → Run）。留空：Windows 上為 http://localhost:8085，其他系統關閉。', 'zh-Hans': '它的 /data.json（Options → Remote Web Server → Run）。留空：Windows 上为 http://localhost:8085，其他系统关闭。' },
  }),
});

/** Overridable for tests: the runner, fetch and the platform. */
export const coolingDeps: CoolingDeps = { ...DEFAULT_COOLING_DEPS };

export const cooling = defineSource({
  id: 'cooling',
  name: { en: 'Cooling', es: 'Refrigeración', de: 'Kühlung', 'zh-Hant': '散熱', 'zh-Hans': '散热' },
  description: {
    en: 'Fan and pump speeds, duty and coolant temperature, from liquidctl, lm-sensors (Linux) or LibreHardwareMonitor (Windows).',
    es: 'Velocidad y carga de ventiladores y bombas, y temperatura del líquido, de liquidctl, lm-sensors (Linux) o LibreHardwareMonitor (Windows).',
    de: 'Drehzahl und Last von Lüftern und Pumpen sowie Kühlmitteltemperatur, von liquidctl, lm-sensors (Linux) oder LibreHardwareMonitor (Windows).',
    'zh-Hant': '風扇與水泵的轉速、負載及冷卻液溫度，來自 liquidctl、lm-sensors（Linux）或 LibreHardwareMonitor（Windows）。',
    'zh-Hans': '风扇和水泵的转速、负载及冷却液温度，来自 liquidctl、lm-sensors（Linux）或 LibreHardwareMonitor（Windows）。',
  },
  options: coolingOptions,
  intervalMs: 3_000,
  // liquidctl talks to the device over USB HID each time: faster than this only adds noise.
  minIntervalMs: 1_000,
  timeoutMs: 15_000,
  read: ({ options, signal, now }) => readCooling(options, coolingDeps, signal, now),
  demo: ({ now }) => demoCooling(now),
});

/* ---------- gaming/fps ---------- */

const fpsOptions = {
  fpsWarn: t.integer({ default: 50, min: 1, max: 1000, unit: 'fps', label: { en: 'Amber under', es: 'Ámbar por debajo de', de: 'Gelb unter', 'zh-Hant': '低於此值顯示琥珀色', 'zh-Hans': '低于此值显示琥珀色' }, help: { en: 'FPS. Frames slower than this are amber in the curve.', es: 'FPS. Los fotogramas más lentos salen en ámbar en la curva.', de: 'FPS. Langsamere Frames sind in der Kurve gelb.', 'zh-Hant': 'FPS。比這更慢的影格在曲線中以琥珀色標示。', 'zh-Hans': 'FPS。比这更慢的帧在曲线中以琥珀色标示。' } }),
  fpsAlert: t.integer({ default: 30, min: 1, max: 1000, unit: 'fps', label: { en: 'Red under', es: 'Rojo por debajo de', de: 'Rot unter', 'zh-Hant': '低於此值顯示紅色', 'zh-Hans': '低于此值显示红色' }, help: { en: 'FPS. Frames slower than this are red in the curve: the stutters you feel.', es: 'FPS. Los fotogramas más lentos salen en rojo en la curva: los tirones que se notan.', de: 'FPS. Langsamere Frames sind in der Kurve rot: die Ruckler, die man spürt.', 'zh-Hant': 'FPS。比這更慢的影格在曲線中以紅色標示：也就是你感覺得到的卡頓。', 'zh-Hans': 'FPS。比这更慢的帧在曲线中以红色标示：也就是你能感觉到的卡顿。' } }),
  frames: t.integer({ default: 300, min: 30, max: 1000, label: { en: 'Frames in the curve', es: 'Fotogramas en la curva', de: 'Frames in der Kurve', 'zh-Hant': '曲線中的影格數', 'zh-Hans': '曲线中的帧数' } }),
  showGame: t.boolean({ default: true, label: { en: "Show the game's name", es: 'Mostrar el nombre del juego', de: 'Namen des Spiels zeigen', 'zh-Hant': '顯示遊戲名稱', 'zh-Hans': '显示游戏名称' } }),
};

type FpsState = { sources: Record<string, unknown> };
const playing = ({ sources }: FpsState) => !!framesOf(sources)?.running;

export const fps = defineWidget({
  id: 'fps',
  name: { en: 'Game FPS', es: 'FPS del juego', de: 'Spiel-FPS', 'zh-Hant': '遊戲 FPS', 'zh-Hans': '游戏 FPS' },
  description: {
    en: 'The average FPS, big, the 1 % low and a frame-time curve where every stutter shows. Hidden while no game runs.',
    es: 'Los FPS medios, en grande, el 1 % bajo y una curva de tiempos de fotograma donde se ve cada tirón. Oculto mientras no hay juego.',
    de: 'Die mittleren FPS groß, das 1-%-Tief und eine Frametime-Kurve, in der jeder Ruckler sichtbar ist. Ausgeblendet, solange kein Spiel läuft.',
    'zh-Hant': '大字顯示平均 FPS、1% 低，以及能看出每次卡頓的影格時間曲線。沒有遊戲執行時隱藏。',
    'zh-Hans': '大字显示平均 FPS、1% 低，以及能看出每次卡顿的帧时间曲线。没有游戏运行时隐藏。',
  },
  icon: 'gamepad-2',
  category: 'system',
  tags: ['gaming', 'fps', 'frame time', 'mangohud', 'presentmon'],
  size: { min: { w: 120, h: 50 }, preferred: { w: 960, h: 462 } },
  options: t.object(fpsOptions),
  sources: [FRAMES_SOURCE],
  // A second is plenty: the figures are averages, and every frame is a USB transfer.
  redraw: 'never',
  render(g, ctx) {
    drawFps(g, ctx, framesOf(ctx.sources), ctx.options);
  },
  empty: (st) => !playing(st),
  hideWhenEmpty: true,
  idle: (st) => !playing(st),
  demo: ({ now }) => ({ sources: { [FRAMES_SOURCE]: demoFrames(now) } }),
});

/* ---------- gaming/cooling ---------- */

const coolingWidgetOptions = {
  tempWarn: t.integer({ default: 40, min: 20, max: 80, unit: '°C', label: { en: 'Amber coolant', es: 'Líquido ámbar', de: 'Kühlmittel gelb ab', 'zh-Hant': '冷卻液琥珀色門檻', 'zh-Hans': '冷却液琥珀色阈值' } }),
  tempAlert: t.integer({ default: 45, min: 20, max: 80, unit: '°C', label: { en: 'Red coolant', es: 'Líquido rojo', de: 'Kühlmittel rot ab', 'zh-Hant': '冷卻液紅色門檻', 'zh-Hans': '冷却液红色阈值' }, help: { en: 'Most AIOs are rated to about 60 °C; past 45 °C the loop is losing. The widget keeps the tile while it is past it.', es: 'La mayoría de las AIO aguantan unos 60 °C; por encima de 45 °C el circuito va perdiendo. El widget se queda la tesela mientras la pase.', de: 'Die meisten AIOs sind bis etwa 60 °C ausgelegt; über 45 °C verliert der Kreislauf. Das Widget behält die Kachel, solange es darüber liegt.', 'zh-Hant': '多數一體式水冷的額定上限約 60 °C；超過 45 °C 表示循環已散熱不及。超過時小工具會持續佔用方格。', 'zh-Hans': '多数一体式水冷的额定上限约 60 °C；超过 45 °C 说明循环已散热不及。超过时小组件会持续占用格子。' } }),
  pumpWarn: t.integer({ default: 800, min: 0, max: 6000, unit: 'rpm', label: { en: 'Amber pump under', es: 'Bomba ámbar por debajo de', de: 'Pumpe gelb unter', 'zh-Hant': '水泵低於此轉速顯示琥珀色', 'zh-Hans': '水泵低于此转速显示琥珀色' } }),
  pumpAlert: t.integer({ default: 300, min: 0, max: 6000, unit: 'rpm', label: { en: 'Red pump under', es: 'Bomba roja por debajo de', de: 'Pumpe rot unter', 'zh-Hant': '水泵低於此轉速顯示紅色', 'zh-Hans': '水泵低于此转速显示红色' }, help: { en: 'A pump that stops is a CPU about to throttle. The widget keeps the tile while one is under it.', es: 'Una bomba parada es una CPU a punto de frenarse. El widget se queda la tesela mientras una esté por debajo.', de: 'Eine stehende Pumpe ist eine CPU kurz vor der Drosselung. Das Widget behält die Kachel, solange eine darunter liegt.', 'zh-Hant': '水泵停轉代表 CPU 即將降頻。只要有水泵低於此值，小工具就會持續佔用方格。', 'zh-Hans': '水泵停转意味着 CPU 即将降频。只要有水泵低于此值，小组件就会持续占用格子。' } }),
  sensors: t.filter({
    label: { en: 'Sensors', es: 'Sensores', de: 'Sensoren', 'zh-Hant': '感測器', 'zh-Hans': '传感器' },
    help: { en: 'Empty: all. Channel or device names, comma-separated: * matches anything, a leading ! leaves out (Pump, Fan*, !amdgpu).', es: 'Vacío: todos. Nombres de canal o de dispositivo separados por comas: * vale por cualquier cosa y un ! delante excluye (Pump, Fan*, !amdgpu).', de: 'Leer: alle. Kanal- oder Gerätenamen, durch Kommas getrennt: * steht für beliebigen Text, ein vorangestelltes ! schließt aus (Pump, Fan*, !amdgpu).', 'zh-Hant': '留空：全部。以逗號分隔的通道或裝置名稱：* 符合任何內容，開頭加 ! 表示排除（Pump, Fan*, !amdgpu）。', 'zh-Hans': '留空：全部。以逗号分隔的通道或设备名称：* 匹配任意内容，开头加 ! 表示排除（Pump, Fan*, !amdgpu）。' },
  }),
  hideStopped: t.boolean({ default: true, label: { en: 'Hide stopped fans', es: 'Ocultar ventiladores parados', de: 'Stehende Lüfter ausblenden', 'zh-Hant': '隱藏停轉的風扇', 'zh-Hans': '隐藏停转的风扇' }, help: { en: 'Empty headers read 0 rpm. A stopped pump is always shown.', es: 'Los conectores vacíos marcan 0 rpm. Una bomba parada se muestra siempre.', de: 'Leere Anschlüsse zeigen 0 U/min. Eine stehende Pumpe wird immer gezeigt.', 'zh-Hant': '空接頭會顯示 0 轉。停轉的水泵一定會顯示。', 'zh-Hans': '空接口会显示 0 转。停转的水泵总会显示。' } }),
};

type CoolingOpts = CoolingThresholds & { sensors: Filter; hideStopped: boolean };
type CoolingState = { options: CoolingOpts; sources: Record<string, unknown> };
const readingsOf = ({ options, sources }: CoolingState) => selectCooling(coolingOf(sources), options.sensors, options.hideStopped);

export const coolingWidget = defineWidget({
  id: 'cooling',
  name: { en: 'Cooling', es: 'Refrigeración', de: 'Kühlung', 'zh-Hant': '散熱', 'zh-Hans': '散热' },
  description: {
    en: 'Coolant temperature, pump and fan speeds with their duty. Dim until the coolant warms up or a pump slows down.',
    es: 'Temperatura del líquido, velocidad de bombas y ventiladores con su carga. Apagado hasta que el líquido se calienta o una bomba se frena.',
    de: 'Kühlmitteltemperatur, Drehzahl von Pumpen und Lüftern mit ihrer Last. Gedimmt, bis das Kühlmittel warm wird oder eine Pumpe langsamer wird.',
    'zh-Hant': '冷卻液溫度、水泵與風扇轉速及其負載。在冷卻液變熱或水泵變慢前保持暗色。',
    'zh-Hans': '冷却液温度、水泵和风扇转速及其负载。在冷却液变热或水泵变慢前保持暗色。',
  },
  icon: 'fan',
  category: 'system',
  tags: ['cooling', 'fan', 'pump', 'aio', 'liquidctl', 'water cooling'],
  size: { min: { w: 120, h: 60 }, preferred: { w: 640, h: 462 } },
  options: t.object(coolingWidgetOptions),
  sources: [COOLING_SOURCE],
  render(g, ctx) {
    const s = coolingOf(ctx.sources);
    const reason = s && !s.available ? (s.reasonText ? ctx.t(s.reasonText) : s.reason) : undefined;
    drawCooling(g, ctx, s?.available ? readingsOf(ctx) : undefined, ctx.options, reason);
  },
  urgent: (st) => coolingLevel(readingsOf(st), st.options) === 'alert',
  idle: (st) => coolingLevel(readingsOf(st), st.options) === 'normal',
  demo: ({ now }) => ({ sources: { [COOLING_SOURCE]: demoCooling(now) } }),
});

export default definePlugin({
  id: 'gaming',
  name: { en: 'Gaming', es: 'Juegos', de: 'Gaming', 'zh-Hant': '遊戲', 'zh-Hans': '游戏' },
  version: '0.1.0',
  languages: LANGS,
  sdk: '^0.2.0',
  permissions: {
    exec: ['liquidctl', 'sensors', 'PresentMon'],
    files: ['~/mangohud'],
    network: ['localhost', 'user'],
    devices: ['usb'],
  },
  description: {
    en: 'Game FPS, 1 % low and frame times (MangoHud, PresentMon), and the cooling: fans, pumps and coolant (liquidctl, lm-sensors, LibreHardwareMonitor).',
    es: 'FPS del juego, 1 % bajo y tiempos de fotograma (MangoHud, PresentMon), y la refrigeración: ventiladores, bombas y líquido (liquidctl, lm-sensors, LibreHardwareMonitor).',
    de: 'Spiel-FPS, 1-%-Tief und Frametimes (MangoHud, PresentMon) sowie die Kühlung: Lüfter, Pumpen und Kühlmittel (liquidctl, lm-sensors, LibreHardwareMonitor).',
    'zh-Hant': '遊戲 FPS、1% 低與影格時間（MangoHud、PresentMon），以及散熱：風扇、水泵與冷卻液（liquidctl、lm-sensors、LibreHardwareMonitor）。',
    'zh-Hans': '游戏 FPS、1% 低和帧时间（MangoHud、PresentMon），以及散热：风扇、水泵和冷却液（liquidctl、lm-sensors、LibreHardwareMonitor）。',
  },
  author: 'Loksly',
  license: 'MIT',
  repository: 'https://github.com/kiosko-lcd/kiosko-plugin-gaming',
  homepage: 'https://github.com/kiosko-lcd/kiosko-plugin-gaming#readme',
  icon: 'gamepad-2',
  widgets: [fps, coolingWidget],
  sources: [frames, cooling],
  templates: [
    {
      id: 'gaming',
      name: { en: 'Gaming', es: 'Juegos', de: 'Gaming', 'zh-Hant': '遊戲', 'zh-Hans': '游戏' },
      icon: 'gamepad-2',
      wide: [
        { x: 0, y: 0, w: 1 / 2, h: 1, widgets: ['fps'] },
        { x: 1 / 2, y: 0, w: 1 / 3, h: 1, widgets: ['cooling'] },
        { x: 5 / 6, y: 0, w: 1 / 6, h: 1, widgets: ['core/clock'] },
      ],
      square: [
        { x: 0, y: 0, w: 1, h: 1 / 2, widgets: ['fps'] },
        { x: 0, y: 1 / 2, w: 2 / 3, h: 1 / 2, widgets: ['cooling'] },
        { x: 2 / 3, y: 1 / 2, w: 1 / 3, h: 1 / 2, widgets: ['core/clock'] },
      ],
      tall: [
        { x: 0, y: 0, w: 1, h: 1 / 6, widgets: ['core/clock'] },
        { x: 0, y: 1 / 6, w: 1, h: 1 / 2, widgets: ['fps'] },
        { x: 0, y: 2 / 3, w: 1, h: 1 / 3, widgets: ['cooling'] },
      ],
    },
  ],
});
