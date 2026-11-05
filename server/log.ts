// One line per event, so the log file stays greppable. Callers pass facts, never keys.
export function log(area: string, message: string, fields?: Record<string, unknown>): void {
  const extra = fields ? ' ' + JSON.stringify(fields, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) : '';
  console.log(`${new Date().toISOString()} [${area}] ${message}${extra}`);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
