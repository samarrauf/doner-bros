// Doner Bros — checks a requested pickup time against data/restaurant.json opening hours.
// A pickup time is optional; without one the order is for as soon as possible.

const RESTAURANT_TIMEZONE = "Asia/Karachi";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MINUTES_PER_DAY = 24 * 60;

// "18:30", "6:30 pm", "6pm" -> minutes after midnight, or null if it can't be read.
function parseClockTime(text) {
  const match = String(text || "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (minutes > 59) return null;
  if (match[3]) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (match[3] === "pm" ? 12 : 0);
  } else if (match[2] === undefined || hours > 23) {
    return null; // a bare "6" is ambiguous
  }
  return hours * 60 + minutes;
}

function formatClockTime(minutes) {
  const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// "Monday – Thursday" or "Sunday" -> day indexes, or null if it can't be read.
function parseDays(text) {
  const names = String(text || "").split(/\s*[–-]\s*/);
  const indexes = names.map((name) => DAYS.indexOf(name.trim()));
  if (indexes.some((i) => i < 0) || indexes.length > 2) return null;
  if (indexes.length === 1) return indexes;
  const days = [];
  for (let i = indexes[0]; ; i = (i + 1) % 7) {
    days.push(i);
    if (i === indexes[1]) return days;
  }
}

// Opening hours for one weekday as { open, close } minutes; close is past 1440 when it's after midnight.
function hoursFor(hours, dayIndex) {
  for (const entry of Array.isArray(hours) ? hours : []) {
    const days = parseDays(entry && entry.days);
    if (!days || !days.includes(dayIndex)) continue;
    const open = parseClockTime(entry.open);
    const close = parseClockTime(String(entry.close || "").split(" ")[0]);
    if (open === null || close === null) return null;
    return { open, close: close <= open ? close + MINUTES_PER_DAY : close };
  }
  return null;
}

function nowInRestaurant(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: RESTAURANT_TIMEZONE, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  return { dayIndex: DAYS.indexOf(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Returns { time: "HH:MM" } or { error }. The time must be later than now and inside today's
// opening hours, which may run past midnight. Times are in minutes from today's midnight.
function checkPickupTime(text, now, hours) {
  const clock = parseClockTime(text);
  if (clock === null) return { error: `"${text}" isn't a time I can read. Give it like 18:30 or 6:30 pm.` };

  const today = nowInRestaurant(now);
  const time = clock > today.minutes ? clock : clock + MINUTES_PER_DAY;
  const windows = [];
  for (const offset of [-1, 0]) {
    const day = hoursFor(hours, (today.dayIndex + offset + 7) % 7);
    if (day) windows.push({ start: offset * MINUTES_PER_DAY + day.open, end: offset * MINUTES_PER_DAY + day.close });
  }
  if (!hoursFor(hours, today.dayIndex)) {
    return { error: "today's opening hours couldn't be checked, so a set pickup time can't be taken. The order can be for as soon as possible." };
  }

  if (!windows.some((w) => time >= w.start && time < w.end)) {
    return { error: `${formatClockTime(clock)} is outside today's opening hours, or has already passed.` };
  }
  return { time: formatClockTime(clock) };
}

module.exports = { checkPickupTime, parseClockTime };
