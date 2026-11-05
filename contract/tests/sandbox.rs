//! Integration tests on a real local node running the real wasm. Build the wasm first, then run through
//! `docker/near`, one test at a time because each starts a node:
//!   cargo near build non-reproducible-wasm --no-abi
//!   cargo near build non-reproducible-wasm --no-abi --features gas-probe --out-dir target/near-probe
//!   cargo test --test sandbox -- --test-threads=1 --nocapture
#![allow(unused_must_use)]
use anyhow::Result;
use dig_here::clues::roll_treasure;
use dig_here::map_data::{is_land, map_index};
use dig_here::rng::{from_hex32, roll_seed, sha256, to_hex, Stream};
use dig_here::rooms::Room;
use futures::future::join_all;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const YOCTO_PER_MILLI: u128 = 1_000_000_000_000_000_000_000;
const BOND: u64 = 100;
const MINT_PRICE: u64 = 500;
const SEASON_SEC: u64 = 3600;

fn wasm(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|_| panic!("{path} is missing. Build it first: see the top of this file."))
}

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}


struct World {
    worker: Worker<Sandbox>,
    root: Account,
    game: Contract,
    oracle: Account,
    treasury: Account,
    next_tip: u32,
}

/// One secret per commitment, as the oracle derives them. Returns the links in reveal order.
fn links_of(tip_index: u64) -> ([u8; 32], Vec<[u8; 32]>) {
    let mut hashes = vec![sha256(format!("secret/{tip_index}").as_bytes())];
    for i in 0..4 {
        let next = sha256(&hashes[i]);
        hashes.push(next);
    }
    let tip = hashes[4];
    hashes.truncate(4);
    hashes.reverse();
    (tip, hashes)
}

async fn world_with(code: &[u8]) -> Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let game_account = root.create_subaccount("game").initial_balance(near(1000)).transact().await?.into_result()?;
    let game = game_account.deploy(code).await?.into_result()?;
    let oracle = root.create_subaccount("oracle").initial_balance(near(100)).transact().await?.into_result()?;
    let treasury = root.create_subaccount("treasury").initial_balance(near(1)).transact().await?.into_result()?;
    game.call("new")
        .args_json(json!({"config": {
            "oracle": oracle.id(), "treasury": treasury.id(), "mint_price": MINT_PRICE, "host_bond": BOND,
            "season_length_sec": SEASON_SEC, "prize_excluded_suffix": ".bots.test.near",
        }}))
        .transact()
        .await?
        .into_result()?;
    Ok(World { worker, root, game, oracle, treasury, next_tip: 0 })
}

async fn world() -> Result<World> {
    world_with(&wasm("target/near/dig_here.wasm")).await
}

impl World {
    async fn player(&self, name: &str) -> Result<Account> {
        Ok(self.root.create_subaccount(name).initial_balance(near(50)).transact().await?.into_result()?)
    }

    /// Accounts of the longest legal name, for worst-case numbers.
    async fn long_player(&self, n: usize) -> Result<Account> {
        self.player(&format!("{n:0>54}")).await
    }

    async fn add_tips(&mut self, count: u32) -> Result<()> {
        let tips: Vec<String> = (0..count).map(|i| to_hex(&links_of((self.next_tip + i) as u64).0)).collect();
        self.next_tip += count;
        call(&self.oracle, &self.game, "add_commitments", json!({ "tips": tips }), 0).await?.into_result()?;
        Ok(())
    }

    async fn now_ms(&self) -> Result<u64> {
        Ok(self.game.view("get_now_ms").await?.json()?)
    }

    /// Moves block time forward to at least `target`.
    async fn warp_to(&self, target: u64) -> Result<()> {
        for _ in 0..200 {
            let now = self.now_ms().await?;
            if now >= target {
                return Ok(());
            }
            // Fast-forwarding moves time by about a second a block here, and a slight overshoot is harmless.
            self.worker.fast_forward(((target - now) / 1000).clamp(1, 2000)).await?;
        }
        anyhow::bail!("time never reached {target}")
    }

    async fn room(&self, id: u64) -> Result<Value> {
        Ok(self.game.view("get_room").args_json(json!({ "id": id })).await?.json()?)
    }

    async fn balance_milli(&self, who: &Account) -> Result<u128> {
        Ok(self.balance_yocto(who).await? / YOCTO_PER_MILLI)
    }

    async fn balance_yocto(&self, who: &Account) -> Result<u128> {
        let v: Value = self.game.view("get_account").args_json(json!({ "id": who.id() })).await?.json()?;
        Ok(v["balance"].as_str().map_or(0, |b| b.parse().unwrap()))
    }

    async fn make_room(&self, host: &Account, map: &str, fee: u64, duration: u32, min: u8, max: u8, countdown: u32) -> Result<u64> {
        let args = json!({"name": "Sandbox", "map": map, "fee": fee, "duration_sec": duration, "host_cut_bps": 500,
            "min_players": min, "max_players": max, "countdown_sec": countdown});
        Ok(call(host, &self.game, "create_room", args, (BOND as u128) * YOCTO_PER_MILLI + YOCTO_PER_MILLI * 10).await?.into_result()?.json()?)
    }

    async fn join_all(&self, room: u64, fee: u64, players: &[Account]) -> Result<()> {
        let attached = fee as u128 * YOCTO_PER_MILLI + 2 * YOCTO_PER_MILLI;
        let calls = players.iter().map(|p| call(p, &self.game, "join", json!({ "room_id": room }), attached));
        for r in join_all(calls).await {
            r?.into_result()?;
        }
        Ok(())
    }

    /// Spaced apart, so nobody's crowded. Each player digs a different land pixel.
    async fn dig_all(&self, room: u64, map: &str, players: &[Account], seen: u8) -> Result<()> {
        let spots = land_spots(map, players.len());
        let calls = players
            .iter()
            .zip(&spots)
            .map(|(p, (x, y))| call(p, &self.game, "dig", json!({"room_id": room, "x": x, "y": y, "seen_clue": seen}), 0));
        for r in join_all(calls).await {
            r?.into_result()?;
        }
        Ok(())
    }

    async fn poke(&self, room: u64) -> Result<String> {
        Ok(call(&self.root, &self.game, "poke", json!({ "room_id": room }), 0).await?.into_result()?.json()?)
    }

    async fn reveal(&self, room: u64, link: &[u8; 32]) -> Result<ExecutionFinalResult> {
        call(&self.root, &self.game, "reveal", json!({"room_id": room, "link": to_hex(link)}), 0).await
    }

    /// Locks and reveals the next steps, up to and including `last`.
    async fn run_steps(&self, room: u64, last: u8) -> Result<Option<ExecutionFinalResult>> {
        let view = self.room(room).await?;
        let (_, links) = links_of(view["tip_index"].as_u64().unwrap());
        let first = view["next_step"].as_u64().unwrap() as u8;
        let mut result = None;
        for step in first..=last {
            let view = self.room(room).await?;
            self.warp_to(view["next_due_ms"].as_u64().unwrap()).await?;
            assert_eq!(self.poke(room).await?, "locked");
            result = Some(self.reveal(room, &links[step as usize - 1]).await?);
            assert!(result.as_ref().unwrap().is_success(), "{:?}", result.as_ref().unwrap().failures());
        }
        Ok(result)
    }
}

fn land_spots(map: &str, count: usize) -> Vec<(u16, u16)> {
    let m = map_index(map).unwrap() as usize;
    let mut out = Vec::new();
    for y in (24..200).step_by(8) {
        for x in (24..296).step_by(8) {
            if is_land(m, x, y) && out.len() < count {
                out.push((x as u16, y as u16));
            }
        }
    }
    assert_eq!(out.len(), count);
    out
}

async fn call(who: &Account, game: &Contract, method: &str, args: Value, attached: u128) -> Result<ExecutionFinalResult> {
    Ok(who.call(game.id(), method).args_json(args).deposit(NearToken::from_yoctonear(attached)).max_gas().transact().await?)
}

fn events(result: &ExecutionFinalResult) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str(l).expect("event is JSON"))
        .collect()
}

fn event<'a>(all: &'a [Value], name: &str) -> &'a Value {
    all.iter().find(|e| e["event"] == name).unwrap_or_else(|| panic!("no {name} event in {all:?}"))
}

#[track_caller]
fn failure(result: &ExecutionFinalResult) -> String {
    assert!(result.is_failure(), "expected this call to fail");
    format!("{:?}", result.failures())
}

/// Coins can only leave through a withdraw, so the contract must always hold everything it owes.
async fn assert_solvent(w: &World) -> Result<()> {
    let totals: Value = w.game.view("get_totals").await?.json()?;
    let owed: u128 = totals["balances"].as_str().unwrap().parse::<u128>()?
        + (totals["held"].as_u64().unwrap() + totals["jackpot"].as_u64().unwrap() + totals["season_pool"].as_u64().unwrap()) as u128 * YOCTO_PER_MILLI;
    let account = w.game.view_account().await?;
    let storage = account.storage_usage as u128 * 10_000_000_000_000_000_000;
    let holding = account.balance.as_yoctonear();
    assert!(holding >= owed + storage, "holding {holding}, owed {owed}, storage {storage}");
    Ok(())
}

#[tokio::test]
async fn full_round_with_commit_lock_and_reveal() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(2).await?;
    let host = w.player("host").await?;
    let players = vec![w.player("a").await?, w.player("b").await?, w.player("c").await?, w.player("d").await?];

    let fee = 50;
    let id = w.make_room(&host, "snowy", fee, 60, 2, 30, 0).await?;
    let created = w.room(id).await?;
    assert_eq!(created["status"], "waiting");
    assert_eq!(created["landmarks"].as_array().unwrap().len(), 40);
    assert_eq!(created["tip"], to_hex(&links_of(0).0));
    assert!(w.game.view("get_rooms").args_json(json!({"from": 0, "limit": 10})).await?.json::<Value>()?[0].get("landmarks").is_none());
    let hosting: Value = w.game.view("get_host").args_json(json!({"id": host.id()})).await?.json()?;
    assert_eq!(hosting["open_rooms"], 1);

    w.join_all(id, fee, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": id }), 0).await?.into_result()?;

    // Clue 1 is out, so digs now get the first bonus. Stale `seen_clue` is turned down.
    let stale = call(&players[0], &w.game, "dig", json!({"room_id": id, "x": 100, "y": 100, "seen_clue": 2}), 0).await?;
    assert!(failure(&stale).contains("A new clue just arrived"));
    w.dig_all(id, "snowy", &players[..2], 1).await?;
    let dup = call(&players[0], &w.game, "dig", json!({"room_id": id, "x": 100, "y": 100, "seen_clue": 1}), 0).await?;
    assert!(failure(&dup).contains("already dug"));

    let reveal_clue = w.run_steps(id, 1).await?.unwrap();
    let revealed = events(&reveal_clue);
    assert!(event(&revealed, "revealed")["data"]["clue"]["level"] == "category");
    let view = w.room(id).await?;
    assert_eq!(view["clues"].as_array().unwrap().len(), 2);
    assert_eq!(view["rolls"][0]["clue"]["level"], "category");

    // These two dig with clue 2 out, and so at its bonus, however late the clue actually was.
    let others = &players[2..];
    let spots = land_spots("snowy", 4);
    for (p, (x, y)) in others.iter().zip(&spots[2..]) {
        let now = w.now_ms().await?;
        let ends = view["ends_at_ms"].as_u64().unwrap();
        assert!(now < ends, "the round ended before the test could dig");
        call(p, &w.game, "dig", json!({"room_id": id, "x": x, "y": y, "seen_clue": 2}), 0).await?.into_result()?;
    }
    let view = w.room(id).await?;
    let bonuses: Vec<u64> = view["digs"].as_array().unwrap().iter().map(|d| d["bonus_bps"].as_u64().unwrap()).collect();
    assert_eq!(bonuses, [25000, 25000, 15000, 15000]);

    let hosted_before = w.balance_milli(&host).await?;
    let settle = w.run_steps(id, 4).await?.unwrap();
    let all = events(&settle);
    let finished = &event(&all, "finished")["data"];
    let treasure = &event(&all, "revealed")["data"]["treasure"];
    assert_eq!(&finished["treasure"], treasure);
    assert_eq!(finished["ranking"].as_array().unwrap().len(), 4);
    assert_eq!(finished["pot"], 200);
    assert!(all.iter().any(|e| e["event"] == "balance"));

    let view = w.room(id).await?;
    assert_eq!(view["status"], "finished");
    assert_eq!(view["result"]["treasure"], *treasure);
    let split = &view["result"]["split"];
    assert_eq!(split["host_cut"], 10);
    assert_eq!(split["prize"], 200 - 10 - 6 - 4 - 2);
    assert_eq!(w.balance_milli(&host).await? - hosted_before, (BOND + 10) as u128);
    let winner = view["result"]["winner"].as_str().unwrap();
    assert_eq!(view["result"]["ranking"][0]["account"], winner);

    // Every link chains to the tip, and every roll seed recomputes from what's public.
    let mut previous = from_hex32(view["tip"].as_str().unwrap()).unwrap();
    for (i, roll) in view["rolls"].as_array().unwrap().iter().enumerate() {
        let link = from_hex32(roll["link"].as_str().unwrap()).unwrap();
        assert_eq!(sha256(&link), previous, "link {i}");
        previous = link;
        let seed = roll_seed(
            id,
            (i + 1) as u8,
            &from_hex32(roll["lock_seed"].as_str().unwrap()).unwrap(),
            &link,
            &from_hex32(roll["digs_hash"].as_str().unwrap()).unwrap(),
        );
        assert_eq!(to_hex(&seed), roll["roll_seed"].as_str().unwrap());
        assert!(roll["lock_height"].as_u64().unwrap() < roll["reveal_height"].as_u64().unwrap());
    }

    assert_eq!(w.game.view("get_jackpot").await?.json::<u64>()?, 6 + 4);
    let recent: Value = w.game.view("get_recent_finished").await?.json()?;
    assert_eq!(recent[0]["room_id"], id);
    assert_eq!(recent[0]["winner"], winner);
    let totals: Value = w.game.view("get_totals").await?.json()?;
    assert_eq!(totals["held"], 0);
    assert_eq!(totals["season_pool"], 2);
    assert_solvent(&w).await
}

#[tokio::test]
async fn refund_paths_including_missed_reveal_with_the_backend_gone() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(4).await?;
    let host = w.player("host").await?;
    let players = vec![w.player("a").await?, w.player("b").await?, w.player("c").await?];
    let fee = 10;

    // Too few digs: one dig at the end refunds, with no lock or treasure roll.
    let room = w.make_room(&host, "tropical", fee, 60, 2, 30, 0).await?;
    w.join_all(room, fee, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    w.dig_all(room, "tropical", &players[..1], 1).await?;
    let ends = w.room(room).await?["ends_at_ms"].as_u64().unwrap();
    w.warp_to(ends).await?;
    let late = call(&players[1], &w.game, "dig", json!({"room_id": room, "x": 60, "y": 60, "seen_clue": 1}), 0).await?;
    assert!(failure(&late).contains("This game has ended"));
    let before = w.balance_milli(&players[0]).await?;
    assert_eq!(w.poke(room).await?, "refunded");
    assert_eq!(w.balance_milli(&players[0]).await? - before, fee as u128);
    let view = w.room(room).await?;
    assert_eq!(view["result"]["refund_reason"], "too-few-digs");
    assert_eq!(view["rolls"].as_array().unwrap().len(), 0);

    // Missed reveal, never locked: nobody ever called anything after the digs. Anyone pokes it home.
    let room = w.make_room(&host, "tropical", fee, 60, 2, 30, 0).await?;
    w.join_all(room, fee, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    w.dig_all(room, "tropical", &players, 1).await?;
    let view = w.room(room).await?;
    w.warp_to(view["next_due_ms"].as_u64().unwrap() + 120_000).await?;
    let hosted = w.balance_milli(&host).await?;
    let stranger = w.player("stranger").await?;
    let poked = call(&stranger, &w.game, "poke", json!({ "room_id": room }), 0).await?;
    assert_eq!(poked.clone().into_result()?.json::<String>()?, "refunded");
    assert_eq!(event(&events(&poked), "refunded")["data"]["reason"], "missed-reveal");
    assert_eq!(w.balance_milli(&host).await? - hosted, BOND as u128, "the bond comes back whole");
    assert_eq!(w.game.view("missed_reveals").await?.json::<u64>()?, 1);

    // Missed reveal, locked: the oracle locked and then vanished. A reveal past the deadline is refused.
    let room = w.make_room(&host, "tropical", fee, 60, 2, 30, 0).await?;
    w.join_all(room, fee, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    w.dig_all(room, "tropical", &players, 1).await?;
    let view = w.room(room).await?;
    let due = view["next_due_ms"].as_u64().unwrap();
    w.warp_to(due).await?;
    assert_eq!(w.poke(room).await?, "locked");
    assert_eq!(w.room(room).await?["locked"], true);
    w.warp_to(due + 120_000).await?;
    let (_, links) = links_of(view["tip_index"].as_u64().unwrap());
    let too_late = w.reveal(room, &links[0]).await?;
    assert!(failure(&too_late).contains("reveal deadline has passed"));
    assert_eq!(w.poke(room).await?, "refunded");
    assert_eq!(w.game.view("missed_reveals").await?.json::<u64>()?, 2);
    assert_eq!(w.room(room).await?["result"]["refund_reason"], "missed-reveal");

    // Expired: under the minimum at the deadline. The host loses 10% to the jackpot, players nothing.
    let room = w.make_room(&host, "tropical", fee, 60, 3, 30, 0).await?;
    w.join_all(room, fee, &players[..2]).await?;
    let view = w.room(room).await?;
    let jackpot = w.game.view("get_jackpot").await?.json::<u64>()?;
    let hosted = w.balance_milli(&host).await?;
    w.warp_to(view["deadline_ms"].as_u64().unwrap()).await?;
    let late = call(&players[2], &w.game, "join", json!({ "room_id": room }), YOCTO_PER_MILLI * fee as u128).await?;
    assert!(failure(&late).contains("run out of time"));
    assert_eq!(w.poke(room).await?, "refunded");
    assert_eq!(w.balance_milli(&host).await? - hosted, (BOND - 10) as u128);
    assert_eq!(w.game.view("get_jackpot").await?.json::<u64>()?, jackpot + 10);
    let hosting: Value = w.game.view("get_host").args_json(json!({"id": host.id()})).await?.json()?;
    assert_eq!(hosting["expired"], 1);
    assert_eq!(hosting["open_rooms"], 0);

    let totals: Value = w.game.view("get_totals").await?.json()?;
    assert_eq!(totals["held"], 0);
    assert_solvent(&w).await
}

#[tokio::test]
async fn deadline_and_timer_starts_and_leaving() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(3).await?;
    let host = w.player("host").await?;
    let players = vec![w.player("a").await?, w.player("b").await?, w.player("c").await?];
    let fee = 10;

    // Countdown: reaching the minimum starts it, and dropping below it cancels it.
    let room = w.make_room(&host, "desert", fee, 60, 2, 30, 30).await?;
    w.join_all(room, fee, &players[..2]).await?;
    let view = w.room(room).await?;
    let start_at = view["start_at_ms"].as_u64().unwrap();
    assert_eq!(w.poke(room).await?, "none");

    let before = w.balance_milli(&players[1]).await?;
    let left = call(&players[1], &w.game, "leave", json!({ "room_id": room }), 0).await?;
    assert!(left.is_success());
    assert_eq!(event(&events(&left), "left")["data"]["players"], 1);
    assert_eq!(w.balance_milli(&players[1]).await? - before, fee as u128);
    assert!(w.room(room).await?["start_at_ms"].is_null());
    let not_in = call(&players[2], &w.game, "leave", json!({ "room_id": room }), 0).await?;
    assert!(failure(&not_in).contains("haven't joined"));

    w.join_all(room, fee, &players[1..2]).await?;
    let start_at_again = w.room(room).await?["start_at_ms"].as_u64().unwrap();
    assert!(start_at_again >= start_at);
    w.warp_to(start_at_again).await?;
    let late = call(&players[2], &w.game, "join", json!({ "room_id": room }), YOCTO_PER_MILLI * fee as u128).await?;
    assert!(failure(&late).contains("starting"));
    assert_eq!(w.poke(room).await?, "started");
    assert_eq!(w.room(room).await?["status"], "live");
    let left = call(&players[0], &w.game, "leave", json!({ "room_id": room }), 0).await?;
    assert!(failure(&left).contains("before the round starts"));

    // A full room starts soon, with no countdown set.
    let room = w.make_room(&host, "desert", fee, 60, 2, 2, 0).await?;
    let early = call(&players[0], &w.game, "start", json!({ "room_id": room }), 0).await?;
    assert!(failure(&early).contains("Only the host"));
    let not_enough = call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?;
    assert!(failure(&not_enough).contains("enough players"));
    w.join_all(room, fee, &players[..2]).await?;
    let view = w.room(room).await?;
    let start_at = view["start_at_ms"].as_u64().unwrap();
    let full = call(&players[2], &w.game, "join", json!({ "room_id": room }), YOCTO_PER_MILLI * fee as u128).await?;
    assert!(failure(&full).contains("full") || failure(&full).contains("starting"));
    w.warp_to(start_at).await?;
    assert_eq!(w.poke(room).await?, "started");

    // At the 15-minute deadline a room at the minimum starts, with no countdown to do it earlier.
    let room = w.make_room(&host, "desert", fee, 60, 2, 30, 0).await?;
    w.join_all(room, fee, &players[..2]).await?;
    let view = w.room(room).await?;
    assert!(view["start_at_ms"].is_null());
    w.warp_to(view["deadline_ms"].as_u64().unwrap()).await?;
    let poked = call(&w.root, &w.game, "poke", json!({ "room_id": room }), 0).await?;
    assert_eq!(event(&events(&poked), "started")["data"]["by"], "deadline");
    Ok(())
}

#[tokio::test]
async fn jackpot_for_an_exact_pixel() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(2).await?;
    let host = w.player("host").await?;
    let players = vec![w.player("a").await?, w.player("b").await?, w.player("c").await?];
    let fee = 1000;

    // An ordinary round fills the jackpot.
    let room = w.make_room(&host, "tropical", fee, 60, 2, 30, 0).await?;
    w.join_all(room, fee, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    w.dig_all(room, "tropical", &players, 1).await?;
    w.run_steps(room, 4).await?;
    let jackpot: u64 = w.game.view("get_jackpot").await?.json()?;
    assert_eq!(jackpot, 150, "3% plus the unowned deed's 2% of a 3000 pot");

    // Nobody can know the treasure while digs are open, which is the point of the design. So to reach
    // this path, the test locks the roll, works out the treasure, and rewrites one dig in state to sit on it.
    let room = w.make_room(&host, "tropical", fee, 60, 2, 30, 0).await?;
    w.join_all(room, fee, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    w.dig_all(room, "tropical", &players, 1).await?;
    w.run_steps(room, 3).await?;
    let view = w.room(room).await?;
    let due = view["next_due_ms"].as_u64().unwrap();
    w.warp_to(due).await?;
    assert_eq!(w.poke(room).await?, "locked");

    let view = w.room(room).await?;
    let (_, links) = links_of(view["tip_index"].as_u64().unwrap());
    let roll = &view["rolls"][3];
    let seed = roll_seed(
        room,
        4,
        &from_hex32(roll["lock_seed"].as_str().unwrap()).unwrap(),
        &links[3],
        &from_hex32(roll["digs_hash"].as_str().unwrap()).unwrap(),
    );
    let places: Vec<(u8, u16, u16)> = view["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            let l = &view["landmarks"][id.as_u64().unwrap() as usize];
            (id.as_u64().unwrap() as u8, l["x"].as_u64().unwrap() as u16, l["y"].as_u64().unwrap() as u16)
        })
        .collect();
    let treasure = roll_treasure(0, &places, &mut Stream::new(seed));

    let mut key = vec![1u8];
    key.extend_from_slice(&room.to_le_bytes());
    let state = w.game.view_state().await?;
    let raw = state.get(&key).expect("the room is at the key the contract uses");
    let mut stored: Room = near_sdk::borsh::from_slice(raw)?;
    stored.digs[1].x = treasure.x;
    stored.digs[1].y = treasure.y;
    // Digs ran concurrently, so a dig's place in the list says nothing about who made it.
    let lucky_name = view["digs"][1]["account"].as_str().unwrap().to_string();
    w.worker.patch_state(w.game.id(), &key, &near_sdk::borsh::to_vec(&stored)?).await?;

    let lucky = players.iter().find(|p| p.id().as_str() == lucky_name).unwrap();
    let before = w.balance_milli(lucky).await?;
    let settled = w.reveal(room, &links[3]).await?;
    assert!(settled.is_success(), "{:?}", settled.failures());
    let all = events(&settled);
    let finished = &event(&all, "finished")["data"];
    // Grown by this round's 3% and unowned deed's 2% first, then 80% of that pays out.
    let grown = jackpot + 150;
    let win = grown * 8000 / 10000;
    assert_eq!(finished["jackpot_win"]["account"], lucky.id().as_str());
    assert_eq!(finished["jackpot_win"]["amount"], win);
    assert_eq!(finished["jackpot_after"], grown - win);
    assert_eq!(w.game.view("get_jackpot").await?.json::<u64>()?, grown - win);
    let prize = if finished["winner"] == lucky.id().as_str() { finished["split"]["prize"].as_u64().unwrap() } else { 0 };
    assert_eq!(w.balance_milli(lucky).await? - before, (win + prize) as u128);
    assert_eq!(w.room(room).await?["result"]["jackpot_win"]["amount"], win);
    assert_solvent(&w).await
}

#[tokio::test]
async fn nft_mint_list_buy_and_listing_cancelled_by_transfer() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(1).await?;
    let host = w.player("host").await?;
    let alice = w.player("alice").await?;
    let bob = w.player("bob").await?;
    let carol = w.player("carol").await?;
    let price = MINT_PRICE as u128 * YOCTO_PER_MILLI;

    let bad = call(&alice, &w.game, "mint_nft", json!({"token_id": "snowy:banana"}), price).await?;
    assert!(failure(&bad).contains("no such NFT"));

    // Attached goes to the balance, then the price comes out of it. Minting into a kind on another map works too.
    let treasury_before = w.balance_yocto(&w.treasury).await?;
    let minted = call(&alice, &w.game, "mint_nft", json!({"token_id": "snowy:penguin"}), price * 2).await?;
    assert!(minted.is_success(), "{:?}", minted.failures());
    let logs = minted.logs();
    assert!(logs.iter().any(|l| l.contains("\"standard\":\"nep171\"") && l.contains("nft_mint")), "{logs:?}");
    let all = events(&minted);
    let mint = &event(&all, "nft_minted")["data"];
    let received: u128 = mint["treasury_received"].as_str().unwrap().parse()?;
    let storage: u128 = mint["storage_cost"].as_str().unwrap().parse()?;
    assert_eq!(received + storage, price, "the minter pays exactly the mint price");
    assert_eq!(w.balance_yocto(&w.treasury).await? - treasury_before, received);
    assert!(storage < price / 10, "storage cost {storage}");

    let again = call(&bob, &w.game, "mint_nft", json!({"token_id": "snowy:penguin"}), price).await?;
    assert!(failure(&again).contains("already been minted"));

    let token: Value = w.game.view("nft_token").args_json(json!({"token_id": "snowy:penguin"})).await?.json()?;
    assert_eq!(token["owner_id"], alice.id().as_str());
    assert!(token["metadata"]["title"].as_str().unwrap().contains("snowy:penguin"));
    let meta: Value = w.game.view("nft_metadata").await?.json()?;
    assert_eq!(meta["symbol"], "DIGHERE");
    assert_eq!(w.game.view("nft_total_supply").await?.json::<String>()?, "1");
    let supply: String = w.game.view("nft_supply_for_owner").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(supply, "1");

    // Listing.
    let not_mine = call(&bob, &w.game, "list_nft", json!({"token_id": "snowy:penguin", "price": 100}), 0).await?;
    assert!(failure(&not_mine).contains("don't own"));
    let listed = call(&alice, &w.game, "list_nft", json!({"token_id": "snowy:penguin", "price": 100}), 0).await?;
    assert_eq!(event(&events(&listed), "nft_listed")["data"]["price"], 100);
    let nfts: Value = w.game.view("get_nfts").args_json(json!({"from": 0, "limit": 36})).await?.json()?;
    assert_eq!(nfts.as_array().unwrap().len(), 36);
    let row = nfts.as_array().unwrap().iter().find(|n| n["token_id"] == "snowy:penguin").unwrap();
    assert_eq!(row["owner"], alice.id().as_str());
    assert_eq!(row["price"], 100);

    // Buying: the wrong price is turned down, and the right one pays the owner's balance.
    let bid = 100 * YOCTO_PER_MILLI;
    let stale = call(&bob, &w.game, "buy_nft", json!({"token_id": "snowy:penguin", "seen_price": 99}), bid).await?;
    assert!(failure(&stale).contains("price just changed"));
    let own = call(&alice, &w.game, "buy_nft", json!({"token_id": "snowy:penguin", "seen_price": 100}), 0).await?;
    assert!(failure(&own).contains("already own"));
    let seller_before = w.balance_milli(&alice).await?;
    let bought = call(&bob, &w.game, "buy_nft", json!({"token_id": "snowy:penguin", "seen_price": 100}), bid + YOCTO_PER_MILLI * 2).await?;
    assert!(bought.is_success(), "{:?}", bought.failures());
    assert!(bought.logs().iter().any(|l| l.contains("nep171") && l.contains("nft_transfer")));
    assert_eq!(event(&events(&bought), "nft_sold")["data"]["seller"], alice.id().as_str());
    assert_eq!(w.balance_milli(&alice).await? - seller_before, 100);
    let token: Value = w.game.view("nft_token").args_json(json!({"token_id": "snowy:penguin"})).await?.json()?;
    assert_eq!(token["owner_id"], bob.id().as_str());
    let gone = call(&carol, &w.game, "buy_nft", json!({"token_id": "snowy:penguin", "seen_price": 100}), bid).await?;
    assert!(failure(&gone).contains("isn't for sale"));

    // A transfer ends the listing, so nobody can buy from the old owner's price.
    call(&bob, &w.game, "list_nft", json!({"token_id": "snowy:penguin", "price": 50}), 0).await?.into_result()?;
    let no_record = call(&bob, &w.game, "nft_transfer", json!({"receiver_id": carol.id(), "token_id": "snowy:penguin"}), 1).await?;
    assert!(failure(&no_record).contains("needs a Dig Here balance"));
    call(&bob, &w.game, "deposit_for", json!({"account_id": carol.id()}), YOCTO_PER_MILLI * 5).await?.into_result()?;
    let no_yocto = call(&bob, &w.game, "nft_transfer", json!({"receiver_id": carol.id(), "token_id": "snowy:penguin"}), 0).await?;
    assert!(failure(&no_yocto).contains("1 yoctoNEAR"));
    let moved = call(&bob, &w.game, "nft_transfer", json!({"receiver_id": carol.id(), "token_id": "snowy:penguin"}), 1).await?;
    assert!(moved.is_success(), "{:?}", moved.failures());
    assert_eq!(event(&events(&moved), "nft_listing_cancelled")["data"]["reason"], "transferred");
    let dead = call(&alice, &w.game, "buy_nft", json!({"token_id": "snowy:penguin", "seen_price": 50}), 50 * YOCTO_PER_MILLI).await?;
    assert!(failure(&dead).contains("isn't for sale"));
    let nfts: Value = w.game.view("get_nfts").args_json(json!({"from": 13, "limit": 5})).await?.json()?;
    let row = nfts.as_array().unwrap().iter().find(|n| n["token_id"] == "snowy:penguin").unwrap();
    assert!(row["price"].is_null());
    assert_eq!(row["owner"], carol.id().as_str());

    // A transfer call that fails sends the token back, and any listing with it stays gone.
    call(&carol, &w.game, "list_nft", json!({"token_id": "snowy:penguin", "price": 70}), 0).await?.into_result()?;
    let back = call(
        &carol,
        &w.game,
        "nft_transfer_call",
        json!({"receiver_id": alice.id(), "token_id": "snowy:penguin", "msg": "hello"}),
        1,
    )
    .await?;
    assert!(back.logs().iter().any(|l| l.contains("nft_transfer")));
    let token: Value = w.game.view("nft_token").args_json(json!({"token_id": "snowy:penguin"})).await?.json()?;
    assert_eq!(token["owner_id"], carol.id().as_str(), "a receiver with no code can't keep it");
    let nfts: Value = w.game.view("get_nfts").args_json(json!({"from": 16, "limit": 1})).await?.json()?;
    assert!(nfts[0]["token_id"] == "snowy:penguin" && nfts[0]["price"].is_null());

    // Owning a deed earns its share. Own all twelve kinds on a map so the landing has to hit one.
    let kinds = ["lighthouse", "well", "hut", "windmill", "pine", "apple", "scarecrow", "cow", "sheep", "duck", "boat", "palm"];
    for kind in kinds {
        call(&alice, &w.game, "mint_nft", json!({"token_id": format!("tropical:{kind}")}), price).await?.into_result()?;
    }
    let players = vec![w.player("p1").await?, w.player("p2").await?, w.player("p3").await?];
    let room = w.make_room(&host, "tropical", 1000, 60, 2, 30, 0).await?;
    w.join_all(room, 1000, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    w.dig_all(room, "tropical", &players, 1).await?;
    let before = w.balance_milli(&alice).await?;
    let settled = w.run_steps(room, 4).await?.unwrap();
    let all = events(&settled);
    let deed = &event(&all, "finished")["data"]["deed"];
    assert_eq!(deed["owner"], alice.id().as_str());
    assert_eq!(deed["paid"], 60);
    assert_eq!(deed["earned"], 60);
    assert_eq!(deed["landings"], 1);
    assert_eq!(w.balance_milli(&alice).await? - before, 60);
    assert_eq!(w.game.view("get_jackpot").await?.json::<u64>()?, 90, "the deed share went to its owner, not the jackpot");
    assert_solvent(&w).await
}

#[tokio::test]
async fn withdraw_success_and_failure_callback() -> Result<()> {
    let w = world().await?;
    let alice = w.player("alice").await?;
    call(&alice, &w.game, "deposit", json!({}), near(2).as_yoctonear()).await?.into_result()?;
    let balance = w.balance_yocto(&alice).await?;
    assert!(balance < near(2).as_yoctonear(), "the first credit paid for the record");

    let none = call(&alice, &w.game, "withdraw", json!({"amount": "1000"}), 0).await?;
    assert!(failure(&none).contains("1 yoctoNEAR"));
    let two = call(&alice, &w.game, "withdraw", json!({"amount": "1000"}), 2).await?;
    assert!(failure(&two).contains("1 yoctoNEAR"));
    let over = call(&alice, &w.game, "withdraw", json!({"amount": (balance + 1).to_string()}), 1).await?;
    assert!(failure(&over).contains("Not enough coins"));
    let starved = alice
        .call(w.game.id(), "withdraw")
        .args_json(json!({"amount": "1000"}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(3))
        .transact()
        .await?;
    assert!(failure(&starved).contains("at least 5 Tgas"));

    let wallet_before = alice.view_account().await?.balance.as_yoctonear();
    let amount = near(1).as_yoctonear();
    let out = call(&alice, &w.game, "withdraw", json!({"amount": amount.to_string()}), 1).await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert!(out.clone().json::<bool>()?);
    assert_eq!(w.balance_yocto(&alice).await?, balance - amount);
    let wallet_after = alice.view_account().await?.balance.as_yoctonear();
    assert!(wallet_after > wallet_before + amount - near(1).as_yoctonear() / 100, "{wallet_before} -> {wallet_after}");
    assert_solvent(&w).await?;

    // Send the withdraw, then delete the account while the coins are on their way. The transfer fails,
    // and the callback must put the balance back without panicking.
    let gone = w.player("gone").await?;
    call(&gone, &w.game, "deposit", json!({}), near(3).as_yoctonear()).await?.into_result()?;
    let held = w.balance_yocto(&gone).await?;
    let sent = gone
        .call(w.game.id(), "withdraw")
        .args_json(json!({"amount": near(1).as_yoctonear().to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact_async()
        .await?;
    let id = gone.id().clone();
    let deleted = gone.delete_account(w.root.id()).await?;
    assert!(deleted.is_success(), "{:?}", deleted.failures());
    let outcome = loop {
        if let std::task::Poll::Ready(result) = sent.status().await? {
            break result;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    };
    let all = events(&outcome);
    assert!(all.len() >= 2, "expected the debit and the restore: {all:?}");
    assert!(!outcome.receipt_failures().is_empty(), "the transfer should have failed");
    let reasons: Vec<&str> = all
        .iter()
        .flat_map(|e| e["data"]["changes"].as_array().cloned().unwrap_or_default().into_iter())
        .map(|c| c["reason"].as_str().unwrap().to_string())
        .map(|s| Box::leak(s.into_boxed_str()) as &str)
        .collect();
    assert_eq!(reasons, ["withdraw", "withdraw_failed"]);
    let v: Value = w.game.view("get_account").args_json(json!({ "id": id })).await?.json()?;
    assert_eq!(v["balance"].as_str().unwrap(), held.to_string(), "every yocto is back");
    let receipts: Vec<f64> = outcome.receipt_outcomes().iter().map(|o| o.gas_burnt.as_gas() as f64 / 1e12).collect();
    println!("WITHDRAW failure path: receipts {receipts:?} Tgas; the callback has 2 Tgas reserved");
    assert_solvent(&w).await
}

#[tokio::test]
async fn function_call_keys_can_play_but_not_move_coins() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(1).await?;
    let host = w.player("host").await?;
    let guest = w.player("guest").await?;
    let other = w.player("other").await?;

    // Coins arrive for the guest, then its browser only holds a function-call key on this contract.
    call(&w.root, &w.game, "deposit_for", json!({"account_id": guest.id()}), near(1).as_yoctonear()).await?.into_result()?;
    let key = SecretKey::from_random(KeyType::ED25519);
    guest
        .batch(guest.id())
        .add_key(key.public_key(), AccessKey::function_call_access(w.game.id(), &[], Some(near(1))))
        .transact()
        .await?
        .into_result()?;
    let browser = Account::from_secret_key(guest.id().clone(), key, &w.worker);

    let fee = 10;
    let room = w.make_room(&host, "snowy", fee, 60, 2, 30, 0).await?;
    let joined = browser.call(w.game.id(), "join").args_json(json!({ "room_id": room })).gas(Gas::from_tgas(10)).transact().await?;
    assert!(joined.is_success(), "a function-call key joins silently: {:?}", joined.failures());
    w.join_all(room, fee, std::slice::from_ref(&other)).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    let spot = land_spots("snowy", 1)[0];
    let dug = browser
        .call(w.game.id(), "dig")
        .args_json(json!({"room_id": room, "x": spot.0, "y": spot.1, "seen_clue": 1}))
        .gas(Gas::from_tgas(5))
        .transact()
        .await?;
    assert!(dug.is_success(), "{:?}", dug.failures());

    // The node refuses a deposit from a function-call key before the contract even runs.
    let before = w.balance_yocto(&guest).await?;
    let attach_one = |method: &'static str, args: Value| {
        browser.call(w.game.id(), method).args_json(args).deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(10)).transact()
    };
    let out = attach_one("withdraw", json!({"amount": "1000"})).await;
    assert!(format!("{out:?}").contains("Deposit") || out.is_err(), "withdraw from a function-call key: {out:?}");
    let sent = attach_one("nft_transfer", json!({"receiver_id": other.id(), "token_id": "snowy:pine"})).await;
    assert!(format!("{sent:?}").contains("Deposit") || sent.is_err(), "nft_transfer from a function-call key: {sent:?}");
    assert_eq!(w.balance_yocto(&guest).await?, before);
    Ok(())
}

#[tokio::test]
async fn season_close_pays_the_top_three_and_skips_bots() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(2).await?;
    let host = w.player("host").await?;
    let bots = w.root.create_subaccount("bots").initial_balance(near(30)).transact().await?.into_result()?;
    let bot = bots.create_subaccount("zed").initial_balance(near(20)).transact().await?.into_result()?;
    let players = vec![bot.clone(), w.player("a").await?, w.player("b").await?, w.player("c").await?];
    let fee = 1000;

    let early = call(&w.root, &w.game, "close_season", json!({}), 0).await?;
    assert!(failure(&early).contains("hasn't ended"));

    let room = w.make_room(&host, "desert", fee, 60, 2, 30, 0).await?;
    w.join_all(room, fee, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    w.dig_all(room, "desert", &players, 1).await?;
    let settled = w.run_steps(room, 4).await?.unwrap();
    let all = events(&settled);
    let points = event(&all, "finished")["data"]["season_points"].as_array().unwrap().clone();
    assert_eq!(points.len(), 3);
    assert_eq!(points[0]["points"], 400, "100 per NEAR on a 4 NEAR pot");
    assert_eq!(points[1]["points"], 120);
    assert_eq!(points[2]["points"], 40);

    let season: Value = w.game.view("get_season").await?.json()?;
    assert_eq!(season["number"], 1);
    assert_eq!(season["pool"], 40);
    let top = season["top"].as_array().unwrap();
    assert!(top.iter().all(|e| e["account"] != bot.id().as_str()), "bots stay off the prize list");
    assert!(top.len() >= 2);
    for pair in top.windows(2) {
        assert!(pair[0]["points"].as_u64() >= pair[1]["points"].as_u64());
    }

    let first = top[0]["account"].as_str().unwrap().to_string();
    let first_view: Value = w.game.view("get_account").args_json(json!({ "id": first })).await?.json()?;
    assert_eq!(first_view["season_points"], top[0]["points"]);
    let ends = season["ends_at_ms"].as_u64().unwrap();
    w.warp_to(ends).await?;
    let closed = call(&w.root, &w.game, "close_season", json!({}), 0).await?;
    assert!(closed.is_success(), "{:?}", closed.failures());
    let all = events(&closed);
    let data = &event(&all, "season_closed")["data"];
    assert_eq!(data["season"], 1);
    assert_eq!(data["prizes"][0]["account"], first.as_str());
    assert_eq!(data["prizes"][0]["prize"], 24, "60% of a 40 pool");
    let paid: u64 = data["prizes"].as_array().unwrap().iter().map(|p| p["prize"].as_u64().unwrap()).sum();
    assert_eq!(data["pool_after"], 40 - paid);

    let season: Value = w.game.view("get_season").await?.json()?;
    assert_eq!(season["number"], 2);
    assert_eq!(season["top"].as_array().unwrap().len(), 0);
    assert_eq!(season["last_winners"][0]["account"], first.as_str());
    let first_view: Value = w.game.view("get_account").args_json(json!({ "id": first })).await?.json()?;
    assert_eq!(first_view["season_points"], 0, "the next season starts from nothing without touching every record");

    let again = call(&w.root, &w.game, "close_season", json!({}), 0).await?;
    assert!(failure(&again).contains("hasn't ended"));
    assert_solvent(&w).await
}

#[tokio::test]
async fn reveal_rejects_replays_wrong_links_and_the_same_block() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(1).await?;
    let host = w.player("host").await?;
    let players = vec![w.player("a").await?, w.player("b").await?];
    let fee = 10;
    let room = w.make_room(&host, "tropical", fee, 60, 2, 30, 0).await?;
    w.join_all(room, fee, &players).await?;
    call(&host, &w.game, "start", json!({ "room_id": room }), 0).await?.into_result()?;
    w.dig_all(room, "tropical", &players, 1).await?;
    let (_, links) = links_of(0);

    let nothing = w.reveal(room, &links[0]).await?;
    assert!(failure(&nothing).contains("No roll is waiting"));

    let view = w.room(room).await?;
    let due = view["next_due_ms"].as_u64().unwrap();
    w.warp_to(due).await?;

    // Poke then reveal in one transaction runs in one receipt, so in one block. That must fail as a whole.
    let same_block = w
        .root
        .batch(w.game.id())
        .call(near_workspaces::operations::Function::new("poke").args_json(json!({"room_id": room})).gas(Gas::from_tgas(50)))
        .call(
            near_workspaces::operations::Function::new("reveal")
                .args_json(json!({"room_id": room, "link": to_hex(&links[0])}))
                .gas(Gas::from_tgas(50)),
        )
        .transact()
        .await?;
    assert!(failure(&same_block).contains("later block"));
    assert_eq!(w.room(room).await?["locked"], false, "the failed batch left no lock behind");

    assert_eq!(w.poke(room).await?, "locked");
    assert_eq!(w.poke(room).await?, "none", "locking twice does nothing");
    let locked = w.room(room).await?;
    let lock_seed = locked["rolls"][0]["lock_seed"].clone();

    let wrong = w.reveal(room, &[9u8; 32]).await?;
    assert!(failure(&wrong).contains("doesn't match"));
    let not_hex = call(&w.root, &w.game, "reveal", json!({"room_id": room, "link": "zz"}), 0).await?;
    assert!(failure(&not_hex).contains("64 lowercase hex"));
    let skip = w.reveal(room, &links[1]).await?;
    assert!(failure(&skip).contains("doesn't match"));
    assert_eq!(w.room(room).await?["rolls"][0]["lock_seed"], lock_seed, "a bad reveal changes nothing");

    let good = w.reveal(room, &links[0]).await?;
    assert!(good.is_success(), "{:?}", good.failures());
    let replay = w.reveal(room, &links[0]).await?;
    assert!(failure(&replay).contains("No roll is waiting"));

    let view = w.room(room).await?;
    assert_eq!(view["clues"].as_array().unwrap().len(), 2);
    w.warp_to(view["next_due_ms"].as_u64().unwrap()).await?;
    assert_eq!(w.poke(room).await?, "locked");
    let replay_locked = w.reveal(room, &links[0]).await?;
    assert!(failure(&replay_locked).contains("doesn't match"), "an old link can't answer a new lock");
    assert_eq!(w.room(room).await?["clues"].as_array().unwrap().len(), 2);
    Ok(())
}

#[tokio::test]
async fn access_rules_and_input_limits() -> Result<()> {
    let mut w = world().await?;
    let host = w.player("host").await?;

    // A stranger can't add commitments, or call init a second time, or reach the callback.
    let not_oracle = call(&host, &w.game, "add_commitments", json!({"tips": [to_hex(&[1; 32])]}), 0).await?;
    assert!(failure(&not_oracle).contains("Only the oracle"));
    let bad_tip = call(&w.oracle, &w.game, "add_commitments", json!({"tips": ["00"]}), 0).await?;
    assert!(failure(&bad_tip).contains("64 lowercase hex"));
    let reinit = call(&host, &w.game, "new", json!({"config": {
        "oracle": host.id(), "treasury": host.id(), "mint_price": 1, "host_bond": 1, "season_length_sec": 1, "prize_excluded_suffix": "",
    }}), 0).await?;
    assert!(failure(&reinit).contains("private"));
    let callback = call(&host, &w.game, "on_withdraw", json!({"account_id": host.id(), "amount": "1000"}), 0).await?;
    assert!(failure(&callback).contains("private"));
    assert_eq!(w.balance_yocto(&host).await?, 0);

    // No seeds yet: the deposit comes back.
    let wallet = host.view_account().await?.balance.as_yoctonear();
    let empty = call(&host, &w.game, "create_room", json!({"name": "x", "map": "snowy", "fee": 10, "duration_sec": 60,
        "host_cut_bps": 0, "min_players": 2, "max_players": 30, "countdown_sec": 0}), near(1).as_yoctonear()).await?;
    assert!(failure(&empty).contains("No round seeds"));
    // Gas refunds from earlier calls can land in between, so the wallet may even have grown.
    let spent = wallet.saturating_sub(host.view_account().await?.balance.as_yoctonear());
    assert!(spent < near(1).as_yoctonear() / 100, "only gas was spent, not {spent}");

    w.add_tips(1).await?;
    let attempt = |patch: Value| {
        let mut args = json!({"name": "x", "map": "snowy", "fee": 10, "duration_sec": 60, "host_cut_bps": 0,
            "min_players": 2, "max_players": 30, "countdown_sec": 0});
        for (k, v) in patch.as_object().unwrap() {
            args[k] = v.clone();
        }
        call(&host, &w.game, "create_room", args, near(1).as_yoctonear())
    };
    let cases = [
        (json!({"name": "   "}), "Give the game a name"),
        (json!({"name": "x".repeat(41)}), "too long"),
        (json!({"map": "moon"}), "no such map"),
        (json!({"fee": 0}), "above 0"),
        (json!({"fee": 100_000_000_001u64}), "too high"),
        (json!({"host_cut_bps": 2001}), "at most 20%"),
        (json!({"duration_sec": 61}), "Pick a timer"),
        (json!({"countdown_sec": 7}), "Pick a countdown"),
        (json!({"min_players": 1}), "at least 2"),
        (json!({"max_players": 31}), "at most 30"),
        (json!({"min_players": 5, "max_players": 4}), "above the maximum"),
    ];
    for (patch, wanted) in cases {
        let result = attempt(patch.clone()).await?;
        assert!(failure(&result).contains(wanted), "{patch}: {:?}", result.failures());
    }

    // Deposits: nothing to deposit, and too little to pay for a record.
    let zero = call(&host, &w.game, "deposit", json!({}), 0).await?;
    assert!(failure(&zero).contains("Attach some NEAR"));
    let fresh = w.player("fresh").await?;
    let tiny = call(&fresh, &w.game, "deposit", json!({}), 1000).await?;
    assert!(failure(&tiny).contains("first deposit"));
    assert!(w.game.view("get_account").args_json(json!({"id": fresh.id()})).await?.json::<Value>()?.is_null());

    // A guest's coins: deposit_for pays the record out of the amount.
    let sponsor = w.player("sponsor").await?;
    let guest = w.player("guest").await?;
    let sent = near(1).as_yoctonear();
    let paid = call(&sponsor, &w.game, "deposit_for", json!({"account_id": guest.id()}), sent).await?;
    assert!(paid.is_success());
    let credited = w.balance_yocto(&guest).await?;
    assert!(credited < sent && sent - credited < near(1).as_yoctonear() / 100);
    assert_eq!(w.balance_yocto(&sponsor).await?, 0);
    Ok(())
}

#[tokio::test]
async fn open_rooms_are_capped_and_old_rooms_fall_off_the_ring() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(32).await?;
    let mut hosts = Vec::new();
    for i in 0..11 {
        hosts.push(w.player(&format!("h{i}")).await?);
    }
    let over = hosts[0].clone();
    let mut rooms = Vec::new();
    for i in 0..3 {
        rooms.push(w.make_room(&hosts[0], "snowy", 10, 60, 2, 30, 0).await?);
        assert_eq!(rooms[i], i as u64 + 1);
    }
    let fourth = call(&over, &w.game, "create_room", json!({"name": "x", "map": "snowy", "fee": 10, "duration_sec": 60,
        "host_cut_bps": 0, "min_players": 2, "max_players": 30, "countdown_sec": 0}), near(1).as_yoctonear()).await?;
    assert!(failure(&fourth).contains("at most 3 open"));

    for host in &hosts[1..10] {
        // One at a time: the client gives concurrent calls from one signer the same nonce, so identical
        // ones become a single transaction.
        for _ in 0..3 {
            rooms.push(w.make_room(host, "snowy", 10, 60, 2, 30, 0).await?);
        }
    }
    assert_eq!(rooms.len(), 30);
    let full = call(&hosts[10], &w.game, "create_room", json!({"name": "x", "map": "snowy", "fee": 10, "duration_sec": 60,
        "host_cut_bps": 0, "min_players": 2, "max_players": 30, "countdown_sec": 0}), near(1).as_yoctonear()).await?;
    assert!(failure(&full).contains("Too many games"));
    let state: Value = w.game.view("live_state").await?.json()?;
    assert_eq!(state["rooms"].as_array().unwrap().len(), 30);
    assert_eq!(state["max_open_rooms"], 30);

    let deadline = w.room(*rooms.last().unwrap()).await?["deadline_ms"].as_u64().unwrap();
    w.warp_to(deadline).await?;
    for &id in &rooms {
        assert_eq!(w.poke(id).await?, "refunded");
    }
    let state: Value = w.game.view("live_state").await?.json()?;
    assert_eq!(state["rooms"].as_array().unwrap().len(), 0);
    let recent: Value = w.game.view("get_recent_finished").await?.json()?;
    assert_eq!(recent.as_array().unwrap().len(), 30);
    let storage_ring_full = w.game.view_account().await?.storage_usage;

    let oldest = recent.as_array().unwrap().iter().map(|r| r["room_id"].as_u64().unwrap()).min().unwrap();
    assert!(w.game.view("get_room").args_json(json!({ "id": oldest })).await.is_ok());
    let newer = w.make_room(&hosts[10], "snowy", 10, 60, 2, 30, 0).await?;
    let deadline = w.room(newer).await?["deadline_ms"].as_u64().unwrap();
    w.warp_to(deadline).await?;
    assert_eq!(w.poke(newer).await?, "refunded");
    let recent: Value = w.game.view("get_recent_finished").await?.json()?;
    assert_eq!(recent.as_array().unwrap().len(), 30);
    assert_eq!(recent[0]["room_id"], newer);
    assert!(w.game.view("get_room").args_json(json!({ "id": oldest })).await.is_err(), "the oldest room is gone");
    let storage_after = w.game.view_account().await?.storage_usage;
    assert!(storage_after <= storage_ring_full + 200, "the ring keeps storage flat: {storage_ring_full} -> {storage_after}");
    assert_solvent(&w).await
}

/// Everything measured, on rooms as big as they get: 30 players with 64-character names.
#[tokio::test]
async fn gas_and_storage_with_full_rooms() -> Result<()> {
    let mut w = world().await?;
    let mut report = Report::new(&w).await?;
    let oracle = w.oracle.clone();
    let mut players = Vec::new();
    for chunk in (0..30).collect::<Vec<usize>>().chunks(10) {
        for p in join_all(chunk.iter().map(|&i| w.long_player(i))).await {
            players.push(p?);
        }
    }
    let host = w.long_player(99).await?;
    let spots = land_spots("tropical", 30);
    let fee: u64 = 100;
    let fund = near(10).as_yoctonear();

    report.call(&w, "deposit (first, 64-char name)", &players[0], "deposit", json!({}), fund).await?;
    report.call(&w, "deposit (again)", &players[0], "deposit", json!({}), YOCTO_PER_MILLI).await?;
    report.call(&w, "deposit_for (first)", &w.root.clone(), "deposit_for", json!({"account_id": players[1].id()}), fund).await?;
    for p in &players[2..] {
        call(p, &w.game, "deposit", json!({}), fund).await?.into_result()?;
    }
    call(&host, &w.game, "deposit", json!({}), fund).await?.into_result()?;

    let tips = |from: u32, count: u32| -> Vec<String> { (from..from + count).map(|i| to_hex(&links_of(i as u64).0)).collect() };
    report.call(&w, "add_commitments (1 tip)", &oracle, "add_commitments", json!({ "tips": tips(0, 1) }), 0).await?;
    report.call(&w, "add_commitments (50 tips)", &oracle, "add_commitments", json!({ "tips": tips(1, 50) }), 0).await?;
    report.call(&w, "add_commitments (100 tips)", &oracle, "add_commitments", json!({ "tips": tips(51, 100) }), 0).await?;
    w.next_tip = 151;

    let room_args = |map: &str, min: u8, max: u8, countdown: u32| {
        json!({"name": "x".repeat(40), "map": map, "fee": fee, "duration_sec": 600, "host_cut_bps": 2000,
            "min_players": min, "max_players": max, "countdown_sec": countdown})
    };
    // The room that gets played to the end.
    report.call(&w, "create_room (tropical, this seed's layout)", &host, "create_room", room_args("tropical", 2, 30, 0), 0).await?;
    let room = 1u64;
    let mut players_iter = players.iter();
    let first = players_iter.next().unwrap();
    report.call(&w, "join (1st player)", first, "join", json!({ "room_id": room }), 0).await?;
    let joins: Vec<&Account> = players_iter.by_ref().take(27).collect();
    for r in join_all(joins.iter().map(|p| call(p, &w.game, "join", json!({ "room_id": room }), 0))).await {
        r?.into_result()?;
    }
    report.call(&w, "join (29th of 30)", players_iter.next().unwrap(), "join", json!({ "room_id": room }), 0).await?;
    report.call(&w, "leave (from 29 players)", &players[28], "leave", json!({ "room_id": room }), 0).await?;
    call(&players[28], &w.game, "join", json!({ "room_id": room }), 0).await?.into_result()?;
    report.call(&w, "join (30th, fills the room)", players_iter.next().unwrap(), "join", json!({ "room_id": room }), 0).await?;
    report.call(&w, "start (30 players)", &host, "start", json!({ "room_id": room }), 0).await?;

    let dig_args = |i: usize, seen: u8| json!({"room_id": room, "x": spots[i].0, "y": spots[i].1, "seen_clue": seen});
    report.call(&w, "dig (1st of 30)", &players[0], "dig", dig_args(0, 1), 0).await?;
    let middle: Vec<usize> = (1..29).collect();
    for r in join_all(middle.iter().map(|&i| call(&players[i], &w.game, "dig", dig_args(i, 1), 0))).await {
        r?.into_result()?;
    }
    report.call(&w, "dig (30th of 30)", &players[29], "dig", dig_args(29, 1), 0).await?;
    assert_eq!(w.room(room).await?["digs"].as_array().unwrap().len(), 30);

    let links = links_of(0).1;
    for step in 1..=3u8 {
        let view = w.room(room).await?;
        w.warp_to(view["next_due_ms"].as_u64().unwrap()).await?;
        report.call(&w, &format!("poke: lock step {step} (30 digs)"), &oracle, "poke", json!({ "room_id": room }), 0).await?;
        report
            .call(&w, &format!("reveal step {step} (clue)"), &oracle, "reveal", json!({"room_id": room, "link": to_hex(&links[step as usize - 1])}), 0)
            .await?;
    }
    let view = w.room(room).await?;
    w.warp_to(view["next_due_ms"].as_u64().unwrap()).await?;
    report.call(&w, "poke: lock step 4 (treasure)", &oracle, "poke", json!({ "room_id": room }), 0).await?;
    report.call(&w, "poke: nothing due", &oracle, "poke", json!({ "room_id": room }), 0).await?;
    let settled = report
        .call(&w, "reveal step 4: settle (30 players, no deed owner)", &oracle, "reveal", json!({"room_id": room, "link": to_hex(&links[3])}), 0)
        .await?;
    let log_bytes: usize = settled.logs().iter().map(|l| l.len()).sum();
    report.note(format!("settlement logs: {log_bytes} bytes (a receipt may log 16384)"));
    assert!(log_bytes < 16384);
    let finished_room = w.room(room).await?;
    report.note(format!("get_room JSON of a finished 30-player room: {} bytes", finished_room.to_string().len()));
    report.view(&w, "get_room (finished, 30 players)", "get_room", json!({ "id": room })).await?;
    report.view(&w, "get_recent_finished (1 room)", "get_recent_finished", json!({})).await?;

    // A full 30-player refund, the costliest thing poke can do.
    report.call(&w, "create_room (2)", &host, "create_room", room_args("desert", 2, 30, 0), 0).await?;
    let room2 = 2u64;
    for chunk in players.chunks(15) {
        for r in join_all(chunk.iter().map(|p| call(p, &w.game, "join", json!({ "room_id": room2 }), 0))).await {
            r?.into_result()?;
        }
    }
    call(&host, &w.game, "start", json!({ "room_id": room2 }), 0).await?.into_result()?;
    let desert = land_spots("desert", 30);
    let digging: Vec<usize> = (0..30).collect();
    for r in join_all(digging.iter().map(|&i| {
        call(&players[i], &w.game, "dig", json!({"room_id": room2, "x": desert[i].0, "y": desert[i].1, "seen_clue": 1}), 0)
    }))
    .await
    {
        r?.into_result()?;
    }
    let view = w.room(room2).await?;
    w.warp_to(view["next_due_ms"].as_u64().unwrap() + 120_000).await?;
    let refunded = report.call(&w, "poke: refund (missed reveal, 30 players)", &oracle, "poke", json!({ "room_id": room2 }), 0).await?;
    report.note(format!("refund logs: {} bytes", refunded.logs().iter().map(|l| l.len()).sum::<usize>()));

    // NFTs.
    report.call(&w, "mint_nft", &players[0], "mint_nft", json!({"token_id": "snowy:penguin"}), 0).await?;
    report.call(&w, "mint_nft (second by the same owner)", &players[0], "mint_nft", json!({"token_id": "snowy:seal"}), 0).await?;
    report.call(&w, "list_nft", &players[0], "list_nft", json!({"token_id": "snowy:penguin", "price": 10}), 0).await?;
    report.call(&w, "buy_nft", &players[1], "buy_nft", json!({"token_id": "snowy:penguin", "seen_price": 10}), 0).await?;
    report.call(&w, "list_nft (to cancel)", &players[1], "list_nft", json!({"token_id": "snowy:penguin", "price": 10}), 0).await?;
    report.call(&w, "nft_transfer (listing cancelled)", &players[1], "nft_transfer", json!({"receiver_id": players[2].id(), "token_id": "snowy:penguin"}), 1).await?;

    // Withdraw and its callback.
    report.call(&w, "withdraw", &players[3], "withdraw", json!({"amount": near(1).as_yoctonear().to_string()}), 1).await?;

    // A round that lands on an owned deed, paid out with an exact pixel and season points all at once
    // is rarer than this measures: settling with an owned deed adds one more credit.
    let season_end: Value = w.game.view("get_season").await?.json()?;
    w.warp_to(season_end["ends_at_ms"].as_u64().unwrap()).await?;
    report.call(&w, "close_season (3 winners, long names)", &oracle, "close_season", json!({}), 0).await?;
    report.view(&w, "get_nfts (all 36)", "get_nfts", json!({"from": 0, "limit": 36})).await?;
    report.view(&w, "nft_tokens (2)", "nft_tokens", json!({})).await?;

    // Every recommended amount of gas, tried on the worst-case call, so these numbers aren't just arithmetic.
    let state = w.game.view_account().await?.storage_usage;
    report.note(format!("contract storage after this test: {state} bytes"));

    // 30 full rooms open at once, the most that can be: what `live_state` must return every second.
    let mut hosts = vec![host.clone()];
    for i in 100..109 {
        let h = w.long_player(i).await?;
        call(&h, &w.game, "deposit", json!({}), near(2).as_yoctonear()).await?.into_result()?;
        hosts.push(h);
    }
    let mut ids = Vec::new();
    for h in &hosts {
        for _ in 0..3 {
            let id: u64 = call(h, &w.game, "create_room", room_args("tropical", 2, 30, 0), 0).await?.into_result()?.json()?;
            ids.push(id);
        }
    }
    assert_eq!(ids.len(), 30);
    let spots = land_spots("tropical", 30);
    for &id in &ids {
        for chunk in players.chunks(15) {
            for r in join_all(chunk.iter().map(|p| call(p, &w.game, "join", json!({ "room_id": id }), 0))).await {
                r?.into_result()?;
            }
        }
    }
    report.view(&w, "live_state (30 rooms, 30 players each, no digs)", "live_state", json!({})).await?;
    for (n, &id) in ids.iter().enumerate() {
        let room_host = &hosts[n / 3];
        call(room_host, &w.game, "start", json!({ "room_id": id }), 0).await?.into_result()?;
        for chunk in (0..30usize).collect::<Vec<_>>().chunks(15) {
            let digs = chunk.iter().map(|&i| {
                call(&players[i], &w.game, "dig", json!({"room_id": id, "x": spots[i].0, "y": spots[i].1, "seen_clue": 1}), 0)
            });
            for r in join_all(digs).await {
                r?.into_result()?;
            }
        }
    }
    report.view(&w, "live_state (30 full rooms, all dug)", "live_state", json!({})).await?;
    let state: Value = w.game.view("live_state").await?.json()?;
    assert_eq!(state["rooms"].as_array().unwrap().len(), 30);
    assert_eq!(state["rooms"][0]["digs"].as_array().unwrap().len(), 30);
    report.note(format!("live_state JSON with 30 full rooms: {} bytes. A plain RPC view returned it, so it fits this node's view limit.", state.to_string().len()));
    report.view(&w, "get_rooms (30, no landmarks)", "get_rooms", json!({"from": 0, "limit": 30})).await?;
    report.view(&w, "get_room (live, 30 digs)", "get_room", json!({ "id": ids[0] })).await?;
    report.view(&w, "get_account", "get_account", json!({"id": players[0].id()})).await?;

    // Refund the lot, which fills the ring with the largest rooms there are.
    let due = w.room(ids[0]).await?["next_due_ms"].as_u64().unwrap();
    let last_due = w.room(*ids.last().unwrap()).await?["next_due_ms"].as_u64().unwrap();
    w.warp_to(due.max(last_due) + 120_000).await?;
    for &id in &ids {
        assert_eq!(w.poke(id).await?, "refunded");
    }
    report.view(&w, "get_recent_finished (30 full rooms)", "get_recent_finished", json!({})).await?;

    // The dearest settlement there is: the deed is owned, a dig is on the exact pixel (put there by rewriting
    // state, as in the jackpot test), season points go to long names, and the oldest room falls off the full ring.
    let token_kinds = ["lighthouse", "well", "hut", "windmill", "pine", "apple", "scarecrow", "cow", "sheep", "duck", "boat", "palm"];
    let owner = &players[4];
    call(owner, &w.game, "deposit", json!({}), near(10).as_yoctonear()).await?.into_result()?;
    for kind in token_kinds {
        call(owner, &w.game, "mint_nft", json!({"token_id": format!("tropical:{kind}")}), 0).await?.into_result()?;
    }
    let tip_index = w.game.view("commitments_next_index").await?.json::<u64>()?;
    assert!(tip_index > 0);
    let host = &hosts[1];
    let id: u64 = call(host, &w.game, "create_room", room_args("tropical", 2, 30, 0), 0).await?.into_result()?.json()?;
    for chunk in players.chunks(15) {
        for r in join_all(chunk.iter().map(|p| call(p, &w.game, "join", json!({ "room_id": id }), 0))).await {
            r?.into_result()?;
        }
    }
    call(host, &w.game, "start", json!({ "room_id": id }), 0).await?.into_result()?;
    for chunk in (0..30usize).collect::<Vec<_>>().chunks(15) {
        let digs = chunk.iter().map(|&i| {
            call(&players[i], &w.game, "dig", json!({"room_id": id, "x": spots[i].0, "y": spots[i].1, "seen_clue": 1}), 0)
        });
        for r in join_all(digs).await {
            r?.into_result()?;
        }
    }
    let view = w.room(id).await?;
    let links = links_of(view["tip_index"].as_u64().unwrap()).1;
    for step in 1..=3usize {
        let due = w.room(id).await?["next_due_ms"].as_u64().unwrap();
        w.warp_to(due).await?;
        assert_eq!(w.poke(id).await?, "locked");
        let r = w.reveal(id, &links[step - 1]).await?;
        assert!(r.is_success(), "{:?}", r.failures());
    }
    let due = w.room(id).await?["next_due_ms"].as_u64().unwrap();
    w.warp_to(due).await?;
    assert_eq!(w.poke(id).await?, "locked");
    let view = w.room(id).await?;
    let roll = &view["rolls"][3];
    let seed = roll_seed(id, 4, &from_hex32(roll["lock_seed"].as_str().unwrap()).unwrap(), &links[3], &from_hex32(roll["digs_hash"].as_str().unwrap()).unwrap());
    let places: Vec<(u8, u16, u16)> = view["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let l = &view["landmarks"][c.as_u64().unwrap() as usize];
            (c.as_u64().unwrap() as u8, l["x"].as_u64().unwrap() as u16, l["y"].as_u64().unwrap() as u16)
        })
        .collect();
    let treasure = roll_treasure(0, &places, &mut Stream::new(seed));
    let mut key = vec![1u8];
    key.extend_from_slice(&id.to_le_bytes());
    let state = w.game.view_state().await?;
    let mut stored: Room = near_sdk::borsh::from_slice(state.get(&key).expect("the room's key"))?;
    stored.digs[0].x = treasure.x;
    stored.digs[0].y = treasure.y;
    w.worker.patch_state(w.game.id(), &key, &near_sdk::borsh::to_vec(&stored)?).await?;
    let worst = report
        .call(&w, "reveal step 4: settle, worst case (owned deed, jackpot hit, ring eviction, 30 long names)", &oracle, "reveal", json!({"room_id": id, "link": to_hex(&links[3])}), 0)
        .await?;
    let all = events(&worst);
    let finished = &event(&all, "finished")["data"];
    assert!(finished["jackpot_win"]["amount"].as_u64().unwrap() > 0);
    assert_eq!(finished["deed"]["owner"], owner.id().as_str());
    report.note(format!("worst settlement logs: {} bytes (a receipt may log 16384)", worst.logs().iter().map(|l| l.len()).sum::<usize>()));
    report.finish();
    assert_solvent(&w).await
}

/// Every attached-gas figure the README recommends, on the worst-case call, so they're proven and not just added up.
#[tokio::test]
async fn recommended_gas_is_enough_for_the_worst_case() -> Result<()> {
    let mut w = world().await?;
    w.add_tips(2).await?;
    let host = w.long_player(99).await?;
    let mut players = Vec::new();
    for chunk in (0..30).collect::<Vec<usize>>().chunks(10) {
        for p in join_all(chunk.iter().map(|&i| w.long_player(i))).await {
            players.push(p?);
        }
    }
    let oracle = w.oracle.clone();
    let tgas = |who: Account, method: &'static str, args: Value, attached: u128, gas: u64, game: &Contract| {
        let call = who.call(game.id(), method).args_json(args).deposit(NearToken::from_yoctonear(attached)).gas(Gas::from_tgas(gas));
        async move { Ok::<_, anyhow::Error>(call.transact().await?) }
    };
    let attach = (BOND as u128 + 1000) * YOCTO_PER_MILLI;
    let args = json!({"name": "x".repeat(40), "map": "tropical", "fee": 100, "duration_sec": 600, "host_cut_bps": 2000,
        "min_players": 2, "max_players": 30, "countdown_sec": 0});
    let created = tgas(host.clone(), "create_room", args, attach, 100, &w.game).await?;
    assert!(created.is_success(), "{:?}", created.failures());
    let room: u64 = created.json()?;

    for chunk in players.chunks(10) {
        let joins = chunk.iter().map(|p| tgas(p.clone(), "join", json!({ "room_id": room }), 200 * YOCTO_PER_MILLI, 10, &w.game));
        for r in join_all(joins).await {
            let r = r?;
            assert!(r.is_success(), "join at 10 Tgas: {:?}", r.failures());
        }
    }
    let started = tgas(host.clone(), "start", json!({ "room_id": room }), 0, 10, &w.game).await?;
    assert!(started.is_success(), "start at 10 Tgas: {:?}", started.failures());
    let spots = land_spots("tropical", 30);
    for chunk in (0..30usize).collect::<Vec<_>>().chunks(10) {
        let digs = chunk.iter().map(|&i| {
            tgas(players[i].clone(), "dig", json!({"room_id": room, "x": spots[i].0, "y": spots[i].1, "seen_clue": 1}), 0, 5, &w.game)
        });
        for r in join_all(digs).await {
            let r = r?;
            assert!(r.is_success(), "dig at 5 Tgas: {:?}", r.failures());
        }
    }
    let links = links_of(0).1;
    for step in 0..4usize {
        let view = w.room(room).await?;
        w.warp_to(view["next_due_ms"].as_u64().unwrap()).await?;
        let locked = tgas(oracle.clone(), "poke", json!({ "room_id": room }), 0, 15, &w.game).await?;
        assert!(locked.is_success(), "poke at 15 Tgas: {:?}", locked.failures());
        let gas = if step == 3 { 30 } else { 10 };
        let revealed = tgas(oracle.clone(), "reveal", json!({"room_id": room, "link": to_hex(&links[step])}), 0, gas, &w.game).await?;
        assert!(revealed.is_success(), "reveal {step} at {gas} Tgas: {:?}", revealed.failures());
    }

    let room2 = w.make_room(&host, "tropical", 100, 600, 2, 30, 0).await?;
    for chunk in players.chunks(10) {
        let joins = chunk.iter().map(|p| tgas(p.clone(), "join", json!({ "room_id": room2 }), 200 * YOCTO_PER_MILLI, 10, &w.game));
        for r in join_all(joins).await {
            assert!(r?.is_success());
        }
    }
    call(&host, &w.game, "start", json!({ "room_id": room2 }), 0).await?.into_result()?;
    let view = w.room(room2).await?;
    w.warp_to(view["next_due_ms"].as_u64().unwrap() + 120_000).await?;
    let refund = tgas(oracle.clone(), "poke", json!({ "room_id": room2 }), 0, 30, &w.game).await?;
    assert!(refund.is_success(), "refund poke at 30 Tgas: {:?}", refund.failures());
    assert_eq!(event(&events(&refund), "refunded")["data"]["reason"], "missed-reveal");

    let withdrew = tgas(players[0].clone(), "withdraw", json!({"amount": "1000"}), 1, 5, &w.game).await?;
    assert!(withdrew.is_success(), "withdraw at 5 Tgas: {:?}", withdrew.failures());
    Ok(())
}

/// create_room's main risk: the layout roll on a real VM. Prices the costliest seeds out of 1000 per map.
#[tokio::test]
async fn layout_gas_on_the_worst_seeds() -> Result<()> {
    let w = world_with(&wasm("target/near-probe/dig_here.wasm")).await?;
    let cases: Value = serde_json::from_str(include_str!("worst-layouts.json"))?;
    let scanned = cases["seeds_scanned_per_map"].as_u64().unwrap();
    println!("LAYOUT scanned {scanned} seeds per map");
    let mut points = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let result = call(&w.root, &w.game, "probe_layout", json!({"map": case["map"], "seed": case["seed"]}), 0).await?;
        assert!(result.is_success(), "{:?}", result.failures());
        let draws: u32 = result.clone().json()?;
        assert_eq!(draws as u64, case["draws"].as_u64().unwrap(), "the wasm's draws match the native scan");
        let tgas = result.total_gas_burnt.as_gas() as f64 / 1e12;
        println!("LAYOUT {} {} draws={draws} burnt={tgas:.2} Tgas", case["map"].as_str().unwrap(), case["rank"].as_str().unwrap());
        points.push((draws, tgas));
    }
    assert!(points.iter().all(|(_, t)| *t < 300.0));
    Ok(())
}

struct Report {
    rows: BTreeMap<usize, String>,
}

impl Report {
    async fn new(_w: &World) -> Result<Self> {
        println!("GAS | call | burnt Tgas | receipts' Tgas | storage delta bytes | NEAR burnt");
        Ok(Self { rows: BTreeMap::new() })
    }

    fn note(&mut self, text: String) {
        println!("NOTE {text}");
        self.rows.insert(self.rows.len(), text);
    }

    async fn call(&mut self, w: &World, label: &str, who: &Account, method: &str, args: Value, attached: u128) -> Result<ExecutionFinalResult> {
        let before = w.game.view_account().await?.storage_usage;
        let result = call(who, &w.game, method, args, attached).await?;
        assert!(result.is_success(), "{label}: {:?}", result.failures());
        let after = w.game.view_account().await?.storage_usage;
        let total = result.total_gas_burnt.as_gas() as f64 / 1e12;
        let in_receipts: f64 = result.receipt_outcomes().iter().map(|o| o.gas_burnt.as_gas() as f64).sum::<f64>() / 1e12;
        println!("GAS | {label} | {total:.3} | {in_receipts:.3} | {} | {:.6}", after as i64 - before as i64, total * 0.0001);
        Ok(result)
    }

    async fn view(&mut self, w: &World, label: &str, method: &str, args: Value) -> Result<()> {
        let bytes = w.game.view(method).args_json(args.clone()).await?.result.len();
        let result = call(&w.root, &w.game, method, args, 0).await?;
        assert!(result.is_success(), "{label}: {:?}", result.failures());
        let in_receipts: f64 = result.receipt_outcomes().iter().map(|o| o.gas_burnt.as_gas() as f64).sum::<f64>() / 1e12;
        println!("VIEW | {label} | {in_receipts:.3} Tgas in its receipt | {bytes} bytes");
        Ok(())
    }

    fn finish(self) {
        println!("NOTES {}", self.rows.len());
    }
}
