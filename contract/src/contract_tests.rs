//! The contract's own methods on a mocked VM. Whole rounds from the vectors, then the rules around them.
use crate::rng::{from_hex32, hash_chain, sha256, to_hex};
use crate::rooms::{RefundReason, Status};
use crate::rules::*;
use crate::{Config, Contract};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, Gas, NearToken};
use serde_json::{json, Value};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// Sets who's calling, when, and which block seed they see, keeping the contract's storage.
struct Chain {
    now_ms: u64,
    height: u64,
    seed: [u8; 32],
}

impl Chain {
    fn new() -> Self {
        Self { now_ms: 1_790_000_000_000, height: 100, seed: [7; 32] }
    }

    fn call(&mut self, who: &str, attached: u128) {
        self.height += 1;
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acct("v1.dighere.testnet"))
            .predecessor_account_id(acct(who))
            .signer_account_id(acct(who))
            .attached_deposit(NearToken::from_yoctonear(attached))
            .block_timestamp(self.now_ms * 1_000_000)
            .block_height(self.height)
            .random_seed(self.seed)
            .account_balance(NearToken::from_near(1_000_000))
            .prepaid_gas(Gas::from_tgas(300));
        testing_env!(ctx.build());
    }
}

fn config() -> Config {
    Config {
        oracle: acct("oracle.testnet"),
        treasury: acct("treasury.testnet"),
        mint_price: 500,
        host_bond: 100,
        season_length_sec: 86_400,
        prize_excluded_suffix: ".bots.dighere.testnet".to_string(),
    }
}

fn contract(chain: &mut Chain) -> Contract {
    // Mocked storage outlives a test case on the same thread, and each case starts a new contract.
    near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    chain.call("v1.dighere.testnet", 0);
    Contract::new(config())
}

fn secret(n: u8) -> [u8; 32] {
    [n; 32]
}

fn add_tip(c: &mut Contract, chain: &mut Chain, n: u8) -> Vec<[u8; 32]> {
    let (tip, links) = hash_chain(secret(n));
    chain.call("oracle.testnet", 0);
    c.add_commitments(vec![to_hex(&tip)]);
    links
}

fn make_room(c: &mut Contract, chain: &mut Chain, host: &str, duration_sec: u32, countdown_sec: u32, min_players: u8, max_players: u8, fee: u64) -> u64 {
    chain.call(host, NEAR);
    c.create_room("Test".to_string(), "tropical".to_string(), fee, duration_sec, 500, min_players, max_players, countdown_sec)
}

fn balance(c: &Contract, who: &str) -> u128 {
    c.account_view(acct(who)).map_or(0, |a| a.balance_yocto())
}

/// Plays every `rounds` vector through the real methods, with the vector's block seeds fed in, so the
/// seams between create, dig, lock, reveal and settle are all held to the TypeScript's answers.
#[test]
fn rounds_through_the_contract() {
    let v: Value = serde_json::from_str(include_str!("../tests/vectors.json")).unwrap();
    for case in v["rounds"].as_array().unwrap() {
        let mut chain = Chain::new();
        let mut c = contract(&mut chain);
        c.next_room_id = case["room_id"].as_u64().unwrap();
        let tip = case["tip"].as_str().unwrap().to_string();
        chain.call("oracle.testnet", 0);
        c.add_commitments(vec![tip]);

        chain.seed = from_hex32(case["block_seed"].as_str().unwrap()).unwrap();
        chain.call("host.testnet", NEAR);
        let id = c.create_room(
            "r".to_string(),
            case["map"].as_str().unwrap().to_string(),
            case["fee"].as_u64().unwrap(),
            300,
            case["host_cut_bps"].as_u64().unwrap() as u16,
            2,
            30,
            0,
        );
        let room = c.load_room(id);
        assert_eq!(to_hex(&room.layout_seed), case["layout_seed"].as_str().unwrap());

        for player in case["players"].as_array().unwrap() {
            chain.call(player.as_str().unwrap(), NEAR);
            c.join(id);
        }
        let digs = case["digs"].as_array().unwrap();
        // The vector times digs from its own start, so start the round at that same moment.
        let steps = case["steps"].as_array().unwrap();
        let first_dig_ms = digs[0]["dug_at_ms"].as_u64().unwrap();
        // Its first digs come one second before step 1's roll is due, at 90 seconds.
        chain.now_ms = first_dig_ms - 89_000;
        chain.call("host.testnet", 0);
        c.start(id);

        let times = [90u64, 180, 255, 300];
        let start_ms = chain.now_ms;
        let mut next_dig = 0;
        for (i, step) in steps.iter().enumerate() {
            let lock_at = start_ms + times[i] * 1000;
            while next_dig < digs.len() && digs[next_dig]["dug_at_ms"].as_u64().unwrap() < lock_at {
                let d = &digs[next_dig];
                chain.now_ms = d["dug_at_ms"].as_u64().unwrap();
                let clue_index = d["clue_index"].as_u64().unwrap() as u8;
                chain.call(d["account"].as_str().unwrap(), 0);
                c.dig(id, d["x"].as_u64().unwrap() as u16, d["y"].as_u64().unwrap() as u16, clue_index + 1);
                let stored = *c.load_room(id).digs.last().unwrap();
                assert_eq!(stored.crowded, d["crowded"].as_bool().unwrap());
                assert_eq!(Contract::bonus_of(stored.clue_index) as u64, d["bonus_bps"].as_u64().unwrap());
                next_dig += 1;
            }
            chain.now_ms = lock_at;
            chain.seed = from_hex32(step["lock_seed"].as_str().unwrap()).unwrap();
            chain.call("anyone.testnet", 0);
            assert_eq!(c.poke(id), "locked");
            let room = c.load_room(id);
            let roll = room.rolls.last().unwrap();
            assert_eq!(to_hex(&roll.digs_hash), step["digs_hash"].as_str().unwrap());

            chain.call("anyone.testnet", 0);
            c.reveal(id, step["link"].as_str().unwrap().to_string());
            let room = c.load_room(id);
            if i < 3 {
                assert_eq!(json!(room.candidates), step["candidates_after"]);
            }
        }

        let room: Value = serde_json::from_slice(&c.room_json(id)).unwrap();
        assert_eq!(room["status"], "finished");
        assert_eq!(room["rolls"][3]["roll_seed"], steps[3]["roll_seed"]);
        for (i, step) in steps.iter().enumerate().take(3) {
            assert_eq!(room["clues"][i + 1], step["clue"], "clue {i}");
            assert_eq!(room["rolls"][i]["clue"], step["clue"], "clue {i}");
        }
        let result = &room["result"];
        assert_eq!(result["treasure"], steps[3]["treasure"]);
        assert_eq!(result["winner"], case["winner"]);
        assert_eq!(result["pot"], case["pot"]);
        let split = &case["split"];
        assert_eq!(result["split"]["host_cut"], split["hostCut"]);
        assert_eq!(result["split"]["prize"], split["prize"]);
        assert_eq!(result["split"]["jackpot"], split["jackpot"]);
        assert_eq!(result["split"]["deed"], split["deed"]);
        assert_eq!(result["split"]["season"], split["season"]);
        for (got, want) in result["ranking"].as_array().unwrap().iter().zip(case["ranking"].as_array().unwrap()) {
            assert_eq!(got["account"], want["account"]);
            assert_eq!(got["distance"], want["distance"]);
            assert_eq!(got["closeness"], want["closeness"]);
            assert_eq!(got["score"], want["score"]);
        }
        assert_eq!(c.held, 0, "nothing stays locked once a room ends");
    }
}

#[test]
fn every_refund_vector_through_the_contract() {
    let v: Value = serde_json::from_str(include_str!("../tests/vectors.json")).unwrap();
    for case in v["refunds"].as_array().unwrap() {
        let mut chain = Chain::new();
        let mut c = contract(&mut chain);
        add_tip(&mut c, &mut chain, 1);
        c.jackpot = case["jackpot_before"].as_u64().unwrap();
        let fee = case["fee"].as_u64().unwrap();
        let host = case["host"].as_str().unwrap();
        let players = case["players"].as_array().unwrap();
        let reason = case["reason"].as_str().unwrap();
        chain.call(host, 0);
        c.deposit_for_test(acct(host), yocto_plain(100));
        let min = if reason == "expired" { players.len() as u8 + 1 } else { 2 };
        chain.call(host, 0);
        let id = c.create_room("r".to_string(), "desert".to_string(), fee, 300, 0, min.max(2), 30, 0);
        for p in players {
            let p = p.as_str().unwrap();
            chain.call(p, 0);
            c.deposit_for_test(acct(p), yocto_plain(fee));
            chain.call(p, 0);
            c.join(id);
        }
        if reason != "expired" {
            chain.call(host, 0);
            c.start(id);
        }
        let dig_count = case["dig_count"].as_u64().unwrap() as usize;
        let mut spots = land_spots(players.len());
        for p in players.iter().take(dig_count) {
            let (x, y) = spots.next().unwrap();
            chain.call(p.as_str().unwrap(), 0);
            c.dig(id, x, y, 1);
        }
        match reason {
            "expired" => chain.now_ms += WAITING_DEADLINE_SEC * 1000,
            "too-few-digs" => chain.now_ms += 300_000,
            _ => chain.now_ms += 90_000 + REVEAL_WINDOW_MS,
        }
        chain.call("anyone.testnet", 0);
        assert_eq!(c.poke(id), "refunded", "{reason}");
        let want = case["credits"].as_object().unwrap();
        for (who, amount) in want {
            assert_eq!(balance(&c, who), yocto_plain(amount.as_u64().unwrap()), "{reason} {who}");
        }
        assert_eq!(c.jackpot, case["jackpot_after"].as_u64().unwrap());
        assert_eq!(c.get_host(acct(host)).expired(), case["host_expired_count"].as_u64().unwrap() as u32);
        assert_eq!(c.missed_reveals, (reason == "missed-reveal") as u64);
        assert_eq!(c.held, 0);
    }
}

fn yocto_plain(milli: u64) -> u128 {
    milli as u128 * YOCTO_PER_MILLI
}

/// Distinct, uncrowded land spots.
fn land_spots(count: usize) -> impl Iterator<Item = (u16, u16)> {
    let mut found = Vec::new();
    for y in (20..210).step_by(10) {
        for x in (20..300).step_by(10) {
            if crate::map_data::is_land(2, x, y) && found.len() < count + 1 {
                found.push((x as u16, y as u16));
            }
        }
    }
    found.into_iter()
}

#[test]
fn first_credit_pays_exactly_for_the_record() {
    let mut chain = Chain::new();
    let mut c = contract(&mut chain);
    chain.call("a.testnet", NEAR);
    c.deposit();
    let first = balance(&c, "a.testnet");
    assert!(first < NEAR && NEAR - first < NEAR / 100, "charged {}", NEAR - first);
    chain.call("a.testnet", NEAR);
    c.deposit();
    assert_eq!(balance(&c, "a.testnet"), first + NEAR);
}

#[test]
#[should_panic(expected = "first deposit must be at least")]
fn a_deposit_too_small_for_the_record_fails() {
    let mut chain = Chain::new();
    let mut c = contract(&mut chain);
    chain.call("a.testnet", 1000);
    c.deposit();
}

#[test]
#[should_panic(expected = "No round seeds are ready")]
fn an_empty_pool_fails_kindly() {
    let mut chain = Chain::new();
    let mut c = contract(&mut chain);
    make_room(&mut c, &mut chain, "h.testnet", 60, 0, 2, 30, 10);
}

#[test]
fn room_bytes_stay_inside_the_bond_check() {
    let mut chain = Chain::new();
    let mut c = contract(&mut chain);
    add_tip(&mut c, &mut chain, 1);
    let long = |n: usize| format!("{:0>54}.test.near", n);
    let id = make_room(&mut c, &mut chain, &long(99), 60, 0, 2, 30, 10);
    let mut room = c.load_room(id);
    room.name = "x".repeat(MAX_ROOM_NAME_BYTES);
    for n in 0..MAX_PLAYERS_CAP as u64 {
        room.players.push(acct(&long(n as usize)));
        room.digs.push(crate::rooms::Dig { player: n as u8, x: 100, y: 100, clue_index: 3, dug_at_ms: 1, crowded: true });
    }
    room.clues = vec![crate::clues::Clue::Yolo, crate::clues::Clue::Category(1), crate::clues::Clue::Kind(1), crate::clues::Clue::Detail(1, 1)];
    for step in 1..=4 {
        room.rolls.push(crate::rooms::Roll {
            step,
            lock_seed: [1; 32],
            digs_hash: [2; 32],
            lock_ms: 1,
            lock_height: 1,
            link: Some([3; 32]),
            reveal_ms: 1,
            reveal_height: 1,
        });
    }
    room.outcome = Some(crate::rooms::Outcome {
        ended_ms: 1,
        treasure: Some(crate::clues::Treasure { x: 1, y: 1, landmark_id: 1 }),
        refund_reason: Some(RefundReason::MissedReveal),
        deed_owner: Some(acct(&long(100))),
        jackpot_win: Some((1, 1)),
        jackpot_before: 1,
        jackpot_after: 1,
    });
    room.status = Status::Finished;
    c.rooms.remove(&id);
    let empty = near_sdk::env::storage_usage();
    c.rooms.insert(&id, &room);
    let used = near_sdk::env::storage_usage() - empty;
    let limit = ROOM_BASE_BYTES + MAX_PLAYERS_CAP as u64 * ROOM_BYTES_PER_PLAYER;
    println!("worst room: {used} bytes, limit {limit}");
    assert!(used <= limit, "worst room is {used} bytes, over the {limit} the bond check assumes");
    assert!(used + 200 > limit, "the bond check assumes {limit} but the worst room is only {used}: tighten it");
}

#[test]
fn testnet_bond_fits_the_largest_room() {
    let bytes = (ROOM_BASE_BYTES + MAX_PLAYERS_CAP as u64 * ROOM_BYTES_PER_PLAYER) as u128;
    assert!(bytes * 10_000_000_000_000_000_000 <= yocto_plain(config().host_bond));
}

#[test]
fn hash_helpers_agree() {
    let chain = hash_chain(secret(9));
    assert_eq!(sha256(&chain.1[0]), chain.0);
}
