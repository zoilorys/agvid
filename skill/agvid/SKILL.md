---
name: agvid
description: Inspect local video clips with timecode-labeled frame sheets, change detection for screen recordings, short frame sequences, and source metadata using the agvid CLI.
---

# Inspect video with agvid

Use when a task requires understanding a local video. Needs Node.js 20+ and FFmpeg/FFprobe 5.1+ on `PATH`. Look at cheap sheets first, then zoom in. `agvid <command> --help` lists every option, default and limit.

1. `agvid probe video.mov`: duration, displayed size, fps, codec. Use when source size or length matters.
2. `agvid overview video.mov`: 12 evenly spaced frames (`--frames N`). Open the printed `sheets` first; each tile is labeled with its timecode.
3. Screen recordings and UI flows: `agvid changes video.mov` keeps the range start plus each frame where the picture changes. Use `--start/--end` on long videos and `--crop` for small changes; a cursor-sized change stays under the default `--threshold`.
4. Motion near a moment: `agvid inspect video.mov --around 00:07.5 --window 2s --fps 4` (`--window` is the total centered duration), or `--start 00:05 --end 00:09`.
5. One moment: `agvid frame video.mov --at 00:07.5`.

Batch instead of repeating calls: `--at 1,4.5,9` and `--around 3,12`. A run makes at most 240 frames.

Zoom with `--crop x,y,w,h` on any image command: fractions 0-1 of the displayed frame (left, top, width, height). Estimate from a tile: a button about 80% across and 40% down, roughly 15% wide and 20% tall, is `--crop 0.8,0.4,0.15,0.2`. The crop is cut at source resolution before `--width` (default 640) scaling, so small text becomes legible.

TIME is seconds, `MM:SS.s` or `HH:MM:SS.s`. A time shows the frame on screen then. Image commands print JSON with `directory`, `manifest` and `sheets`; `manifest.json` maps each frame `file` to its source `time` and `timecode`. Report observations with manifest times.

Output goes to a fresh `.agvid/runs/<video>-<command>/` under the git root, or `--output DIR`. If agvid reports a directory in use or holding a killed run's work, pass another `--output`.

[references/advanced.md](references/advanced.md) covers change-detection tuning and truncation, multiple video streams, MPEG-TS/AVI/raw streams, exact timeline rules and crop/aspect details.
