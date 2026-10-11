const civilDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function approvedCivilDay(approvedAt: string): string {
  const parts = new Map(
    civilDateFormatter.formatToParts(new Date(approvedAt)).map(({ type, value }) => [type, value]),
  );
  return [parts.get("year"), parts.get("month"), parts.get("day")].join("-");
}

export function isPastDeadline(approvedAt: string, deadlineDate: string): boolean {
  return approvedCivilDay(approvedAt) > deadlineDate;
}
