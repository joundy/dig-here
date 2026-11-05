//! Rolls clues and the treasure in the call order of `clues.ts` and `rollTreasure` in `engine.ts`.
//! The landmark a clue is seeded from is forgotten at once: only the public clue survives.
use crate::map_data::is_land;
use crate::rng::Stream;
use crate::rules::{TREASURE_ATTEMPTS, TREASURE_SCATTER};
use near_sdk::near;

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Clue {
    Yolo,
    Category(u8),
    Kind(u8),
    Detail(u8, u8),
}

#[derive(Clone, Copy, Debug)]
pub struct Candidate {
    pub id: u8,
    pub kind: u8,
    pub category: u8,
    /// A bit set, in `TAGS` order.
    pub tags: u8,
}

const TAG_BITS: u8 = 6;

/// Prefers a tag that narrows things down but leaves more than one option, to keep the end uncertain.
fn tag_options(seed: &Candidate, candidates: &[Candidate]) -> Vec<u8> {
    let of_seed = || (0..TAG_BITS).filter(|t| seed.tags & (1 << t) != 0);
    let remaining = |t: u8| candidates.iter().filter(|c| c.tags & (1 << t) != 0).count();
    let ideal: Vec<u8> = of_seed().filter(|&t| remaining(t) < candidates.len() && remaining(t) >= 2).collect();
    if !ideal.is_empty() {
        return ideal;
    }
    let narrowing: Vec<u8> = of_seed().filter(|&t| remaining(t) < candidates.len()).collect();
    if !narrowing.is_empty() {
        return narrowing;
    }
    of_seed().collect()
}

/// `level` is how many clues are already out. Returns the clue and the ids still possible, in order.
pub fn roll_clue(level: usize, candidates: &[Candidate], rng: &mut Stream) -> (Clue, Vec<u8>) {
    let ids_where = |fits: &dyn Fn(&Candidate) -> bool| candidates.iter().filter(|c| fits(c)).map(|c| c.id).collect();
    if level == 0 {
        return (Clue::Yolo, ids_where(&|_| true));
    }
    let seed = candidates[rng.below(candidates.len() as u32) as usize];
    match level {
        1 => (Clue::Category(seed.category), ids_where(&|c| c.category == seed.category)),
        2 => (Clue::Kind(seed.kind), ids_where(&|c| c.kind == seed.kind)),
        _ => {
            let options = tag_options(&seed, candidates);
            let tag = options[rng.below(options.len() as u32) as usize];
            (Clue::Detail(seed.kind, tag), ids_where(&|c| c.tags & (1 << tag) != 0))
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Treasure {
    pub x: u16,
    pub y: u16,
    pub landmark_id: u8,
}

/// Spots off the land are thrown out, so the odds stay level on any coastline. The cap keeps gas bounded.
/// `candidates` are (landmark id, x, y).
pub fn roll_treasure(map: usize, candidates: &[(u8, u16, u16)], rng: &mut Stream) -> Treasure {
    let (landmark_id, lx, ly) = candidates[rng.below(candidates.len() as u32) as usize];
    let reach = TREASURE_SCATTER;
    for _ in 0..TREASURE_ATTEMPTS {
        let dx = rng.below((reach * 2 + 1) as u32) as i32 - reach;
        let dy = rng.below((reach * 2 + 1) as u32) as i32 - reach;
        let (x, y) = (lx as i32 + dx, ly as i32 + dy);
        if dx * dx + dy * dy <= reach * reach && is_land(map, x, y) {
            return Treasure { x: x as u16, y: y as u16, landmark_id };
        }
    }
    Treasure { x: lx, y: ly, landmark_id }
}
