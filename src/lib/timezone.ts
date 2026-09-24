/** Whether `name` is a time zone this runtime can compute dates in: an IANA name such as `Europe/Helsinki`. */
export function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
