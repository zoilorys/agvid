---
name: agvid
description: Inspect local video clips with timestamped contact sheets, short frame sequences, and source metadata using the agvid CLI.
---

# Inspect video with agvid

Use this skill when a task requires understanding a local video clip. `agvid` needs Node.js, FFmpeg, and FFprobe on `PATH`.

Start with `agvid overview video.mov`. Read its printed JSON for the contact sheet path and open that image. The `manifest.json` in the same directory maps the sheet's frames, in row order, to source times.

When an event needs a closer look, run `agvid inspect video.mov --around 00:07.5 --window 2s --fps 4`. Read the returned frame directory and manifest, then inspect the relevant JPEGs in time order. The window is a total duration centered on `--around`.

Use `agvid probe video.mov` to check source dimensions, duration, frame rate, and codec. Use `agvid frame video.mov --at 00:07.5` for one moment. All image commands accept `--width PX`; start with the 640 pixel default and increase it only when details are too small. Use `--output DIR` when you need a specific artifact location.

Report observations with source timestamps. Treat them as approximate positions because seeking precision depends on the source codec.
