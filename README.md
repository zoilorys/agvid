# agvid

[![npm](https://img.shields.io/npm/v/agvid)](https://www.npmjs.com/package/agvid)
[![license](https://img.shields.io/npm/l/agvid)](LICENSE)
[![node](https://img.shields.io/node/v/agvid)](package.json)

**Let coding agents watch video without drowning in frames.**

`agvid` is a small CLI that turns a local video into a few timestamped JPEGs, labeled contact sheets, and a `manifest.json` that ties every image to its source time. An agent looks at a cheap overview first, then zooms in on the moments that matter.

- **Progressive:** overview → find changes → inspect a window → grab one frame.
- **Timestamped:** every tile is labeled with its timecode; the manifest maps files to source seconds.
- **Screen-recording aware:** `changes` finds the moments where the UI actually changes.
- **Crop and zoom:** cut a region at source resolution so small text stays legible.
- **Bounded:** frame width capped at 640 px by default, runs capped at 240 frames.
- **No npm dependencies:** just Node.js and FFmpeg.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Output](#output)
- [Reference](#reference)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on `PATH` (FFmpeg 5.1+ for `changes`)

## Install

```sh
npm install -g agvid
```

### Agent skill

The package ships an agent skill at [`skill/agvid/SKILL.md`](skill/agvid/SKILL.md) that teaches agents the workflow. Copy it into your agent's skills directory:

```sh
# Claude Code (user scope)
mkdir -p ~/.claude/skills && cp -R "$(npm root -g)/agvid/skill/agvid" ~/.claude/skills/

# Claude Code (project scope, from the project root)
mkdir -p .claude/skills && cp -R "$(npm root -g)/agvid/skill/agvid" .claude/skills/

# Codex
mkdir -p ~/.codex/skills && cp -R "$(npm root -g)/agvid/skill/agvid" ~/.codex/skills/
```

Use the same Node and npm that installed agvid: nvm and Volta keep global packages per version. If the path is missing, look for `agvid/skill/agvid` in your version manager's package directory.

## Quick start

```sh
agvid probe demo.mov                                     # duration, size, fps, codec
agvid overview demo.mov                                  # 12 evenly spaced frames + sheet
agvid changes demo.mov                                   # frames where the picture changes
agvid inspect demo.mov --around 00:07.5 --window 2s --fps 4
agvid frame demo.mov --at 00:07.5
agvid frame demo.mov --at 00:07.5 --crop 0.5,0,0.5,0.5   # zoom into the top-right quarter
```

Each image command prints where it wrote its files:

```json
{
  "directory": "/repo/.agvid/runs/demo-overview",
  "sheets": ["/repo/.agvid/runs/demo-overview/sheet-01.jpg"],
  "manifest": "/repo/.agvid/runs/demo-overview/manifest.json",
  "frames": 12
}
```

## Commands

| Command | What it does | Key options |
| --- | --- | --- |
| `probe <video>...` | Prints source metadata as JSON | `--video-stream` |
| `overview <video>` | Evenly spaced frames across the video | `--frames` (1–64, default 12), `--start`, `--end` |
| `changes <video>` | Range start plus each frame where the picture changes | `--threshold`, `--min-gap`, `--max`, `--start`, `--end` |
| `inspect <video>` | Frames at a fixed rate around a moment or over a range | `--around`, `--window` (default 2s), `--fps` (default 4), `--start`, `--end` |
| `frame <video>` | Frames at exact moments | `--at` |

All image commands accept `--crop`, `--width`, `--output` and `--video-stream`. Times accept seconds, `MM:SS.s`, or `HH:MM:SS.s`; durations accept seconds with an optional `s` suffix. Options accept `--key value` or `--key=value`. Run `agvid --help` for the full synopsis.

### Batching

`--at` and `--around` take a comma list or repeated flags: `--at 1,4.5 --at 9`. `--at` times are deduped and sorted. Each `--around` gets its own window and sheets, recorded in the manifest's `windows[]`.

### Crop

`--crop x,y,w,h` takes fractions 0–1 of the displayed frame (left, top, width, height; origin top-left). Estimate them from a sheet tile: a button about 80% across and 40% down, roughly 15% wide and 20% tall, is `--crop 0.8,0.4,0.15,0.2`. The region is cut at source resolution before `--width` scaling and is never enlarged. It must fit in the frame and be at least 16×16 source pixels.

### Change detection

`changes` decodes the range once, samples it at up to 30 fps, and keeps the range start plus each frame where more than `--threshold` (default `0.002`) of the picture differs from the last detected candidate, at least `--min-gap` (default `0.5s`) apart. A pixel counts as changed when any RGB channel moves by more than 16/255, so color changes with similar brightness are caught.

| Option | Default | Range |
| --- | --- | --- |
| `--threshold` | `0.002` | changed-pixel share |
| `--min-gap` | `0.5s` | |
| `--max` | `48` | up to 239 (plus the baseline = 240 frames) |
| `--analysis-fps` | `30` | 1–60 |
| `--analysis-width` | `256` | 64–512 (area capped at 512×512) |

Higher analysis values catch shorter or smaller changes but cost more decode time. `--max` keeps the highest scores, earliest first on ties.

Tips:

- A moving cursor-sized box stays below the default threshold. `--crop` to the region of interest or lower `--threshold` to catch small UI changes.
- `changes` decodes the whole range: use `--start/--end` on long videos.

### Multiple video streams

`--video-stream N` selects the zero-based video stream, as in FFmpeg's `0:v:N` (default `0`). This is not the container's absolute stream index. Use `--video-stream 1` when, for example, the first video stream is cover art. `probe` reports both `videoStream` and `streamIndex`.

## Output

Each run writes to a fresh directory, `.agvid/runs/<video>-<command>[-N]/`, under the git root (else the current directory). `.agvid/` ignores itself in git. `--output DIR` picks another directory, which must be new or empty.

```
.agvid/runs/demo-overview/
├── frame-0000_00-01.066.jpg
├── frame-0001_00-03.198.jpg
├── ...
├── sheet-01.jpg
└── manifest.json
```

- **Frames:** JPEGs named `frame-<index>_<timecode>.jpg`, at most `--width` pixels wide (default 640, range 64–4096), aspect ratio preserved.
- **Sheets:** `overview`, `inspect`, `changes`, and `frame` with several `--at` times write `sheet-01.jpg`, … Tiles are labeled bottom-left with their timecode. Sheets are at most 1568 px per side and split as needed.
- **Manifest:** `manifest.json` records the `command`, the `source` metadata, and every frame's `file`, `time` (seconds) and `timecode`. Depending on the command it also holds `sheets`, `crop`, `range`, `windows` and `detection`; `changes` frames add a `score` (`null` for the baseline).

```json
{
  "command": "changes",
  "frames": [
    { "file": "frame-0000_00-00.000.jpg", "time": 0, "timecode": "00:00.000", "score": null },
    { "file": "frame-0001_00-00.717.jpg", "time": 0.7166666666666667, "timecode": "00:00.717", "score": 0.003955 }
  ],
  "sheets": [
    { "file": "sheet-01.jpg", "frames": [0, 17], "start": 0, "end": 14.18, "columns": 3, "rows": 6 }
  ]
}
```

## Reference

<details>
<summary><strong>probe output</strong></summary>

`probe` prints the selected video stream's `start`, `end` and `duration` on the container timeline (with `durationSource`), `containerStart`, displayed and coded size, `sar` (sample aspect ratio, rotation-adjusted), `rotation`, `fps`, `frameCount`, `codec`, `pixelFormat`, `bitDepth`, and `hasAudio`.

With several videos it prints an array in argument order. A video that fails becomes `{ "video": "/abs/path", "error": "..." }` and the exit code is 1.

MPEG-PS and MPEG-TS spans come from a packet scan, because FFmpeg's duration estimate for them can stop short. The scan reads from 30 s before that estimate to the end, or the whole file when that tail holds no video keyframe.

</details>

<details>
<summary><strong>Timeline</strong></summary>

All times are seconds on the container timeline, as players and `ffmpeg -ss` show them: 0 is the container start. The selected video stream spans `start` to `end`; `start` is above 0 when, for example, audio begins before the video.

- `overview` and `changes` default to that span.
- `--start/--end` are clamped to it; `--start` must be before its end.
- `--at`/`--around` outside it are errors.
- `--start/--end` replace `--around/--window` on `inspect`; combining them is an error.

A time shows the frame on screen at that moment, as a player would: the last frame at or before it. Manifest times are the requested times, or for `changes` the exact source frame times. Manifest times keep the requested precision; filenames and sheet labels round to milliseconds.

`--window` is the total duration, so `--around 00:07.5 --window 2s` covers 6.5 to 8.5 seconds, clipped at the video's ends.

</details>

<details>
<summary><strong>Output size and aspect ratio</strong></summary>

Output never exceeds the displayed width of the frame or crop in square pixels: SAR is applied to the coded horizontal axis, then rotation. A 160×90 source with SAR 1:2 is at most 80×90, or 90×80 when rotated 90 degrees.

The manifest `crop` holds the requested fractions and `pixels`: the even stored-pixel `x`, `y`, `width`, `height` given to the crop filter, and `displayed`, its size in square pixels.

</details>

<details>
<summary><strong>Concurrency and cancellation</strong></summary>

A run holds `DIR/.agvid.lock` until it ends, so a concurrent run on the same directory fails. A lock left by a killed run (its pid is gone on this host) is replaced by the next run. Failed runs, and runs stopped with Ctrl-C or SIGTERM, stop FFmpeg and delete their own files and any directory they created.

</details>

## Limitations

- **Frames are evidence for a moment, not frame-accurate.** FFmpeg seeking can land on a nearby decoded frame depending on the codec.
- **Raw elementary streams** (`.h264`, `.m2v`) have no timestamps and are rejected. Wrap them in a container first: `ffmpeg -r FPS -i video.h264 video.mp4`.
- **AVI with B-frames** stores no timestamps for reordered frames, so FFmpeg rebuilds them. `changes` may report a cut at 1 s as 1.04 s; extraction uses the same timestamps, so that time still shows the changed frame.
- **MPEG-TS** decodes from the container start, because fast seeking can skip frames. Other formats retry from the start if fast seeking produces no frames, so late timestamps can take longer.
- **Run size** is capped at 240 frames; `overview` accepts 1–64 frames.

## Development

```sh
git clone https://github.com/zoilorys/agvid.git
cd agvid
npm link        # puts the checkout's agvid on PATH
npm test
npm pack --dry-run
```

To make the skill track your checkout, symlink it (this replaces any existing copy):

```sh
mkdir -p ~/.claude/skills && rm -rf ~/.claude/skills/agvid && ln -s "$PWD/skill/agvid" ~/.claude/skills/agvid
```

Tests run against real videos generated with FFmpeg and the fixture in `test/fixtures`.

## License

[MIT](LICENSE) © Illia Puzanov
