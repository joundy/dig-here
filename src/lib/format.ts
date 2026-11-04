export function near(milli: number): string {
  return `${Number((milli / 1000).toFixed(3))} NEAR`;
}

export function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(whole / 60);
  return `${m}:${String(whole % 60).padStart(2, '0')}`;
}

export function percent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** A bonus or penalty in basis points, like ×2.5. */
export function bonus(bps: number): string {
  return `×${bps / 10000}`;
}

/** Closeness and scores are stored in tenths of a point. */
export function points(tenths: number): string {
  return String(tenths / 10);
}

/** A long time, for season countdowns: "3d 4h", "4h 12m", or "12:30". */
export function longTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return clock(s);
}
