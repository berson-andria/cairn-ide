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
