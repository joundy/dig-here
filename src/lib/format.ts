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

export function bonus(value: number): string {
  return `×${value}`;
}
