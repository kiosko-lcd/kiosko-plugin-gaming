## Requirements

Each source works with whatever tools it finds; set up the ones you have.

**FPS and frame times** (`gaming/frames`), only while a game runs:

- **Linux: [MangoHud](https://github.com/flightlessmango/MangoHud)** writing its
  CSV log as it plays (a version that writes the log while recording). In
  `~/.config/MangoHud/MangoHud.conf`:

  ```ini
  output_folder=/home/you/mangohud
  autostart_log=1
  log_interval=0
  ```

  and the same folder in the source's `mangohudFolder` (default `~/mangohud`).
  Start games with `mangohud %command%` (Steam) or `MANGOHUD=1`. The newest log
  in the folder is followed as it grows; a few seconds without new frames
  means the game is gone. MangoHud's own summary files are ignored.
- **Windows: [PresentMon](https://github.com/GameTechDev/PresentMon) 2.x** (the
  console program) on the `PATH` or at the path in `presentmon`. Kiosko runs it
  with its CSV on stdout while a widget needs it (`--output_stdout
  --no_console_stats --stop_existing_session --session_name KioskoGaming
  --exclude dwm.exe`). It needs an administrator, or a user in the *Performance
  Log Users* group. The game is the program presenting the most frames. Or set
  `presentmonCsv` to a CSV PresentMon is already writing (`--output_file`).

The average FPS and the 1 % low (the average FPS of the slowest 1 % of frames)
are taken over the last `windowMs` of play (30 s).

**Fans, pumps and coolant** (`gaming/cooling`), any that answer, merged:

- **[liquidctl](https://github.com/liquidctl/liquidctl)** (Linux, macOS,
  Windows): AIO coolers and Corsair / NZXT controllers, `liquidctl status
  --json`. Some devices need `liquidctl initialize all` once after boot, and on
  Linux the udev rules that let your user reach the device.
- **lm-sensors** (Linux): `sensors -j`, the motherboard fan headers and the
  kernel drivers of AIOs (`nzxt-kraken3`, `aquacomputer_d5next`…).
- **[LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)**
  (Windows): turn on *Options → Remote Web Server → Run*; its `/data.json` on
  `http://localhost:8085` is read by default on Windows (`lhmUrl` for another
  host or port).

A pump is a channel whose name says *pump*; the coolant, a temperature that
says *liquid*, *water* or *coolant* (or any of an AIO's own). Stopped fans
(empty headers) are hidden by default; a stopped pump never is.
