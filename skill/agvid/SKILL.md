---
name: agvid
description: Inspect local video clips with timecode-labeled frame sheets, change detection for screen recordings, short frame sequences, and source metadata using the agvid CLI.
---

# Inspect video with agvid

Use when a task requires understanding a local video. Needs Node.js, FFmpeg, and FFprobe on `PATH`.

1. `agvid probe a.mov [b.mov ...]` for duration, displayed size, `sar`, fps, codec. Several videos print an array; failed ones are `{video, error}` and exit 1.
2. `agvid overview video.mov` samples 12 evenly spaced frames (`--frames 1-64`). Open the `sheets` paths first. Each tile's bottom-left label is its timecode; very small tiles have none.
3. Screen recording or UI flow: `agvid changes video.mov` writes the range start plus a frame at each detected change. Open its `sheets`; `frames[].score` is the RGB changed-pixel share (`null` for the first). It samples at up to 30 fps at 256 pixels wide and counts pixels where any channel changes by more than 16/255. Options: `--threshold` (default 0.002), `--min-gap` (0.5s), `--max` (48, up to 240), `--analysis-fps` (1-60, default 30), `--analysis-width` (64-512, default 256).
4. Zoom in: `agvid inspect video.mov --around 00:07.5 --window 2s --fps 4` (total centered window, clipped) or `--start 00:05 --end 00:09`. `agvid frame video.mov --at 00:07.5` for one moment (no sheet).
5. Batch instead of repeating calls: `--at 1,4.5,9` and `--around 3,12` (comma list or repeated flag). `--at` is deduped and sorted; each `--around` is its own window with its own sheets.

For a file with several video streams, pass `--video-stream N` to any command. `N` is zero-based among video streams (`0:v:N`), default `0`, and differs from the container's absolute stream index when audio comes first. `probe` reports both `videoStream` and `streamIndex`; manifests record them in `source`. A batched `probe --video-stream 1 a.mov b.mov` reports an error entry for each file without that stream.

Crop with `--crop x,y,w,h` (fractions 0-1 of the displayed frame; works on overview, inspect, frame, changes). Estimate from a sheet tile: a button at the right edge of the tile's middle third, about 80% across and 40% down, roughly 15% wide and 20% tall, is `--crop 0.8,0.4,0.15,0.2`. Crop cuts at source resolution, so text stays legible. On `changes`, crop to the region of interest: a moving cursor-sized box stays under the default threshold, and small UI changes need a crop to register.

On long videos, pass `--start`/`--end` (to overview, inspect, changes); `changes` decodes the whole range. `--end` is clamped to the duration. `changes` needs FFmpeg 5.1+.

Output: printed JSON has `directory`, `sheets` (not for a single `frame`), `manifest`, `frames` (count; `changes` also prints `changes`). `manifest.json` maps each frame `file` to `time` and `timecode`, plus `sheets`, `crop`, `range`, `windows`, `detection` where they apply. Goes to `.agvid/runs/<video>-<command>[-N]/`; `--output DIR` must be new or empty. `--width PX` (64-4096) caps width, default 640.

Manifest times keep requested positions, including sub-millisecond precision. Filenames and sheet labels round to milliseconds; seeking is approximate for some codecs. Report observations with manifest times.
