// Domain timing configuration.
// Block structure + ward data are now fully stored in the database —
// the old static FLOOR_MAP / WARDS / SEED_ACCOUNTS constants have been removed.

export const PRE_INTERVAL_MIN = 120;       // PRE round every 2 hours — no shift windows, on duty 24/7
export const COO_REMINDERS = ["09:00", "12:00", "15:00", "18:00"];

/** Whether the user-entered date of admission may be in the future.
 *
 *  false (default): the date must be today (IST) or earlier — a patient cannot
 *  have been admitted on a day that hasn't happened yet. Flip to true if the
 *  hospital ever needs to pre-register an admission ahead of time.
 *
 *  Deliberately a single constant read by BOTH sides: the API validator enforces
 *  it, and GET /meta ships it to the client so the date picker's max bound is
 *  derived from the same value. A second copy in the frontend would silently
 *  drift the first time only one of them is changed. */
export const ALLOW_FUTURE_ADMISSION_DATE = false;

// ---- time helpers ----
export function hmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number); return h * 60 + m;
}

/** Returns a Date whose getHours/getMinutes reflect Asia/Kolkata time,
 *  regardless of the server's system timezone (Render runs UTC). */
function indiaTime(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

export function minsNow(): number {
  const d = indiaTime(); return d.getHours() * 60 + d.getMinutes();
}

export function todayStr(): string {
  const d = indiaTime();
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

/** Unix-ms for IST midnight of today (safe for DB range queries). */
export function startOfDayIST(): number {
  return new Date(todayStr() + "T00:00:00+05:30").getTime();
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date in YYYY-MM-DD form.
 *  The regex alone is not enough — it happily accepts 2026-02-31. JS rolls an
 *  out-of-range day forward into the next month, so the parsed date is formatted
 *  back to a string and compared: a rollover no longer matches what came in.
 *  Parsed as UTC so the server's own timezone can never shift the day. */
export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/** PRE rounds are due every PRE_INTERVAL_MIN, anchored at midnight IST —
 *  every PRE user is on duty all day, every day (no shift windows). */
export function currentRound(mins: number) {
  const idx = Math.floor(mins / PRE_INTERVAL_MIN);
  const startMin = idx * PRE_INTERVAL_MIN;
  return { idx, startMin, endMin: startMin + PRE_INTERVAL_MIN };
}

/** round_key format: "1A|2026-05-27|540"  (block name replaces pre_code) */
export function roundKey(blockName: string, date: string, startMin: number): string {
  return `${blockName}|${date}|${startMin}`;
}
