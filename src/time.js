export function parseTime(value) {
  const parts = String(value).replace(/s$/, '').split(':');
  const clockFields = parts.length === 2 ? parts : parts.slice(1);
  if (parts.length > 3 || parts.some((part, i) => !(i === parts.length - 1 ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(part))
    || clockFields.some((part) => Number(part) >= 60)) {
    throw new Error(`invalid time: ${value}`);
  }
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (!Number.isFinite(seconds)) throw new Error(`invalid time: ${value}`);
  return seconds;
}

export function formatTimecode(seconds) {
  const total = Math.round(seconds * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const hours = Math.floor(total / 3600000);
  const clock = `${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
  return hours ? `${hours}:${clock}` : clock;
}
