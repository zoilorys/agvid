import { lines, run } from './process.js';
import { ORIGIN_MARGIN, SOURCE_FORMAT, TICK } from './seek.js';
import { parseTime } from './time.js';

export async function probe(video, videoStream) {
  // Keep the full listing for audio presence and the container index of the selected video stream.
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time,duration,format_name:stream=index,codec_type,width,height,avg_frame_rate,codec_name,start_pts,start_time,time_base,duration_ts,duration,nb_frames,pix_fmt,bits_per_raw_sample,sample_aspect_ratio:stream_side_data=rotation:stream_tags=DURATION,rotate', '-of', 'json', video]);
  const { streams = [], format = {} } = JSON.parse(raw);
  const videoStreams = streams.filter((entry) => entry.codec_type === 'video');
  const stream = videoStreams[videoStream];
  if (!stream) throw new Error(`video stream ${videoStream} not found (${videoStreams.length} video streams)`);
  const valid = (value) => Number.isFinite(value) && value > 0;
  // FFmpeg seeks relative to the container's microsecond start time. Stream timestamps need their integer
  // ticks: rounded start_time can fall after the actual first (and possibly only) frame.
  const micros = (value) => (/^-?\d+(?:\.\d+)?$/.test(value ?? '') ? Math.round(Number(value) * 1e6) : NaN);
  const containerMicros = Number.isFinite(micros(format.start_time)) ? micros(format.start_time) : 0;
  const streamMicros = micros(stream.start_time);
  const [timeNum, timeDen] = String(stream.time_base ?? '').split('/').map(Number);
  const ticksToSeconds = (ticks) => Number.isSafeInteger(ticks) && Number.isSafeInteger(timeNum) && timeNum > 0
    && Number.isSafeInteger(timeDen) && timeDen > 0
    ? ticks * timeNum / timeDen : NaN;
  const exactStart = ticksToSeconds(stream.start_pts);
  let streamStart = Number.isFinite(exactStart) ? exactStart
    : Number.isFinite(streamMicros) ? streamMicros / 1e6 : containerMicros / 1e6;
  let duration = ticksToSeconds(stream.duration_ts);
  if (!valid(duration)) duration = Number(stream.duration);
  let durationSource = 'stream';
  let untimed = false;
  // FFmpeg's Matroska muxer writes DURATION as the endpoint on the raw stream timeline, including any start offset.
  if (!valid(duration) && stream.tags?.DURATION) {
    durationSource = 'tag';
    try { duration = parseTime(stream.tags.DURATION) - streamStart; }
    catch { duration = NaN; }
  }
  // FFmpeg estimates MPEG-PS/TS durations from timestamps near the end of the file, which can stop short of the
  // last frames (stream and container alike), so those spans come from the packets. Other formats keep their metadata.
  const estimated = (format.format_name ?? '').split(',').some((name) => name === 'mpeg' || name === 'mpegts');
  if (!valid(duration) || estimated) {
    // The first pts comes from the head; the end from the tail past the container's estimated end.
    const [head, packets] = await Promise.all([packetSpan(video, videoStream, '%+#32'),
      tailPackets(video, videoStream, containerMicros / 1e6 + Number(format.duration))]);
    let { end } = packets;
    // With no pts at all (raw elementary streams) the timeline is synthetic: the span stays unknown.
    untimed = !Number.isFinite(head.start);
    if (!untimed && !packets.exact) {
      // Packets without pts only bound the end from below; decode the tail for the frames' actual times.
      const tail = await decodedTail(video, videoStream, packets.last - containerMicros / 1e6 - 1, packets.lastDuration);
      if (tail.end > end || !Number.isFinite(end)) end = tail.end;
    }
    if (valid(end - head.start)) {
      durationSource = 'packets';
      duration = end - head.start;
      streamStart = head.start;
    }
  }
  if (!valid(duration) && untimed) {
    throw new Error(`video stream ${videoStream} has no timestamps (a raw elementary stream?); re-encode it into a container first, e.g. ffmpeg -r FPS -i VIDEO out.mp4`);
  }
  if (!valid(duration)) {
    throw new Error(`video stream ${videoStream} has no duration metadata; provide a video with a known video-stream duration`);
  }
  if (!Number.isInteger(stream.width) || stream.width <= 0 || !Number.isInteger(stream.height) || stream.height <= 0) {
    throw new Error('video dimensions are unavailable');
  }
  const rawRotation = Number(stream.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  const rotation = Number.isFinite(rawRotation) ? ((Math.round(rawRotation) % 360) + 360) % 360 : 0;
  const swap = rotation === 90 || rotation === 270;
  const [numerator, denominator] = String(stream.avg_frame_rate ?? '').split('/').map(Number);
  const rate = numerator / denominator;
  const fps = Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
  const counted = Number(stream.nb_frames);
  const frameCountEstimated = !(Number.isInteger(counted) && counted > 0);
  const frameCount = frameCountEstimated ? (fps === null ? null : Math.round(duration * rate)) : counted;
  const bitDepth = Number(stream.bits_per_raw_sample);
  // SAR stretches stored pixels horizontally; after a 90/270 turn it applies to the displayed vertical axis, so invert it.
  const [sarNum, sarDen] = String(stream.sample_aspect_ratio ?? '').split(':').map(Number);
  const storedSar = sarNum > 0 && sarDen > 0 ? sarNum / sarDen : 1;
  const sar = swap ? 1 / storedSar : storedSar;
  const relativeStart = streamStart - containerMicros / 1e6;
  // Clipping a first PTS just before the rounded container origin to zero must not extend the stream's end.
  return { [SOURCE_FORMAT]: format.format_name ?? '', [TICK]: ticksToSeconds(1), video, videoStream, streamIndex: stream.index, start: Math.max(0, relativeStart), end: relativeStart + duration, duration,
    containerStart: containerMicros / 1e6, width: swap ? stream.height : stream.width, height: swap ? stream.width : stream.height,
    sar, rotation, codedWidth: stream.width, codedHeight: stream.height, fps, frameRate: stream.avg_frame_rate ?? null,
    frameCount, frameCountEstimated, codec: stream.codec_name, pixelFormat: stream.pix_fmt ?? null,
    bitDepth: Number.isInteger(bitDepth) && bitDepth > 0 ? bitDepth : null,
    hasAudio: streams.some((entry) => entry.codec_type === 'audio'), durationSource };
}

// Demux-only scan of the video packets, in seconds on the stream timeline: first pts, display end, last
// presentation time and that packet's duration. A packet without pts (reordered frames in AVI or MPEG-PS) counts at
// its dts, which is never after its pts, so `exact` turns false and `end`/`last` become lower bounds. `interval` is an
// ffprobe -read_intervals value; `keyframe` tells whether a timed keyframe packet was read.
async function packetSpan(video, videoStream, interval) {
  let first = Infinity;
  let last = -Infinity;
  let end = -Infinity;
  let lastLength = NaN;
  let exact = true;
  let keyframe = false;
  let timeBase;
  await lines('ffprobe', ['-v', 'error', '-select_streams', `v:${videoStream}`, ...(interval ? ['-read_intervals', interval] : []),
    '-show_entries', 'packet=pts,dts,duration,flags:stream=time_base', '-of', 'compact', video], 'stdout', (line) => {
    timeBase = /^stream\|time_base=([1-9]\d*)\/([1-9]\d*)\|?$/.exec(line.trim())?.slice(1).map(Number) ?? timeBase;
    if (!line.startsWith('packet|')) return;
    const fields = Object.fromEntries(line.trim().split('|').slice(1).map((field) => field.split('=')));
    const ticks = (value) => (/^-?\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : NaN);
    const pts = ticks(fields.pts);
    const time = Number.isFinite(pts) ? pts : ticks(fields.dts);
    if (!Number.isFinite(time)) return;
    if (Number.isFinite(pts)) first = Math.min(first, pts);
    else exact = false;
    if (fields.flags?.startsWith('K')) keyframe = true;
    const length = ticks(fields.duration);
    if (time > last) { last = time; lastLength = length; }
    if (Number.isFinite(length)) end = Math.max(end, time + length);
  });
  const seconds = (value) => (timeBase && Number.isFinite(value) ? value * timeBase[0] / timeBase[1] : NaN);
  return { start: seconds(first), end: seconds(end), last: seconds(last), lastDuration: seconds(lastLength), exact, keyframe };
}

// Packets from TAIL_SCAN seconds before `rawEnd` (the expected end on the raw container timeline) to EOF bound the end
// of the stream in time proportional to that tail. The frame shown last is decoded after the last keyframe, so a tail
// holding a keyframe holds it too. Otherwise (the end was overestimated, or a GOP is longer) the whole file is scanned.
const TAIL_SCAN = 30;

async function tailPackets(video, videoStream, rawEnd) {
  if (Number.isFinite(rawEnd)) {
    const tail = await packetSpan(video, videoStream, `${rawEnd - TAIL_SCAN}%`);
    if (tail.keyframe) return tail;
  }
  return packetSpan(video, videoStream);
}

// Decodes from `from` (container timeline seconds) to the end and returns the last decoded frame's presentation
// time and display end, in seconds on the stream timeline: the timestamps FFmpeg extraction itself selects by.
// NaN when nothing decodes. Frames without a showinfo duration (older FFmpeg) last `frameDuration` seconds.
async function decodedTail(video, videoStream, from, frameDuration) {
  const scan = async (seek) => {
    let timeBase;
    let last = -Infinity;
    let end = -Infinity;
    await lines('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'info', '-copyts', ...(seek ? ['-ss', String(from)] : []),
      '-i', video, '-map', `0:v:${videoStream}`, '-vf', 'showinfo', '-f', 'null', '-'], 'stderr', (line) => {
      if (!/Parsed_showinfo/.test(line)) return;
      timeBase = /\bconfig in time_base:\s*(\d+)\/(\d+)/.exec(line)?.slice(1).map(Number) ?? timeBase;
      const frame = /\bn:\s*\d+\s+pts:\s*(-?\d+)\s(?:.*?\bduration:\s*(\d+)\s)?/.exec(line);
      if (!frame || !timeBase?.[1]) return;
      const pts = Number(frame[1]) * timeBase[0] / timeBase[1];
      const length = frame[2] === undefined ? frameDuration : Number(frame[2]) * timeBase[0] / timeBase[1];
      last = Math.max(last, pts);
      end = Math.max(end, pts + (Number.isFinite(length) ? length : 0));
    });
    return { last, end };
  };
  // A seek can land past the last frame (MPEG-TS can skip a GOP); then decode the whole stream.
  let tail = from >= ORIGIN_MARGIN ? await scan(true) : { last: -Infinity };
  if (!Number.isFinite(tail.last)) tail = await scan(false);
  const finite = (value) => (Number.isFinite(value) ? value : NaN);
  return { last: finite(tail.last), end: finite(tail.end) };
}
