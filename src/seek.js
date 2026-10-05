// Internal demuxer metadata controls seeking; symbol keys stay out of probe JSON and manifests.
export const SOURCE_FORMAT = Symbol('sourceFormat');
export const TICK = Symbol('tick');

// With B-frame delay, FFmpeg moves an input seek 3/23 s earlier. Near the stream start that target precedes the first
// index entry, and the AVI demuxer then resumes after the keyframe: frames decode without error but corrupt, or not
// at all. MPEG-TS input seeking can silently skip a GOP anywhere. Those positions decode from the origin instead.
export const ORIGIN_MARGIN = 0.5;

function seekable(info, time) {
  return !info[SOURCE_FORMAT].split(',').includes('mpegts') && time >= info.start + ORIGIN_MARGIN;
}

// A time shows the frame on screen then: the last one whose pts is at most that time. The tolerance absorbs only float
// rounding between container-timeline seconds and source pts (about 1e-11 s at a day's timeline), far below a tick
// of any stream time base (1/90000 s for MPEG), so no later frame counts as already shown.
export const TIME_TOLERANCE = 1e-9;
// Frames before a time are first kept (scaled, encoded or piped) only from this long before it; a time with no frame
// there (sparse VFR) retries with every earlier frame.
const RECENT = 0.5;

// Decode attempts for the frame on screen at `time`: input seeking where it is reliable, then from the origin.
// Other demuxers can seek past the initial keyframe's DTS, so an attempt that finds no frame falls through.
export function attempts(info, time) {
  return [...(seekable(info, time) ? [false] : []), true].flatMap((slow) => [{ slow, window: RECENT }, { slow, window: Infinity }]);
}

// Seeks with -noaccurate_seek and -copyts so decoding starts at the keyframe before `time` on source pts. Output -ss
// would count from the stream's own rebased start in MPEG-PS/TS (wrong for a delayed video stream).
export function seekArgs(slow, time) {
  return slow ? ['-copyts'] : ['-noaccurate_seek', '-copyts', '-ss', String(time)];
}

// Ends decoding just past `end` (source seconds). trim rounds to the nearest tick, so it ends a tick late; callers
// cut at the exact time themselves.
export function trimEnd(info, end) {
  return `trim=end=${end + (Number.isFinite(info[TICK]) ? info[TICK] : 0.1) + TIME_TOLERANCE}`;
}
