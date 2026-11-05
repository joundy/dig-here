// Tests run in Node, but the app's type check leaves out Node's types, which would change browser
// globals such as setTimeout. Tests only need these two calls.
declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): { update(data: Uint8Array): { digest(): Uint8Array } };
}
declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
}
