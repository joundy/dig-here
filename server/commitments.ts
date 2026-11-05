import { createHash, createHmac } from 'node:crypto';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();

/** The oracle stores nothing: every secret is recomputed from ORACLE_SECRET and the tip's index on chain. */
export function secretFor(oracleSecret: string, tipIndex: number): Buffer {
  return createHmac('sha256', oracleSecret).update(String(tipIndex)).digest();
}

/** links[0] is step 1 (H³(s)), ..., links[3] is step 4 (s). The tip is H⁴(s). */
export function chainFor(oracleSecret: string, tipIndex: number): { tip: string; links: string[] } {
  const s = secretFor(oracleSecret, tipIndex);
  const h1 = sha256(s);
  const h2 = sha256(h1);
  const h3 = sha256(h2);
  const tip = sha256(h3);
  return { tip: tip.toString('hex'), links: [h3, h2, h1, s].map((b) => b.toString('hex')) };
}
