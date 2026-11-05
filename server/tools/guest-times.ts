// How long from a request until a guest's first transaction could go out: the wait a juror feels.
import { KeyPair } from 'near-api-js';
import { viewAccessKey } from '../rpc.ts';

const N = Number(process.argv[2] ?? 5);
const times: number[] = [];
for (let i = 0; i < N; i++) {
  const key = KeyPair.fromRandom('ed25519');
  const t = Date.now();
  const res = await fetch('http://localhost:8787/api/guest-accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ public_key: key.getPublicKey().toString() }),
  });
  const body: any = await res.json();
  const ms = Date.now() - t;
  const visible = res.ok ? Boolean(await viewAccessKey(body.account_id, key.getPublicKey().toString())) : false;
  console.log(res.status, body.account_id ?? body.error, `${ms} ms`, 'key visible at once', visible);
  if (res.ok) times.push(ms);
}
times.sort((a, b) => a - b);
console.log({ n: times.length, min: times[0], p50: times[times.length >> 1], max: times.at(-1) });
