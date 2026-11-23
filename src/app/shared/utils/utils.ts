export function convertToDaysAndHours(
  date: Date | string | number,
  now: Date = new Date(),
): string {
  const target = new Date(date);
  if (isNaN(target.getTime())) {
    throw new Error('Invalid date');
  }

  const totalSeconds = Math.floor(Math.abs(now.getTime() - target.getTime()) / 1000);

  const SECOND = 1;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  const days = Math.floor(totalSeconds / DAY);
  const hours = Math.floor((totalSeconds % DAY) / HOUR);
  const minutes = Math.floor((totalSeconds % HOUR) / MINUTE);
  const seconds = totalSeconds % MINUTE;

  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'}`;

  const parts: string[] = [];

  if (days > 0) parts.push(unit(days, 'day'));
  if (hours > 0 && totalSeconds < 2 * DAY) parts.push(unit(hours, 'hour'));
  if (minutes > 0 && totalSeconds < DAY) parts.push(unit(minutes, 'minute'));
  if (seconds > 0 && totalSeconds < HOUR) parts.push(unit(seconds, 'second'));

  return parts.length > 0 ? parts.join(' ') : '0 seconds';
}
export interface FormatBytesOptions {
  /** Number of decimal places to display (default: 2) */
  decimals?: number;
  /** Use base-1024 (KiB, MiB) instead of base-1000 (KB, MB) (default: false) */
  binary?: boolean;
}

export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  const { decimals = 2, binary = false } = options;

  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes === 0) return '0 B';

  const isNegative = bytes < 0;
  const absBytes = Math.abs(bytes);

  const base = binary ? 1024 : 1000;
  const units = binary
    ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']
    : ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const dm = Math.max(0, decimals);
  const exponent = Math.min(Math.floor(Math.log(absBytes) / Math.log(base)), units.length - 1);

  const value = parseFloat((absBytes / Math.pow(base, exponent)).toFixed(dm));
  return `${isNegative ? '-' : ''}${value} ${units[exponent]}`;
}
