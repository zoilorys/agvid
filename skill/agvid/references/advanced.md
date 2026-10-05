# agvid advanced reference

Read this when the core workflow in `SKILL.md` is not enough: tuning `changes`, multi-stream files, unusual formats, exact timeline semantics, or a refused output directory.

## Change detection

`changes` decodes the range once and keeps source timestamps without resampling. It thins frames to at most `--analysis-fps` per second, scales them to `--analysis-width` wide with the area capped at 512×512 (`detection.analysis` holds the actual size), and compares RGB. A pixel counts as changed when any channel differs by more than 16/255 from the last detected candidate; the first reference is the frame on screen at the range start. A frame becomes a candidate when its changed-pixel share exceeds `--threshold` and it is at least `--min-gap` after the previous candidate.

| Option | Default | Range | Effect |
| --- | --- | --- | --- |
| `--threshold` | `0.002` | above 0, up to 1 | changed-pixel share needed |
| `--min-gap` | `0.5s` | 0–3600 s | spacing between candidates |
| `--max` | `48` | 1–239 | changes kept (plus the range-start baseline) |
| `--analysis-fps` | `30` | 1–60 | higher catches shorter changes, costs decode time |
| `--analysis-width` | `256` | 64–512 | higher catches smaller changes |
| `--analysis-budget` | `300` | 1–1000000 s | source seconds one decode attempt may cover |

- **Small changes:** a cursor-sized box stays under the default threshold. `--crop` to the region (detection then runs on the crop) or lower `--threshold`.
- **Truncation:** with at most `--max` candidates, all are kept. Otherwise the range is split into `--max` equal time slices, the strongest candidate of each slice is kept, and slots left by empty slices go to the strongest remaining candidates (earlier wins ties). A quiet late change is not crowded out by a busy stretch. Stdout reports `changes`, `candidates` and `truncated`; the manifest's `detection` adds `max`, `candidates`, `truncated` and `selection` (`method`, and when truncated `slices`, `sliceDuration`, `fromSlices`, `byScore`). Each frame has a `score` (`null` for the baseline).
- **Budget:** `--analysis-budget DURATION` (default 300) limits the source seconds one decode attempt covers, from where it starts decoding to the range end. That start is the range start, or the video start for MPEG-TS, for a range starting within 0.5 s of the video start, and for the fallback taken when seeking finds no frame at the range start. An over-budget plan, including that fallback, fails before FFmpeg runs and says whether `--start/--end` or only `--end` narrows it. The budget is not wall-clock time, is not summed across attempts, and excludes decoding back to the keyframe before the range start. The manifest's `detection.scan` (`from`, `to`, `seconds`, `budget`) records the attempt that succeeded.
- **Progress:** every 5 s a running scan writes `agvid changes: scanned T of END (P%), N candidates, Ss elapsed` to stderr. Stdout holds only the final JSON.

## Timeline and evidence

- Times are seconds on the container timeline, as players and `ffmpeg -ss` show them. The selected video stream spans probe `start` to `end`; `start` is above 0 when, for example, audio begins first.
- `overview` and `changes` default to that span. `--start/--end` are clamped to it and the start must come before the end. `--at`/`--around` outside it fail. `--start/--end` replace `--around/--window` on `inspect`; combining them fails.
- `--window` is the total centered duration, clipped to the span: `--around 7.5 --window 2s` covers 6.5–8.5 s.
- A time shows the frame on screen then: the last frame at or before it. Manifest times are the requested times at full precision; `changes` times are exact source frame times. Filenames and sheet labels round to milliseconds. Report findings with manifest times. Seeking may land on a nearby frame for some codecs, so treat a frame as evidence for a moment.
- `--at` values are deduped and sorted. Each `--around` keeps its own window (`windows[]`: `around`, `start`, `end`, the `frames` index range and `sheets`) and sheets, so overlapping windows repeat a moment as separate entries and files. Times that show the same source frame stay separate entries.

## Crop and size

- `--crop x,y,w,h` uses fractions of the displayed frame, after rotation and sample aspect ratio (SAR). It is cut at source resolution before `--width` scaling, never enlarged, and must cover at least 16×16 source pixels.
- Output never exceeds the displayed width of the frame or crop in square pixels: SAR is applied to the coded horizontal axis, then rotation. A 160×90 source with SAR 1:2 gives at most 80×90, or 90×80 rotated 90 degrees.
- The manifest's `crop` holds the requested fractions and `pixels`: the even stored-pixel `x`, `y`, `width`, `height` and the `displayed` size.

## Streams and probe

- `--video-stream N` picks the zero-based video stream, as in FFmpeg's `0:v:N` (default 0). This is not the container's absolute stream index: use 1 when, for example, stream 0 is cover art. `probe` reports `videoStream` and `streamIndex`; manifests record both in `source`.
- `probe` prints the stream's `start`, `end`, `duration` (with `durationSource`), `containerStart`, displayed and coded size, `sar`, `rotation`, `fps`, `frameCount`, `codec`, `pixelFormat`, `bitDepth` and `hasAudio`.
- `probe a.mov b.mov` prints an array in argument order. A failed file, including one without the requested stream, becomes `{ "video": "/abs/path", "error": "..." }`, and the exit code is 1.

## Unusual formats

- **MPEG-PS/TS:** spans come from a packet scan, because FFmpeg's estimate can stop short. MPEG-TS always decodes from the video start, so only `--end` reduces a `changes` budget.
- **Seek fallback:** other formats retry from the video start when seeking finds no frame, so late times in sparse or oddly muxed files can be slow.
- **Raw elementary streams** (`.h264`, `.m2v`) have no timestamps and are rejected. Wrap them first: `ffmpeg -r FPS -i video.h264 video.mp4`.
- **AVI with B-frames:** FFmpeg rebuilds missing timestamps, so a cut at 1 s can read 1.04 s. Extraction uses the same timestamps, so that time still shows the changed frame.
- **Variable frame rate and long holds:** a time inside a hold shows the held frame.

## Output directory and locks

- Each run writes a fresh `.agvid/runs/<video>-<command>[-N]/` under the git root (else cwd). `--output DIR` must be new or empty.
- A run holds `DIR/.agvid.lock` (pid and host) and stages files in a private `DIR/.agvid.lock.work-*` directory. A concurrent run on the same directory fails. Errors, Ctrl-C and SIGTERM stop FFmpeg and remove the run's files and any directory it created.
- A run killed outright (SIGKILL, crash) leaves its lock and staging directory. agvid never removes them itself. When it reports the directory in use or holding a killed run's work, first make sure no agvid run (check the pid in the lock) is still writing there, then delete `.agvid.lock` and `.agvid.lock.work-*` by hand, or use a new `--output`.

## Requirements

Node.js 20+ and FFmpeg/FFprobe 5.1+ on `PATH`: extraction and `changes` use `-fps_mode`. Run size is capped at 240 frames; `overview` takes 1–64 frames.
