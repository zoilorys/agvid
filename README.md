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
- **Bounded:** frame width capped at 640 px by default, runs at 240 frames, change scans at 300 s of source.
- **No npm dependencies:** just Node.js and FFmpeg.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Output](#output)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Requirements

- Node.js 20+
- FFmpeg 5.1+ (`ffmpeg` and `ffprobe` on `PATH`)

## Install

```sh
npm install -g agvid
```

### Agent skill

The package ships an agent skill, [`skill/agvid/SKILL.md`](skill/agvid/SKILL.md), with an [advanced reference](skill/agvid/references/advanced.md). Copy the whole directory into your agent's skills directory:

```sh
# Claude Code (user scope)
mkdir -p ~/.claude/skills && cp -R "$(npm root -g)/agvid/skill/agvid" ~/.claude/skills/

# Claude Code (project scope, from the project root)
mkdir -p .claude/skills && cp -R "$(npm root -g)/agvid/skill/agvid" .claude/skills/

# Codex
mkdir -p ~/.codex/skills && cp -R "$(npm root -g)/agvid/skill/agvid" ~/.codex/skills/
```

Use the same Node and npm that installed agvid: nvm and Volta keep global packages per version.

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
| `overview <video>` | Evenly spaced frames | `--frames` (1–64, default 12), `--start`, `--end` |
| `changes <video>` | Range start plus each frame where the picture changes | `--threshold`, `--max`, `--start`, `--end` |
| `inspect <video>` | Frames at a fixed rate around a moment or over a range | `--around`, `--window` (default 2s), `--fps` (default 4), `--start`, `--end` |
| `frame <video>` | Frames at exact moments | `--at` |

Image commands accept `--crop`, `--width`, `--output` and `--video-stream`. Times accept seconds, `MM:SS.s` or `HH:MM:SS.s`; durations accept seconds with an optional `s`. A time shows the frame on screen then: the last frame at or before it. `--at` and `--around` take comma lists or repeated flags; each `--around` gets its own window and sheets. A run makes at most 240 frames.

The [advanced reference](skill/agvid/references/advanced.md) covers exact detection settings, `--video-stream`, multi-file `probe`, unusual formats and timeline rules.

### Crop

`--crop x,y,w,h` takes fractions 0–1 of the displayed frame (left, top, width, height). Estimate them from a sheet tile: a button about 80% across and 40% down, roughly 15% wide and 20% tall, is `--crop 0.8,0.4,0.15,0.2`. The region is cut at source resolution before `--width` scaling, never enlarged, and must be at least 16×16 source pixels.

### Change detection

`changes` decodes the range once, samples up to 30 fps, and keeps the range start plus each frame where more than `--threshold` (default `0.002`) of the pixels changed in any RGB channel since the last detected change, at least `--min-gap` (default `0.5s`) apart.

- **Small changes:** a cursor-sized box stays below the default threshold. `--crop` to the region or lower `--threshold`.
- **Long videos:** `--analysis-budget` (default `300`) caps the source seconds one decode attempt may cover, so an oversized scan fails before decoding and says how to narrow `--start/--end`. It is not wall-clock time.
- **Progress:** scans longer than 5 s report progress on stderr; stdout stays JSON.
- **Truncation:** past `--max` (default 48) candidates, the strongest change of each time slice is kept so quiet stretches stay covered. Output reports `candidates` and `truncated`.

`--analysis-fps` and `--analysis-width` trade decode time for sensitivity.

## Output

Each run writes to a fresh directory, `.agvid/runs/<video>-<command>[-N]/`, under the git root (else the current directory). `.agvid/` ignores itself in git. `--output DIR` picks another directory, which must be new or empty.

```
.agvid/runs/demo-overview/
├── frame-0000_00-01.066.jpg
├── ...
├── sheet-01.jpg
└── manifest.json
```

- **Frames:** JPEGs named `frame-<index>_<timecode>.jpg`, at most `--width` pixels wide (default 640, range 64–4096, never above the displayed width), aspect ratio preserved.
- **Sheets:** `overview`, `inspect`, `changes`, and `frame` with several `--at` times write `sheet-01.jpg`, … with tiles labeled by timecode, at most 1568 px per side.
- **Manifest:** `manifest.json` records the `command`, the `source` metadata, and every frame's `file`, requested `time` (seconds) and `timecode`. Depending on the command it also holds `sheets`, `crop`, `range`, `windows` and `detection`; `changes` frames add a `score`.

```json
{
  "command": "changes",
  "frames": [
    { "file": "frame-0000_00-00.000.jpg", "time": 0, "timecode": "00:00.000", "score": null },
    { "file": "frame-0001_00-00.717.jpg", "time": 0.7166666666666667, "timecode": "00:00.717", "score": 0.003955 }
  ]
}
```

A run holds `DIR/.agvid.lock`, so a concurrent run on the same directory fails. Errors, Ctrl-C and SIGTERM remove the run's files. A run killed outright leaves its lock and `.agvid.lock.work-*` staging directory; agvid never removes them, so delete them by hand once no agvid run uses the directory.

## Limitations

- **Frames are evidence for a moment, not frame-accurate.** FFmpeg seeking can land on a nearby frame for some codecs.
- **Raw elementary streams** (`.h264`, `.m2v`) have no timestamps and are rejected. Wrap them first: `ffmpeg -r FPS -i video.h264 video.mp4`.
- **MPEG-TS** decodes from the video start, and other formats retry from there when seeking finds no frame, so late times can be slow.
- **No audio, subtitles or coordinate grids:** agvid covers visual inspection only.

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

### Benchmark

`scripts/benchmark.js` times every command, including Node startup, on the bundled fixture and a generated 20 s 1080p60 clip (`--video long` adds a 120 s one; clips are cached in `benchmark/.cache/`). `benchmark/baseline-src/` is a frozen copy of the CLI before the performance work, and `benchmark/baseline.json` holds its results:

```sh
# Recreate the baseline
node scripts/benchmark.js --cli benchmark/baseline-src/bin/agvid.js --video bundled --video short --runs 3 --json benchmark/baseline.json

# Compare the checkout against it
node scripts/benchmark.js --video bundled --video short --runs 3 --compare benchmark/baseline.json
```

`--case` picks cases (`probe`, `overview12`, `overview48`, `frame1`, `frame5`, `inspect8`, `inspect100`, `changes`, `changesCrop`). Compare runs on the same machine under similar load.

## License

[MIT](LICENSE) © Illia Puzanov
