// Parses --crop fractions and maps them to even pixel offsets and sizes in the source's displayed orientation.
// FFmpeg auto-rotates before -vf. SAR stretches one displayed axis uniformly, so equal fractions of stored pixels
// still name the displayed region; `displayed` is that region's size in square pixels (see displayedSize).
export function parseCrop(value, info) {
  const parts = String(value).split(',');
  const numbers = parts.map((part) => (/^\s*\d*\.?\d+\s*$/.test(part) ? Number(part) : NaN));
  if (parts.length !== 4 || numbers.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new Error(`--crop must be four fractions from 0 to 1 (x,y,w,h): ${value}`);
  }
  const [x, y, w, h] = numbers;
  if (w <= 0 || h <= 0) throw new Error(`--crop width and height must be above 0: ${value}`);
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) throw new Error(`--crop region must fit in the frame (x+w and y+h at most 1): ${value}`);
  const axis = (start, size, total) => {
    const offset = Math.floor(start * total / 2) * 2;
    return [offset, Math.min(Math.round(size * total / 2) * 2, Math.floor((total - offset) / 2) * 2)];
  };
  const [px, width] = axis(x, w, info.width);
  const [py, height] = axis(y, h, info.height);
  if (width < 16 || height < 16) throw new Error(`--crop region is ${width}x${height} source pixels; it must be at least 16x16`);
  return { x, y, w, h, pixels: { x: px, y: py, width, height, displayed: displayedSize(width, height, info) } };
}

// Square-pixel size of width x height stored pixels in displayed orientation. SAR scales the coded horizontal axis,
// keeping the other at stored resolution; after a 90/270 turn that axis is displayed vertically. info.sar is
// rotation-adjusted (inverted on a turn, as FFmpeg's transpose does), so dividing by it applies the coded SAR.
export function displayedSize(width, height, info) {
  const sar = info.sar ?? 1;
  return info.rotation === 90 || info.rotation === 270
    ? { width, height: Math.max(2, Math.round(height / sar)) }
    : { width: Math.max(2, Math.round(width * sar)), height };
}
