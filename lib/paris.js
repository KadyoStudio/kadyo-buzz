/** Paris wall-clock time: stamp "YYYY-MM-DDTHH:MM" (comparable with calendar entries), date, hour, weekday. */
export function parisNow(at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { stamp: `${date}T${parts.hour}:${parts.minute}`, date, hour: Number(parts.hour), weekday: parts.weekday };
}

export const parisDate = () =>
  new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", year: "numeric" }).format(new Date());
