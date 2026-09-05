/** Number and time formatting. No Intl: Hermes' locale support varies by platform. */

/** 1250 -> "1,250". Negative numbers get a true minus sign. */
export function fmtPoints(n: number): string {
  const abs = Math.abs(Math.round(n));
  const grouped = String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `−${grouped}` : grouped;
}

/** +250 / −250 / 0. */
export function fmtSigned(n: number): string {
  if (n > 0) {
    return `+${fmtPoints(n)}`;
  }
  return fmtPoints(n);
}

/** 1250 -> "1.2K" for the balance pill. */
export function compactPoints(n: number): string {
  if (Math.abs(n) >= 1000) {
    return `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(n));
}

/** 87 -> "1:27". */
export function formatSeconds(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** 874 tenths -> "1:27.4". The hold timer on camera. */
export function formatTenths(tenths: number): string {
  const whole = Math.max(0, Math.floor(tenths));
  return `${formatSeconds(Math.floor(whole / 10))}.${whole % 10}`;
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "Today" / "Yesterday" / "Tue" (this week) / "Aug 12". */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return '';
  }
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfThen = new Date(
    then.getFullYear(),
    then.getMonth(),
    then.getDate(),
  ).getTime();
  const days = Math.round((startOfToday - startOfThen) / DAY);
  if (days <= 0) {
    return 'Today';
  }
  if (days === 1) {
    return 'Yesterday';
  }
  if (days < 7) {
    return WEEKDAY[then.getDay()] ?? '';
  }
  return `${MONTH[then.getMonth()]} ${then.getDate()}`;
}
