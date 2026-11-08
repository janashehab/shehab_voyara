/** Label for an approved sample route. Zero days are omitted by the caller. */
export function sampleDaysLabel(count: number, leading: "Read" | "The"): string {
  if (leading === "Read") {
    return count === 1 ? "Read the day" : `Read the ${count} days`;
  }

  return count === 1 ? "The day" : `The ${count} days`;
}

export function regionName(countryCode: string): string {
  const name = new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode);
  return name && name !== countryCode ? name : countryCode;
}

export function durationLabel(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) {
    return null;
  }

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  if (remainder === 0) {
    return hours === 1 ? "1 hr" : `${hours} hr`;
  }

  return `${hours} hr ${remainder} min`;
}
