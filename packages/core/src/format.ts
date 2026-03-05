const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });

export function timeAgo(timestamp: string): string {
  const seconds = Math.floor((new Date(timestamp).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.trunc(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.trunc(seconds / 3600), "hour");
  if (abs < 2592000) return rtf.format(Math.trunc(seconds / 86400), "day");
  if (abs < 31536000) return rtf.format(Math.trunc(seconds / 2592000), "month");
  return rtf.format(Math.trunc(seconds / 31536000), "year");
}
