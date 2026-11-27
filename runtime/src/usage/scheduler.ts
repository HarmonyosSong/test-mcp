import { addCalendarDays, calendarDateInTimeZone, yesterdayYmd, zonedDateTimeToUtc } from './day.js';

/** Minimal 5-field cron: `m h * * *` (minute hour only; day/month/dow must be *). */
export function parseDailyCron(cron: string): { minute: number; hour: number } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteRaw, hourRaw, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*' || dow !== '*') return null;
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return { minute, hour };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Next fire time for daily cron in timezone (strictly after `from`). */
export function nextCronFire(
  cron: string,
  timeZone: string,
  from = new Date(),
): Date | null {
  const parsed = parseDailyCron(cron);
  if (!parsed) return null;
  const hms = `${pad(parsed.hour)}:${pad(parsed.minute)}:00`;
  const todayYmd = calendarDateInTimeZone(from, timeZone);
  let candidate = zonedDateTimeToUtc(todayYmd, hms, timeZone);
  if (candidate.getTime() <= from.getTime()) {
    candidate = zonedDateTimeToUtc(addCalendarDays(todayYmd, 1), hms, timeZone);
  }
  return candidate;
}

export type DigestSchedulerHandle = {
  close: () => void;
};

/**
 * Schedule daily digest callback. Uses setTimeout chain (single-replica).
 * Invokes `onFire` with yesterday's YMD in timezone.
 */
export function startDigestScheduler(options: {
  cron: string;
  timeZone: string;
  onFire: (yesterdayYmd: string) => void | Promise<void>;
  now?: () => Date;
}): DigestSchedulerHandle | null {
  const fireAt = nextCronFire(options.cron, options.timeZone, options.now?.() ?? new Date());
  if (!fireAt) return null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const schedule = (from: Date) => {
    if (closed) return;
    const next = nextCronFire(options.cron, options.timeZone, from);
    if (!next) return;
    const delay = Math.max(1_000, next.getTime() - (options.now?.().getTime() ?? Date.now()));
    timer = setTimeout(() => {
      void (async () => {
        const ymd = yesterdayYmd(options.timeZone, options.now?.() ?? new Date());
        try {
          await options.onFire(ymd);
        } catch {
          // caller logs; keep scheduler alive
        }
        schedule(new Date((options.now?.() ?? new Date()).getTime() + 1_000));
      })();
    }, delay);
  };

  schedule(options.now?.() ?? new Date());

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
