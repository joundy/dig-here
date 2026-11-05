export const YOCTO_PER_NEAR = 10n ** 24n;
export const YOCTO_PER_MILLI = 10n ** 21n;
export const TGAS = 10n ** 12n;

/** Whole-number arithmetic on the way in, so 0.3 can't pick up float noise. */
export function near(amount: number | string): bigint {
  const [whole, frac = ''] = String(amount).split('.');
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt((frac + '0'.repeat(24)).slice(0, 24));
}

export function milli(amount: number): bigint {
  return BigInt(amount) * YOCTO_PER_MILLI;
}

export function toNear(yocto: bigint | string, digits = 4): string {
  const v = BigInt(yocto);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const whole = abs / YOCTO_PER_NEAR;
  const frac = (abs % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, digits);
  return `${sign}${whole}.${frac}`;
}
