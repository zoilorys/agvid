# agvid

`agvid` extracts small, timestamped video frames for coding agents. It uses FFmpeg and FFprobe installed on your system.

## Install

Install Node.js 20 or newer, plus FFmpeg. Then install the CLI:

```sh
npm install -g agvid
```

For a checkout, run `npm link` from the repository root.

### Install the agent skill

The package includes an agent skill at `skill/agvid/SKILL.md`. Copy it for your agent:

```sh
# Claude Code, user scope
mkdir -p ~/.claude/skills && cp -R "$(npm root -g)/agvid/skill/agvid" ~/.claude/skills/

# Claude Code, project scope (run from the project root)
mkdir -p .claude/skills && cp -R "$(npm root -g)/agvid/skill/agvid" .claude/skills/

# Codex
mkdir -p ~/.codex/skills && cp -R "$(npm root -g)/agvid/skill/agvid" ~/.codex/skills/
```

Run these with the same Node and npm that installed agvid, since nvm and Volta keep global packages per version or tool. If the path is missing, find `agvid/skill/agvid` in your version manager's package directory.

From a checkout, symlink instead so the skill tracks the repository (run from the repository root). This replaces any existing copy or link:

```sh
mkdir -p ~/.claude/skills && rm -rf ~/.claude/skills/agvid && ln -s "$PWD/skill/agvid" ~/.claude/skills/agvid
```

## Inspect a video

```sh
agvid probe video.mov
agvid overview video.mov
agvid inspect video.mov --around 00:07.5 --window 2s --fps 4
agvid frame video.mov --at 00:07.5 --width 320
agvid changes recording.mov --crop 0.5,0,0.5,0.5
agvid probe a.mov b.mov
agvid probe --video-stream 1 multi-track.mov
agvid overview multi-track.mov --video-stream 1
```

`overview` samples evenly across the video. `inspect` samples the centered window at the requested frame rate. `changes` finds moments where the picture changes (see below). All three write JPEG frames, `manifest.json`, and sheets `sheet-01.jpg`, … (at most 1568 px per side, split across several sheets when needed; `sheet-001.jpg`, … from 100 sheets), with each tile labeled bottom-left with its timecode. `frame` extracts JPEGs and no sheet, except a sheet when `--at` lists several times. Frame files are named like `frame-0003_00-07.500.jpg`. `probe` prints source metadata as JSON: duration (with `durationSource`), displayed and coded size, `sar` (sample aspect ratio, rotation-adjusted), rotation, fps, frame count, codec, pixel format, bit depth, and audio presence. With several videos it prints an array in argument order; a video that fails becomes `{ "video": "/abs/path", "error": "..." }` and the exit code is 1.

### Select a video stream

All commands accept `--video-stream N`. `N` is the zero-based video-stream ordinal used by FFmpeg's `0:v:N`, not the absolute stream index in the container. The default is `0`. For example, use `--video-stream 1` when the first video stream is cover art and the second is the footage. `probe --video-stream 1 a.mov b.mov` applies the same choice to both files; a file without that video stream gets an error entry. `probe` reports `videoStream` and `streamIndex` (the absolute container index). Image manifests record both in `source`.

### Ranges

`overview`, `inspect` and `changes` accept `--start TIME` and `--end TIME` (seconds, `MM:SS.s`, or `HH:MM:SS.s`) to work on part of the video. Clock minute and second fields must be below 60. `--end` is clamped to the duration; `--start` must be before it. For `inspect`, `--start/--end` replace `--around/--window` (combining them is an error). The manifest gets `range: { start, end }` when either is passed.

### Batching

`--at` (frame) and `--around` (inspect) take a comma list or repeated flags: `--at 1,4.5 --at 9`. `--at` times are deduped and sorted. Each `--around` gets its own window, sheets, and an entry in the manifest `windows[]` (`around`, `start`, `end`, `frames` as `[first, last]` indexes into `frames`, `sheets`; `around` is `null` for `--start/--end`). A run is capped at 240 frames.

### Crop

`--crop x,y,w,h` (frame, inspect, overview, changes) takes fractions 0 to 1 of the displayed frame: left, top, width, height, with the origin at the top left. Estimate them from a sheet tile: a button about 80% across and 40% down the tile, roughly 15% wide and 20% tall, is `--crop 0.8,0.4,0.15,0.2`. The region is cut at source resolution before `--width` scaling and is never enlarged, so small text becomes legible. It must fit in the frame and be at least 16x16 source pixels. The manifest `crop` holds the fractions and `pixels`: the even stored-pixel `x`, `y`, `width`, `height` given to the crop filter, and `displayed`, its SAR-adjusted size.

### Find changes

```sh
agvid changes recording.mov
```

`changes` decodes the range once, samples at up to 30 fps by default, and writes the range start plus each frame where more than `--threshold` of the picture (default 0.002) differs from the last detected candidate, at least `--min-gap` (default 0.5s) apart. It compares RGB pixels at 256 pixels wide and counts a pixel when any channel differs by more than 16/255. This catches color changes with similar brightness. `--analysis-fps` accepts 1 to 60; `--analysis-width` accepts 64 to 512. Higher values catch shorter or smaller changes but take more decode time. `--max` (default 48, up to 240) keeps the highest scores. The printed JSON adds `changes`, the number of frames after the first. In the manifest, each frame has a `score` (`null` for the range start, the baseline), and `detection` records the actual `metric`, `threshold`, `minGap`, `candidates` found, and `truncated`. Sheets are split as for `inspect`.

- Needs FFmpeg 5.1 or newer (it uses `-fps_mode`).
- A moving cursor-sized box stays below the default threshold. Use `--crop` around a region of interest, or lower `--threshold`, to catch small UI changes.
- `changes` decodes the whole range: use `--start/--end` on long videos.

### Options and output

`overview` defaults to 12 frames. Frame width defaults to a 640 pixel cap; `--width PX` accepts 64 to 4096 and preserves aspect ratio without enlarging narrower (or rotated) sources. Options accept `--key value` or `--key=value`. By default each run gets a fresh directory `.agvid/runs/<video>-<command>[-N]/` under the git root, else the current directory; `.agvid/` ignores itself in git. `--output DIR` must be new or empty. Failed runs clean up. The command prints JSON with `directory`, `sheets`, `manifest`, and the frame count. The manifest maps each frame file to its requested source `time` in seconds and `timecode`, and each sheet to its frame range and grid.

`--window` defaults to 2 seconds and is the total duration, so `--around 00:07.5 --window 2s` covers roughly 6.5 to 8.5 seconds. The window clips at the start or end of the video. `--fps` defaults to 4. `inspect` caps output at 240 frames; `overview` accepts 1 to 64 frames.

Frames are evidence for a moment, not frame accurate: FFmpeg seeking can land on a nearby decoded frame, depending on the source codec. Manifest times keep the requested precision; filenames and sheet labels round to milliseconds.

## Develop

```sh
npm test
npm pack --dry-run
```

The package has no npm runtime dependencies. It requires the `ffmpeg` and `ffprobe` executables on `PATH`.
