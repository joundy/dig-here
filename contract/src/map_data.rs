//! The generated map tables (see `contract/data/README.md`) and each map's roster.

pub const W: i32 = 320;
pub const H: i32 = 224;
pub const LAND_BYTES: usize = 8960;
pub const SPOT_BYTES: usize = 6;

pub const CATEGORIES: [&str; 4] = ["building", "tree", "thing", "animal"];
const BUILDING: u8 = 0;
const TREE: u8 = 1;
const THING: u8 = 2;
const ANIMAL: u8 = 3;

/// Bit order of a spot's tags. Clues pick from a tag list by index, so this order is part of the rules.
pub const TAGS: [&str; 6] = ["north", "south", "west", "east", "water", "inland"];

pub struct KindDef {
    pub name: &'static str,
    pub count: u8,
    pub category: u8,
    pub width: u8,
    pub height: u8,
    pub habitat: bool,
}

const fn k(name: &'static str, count: u8, category: u8, width: u8, height: u8, habitat: bool) -> KindDef {
    KindDef { name, count, category, width, height, habitat }
}

pub struct MapDef {
    pub name: &'static str,
    pub land: &'static [u8; LAND_BYTES],
    pub spots: &'static [u8],
    pub kinds: [KindDef; 12],
}

pub static MAPS: [MapDef; 3] = [
    MapDef {
        name: "tropical",
        land: include_bytes!("../data/land-tropical.bin"),
        spots: include_bytes!("../data/spots-tropical.bin"),
        kinds: [
            k("lighthouse", 3, BUILDING, 12, 20, true),
            k("well", 3, BUILDING, 14, 12, false),
            k("hut", 4, BUILDING, 16, 15, false),
            k("windmill", 3, BUILDING, 16, 23, false),
            k("pine", 4, TREE, 13, 16, false),
            k("apple", 3, TREE, 14, 14, false),
            k("scarecrow", 3, THING, 14, 17, false),
            k("cow", 3, ANIMAL, 16, 13, false),
            k("sheep", 3, ANIMAL, 16, 11, false),
            k("duck", 3, ANIMAL, 12, 12, true),
            k("boat", 3, THING, 16, 15, true),
            k("palm", 5, TREE, 16, 17, true),
        ],
    },
    MapDef {
        name: "snowy",
        land: include_bytes!("../data/land-snowy.bin"),
        spots: include_bytes!("../data/spots-snowy.bin"),
        kinds: [
            k("campfire", 3, THING, 12, 12, false),
            k("cabin", 4, BUILDING, 16, 17, false),
            k("seal", 3, ANIMAL, 16, 15, true),
            k("boat", 3, THING, 16, 15, true),
            k("penguin", 3, ANIMAL, 14, 16, false),
            k("snowpine", 5, TREE, 13, 16, false),
            k("pine", 4, TREE, 13, 16, false),
            k("birch", 3, TREE, 14, 17, false),
            k("igloo", 3, BUILDING, 16, 11, false),
            k("husky", 3, ANIMAL, 16, 15, false),
            k("sled", 3, THING, 16, 11, false),
            k("snowman", 3, THING, 13, 16, false),
        ],
    },
    MapDef {
        name: "desert",
        land: include_bytes!("../data/land-desert.bin"),
        spots: include_bytes!("../data/spots-desert.bin"),
        kinds: [
            k("pyramid", 3, BUILDING, 20, 11, false),
            k("palm", 5, TREE, 16, 17, true),
            k("well", 3, BUILDING, 14, 12, false),
            k("tent", 4, BUILDING, 16, 12, false),
            k("campfire", 3, THING, 12, 12, false),
            k("camel", 3, ANIMAL, 16, 17, false),
            k("lizard", 3, ANIMAL, 16, 11, false),
            k("skull", 3, THING, 13, 12, false),
            k("deadtree", 3, TREE, 14, 15, false),
            k("vulture", 3, ANIMAL, 14, 17, false),
            k("cactus", 4, TREE, 13, 16, false),
            k("cart", 3, THING, 16, 14, false),
        ],
    },
];

pub const KINDS_PER_MAP: usize = 12;
/// One NFT per kind per map.
pub const DEED_COUNT: usize = MAPS.len() * KINDS_PER_MAP;

pub fn map_index(name: &str) -> Option<u8> {
    MAPS.iter().position(|m| m.name == name).map(|i| i as u8)
}

#[derive(Clone, Copy)]
pub struct Spot {
    pub x: u16,
    pub y: u16,
    pub tags: u8,
    pub kind_mask: u16,
}

pub fn spot_count(map: usize) -> usize {
    MAPS[map].spots.len() / SPOT_BYTES
}

pub fn spot(map: usize, index: usize) -> Spot {
    let at = index * SPOT_BYTES;
    let s = &MAPS[map].spots[at..at + SPOT_BYTES];
    Spot {
        x: u16::from_le_bytes([s[0], s[1]]),
        y: s[2] as u16,
        tags: s[3],
        kind_mask: u16::from_le_bytes([s[4], s[5]]),
    }
}

pub fn is_land(map: usize, x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x >= W || y >= H {
        return false;
    }
    let i = (y * W + x) as usize;
    MAPS[map].land[i >> 3] & (1 << (i & 7)) != 0
}

/// `tropical:palm`. A deed's index is its map times 12, plus its kind.
pub fn token_id(deed: usize) -> String {
    let def = &MAPS[deed / KINDS_PER_MAP];
    let mut id = String::with_capacity(24);
    id.push_str(def.name);
    id.push(':');
    id.push_str(def.kinds[deed % KINDS_PER_MAP].name);
    id
}

pub fn deed_index(token_id: &str) -> Option<u8> {
    let (map_name, kind_name) = token_id.split_once(':')?;
    let map = map_index(map_name)? as usize;
    let kind = MAPS[map].kinds.iter().position(|k| k.name == kind_name)?;
    Some((map * KINDS_PER_MAP + kind) as u8)
}

pub fn deed_of(map: u8, kind: u8) -> u8 {
    map * KINDS_PER_MAP as u8 + kind
}
