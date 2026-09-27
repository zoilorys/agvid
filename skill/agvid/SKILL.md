---
name: agvid
description: Inspect local video clips with timestamped contact sheets, short frame sequences, and source metadata using the agvid CLI.
---

# Inspect video with agvid

Use this skill when a task requires understanding a local video clip. `agvid` needs Node.js, FFmpeg, and FFprobe on `PATH`.

Run `agvid probe video.mov` first when source duration, dimensions, frame rate, or codec matter. Then run `agvid overview video.mov` for 12 evenly spaced frames. Read its printed JSON for the contact sheet path and open that image. The `manifest.json` in the same directory maps frame filenames to requested source times, in sheet order.

When an event needs a closer look, run `agvid inspect video.mov --around 00:07.5 --window 2s --fps 4`. Read the returned directory and manifest, then inspect the relevant JPEGs in time order. The window is a total duration centered on `--around` and clips to the video bounds.

Use `agvid frame video.mov --at 00:07.5` for one moment. All image commands accept `--width PX` from 64 to 4096; the default caps frame width at 640 pixels without enlarging smaller sources. `overview` accepts 1 to 64 frames. `inspect` defaults to a 2 second window at 4 fps and caps extraction at 240 frames. Each image command creates a fresh directory under `./agvid-output/` by default. Use `--output DIR` for a specific new or empty directory.

Report observations with source timestamps. Treat them as approximate positions because seeking precision depends on the source codec.
