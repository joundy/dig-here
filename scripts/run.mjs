// Runs a generator through Vite, so scripts share the game's TypeScript without a build step or a new
// dependency. A generator is pure: it returns { path: contents } and only this file touches the disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runnerImport } from 'vite';

const script = process.argv[2];
if (!script) throw new Error('Usage: node scripts/run.mjs scripts/<generator>.ts');
const { module } = await runnerImport(resolve(script), { configFile: false, logLevel: 'error' });
const outputs = module.default();
for (const [path, contents] of Object.entries(outputs)) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  console.log(`${path}  ${Buffer.byteLength(contents)} bytes`);
}
