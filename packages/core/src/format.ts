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

/** Render a byte count for a person. Disk figures reach the gigabytes, and a
 *  raw byte count at that size is unreadable. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
