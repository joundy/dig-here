# Shared test vectors

`vectors.json` is written by `npm run gen-vectors` (`scripts/gen-vectors.ts`) from the TypeScript rules, and both
sides must reproduce it exactly. `src/lib/game/generated.test.ts` fails if it drifts from the rules. Map data
formats are in `contract/data/README.md`.

Conventions: bytes are lowercase hex. Money is whole milliNEAR. Field names are `snake_case`. Kinds and tags are
their names, and tag lists are in order, because that order is part of the rules. `credits` lists what each account
gained from a zero balance: an account that's missing gained 0, and one listed with 0 may or may not exist on your side.

## Byte layouts

`||` is concatenation, and `H` is SHA-256.

| Value | Bytes |
|---|---|
| `hash_chain(s)` | `tip = H(H(H(H(s))))`. Revealed in order: `links[0] = H(H(H(s)))`, `links[1] = H(H(s))`, `links[2] = H(s)`, `links[3] = s` |
| `digs_hash` | `H` over each dig in order: account UTF-8 `\|\|` `0x00` `\|\|` x u16 LE `\|\|` y u16 LE `\|\|` clue_index u8 `\|\|` dug_at_ms u64 LE. No digs: `H` of empty |
| `roll_seed` | `H("dig-here-v1" \|\| room_id u64 LE \|\| step u8 \|\| lock_seed \|\| link \|\| digs_hash)`, the last three 32 bytes each |
| `layout_seed` | `H("dig-here-layout-v1" \|\| room_id u64 LE \|\| block_seed \|\| tip)`, the last two 32 bytes each |
| Stream block k | `H(seed \|\| k u32 LE)`, k from 0, read as eight u32 LE words in order |

## Number stream

`below(n)`, for n from 1 to 2^32 - 1:

```
limit = 2^32 - (2^32 mod n)     // compute in u64: for n = 1 the limit is 2^32
word = next word; repeat while word >= limit
return word mod n
```

`below(1)` still uses up a word. Everything below calls it `rng(n)`.

## Exact call order

Each roll gets a fresh stream from its own seed. Any call not listed draws nothing.

**Layout**, `rollLayout` in `src/lib/game/map.ts`, from the layout seed:

```
for attempt in 0..=20:                       // 1 try plus at most 20 restarts, then panic
  pool = each kind in roster order, repeated by its count (always fresh: a restart reshuffles from roster order)
  for i = len - 1 down to 1: j = rng(i + 1); swap pool[i], pool[j]
  order = pool's habitat kinds, then the other kinds, each keeping pool order
  placed = []
  for kind in order:
    for spread in [90, 70, 50, 36]:
      best = none; best_room = -1; found = 0; tries = 0
      while tries < 150 and found < 8:
        tries += 1
        spot = spots[rng(spots.len)]         // always one draw per try, whatever happens to the spot
        if the spot's kindMask lacks this kind: continue
        if spot doesn't clear every placed landmark: continue
        room = infinity
        for other in placed:
          d2 = dx*dx + dy*dy
          if other.kind == kind and d2 < spread*spread: reject this spot, continue the while loop
          room = min(room, other.kind == kind ? floor(d2 / 4) : d2)
        found += 1
        if room > best_room: best = spot; best_room = room     // strictly greater: the first of equals stays
      if best:
        flip = rng(2) == 0                   // drawn right after placing, before the next kind
        place at best: id = placed.len, tags from the spot
        go to the next kind
    all four spreads found nothing: restart the whole attempt, carrying on with the same stream
```

Clearing a placed landmark `o` for a new one at (x, y):

```
dx*dx + dy*dy >= 20*20
and the footprint boxes are 2 or more pixels apart on x or y:
  left = x - floor(w / 2), top = y - h, and the same for o
  o.left >= left + w + 2  or  left >= o.left + o.w + 2  or  o.y - o.h >= y + 2  or  top >= o.y + 2
```

**Clues**, `rollNextClue` in `src/lib/game/clues.ts`:

| Clue | Stream | Calls in order |
|---|---|---|
| 1, at start | none | Always `yolo`. Draws nothing |
| 2 | step 1 | `seed = candidates[rng(candidates.len)]`. Clue is the seed's category. Keep candidates of that category |
| 3 | step 2 | `seed = candidates[rng(candidates.len)]`. Clue is the seed's kind. Keep candidates of that kind |
| 4 | step 3 | `seed = candidates[rng(candidates.len)]`, then `options = tag_options(seed, candidates)`, then `tag = options[rng(options.len)]`. Clue is the seed's kind plus the tag. Keep candidates with that tag |

Candidates keep their order, and start as every landmark by id. The seed is forgotten once the clue is public.

`tag_options(seed, candidates)`, with `n(t)` = how many candidates have tag t, each list keeping the order of the seed's tags:

```
ideal = seed's tags with n(t) < candidates.len and n(t) >= 2.   If any: return ideal.
narrowing = seed's tags with n(t) < candidates.len.             If any: return narrowing.
return all of the seed's tags
```

**Treasure**, step 4, `rollTreasure` in `src/lib/game/engine.ts`:

```
id = candidates[rng(candidates.len)]
repeat up to 60 times:
  x = landmark.x + rng(27) - 13          // x first, then y. 27 = 13 * 2 + 1
  y = landmark.y + rng(27) - 13
  if dx*dx + dy*dy <= 13*13 and (x, y) is land: return it
return the landmark's own position
```

x and y can go negative or off the map there, so use signed numbers. Off the map is never land.

## Whole-number rules

`d2` is squared distance in pixels.

| Rule | Formula |
|---|---|
| Crowded | Any earlier dig with `d2 <= 6*6` |
| `distance` | `isqrt(d2 * 1_000_000)`, floor of the square root, in thousandths of a pixel |
| `closeness` | `max(0, 1000 - floor(distance / range))`. `range` is the room's: 96, or 48 for rooms from before the change. Each `scores` case states its own |
| `score` | `floor(closeness * bonus_bps * (crowded ? 8500 : 10000) / 100_000_000)`. Fits in u64 |
| Ranking | Higher score first. If both scores are 0, smaller distance first. Then earlier `dug_at`. Still tied: dig order, so **sort stably** |
| Pot split | Each of host cut, jackpot (300), deed (200), season (100) is `floor(pot * bps / 10000)`. The prize is whatever is left |
| Season points | Only with 3 or more digs. Place 1, 2, 3 get `floor(pot * [100, 30, 10] / 1000)`. Points of 0 still create an entry |

### Settling a finished room, in this order

Each line can depend on the one before, especially the jackpot.

1. Host gets the bond back, plus the host cut. Winner gets the prize.
2. Season pool grows by `season`. Jackpot grows by `jackpot`.
3. The landmark under the treasure gives the deed: `landings += 1`. An owner gets `deed` and `earned += deed`. No owner: jackpot grows by `deed`.
4. Exact pixel hit: the first dig by `dug_at` with the treasure's x and y wins `min(floor(jackpot * 8000 / 10000), pot * 100)`, using the jackpot **after** steps 2 and 3.
5. Season points, by ranking.

### Refunds

Every player gets the fee back. The host then gets:

| Reason | Bond | Other |
|---|---|---|
| `too-few-digs`: under 2 digs at the end | Whole | |
| `expired` | Less 10%: `floor(bond * 1000 / 10000)` goes to the jackpot | Host's `expired` count + 1 |
| `missed-reveal` | Whole | Contract's `missed_reveals` + 1, which isn't in these vectors |

### Closing a season

Rank by points, highest first, then by account name **compared byte by byte**. Drop accounts ending in the excluded suffix (an empty suffix drops nobody), so whoever ranked below them moves up. Places 1, 2, 3 get `floor(starting_pool * [6000, 3000, 1000] / 10000)`, and the rest stays in the pool. Prizes of 0 are still listed.

## Areas in vectors.json

| Area | What to check |
|---|---|
| `rules` | The constants these cases assume. `host_bond` is the contract's config value on testnet |
| `map_facts` | Roster order, spot count and SHA-256 of each `contract/data` file |
| `below_streams` | `values[i] = below(ns[i])` from one stream on `seed` |
| `layouts` | `landmarks` from `seed`, in placement order, so index is id |
| `clue_rolls` | `clue` and `candidates_after` from `candidates` at `level`: the number of clues already out |
| `treasure_rolls` | `treasure` from `candidates`. An odd `candidates` list is deliberate, such as open sea to reach the fallback |
| `digs_hashes`, `roll_seeds`, `layout_seeds`, `hash_chains` | The byte layouts above |
| `land_points` | The land bitmap, including off the map |
| `crowding` | `crowded` for `spot` against `digs` |
| `scores`, `rankings`, `pot_splits` | The formulas above |
| `settlements` | Everything a finished room moves, from zero balances and `jackpot_before` |
| `refunds` | Same, for refunded rooms |
| `season_closes` | `prizes`, `pool_after` and `credits` |
| `rounds` | One room from start to finish in contract order: the layout seed, then each step's digs hash, roll seed, roll, then the ranking and split |

`layouts`, `clue_rolls`, `treasure_rolls` and `rounds` give `draws`, the number of `rng` calls, and `after`, the value of `rng(1000000)` right afterwards. Those catch a stream left in the wrong position, even when the result looks right.
