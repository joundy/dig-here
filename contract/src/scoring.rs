//! Whole-number scoring and ranking, as `scoreDig` and `rankDigs` in `src/lib/game/engine.ts`.
use crate::rules::{CLOSENESS_RANGE, CROWD_BPS, CROWD_RADIUS};

fn isqrt(n: u64) -> u64 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut next = (x + 1) / 2;
    while next < x {
        x = next;
        next = (x + n / x) / 2;
    }
    x
}

pub fn squared_distance(ax: u16, ay: u16, bx: u16, by: u16) -> i64 {
    let (dx, dy) = (ax as i64 - bx as i64, ay as i64 - by as i64);
    dx * dx + dy * dy
}

pub fn is_crowded(mut earlier: impl Iterator<Item = (u16, u16)>, x: u16, y: u16) -> bool {
    earlier.any(|(ox, oy)| squared_distance(ox, oy, x, y) <= CROWD_RADIUS * CROWD_RADIUS)
}

#[derive(Clone, Copy, Debug)]
pub struct Ranked {
    /// Index into the room's digs, in dig order.
    pub dig: u8,
    pub distance: u64,
    pub closeness: u64,
    pub score: u64,
    pub dug_at: u64,
}

#[allow(clippy::too_many_arguments)]
pub fn score_dig(dig: u8, x: u16, y: u16, bonus_bps: u32, crowded: bool, dug_at: u64, tx: u16, ty: u16) -> Ranked {
    let distance = isqrt(squared_distance(x, y, tx, ty) as u64 * 1_000_000);
    let closeness = 1000u64.saturating_sub(distance / CLOSENESS_RANGE);
    let crowd = if crowded { CROWD_BPS } else { 10000 };
    Ranked { dig, distance, closeness, score: closeness * bonus_bps as u64 * crowd / 100_000_000, dug_at }
}

fn goes_before(a: &Ranked, b: &Ranked) -> bool {
    if a.score != b.score {
        return a.score > b.score;
    }
    if a.score == 0 && a.distance != b.distance {
        return a.distance < b.distance;
    }
    a.dug_at < b.dug_at
}

/// Best score first. Equal scores go to whoever dug first; if nobody scored, closest wins. Digs tied on
/// everything keep their dig order, so this has to be stable. Insertion sort: at most 30 rows, and it
/// costs far less wasm than the standard library's sort.
pub fn rank(rows: &mut [Ranked]) {
    for i in 1..rows.len() {
        let row = rows[i];
        let mut j = i;
        while j > 0 && goes_before(&row, &rows[j - 1]) {
            rows[j] = rows[j - 1];
            j -= 1;
        }
        rows[j] = row;
    }
}

/// Exact pixel: the earliest dig on the treasure, so the jackpot can't be taken by copying.
pub fn first_exact_hit(digs: impl Iterator<Item = (u16, u16, u64)>, tx: u16, ty: u16) -> Option<usize> {
    let mut hit: Option<(usize, u64)> = None;
    for (i, (x, y, at)) in digs.enumerate() {
        if x == tx && y == ty && hit.is_none_or(|(_, best)| at < best) {
            hit = Some((i, at));
        }
    }
    hit.map(|(i, _)| i)
}
