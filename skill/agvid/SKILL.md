---
name: agvid
description: Inspect local video clips with timecode-labeled frame sheets, change detection for screen recordings, short frame sequences, and source metadata using the agvid CLI.
---

# Inspect video with agvid

Use when a task requires understanding a local video. Needs Node.js 20+ and FFmpeg/FFprobe 5.1+ on `PATH`. Look at cheap sheets first, then zoom in.

1. `agvid probe video.mov` when source size matters: `start`/`end`/`duration`, displayed size, fps, codec.
2. `agvid overview video.mov` writes 12 evenly spaced frames (`--frames 1-64`). Open the printed `sheets` first; each tile is labeled bottom-left with its timecode.
3. Screen recording or UI flow: `agvid changes video.mov` writes the range start plus each frame where the picture changes. Use `--start/--end` on long videos and `--crop` for small UI changes; a cursor-sized change stays under the default `--threshold 0.002`. Its planned scan may span at most 300 s of source per decode attempt (`--analysis-budget`; not wall-clock time, and seeking back to a keyframe is extra) and it reports progress on stderr every 5 s. With more than `--max` (48) candidates, it keeps the strongest per time slice and prints `truncated: true`.
4. Motion near a moment: `agvid inspect video.mov --around 00:07.5 --window 2s --fps 4` (`--window` is the total centered duration, clipped to the video), or `--start 00:05 --end 00:09` instead.
5. One moment: `agvid frame video.mov --at 00:07.5`.

Batch instead of repeating calls: `--at 1,4.5,9` and `--around 3,12` (comma lists or repeated flags). A run makes at most 240 frames.

Zoom with `--crop x,y,w,h` on any image command: fractions 0-1 of the displayed frame (left, top, width, height). Estimate from a tile: a button about 80% across and 40% down, roughly 15% wide and 20% tall, is `--crop 0.8,0.4,0.15,0.2`. The crop is cut at source resolution before `--width` (default 640) scaling, so small text becomes legible.

TIME is seconds, `MM:SS.s` or `HH:MM:SS.s`; DURATION is seconds with an optional `s`. A time shows the frame on screen then (the last frame at or before it). Image commands print JSON with `directory`, `manifest`, the frame count and `sheets` (omitted for a single-time `frame`); `manifest.json` maps each frame `file` to its requested `time` and `timecode`. Report observations with manifest times.

Output goes to a fresh `.agvid/runs/<video>-<command>[-N]/` under the git root, or `--output DIR` (new or empty). If agvid reports a directory in use or holding a killed run's work, use another `--output`, or delete its `.agvid.lock` and `.agvid.lock.work-*` only when no agvid run is using it.

Read [references/advanced.md](references/advanced.md) for exact change-detection settings and truncation, `--video-stream` and multi-file `probe`, MPEG-TS/AVI/raw streams, timeline and overlap rules, and crop/aspect details.
