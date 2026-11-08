// Doner Bros — restaurant-time dates. Every day, hour and month the dashboard groups by is an
// Asia/Karachi one, never UTC, so a day starts at midnight in Sargodha (19:00 UTC the day before).

const TIME_ZONE = "Asia/Karachi";
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const partsFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// { year, month, day, hour, minute, second } of an instant, in Karachi.
function karachiParts(instant) {
  const parts = {};
  for (const { type, value } of partsFormat.formatToParts(new Date(instant))) {
    if (type !== "literal") parts[type] = Number(value);
  }
  return parts;
}

const pad = (n) => String(n).padStart(2, "0");
const formatDate = ({ year, month, day }) => `${year}-${pad(month)}-${pad(day)}`;

// "YYYY-MM-DD" in Karachi for an instant.
function karachiDate(instant) {
  return formatDate(karachiParts(instant));
}

function karachiHour(instant) {
  return karachiParts(instant).hour;
}

// Parses "YYYY-MM-DD" into { year, month, day }, or null if it isn't a real calendar date.
function parseDate(text) {
  const match = DATE_PATTERN.exec(String(text || ""));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

function addDays(dateText, days) {
  const { year, month, day } = parseDate(dateText);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return formatDate({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() });
}

// Whole days from a to b ("YYYY-MM-DD"), b - a.
function daysBetween(a, b) {
  const pa = parseDate(a);
  const pb = parseDate(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY_MS);
}

// The UTC instant (ms) of Karachi midnight at the start of dateText.
function karachiMidnight(dateText) {
  const { year, month, day } = parseDate(dateText);
  const wallClockAsUtc = Date.UTC(year, month - 1, day);
  let guess = wallClockAsUtc;
  // Two passes settle the offset even if the zone ever changes it around that date.
  for (let i = 0; i < 2; i++) {
    const p = karachiParts(guess);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
    guess = wallClockAsUtc - offset;
  }
  return guess;
}

// Inclusive Karachi dates -> [startIso, endIso) in UTC, for created_at >= start and < end.
function dayRangeToUtc(from, to) {
  return {
    startIso: new Date(karachiMidnight(from)).toISOString(),
    endIso: new Date(karachiMidnight(addDays(to, 1))).toISOString(),
  };
}

// First and last day ("YYYY-MM-DD") of the Karachi calendar month containing dateText.
function monthBounds(dateText) {
  const { year, month } = parseDate(dateText);
  const first = formatDate({ year, month, day: 1 });
  const nextFirst = month === 12 ? formatDate({ year: year + 1, month: 1, day: 1 }) : formatDate({ year, month: month + 1, day: 1 });
  return { first, last: addDays(nextFirst, -1), month: `${year}-${pad(month)}` };
}

module.exports = {
  TIME_ZONE,
  karachiParts,
  karachiDate,
  karachiHour,
  parseDate,
  addDays,
  daysBetween,
  karachiMidnight,
  dayRangeToUtc,
  monthBounds,
};
