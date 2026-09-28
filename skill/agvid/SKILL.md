---
name: agvid
description: Inspect local video clips with timecode-labeled frame sheets, short frame sequences, and source metadata using the agvid CLI.
---

# Inspect video with agvid

Use when a task requires understanding a local video. Needs Node.js, FFmpeg, and FFprobe on `PATH`.

1. `agvid probe video.mov` when duration, dimensions (displayed, after rotation), fps, or codec matter. Prints JSON.
2. `agvid overview video.mov` samples 12 evenly spaced frames (`--frames 1-64`). Open the `sheets` paths from the printed JSON first. Each tile's bottom-left label is its timecode (`MM:SS.mmm` or `H:MM:SS.mmm`); very small tiles have none.
3. `agvid inspect video.mov --around 00:07.5 --window 2s --fps 4` samples a total window centered on `--around`, clipped to the video. At most 240 frames. Also writes sheets.
4. `agvid frame video.mov --at 00:07.5` extracts one frame, no sheet. Find its path in the manifest `frames[].file`; the filename carries the time, e.g. `frame-0000_00-07.500.jpg`.

Printed JSON: `directory`, `sheets` (overview/inspect only), `manifest`, `frames` (count). `manifest.json` maps each frame `file` to `time` (seconds) and `timecode`, and each sheet to its frame range. Output goes to a fresh `.agvid/runs/<video>-<command>[-N]/` under the git root (else cwd); `--output DIR` must be new or empty. `--width PX` (64-4096) caps frame width, default 640, never enlarging.

Times and sheet labels are requested positions; seeking is approximate for some codecs. Report observations with those timestamps.
