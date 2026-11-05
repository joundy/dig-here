import { createHmac, createPrivateKey, createPublicKey } from 'node:crypto';
import { baseEncode, KeyPair } from 'near-api-js';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Every backend key comes from one seed plus a label, so a new deploy works out the same keys
 * for bots and lanes with no key store to lose or leak.
 */
export function deriveKeyPair(seed: string, label: string): KeyPair {
  const secret = createHmac('sha256', seed).update(label).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, secret]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return KeyPair.fromString(`ed25519:${baseEncode(Buffer.concat([secret, publicKey]))}`);
}
