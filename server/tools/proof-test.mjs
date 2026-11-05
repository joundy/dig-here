// Rebuilds finished rounds from the indexer's events alone, using the game's real rules, and compares them with
// what the contract still holds. A room the contract has deleted can only pass by the events being complete.
//   node server/tools/proof-test.mjs <room id>...      or with no ids, every finished game the indexer knows
import { resolve } from 'node:path';
import { runnerImport } from 'vite';

const load = async (p) => (await runnerImport(resolve(p), { configFile: false, logLevel: 'error' })).module;
const { streamRng, rollSeed, layoutSeed, digsHash, sha256, fromHex, toHex } = await load('src/lib/game/random.ts');
const { rollLayout } = await load('src/lib/game/map.ts');
const { rollNextClue } = await load('src/lib/game/clues.ts');
const { rollTreasure, rankDigs, scoreDig, splitPot } = await load('src/lib/game/engine.ts');

const API = process.env.API ?? 'http://localhost:8787';
const RPC = 'https://near-testnet.drpc.org';

async function chainRoom(id) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: 'v1.dighere.testnet', method_name: 'get_room', args_base64: Buffer.from(JSON.stringify({ id })).toString('base64') } }),
  });
  const j = await res.json();
  const bytes = j.result?.result;
  if (!bytes) return null;
  return JSON.parse(Buffer.from(bytes).toString());
}

function check(room, proof) {
  const problems = [];
  const expect = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${label}: got ${JSON.stringify(got)?.slice(0, 90)}, want ${JSON.stringify(want)?.slice(0, 90)}`);
  };
  const only = (name) => proof.events.filter((e) => e.event === name).map((e) => e.data);
  const created = only('room_created')[0];
  if (!created) return { problems: ['no room_created event'] };
  const finished = only('finished')[0];
  const refunded = only('refunded')[0];
  if (!finished && !refunded) return { problems: ['never ended'] };
  const digs = only('dig');
  const reveals = only('revealed');
  const locks = only('locked');

  // The layout, from nothing but seeds in the event.
  const seed = layoutSeed(room, fromHex(created.block_seed), fromHex(created.tip));
  expect('layout seed', toHex(seed), created.layout_seed);
  const landmarks = rollLayout(created.map, streamRng(seed));
  expect('layout', landmarks.map((l) => [l.kind, l.x, l.y, Boolean(l.flip)]), created.landmarks.map((l) => [l.kind, l.x, l.y, Boolean(l.flip)]));

  const hashed = digs.map((d) => ({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, dugAtMs: d.dug_at_ms }));
  const game = { landmarks, candidateIds: landmarks.map((l) => l.id), clues: [{ level: 'yolo' }], mapId: created.map };
  let previous = created.tip;
  for (const r of reveals) {
    const lock = locks.find((l) => l.step === r.step);
    if (!lock) problems.push(`step ${r.step}: reveal with no lock`);
    expect(`step ${r.step} chain`, toHex(sha256(fromHex(r.link))), previous);
    previous = r.link;
    expect(`step ${r.step} digs hash`, toHex(digsHash(hashed.slice(0, lock.digs_count))), r.digs_hash);
    const rollHex = toHex(rollSeed(room, r.step, fromHex(r.lock_seed), fromHex(r.link), fromHex(r.digs_hash)));
    expect(`step ${r.step} roll seed`, rollHex, r.roll_seed);
    const stream = streamRng(fromHex(r.roll_seed));
    if (r.step < 4) {
      rollNextClue(game, stream);
      expect(`step ${r.step} clue`, game.clues[r.step], r.clue);
      expect(`step ${r.step} candidates`, game.candidateIds, r.candidates_after);
    } else {
      const t = rollTreasure(game, stream);
      expect('treasure', { x: t.x, y: t.y, landmark_id: t.landmarkId }, r.treasure);
    }
  }
  if (finished) {
    expect('finished treasure', finished.treasure, reveals.at(-1)?.treasure);
    const split = splitPot(finished.pot, finished.host_cut_bps);
    expect('split', { host_cut: split.hostCut, jackpot: split.jackpot, deed: split.deed, season: split.season, prize: split.prize }, finished.split);
    const ranked = rankDigs(digs.map((d) => scoreDig({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, bonusBps: d.bonus_bps, crowded: d.crowded, at: d.dug_at_ms }, finished.treasure, finished.closeness_range ?? created.closeness_range ?? 48)));
    expect('ranking', ranked.map((d) => [d.account, d.score]), finished.ranking.map((d) => [d.account, d.score]));
    expect('winner', ranked[0]?.account, finished.winner);
  }
  return { problems, digs: digs.length, reveals: reveals.length, ended: finished ? 'finished' : `refunded ${refunded.reason}` };
}

let ids = process.argv.slice(2).map(Number);
if (!ids.length) {
  const list = await (await fetch(`${API}/api/finished-games?limit=100`)).json();
  ids = list.games.map((g) => g.room_id);
}
let bad = 0;
for (const id of ids) {
  const res = await fetch(`${API}/api/games/${id}/proof`);
  const proof = await res.json();
  if (!res.ok) {
    console.log(id, 'no proof', proof);
    bad++;
    continue;
  }
  const out = check(id, proof);
  const onChain = await chainRoom(id);
  if (onChain?.result) {
    // Whatever the contract still has must match what the events say.
    const reveals = proof.events.filter((e) => e.event === 'revealed').map((e) => e.data);
    for (const r of onChain.rolls) {
      const ev = reveals.find((x) => x.step === r.step);
      if (r.link && ev?.link !== r.link) out.problems.push(`step ${r.step} differs from get_room`);
    }
    if (onChain.result.winner !== (proof.events.find((e) => e.event === 'finished')?.data.winner ?? null)) out.problems.push('winner differs from get_room');
  }
  if (out.problems.length) bad++;
  console.log(`room ${id}: ${onChain ? 'still on chain' : 'DELETED from contract'}; ${out.ended}; ${out.digs} digs, ${out.reveals} reveals; ${out.problems.length ? 'PROBLEMS ' + out.problems.join(' | ') : 'all recomputed OK'}`);
}
process.exit(bad ? 1 : 0);
