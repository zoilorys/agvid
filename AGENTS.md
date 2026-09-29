# Agent instructions

Be extremely concise. Avoid tautological tests.

## Product intent

`agvid` helps coding agents inspect video without loading every full-resolution frame into context. It is a local npm CLI backed by FFmpeg and FFprobe. Keep output files and machine-readable manifests easy for agents to find and relate to source timestamps.

The main workflow is progressive:

1. Run `agvid probe video.mov` to see duration, dimensions, frame rate, and codec when source size matters.
2. Run `agvid overview video.mov` for evenly spaced frames and labeled sheets. The default is 12 frames.
3. Run `agvid changes video.mov` on screen recordings to find moments where the picture changes. Use `--start/--end` on long videos and `--crop` for small UI changes.
4. Run `agvid inspect video.mov --around 00:07.5 --window 2s --fps 4` to inspect motion near a moment. The window is the total centered duration and clips to video bounds. `--start/--end` inspects a range instead.
5. Run `agvid frame video.mov --at 00:07.5` when one exact moment is enough. `--at` and `--around` accept several values in one call.
6. Add `--crop x,y,w,h` (fractions of the displayed frame) to zoom into a region on any image command.

`--width` caps extracted frame width and defaults to 640 pixels. Preserve aspect ratio. Output JPEG frames plus `manifest.json`, which maps filenames to source times. Overview, inspect and changes also write sheets, and frame does when given several `--at` times. `--output` chooses an output directory; otherwise create a fresh directory under `.agvid/runs/` in the git root (else cwd).

## Development boundaries

- Keep the CLI dependency free where practical. FFmpeg and FFprobe are explicit runtime prerequisites.
- Validate arguments and cap accidental large extraction jobs before running FFmpeg.
- Keep timestamps in the manifest tied to the requested source positions. A frame is evidence for a moment, not a promise of frame accurate seeking across all codecs.
- Keep the installable agent skill in `skill/agvid/SKILL.md` aligned with the actual CLI. Package it in npm releases.
- Verify behavior with a real short video fixture or generated test video. Avoid tests that merely mirror argument parsing or string literals.
- Do not add CI or CD configuration unless requested.
