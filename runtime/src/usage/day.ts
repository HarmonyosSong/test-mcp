/** Calendar-day helpers for usage stats (default Asia/Shanghai). */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateYmd(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const utc = Date.UTC(y!, m! - 1, d!);
  const check = new Date(utc);
  return (
    check.getUTCFullYear() === y
    && check.getUTCMonth() === m! - 1
    && check.getUTCDate() === d
  );
}

/** Format a Date as YYYY-MM-DD in the given IANA timezone. */
export function calendarDateInTimeZone(date: Date, timeZone: string): string {
  // formatToParts avoids en-CA locale quirks (some runtimes emit YYYY/MM/DD).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${map.year}-${map.month}-${map.day}`;
}

/** Yesterday's calendar date in timezone. */
export function yesterdayYmd(timeZone: string, now = new Date()): string {
  const today = calendarDateInTimeZone(now, timeZone);
  for (let hours = 1; hours <= 48; hours += 1) {
    const ymd = calendarDateInTimeZone(new Date(now.getTime() - hours * 3_600_000), timeZone);
    if (ymd !== today) return ymd;
  }
  return calendarDateInTimeZone(new Date(now.getTime() - 24 * 3_600_000), timeZone);
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - date.getTime();
}

/** Convert zoned wall-clock on dateYmd to UTC Date. */
export function zonedDateTimeToUtc(dateYmd: string, hms: string, timeZone: string): Date {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const [hh, mm, ss] = hms.split(':').map(Number);
  let utc = Date.UTC(y!, m! - 1, d!, hh!, mm!, ss ?? 0);
  const offset = tzOffsetMs(new Date(utc), timeZone);
  utc -= offset;
  const offset2 = tzOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset) {
    utc = Date.UTC(y!, m! - 1, d!, hh!, mm!, ss ?? 0) - offset2;
  }
  return new Date(utc);
}

/** Add one calendar day to YYYY-MM-DD (Gregorian, via UTC date arithmetic). */
export function addCalendarDays(dateYmd: string, days: number): string {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

export function dayWindow(dateYmd: string, timeZone: string): { from: Date; toInclusive: Date } {
  const from = zonedDateTimeToUtc(dateYmd, '00:00:00', timeZone);
  const nextStart = zonedDateTimeToUtc(addCalendarDays(dateYmd, 1), '00:00:00', timeZone);
  return { from, toInclusive: new Date(nextStart.getTime() - 1) };
}

export function isInstantInDay(iso: string, dateYmd: string, timeZone: string): boolean {
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return false;
  return calendarDateInTimeZone(created, timeZone) === dateYmd;
}

/** Inclusive calendar-day range check (YYYY-MM-DD string compare). */
export function isInstantInRange(
  iso: string,
  fromYmd: string,
  toYmd: string,
  timeZone: string,
): boolean {
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return false;
  const ymd = calendarDateInTimeZone(created, timeZone);
  return ymd >= fromYmd && ymd <= toYmd;
}

export function todayYmd(timeZone: string, now = new Date()): string {
  return calendarDateInTimeZone(now, timeZone);
}
