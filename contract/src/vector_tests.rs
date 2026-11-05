//! Runs every area of `tests/vectors.json` against the Rust rules. These answers come from the TypeScript
//! rules, so a failure here means the Rust is wrong, unless the vector itself is reported as wrong.
use crate::clues::{roll_clue, roll_treasure, Candidate, Clue, Treasure};
use crate::layout::roll_layout;
use crate::map_data::*;
use crate::money::{expired_penalty, settle, split_pot, Split};
use crate::rng::*;
use crate::rules::*;
use crate::scoring::*;
use crate::season::{is_excluded, Season};
use near_sdk::AccountId;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../tests/vectors.json")).expect("vectors.json parses")
}

fn area(v: &Value, name: &str) -> Vec<Value> {
    let cases = v[name].as_array().unwrap_or_else(|| panic!("no area {name}")).clone();
    assert!(cases.len() >= 50 || name == "map_facts", "{name} has only {} cases", cases.len());
    cases
}

fn hex32(v: &Value) -> [u8; 32] {
    from_hex32(v.as_str().expect("hex string")).expect("32 bytes of hex")
}

fn hexs(bytes: &[u8; 32]) -> Value {
    Value::String(to_hex(bytes))
}

fn u(v: &Value) -> u64 {
    v.as_u64().unwrap_or_else(|| panic!("not a whole number: {v}"))
}

fn map_of(v: &Value) -> usize {
    map_index(v.as_str().expect("map name")).expect("known map") as usize
}

fn tag_bits(tags: &Value) -> u8 {
    let mut bits = 0;
    let mut last = -1i32;
    for tag in tags.as_array().expect("tags") {
        let bit = TAGS.iter().position(|t| *t == tag.as_str().unwrap()).expect("known tag") as i32;
        assert!(bit > last, "tags out of the rules' order: {tags}");
        last = bit;
        bits |= 1 << bit;
    }
    bits
}

fn tag_names(bits: u8) -> Vec<&'static str> {
    (0..TAGS.len()).filter(|t| bits & (1 << t) != 0).map(|t| TAGS[t]).collect()
}

fn after(stream: &mut Stream) -> u64 {
    stream.below(1_000_000) as u64
}

#[test]
fn rule_constants() {
    let v = vectors();
    assert_eq!(u(&v["rules"]["expired_bond_penalty_bps"]), EXPIRED_BOND_PENALTY_BPS);
    assert_eq!(expired_penalty(u(&v["rules"]["host_bond"])), 10);
}

#[test]
fn map_facts() {
    let v = vectors();
    for case in area(&v, "map_facts") {
        let map = map_of(&case["map"]);
        let names: Vec<&str> = MAPS[map].kinds.iter().map(|k| k.name).collect();
        assert_eq!(json!(names), case["kinds"]);
        assert_eq!(spot_count(map) as u64, u(&case["spot_count"]));
        assert_eq!(hexs(&sha256(MAPS[map].land.as_slice())), case["land_sha256"]);
        assert_eq!(hexs(&sha256(MAPS[map].spots)), case["spots_sha256"]);
        let total: u32 = MAPS[map].kinds.iter().map(|k| k.count as u32).sum();
        assert_eq!(total, 40);
    }
}

#[test]
fn below_streams() {
    let v = vectors();
    for case in area(&v, "below_streams") {
        let mut stream = Stream::new(hex32(&case["seed"]));
        let ns = case["ns"].as_array().unwrap();
        let values = case["values"].as_array().unwrap();
        assert_eq!(ns.len(), values.len());
        for (n, value) in ns.iter().zip(values) {
            assert_eq!(stream.below(u(n) as u32) as u64, u(value), "n = {n} in {}", case["shape"]);
        }
    }
}

#[test]
fn layouts() {
    let v = vectors();
    for case in area(&v, "layouts") {
        let map = map_of(&case["map"]);
        let mut stream = Stream::new(hex32(&case["seed"]));
        let landmarks = roll_layout(map, &mut stream);
        let expected = case["landmarks"].as_array().unwrap();
        assert_eq!(landmarks.len(), expected.len());
        for (l, e) in landmarks.iter().zip(expected) {
            let s = spot(map, l.spot as usize);
            let got = json!({
                "kind": MAPS[map].kinds[l.kind as usize].name, "x": s.x, "y": s.y, "tags": tag_names(s.tags), "flip": l.flip,
            });
            assert_eq!(&got, e, "seed {}", case["seed"]);
        }
        assert_eq!(stream.draws as u64, u(&case["draws"]));
        assert_eq!(after(&mut stream), u(&case["after"]));
    }
}

/// Kinds and categories are compared by name here, since a clue case isn't tied to one map.
#[derive(Default)]
struct Names(Vec<String>);

impl Names {
    fn id(&mut self, name: &Value) -> u8 {
        let name = name.as_str().unwrap();
        match self.0.iter().position(|n| n == name) {
            Some(i) => i as u8,
            None => {
                self.0.push(name.to_string());
                (self.0.len() - 1) as u8
            }
        }
    }
    fn name(&self, id: u8) -> &str {
        &self.0[id as usize]
    }
}

#[test]
fn clue_rolls() {
    let v = vectors();
    for case in area(&v, "clue_rolls") {
        let (mut kinds, mut categories) = (Names::default(), Names::default());
        let candidates: Vec<Candidate> = case["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| Candidate {
                id: u(&c["id"]) as u8,
                kind: kinds.id(&c["kind"]),
                category: categories.id(&c["category"]),
                tags: tag_bits(&c["tags"]),
            })
            .collect();
        let mut stream = Stream::new(hex32(&case["seed"]));
        let (clue, left) = roll_clue(u(&case["level"]) as usize, &candidates, &mut stream);
        let got = match clue {
            Clue::Yolo => json!({"level": "yolo"}),
            Clue::Category(c) => json!({"level": "category", "category": categories.name(c)}),
            Clue::Kind(k) => json!({"level": "kind", "kind": kinds.name(k)}),
            Clue::Detail(k, t) => json!({"level": "detail", "kind": kinds.name(k), "tag": TAGS[t as usize]}),
        };
        assert_eq!(got, case["clue"], "{}", case["note"]);
        assert_eq!(json!(left), case["candidates_after"], "{}", case["note"]);
        assert_eq!(stream.draws as u64, u(&case["draws"]));
        assert_eq!(after(&mut stream), u(&case["after"]));
    }
}

#[test]
fn treasure_rolls() {
    let v = vectors();
    for case in area(&v, "treasure_rolls") {
        let map = map_of(&case["map"]);
        let places: Vec<(u8, u16, u16)> = case["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (u(&c["id"]) as u8, u(&c["x"]) as u16, u(&c["y"]) as u16))
            .collect();
        let mut stream = Stream::new(hex32(&case["seed"]));
        let t = roll_treasure(map, &places, &mut stream);
        assert_eq!(json!({"x": t.x, "y": t.y, "landmark_id": t.landmark_id}), case["treasure"], "{}", case["note"]);
        assert_eq!(stream.draws as u64, u(&case["draws"]));
        assert_eq!(after(&mut stream), u(&case["after"]));
    }
}

#[test]
fn digs_hashes() {
    let v = vectors();
    for case in area(&v, "digs_hashes") {
        let digs = case["digs"].as_array().unwrap();
        let hash = digs_hash(digs.iter().map(|d| HashedDig {
            account: d["account"].as_str().unwrap(),
            x: u(&d["x"]) as u16,
            y: u(&d["y"]) as u16,
            clue_index: u(&d["clue_index"]) as u8,
            dug_at_ms: u(&d["dug_at_ms"]),
        }));
        assert_eq!(hexs(&hash), case["hash"]);
    }
}

#[test]
fn roll_seeds() {
    let v = vectors();
    for case in area(&v, "roll_seeds") {
        let seed = roll_seed(u(&case["room_id"]), u(&case["step"]) as u8, &hex32(&case["lock_seed"]), &hex32(&case["link"]), &hex32(&case["digs_hash"]));
        assert_eq!(hexs(&seed), case["seed"]);
    }
}

#[test]
fn layout_seeds() {
    let v = vectors();
    for case in area(&v, "layout_seeds") {
        let seed = layout_seed(u(&case["room_id"]), &hex32(&case["block_seed"]), &hex32(&case["tip"]));
        assert_eq!(hexs(&seed), case["seed"]);
    }
}

#[test]
fn hash_chains() {
    let v = vectors();
    for case in area(&v, "hash_chains") {
        let (tip, links) = hash_chain(hex32(&case["secret"]));
        assert_eq!(hexs(&tip), case["tip"]);
        let links: Vec<Value> = links.iter().map(hexs).collect();
        assert_eq!(json!(links), case["links"]);
    }
}

#[test]
fn land_points() {
    let v = vectors();
    for case in area(&v, "land_points") {
        let (x, y) = (case["x"].as_i64().unwrap() as i32, case["y"].as_i64().unwrap() as i32);
        assert_eq!(is_land(map_of(&case["map"]), x, y), case["land"].as_bool().unwrap(), "{case}");
    }
}

#[test]
fn crowding() {
    let v = vectors();
    for case in area(&v, "crowding") {
        let digs = case["digs"].as_array().unwrap();
        let got = is_crowded(digs.iter().map(|d| (u(&d["x"]) as u16, u(&d["y"]) as u16)), u(&case["spot"]["x"]) as u16, u(&case["spot"]["y"]) as u16);
        assert_eq!(got, case["crowded"].as_bool().unwrap(), "{case}");
    }
}

struct VDig {
    x: u16,
    y: u16,
    bonus: u32,
    crowded: bool,
    at: u64,
}

fn vdig(d: &Value, at: u64) -> VDig {
    VDig { x: u(&d["x"]) as u16, y: u(&d["y"]) as u16, bonus: u(&d["bonus_bps"]) as u32, crowded: d["crowded"].as_bool().unwrap(), at }
}

#[test]
fn scores() {
    let v = vectors();
    for case in area(&v, "scores") {
        let d = vdig(&case["dig"], 0);
        let r = score_dig(0, d.x, d.y, d.bonus, d.crowded, 0, u(&case["treasure"]["x"]) as u16, u(&case["treasure"]["y"]) as u16);
        assert_eq!(r.distance, u(&case["distance"]));
        assert_eq!(r.closeness, u(&case["closeness"]));
        assert_eq!(r.score, u(&case["score"]));
    }
}

fn ranked(digs: &[VDig], tx: u16, ty: u16) -> Vec<Ranked> {
    let mut rows: Vec<Ranked> =
        digs.iter().enumerate().map(|(i, d)| score_dig(i as u8, d.x, d.y, d.bonus, d.crowded, d.at, tx, ty)).collect();
    rank(&mut rows);
    rows
}

#[test]
fn rankings() {
    let v = vectors();
    for case in area(&v, "rankings") {
        let raw = case["digs"].as_array().unwrap();
        let digs: Vec<VDig> = raw.iter().map(|d| vdig(d, u(&d["dug_at"]))).collect();
        let rows = ranked(&digs, u(&case["treasure"]["x"]) as u16, u(&case["treasure"]["y"]) as u16);
        let order: Vec<&Value> = rows.iter().map(|r| &raw[r.dig as usize]["account"]).collect();
        assert_eq!(json!(order), case["order"], "{}", case["note"]);
        let scores: Vec<u64> = rows.iter().map(|r| r.score).collect();
        assert_eq!(json!(scores), case["scores"], "{}", case["note"]);
    }
}

fn split_json(s: &Split) -> Value {
    json!({"hostCut": s.host_cut, "jackpot": s.jackpot, "deed": s.deed, "season": s.season, "prize": s.prize})
}

#[test]
fn pot_splits() {
    let v = vectors();
    for case in area(&v, "pot_splits") {
        let s = split_pot(u(&case["pot"]), u(&case["host_cut_bps"]) as u16);
        assert_eq!(s.host_cut, u(&case["host_cut"]));
        assert_eq!(s.jackpot, u(&case["jackpot"]));
        assert_eq!(s.deed, u(&case["deed"]));
        assert_eq!(s.season, u(&case["season"]));
        assert_eq!(s.prize, u(&case["prize"]));
    }
}

#[test]
fn settlements() {
    let v = vectors();
    let bond = u(&v["rules"]["host_bond"]);
    for case in area(&v, "settlements") {
        let note = &case["note"];
        let raw = case["digs"].as_array().unwrap();
        let digs: Vec<VDig> = raw.iter().map(|d| vdig(d, u(&d["dug_at"]))).collect();
        let (tx, ty) = (u(&case["treasure"]["x"]) as u16, u(&case["treasure"]["y"]) as u16);
        let rows = ranked(&digs, tx, ty);
        let hit = first_exact_hit(digs.iter().map(|d| (d.x, d.y, d.at)), tx, ty);
        let pot = u(&case["fee"]) * case["players"].as_array().unwrap().len() as u64;
        assert_eq!(pot, u(&case["pot"]));
        let owner = case["deed_owner"].as_str();
        let s = settle(pot, u(&case["host_cut_bps"]) as u16, &rows, hit.is_some(), owner.is_some(), u(&case["jackpot_before"]));

        let mut credits: BTreeMap<String, u64> = BTreeMap::new();
        let mut add = |who: &str, amount: u64| *credits.entry(who.to_string()).or_default() += amount;
        let name = |row: usize| raw[row]["account"].as_str().unwrap();
        add(case["host"].as_str().unwrap(), bond + s.split.host_cut);
        add(name(rows[0].dig as usize), s.split.prize);
        if let Some(o) = owner {
            add(o, s.deed_paid);
        }
        if let Some(h) = hit {
            add(name(h), s.jackpot_win);
        }
        let mut expected_credits: BTreeMap<String, u64> = BTreeMap::new();
        for (who, amount) in case["credits"].as_object().unwrap() {
            expected_credits.insert(who.clone(), u(amount));
        }
        credits.retain(|who, amount| *amount != 0 || expected_credits.contains_key(who));
        assert_eq!(credits, expected_credits, "{note}");

        assert_eq!(split_json(&s.split), case["split"], "{note}");
        assert_eq!(s.jackpot_after, u(&case["jackpot_after"]), "{note}");
        assert_eq!(s.split.season, u(&case["season_pool"]), "{note}");
        assert_eq!(json!(name(rows[0].dig as usize)), case["winner"], "{note}");
        let order: Vec<&str> = rows.iter().map(|r| name(r.dig as usize)).collect();
        assert_eq!(json!(order), case["ranking"], "{note}");
        // The deed's own counters: `earned` only counts what an owner was actually paid.
        assert_eq!(s.deed_paid, u(&case["deed_earned"]), "{note}");
        assert_eq!(u(&case["deed_landings"]), 1, "{note}");
        assert_eq!(case["deed_paid_to"], case["deed_owner"], "{note}");

        let win = hit.map(|h| json!({"account": name(h), "amount": s.jackpot_win})).unwrap_or(Value::Null);
        assert_eq!(win, case["jackpot_win"], "{note}");

        let mut points = serde_json::Map::new();
        for (place, p) in s.season_points.iter().enumerate() {
            points.insert(name(rows[place].dig as usize).to_string(), json!(p));
        }
        assert_eq!(Value::Object(points), case["season_points"], "{note}");
    }
}

#[test]
fn refunds() {
    let v = vectors();
    let bond = u(&v["rules"]["host_bond"]);
    for case in area(&v, "refunds") {
        let reason = case["reason"].as_str().unwrap();
        let penalty = if reason == "expired" { expired_penalty(bond) } else { 0 };
        let mut credits: BTreeMap<String, u64> = BTreeMap::new();
        for p in case["players"].as_array().unwrap() {
            *credits.entry(p.as_str().unwrap().to_string()).or_default() += u(&case["fee"]);
        }
        *credits.entry(case["host"].as_str().unwrap().to_string()).or_default() += bond - penalty;
        let expected: BTreeMap<String, u64> = case["credits"].as_object().unwrap().iter().map(|(k, a)| (k.clone(), u(a))).collect();
        assert_eq!(credits, expected, "{reason}");
        assert_eq!(u(&case["jackpot_before"]) + penalty, u(&case["jackpot_after"]), "{reason}");
        assert_eq!(u(&case["host_expired_count"]), (reason == "expired") as u64, "{reason}");
    }
}

#[test]
fn season_closes() {
    let v = vectors();
    for case in area(&v, "season_closes") {
        let suffix = case["excluded_suffix"].as_str().unwrap();
        let mut season = Season { number: 1, ends_at_ms: 0, pool: u(&case["pool"]), top: Vec::new(), last_winners: Vec::new() };
        for (who, points) in case["points"].as_object().unwrap() {
            // One name, `Bob.testnet`, isn't a legal NEAR account. It's there to prove the order is byte by
            // byte, with capitals first, which still holds for the names this contract can really see.
            let account = AccountId::new_unvalidated(who.clone());
            if !is_excluded(who, suffix) {
                season.record(&account, u(points));
            }
        }
        let prizes = season.prizes();
        let mut pool = season.pool;
        let mut credits = serde_json::Map::new();
        for w in &prizes {
            pool -= w.prize;
            credits.insert(w.account.to_string(), json!(w.prize));
        }
        let got: Vec<Value> = prizes.iter().map(|w| json!({"account": w.account.as_str(), "prize": w.prize})).collect();
        assert_eq!(json!(got), case["prizes"], "{case}");
        assert_eq!(pool, u(&case["pool_after"]));
        assert_eq!(Value::Object(credits), case["credits"]);
    }
}

/// The same seed-to-seed chain as `rounds`, through the pure rules. `contract_tests` plays them through
/// the contract's own methods as well.
#[test]
fn rounds_pure() {
    let v = vectors();
    for case in area(&v, "rounds") {
        let map = map_of(&case["map"]);
        let room_id = u(&case["room_id"]);
        let (tip, links) = hash_chain(hex32(&case["secret"]));
        assert_eq!(hexs(&tip), case["tip"]);
        let seed = layout_seed(room_id, &hex32(&case["block_seed"]), &tip);
        assert_eq!(hexs(&seed), case["layout_seed"]);
        let landmarks = roll_layout(map, &mut Stream::new(seed));
        let mut rows: Vec<Candidate> = landmarks
            .iter()
            .enumerate()
            .map(|(id, l)| Candidate {
                id: id as u8,
                kind: l.kind,
                category: MAPS[map].kinds[l.kind as usize].category,
                tags: spot(map, l.spot as usize).tags,
            })
            .collect();
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            assert_eq!(hexs(&links[i]), step["link"]);
            let roll = roll_seed(room_id, (i + 1) as u8, &hex32(&step["lock_seed"]), &links[i], &hex32(&step["digs_hash"]));
            assert_eq!(hexs(&roll), step["roll_seed"]);
            let mut stream = Stream::new(roll);
            if i < 3 {
                let (_, after_ids) = roll_clue(i + 1, &rows, &mut stream);
                assert_eq!(json!(after_ids), step["candidates_after"]);
                rows.retain(|c| after_ids.contains(&c.id));
            } else {
                let places: Vec<(u8, u16, u16)> = rows
                    .iter()
                    .map(|c| {
                        let s = spot(map, landmarks[c.id as usize].spot as usize);
                        (c.id, s.x, s.y)
                    })
                    .collect();
                let t: Treasure = roll_treasure(map, &places, &mut stream);
                assert_eq!(json!({"x": t.x, "y": t.y, "landmark_id": t.landmark_id}), step["treasure"]);
            }
            assert_eq!(stream.draws as u64, u(&step["draws"]));
            assert_eq!(after(&mut stream), u(&step["after"]));
        }
    }
}

/// The spec asks for 500 seeds per map. This runs 2000 and records the costliest, so the sandbox can
/// price them on real wasm: run with `--ignored` to rewrite `tests/worst-layouts.json`.
#[test]
fn layouts_never_fail_on_thousands_of_seeds() {
    for (map, def) in MAPS.iter().enumerate() {
        let mut most = 0;
        for i in 0u32..2000 {
            let mut input = def.name.as_bytes().to_vec();
            input.extend_from_slice(&i.to_le_bytes());
            let mut stream = Stream::new(sha256(&input));
            let landmarks = roll_layout(map, &mut stream);
            assert_eq!(landmarks.len(), 40);
            most = most.max(stream.draws);
        }
        println!("{}: at most {most} draws", def.name);
    }
}

#[test]
#[ignore = "writes tests/worst-layouts.json"]
fn write_worst_layouts() {
    const SEEDS: u32 = 1000;
    let mut out = Vec::new();
    for (map, def) in MAPS.iter().enumerate() {
        let mut draws: Vec<(u32, String)> = (0..SEEDS)
            .map(|i| {
                let seed = sha256(format!("worst-layout/{}/{i}", def.name).as_bytes());
                let mut stream = Stream::new(seed);
                roll_layout(map, &mut stream);
                (stream.draws, to_hex(&seed))
            })
            .collect();
        draws.sort();
        let total: u64 = draws.iter().map(|d| d.0 as u64).sum();
        let median = draws[draws.len() / 2].0;
        println!("{}: min {} median {median} mean {} max {}", def.name, draws[0].0, total / SEEDS as u64, draws[draws.len() - 1].0);
        for (count, seed) in draws.iter().rev().take(5) {
            out.push(json!({"map": def.name, "seed": seed, "draws": count, "rank": "worst"}));
        }
        let (count, seed) = &draws[draws.len() / 2];
        out.push(json!({"map": def.name, "seed": seed, "draws": count, "rank": "median"}));
    }
    let text = serde_json::to_string_pretty(&json!({"seeds_scanned_per_map": SEEDS, "cases": out})).unwrap();
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/worst-layouts.json"), text + "\n").unwrap();
}
