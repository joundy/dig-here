const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Block hashes and random values come as base58. The verify screen shows them beside the contract's hex. */
export function fromBase58ToHex(text: string): string {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error('Not base58');
    value = value * 58n + BigInt(digit);
  }
  return value.toString(16).padStart(64, '0');
}
