# agvid

`agvid` extracts small, timestamped video frames for coding agents. It uses FFmpeg and FFprobe installed on your system.

## Install

Install Node.js 20 or newer, plus FFmpeg. Then install the CLI:

```sh
npm install -g agvid
```

For a checkout, run `npm link` from the repository root. The package also includes an agent skill at `skill/agvid/SKILL.md`. To install the skill for Codex, copy that directory into `~/.codex/skills/`.

## Inspect a video

```sh
agvid probe video.mov
agvid overview --frames 12 video.mov
agvid inspect video.mov --around 00:07.5 --window 2s --fps 4
agvid frame video.mov --at 00:07.5 --width 320
```

`overview` samples evenly across the video and writes `contact-sheet.jpg`, individual JPEG frames, and `manifest.json`. `inspect` samples the centered window at the requested frame rate. `frame` extracts one JPEG. `probe` prints source metadata as JSON.

Frame width defaults to 640 pixels. Use `--width PX` on image commands to reduce size. Use `--output DIR` to choose a directory. By default, each run gets a fresh directory under `./agvid-output/`. The command prints the output paths as JSON. The manifest maps each frame filename to a source timestamp in seconds.

`--window` is the total duration, so `--around 00:07.5 --window 2s` covers roughly 6.5 to 8.5 seconds. The window clips at the start or end of the video. `inspect` caps output at 240 frames; `overview` accepts 1 to 64 frames.

FFmpeg seeking can land on a nearby decoded frame, depending on the source codec. Use the timestamps as requested positions, not frame accuracy guarantees.

## Develop

```sh
npm test
npm pack --dry-run
```

The package has no npm runtime dependencies. It requires the `ffmpeg` and `ffprobe` executables on `PATH`.
