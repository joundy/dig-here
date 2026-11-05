//! Rolls where every landmark stands, in the exact call order of `rollLayout` in `src/lib/game/map.ts`.
use crate::map_data::{spot, spot_count, Spot, MAPS};
use crate::rng::Stream;
use crate::rules::{BOX_GAP, KIND_SPREAD, LAYOUT_RESTARTS, LAYOUT_SAMPLES, LAYOUT_TRIES, MIN_SPACING};
use near_sdk::near;

/// Position and tags stay in the map's spot table, which saves a few bytes per landmark in every room.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug)]
pub struct Landmark {
    pub kind: u8,
    pub spot: u16,
    pub flip: bool,
}

struct Placed {
    kind: u8,
    x: i32,
    y: i32,
    left: i32,
    width: i32,
    height: i32,
}

fn clears(placed: &[Placed], left: i32, width: i32, height: i32, x: i32, y: i32) -> bool {
    let top = y - height;
    for o in placed {
        let (dx, dy) = ((o.x - x) as i64, (o.y - y) as i64);
        if dx * dx + dy * dy < MIN_SPACING * MIN_SPACING {
            return false;
        }
        let clear_x = o.left >= left + width + BOX_GAP || left >= o.left + o.width + BOX_GAP;
        let clear_y = o.y - o.height >= y + BOX_GAP || top >= o.y + BOX_GAP;
        if !clear_x && !clear_y {
            return false;
        }
    }
    true
}

fn best_spot(map: usize, placed: &[Placed], kind: u8, spread: i64, rng: &mut Stream) -> Option<u16> {
    let def = &MAPS[map].kinds[kind as usize];
    let (width, height) = (def.width as i32, def.height as i32);
    let count = spot_count(map) as u32;
    let mut best = None;
    let mut best_room = -1i64;
    let mut found = 0;
    let mut tries = 0;
    while tries < LAYOUT_TRIES && found < LAYOUT_SAMPLES {
        tries += 1;
        let index = rng.below(count) as usize;
        let Spot { x, y, kind_mask, .. } = spot(map, index);
        if kind_mask & (1 << kind) == 0 {
            continue;
        }
        let (x, y) = (x as i32, y as i32);
        let left = x - width / 2;
        if !clears(placed, left, width, height, x, y) {
            continue;
        }
        let mut room = i64::MAX;
        let mut too_close = false;
        for other in placed {
            let (dx, dy) = ((other.x - x) as i64, (other.y - y) as i64);
            let d2 = dx * dx + dy * dy;
            if other.kind == kind {
                if d2 < spread * spread {
                    too_close = true;
                    break;
                }
                room = room.min(d2 / 4);
            } else {
                room = room.min(d2);
            }
        }
        if too_close {
            continue;
        }
        found += 1;
        if room > best_room {
            best_room = room;
            best = Some(index as u16);
        }
    }
    best
}

/// Picky kinds go first, while the coast is still free. Each restart reshuffles from roster order,
/// carrying on with the same stream.
pub fn roll_layout(map: usize, rng: &mut Stream) -> Vec<Landmark> {
    let kinds = &MAPS[map].kinds;
    let mut roster = Vec::with_capacity(40);
    for (i, def) in kinds.iter().enumerate() {
        for _ in 0..def.count {
            roster.push(i as u8);
        }
    }
    'attempt: for _ in 0..=LAYOUT_RESTARTS {
        let mut pool = roster.clone();
        for i in (1..pool.len()).rev() {
            let j = rng.below(i as u32 + 1) as usize;
            pool.swap(i, j);
        }
        let mut placed: Vec<Placed> = Vec::with_capacity(pool.len());
        let mut landmarks = Vec::with_capacity(pool.len());
        for picky in [true, false] {
            for &kind in pool.iter().filter(|&&k| kinds[k as usize].habitat == picky) {
                let mut chosen = None;
                for spread in KIND_SPREAD {
                    chosen = best_spot(map, &placed, kind, spread, rng);
                    if chosen.is_some() {
                        break;
                    }
                }
                let Some(index) = chosen else { continue 'attempt };
                let flip = rng.below(2) == 0;
                let Spot { x, y, .. } = spot(map, index as usize);
                let def = &kinds[kind as usize];
                let (x, y) = (x as i32, y as i32);
                placed.push(Placed { kind, x, y, left: x - def.width as i32 / 2, width: def.width as i32, height: def.height as i32 });
                landmarks.push(Landmark { kind, spot: index, flip });
            }
        }
        return landmarks;
    }
    near_sdk::env::panic_str("No room for every landmark. Try creating the room again.")
}
