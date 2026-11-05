//! Everything read from outside. Yocto amounts are U128 strings, and milliNEAR amounts, times and ids are
//! plain JSON numbers: the caps in `rules.rs` keep them all below 2^53.
use crate::ContractExt;
use crate::clues::{Clue, Treasure};
use crate::map_data::{spot, token_id, CATEGORIES, DEED_COUNT, KINDS_PER_MAP, MAPS, TAGS};
use crate::money::split_pot;
use crate::rng::{roll_seed, to_hex};
use crate::rooms::{Roll, Room};
use crate::rules::*;
use crate::scoring::Ranked;
use crate::season::{TopEntry, Winner};
use crate::{Config, Contract};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, near, AccountId};

#[derive(Serialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", tag = "level", rename_all = "lowercase")]
pub enum ClueView {
    Yolo,
    Category { category: &'static str },
    Kind { kind: &'static str },
    Detail { kind: &'static str, tag: &'static str },
}

impl ClueView {
    pub fn of(map: u8, clue: &Clue) -> Self {
        let kind_name = |k: u8| MAPS[map as usize].kinds[k as usize].name;
        match *clue {
            Clue::Yolo => ClueView::Yolo,
            Clue::Category(c) => ClueView::Category { category: CATEGORIES[c as usize] },
            Clue::Kind(k) => ClueView::Kind { kind: kind_name(k) },
            Clue::Detail(k, t) => ClueView::Detail { kind: kind_name(k), tag: TAGS[t as usize] },
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct TreasureView {
    x: u16,
    y: u16,
    landmark_id: u8,
}

impl TreasureView {
    pub fn of(t: &Treasure) -> Self {
        Self { x: t.x, y: t.y, landmark_id: t.landmark_id }
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct LandmarkView {
    id: u8,
    kind: &'static str,
    category: &'static str,
    x: u16,
    y: u16,
    tags: Vec<&'static str>,
    flip: bool,
}

fn landmark_views(room: &Room) -> Vec<LandmarkView> {
    let map = room.map as usize;
    room.landmarks
        .iter()
        .enumerate()
        .map(|(id, l)| {
            let def = &MAPS[map].kinds[l.kind as usize];
            let s = spot(map, l.spot as usize);
            LandmarkView {
                id: id as u8,
                kind: def.name,
                category: CATEGORIES[def.category as usize],
                x: s.x,
                y: s.y,
                tags: (0..TAGS.len()).filter(|t| s.tags & (1 << t) != 0).map(|t| TAGS[t]).collect(),
                flip: l.flip,
            }
        })
        .collect()
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct DigView<'a> {
    account: &'a AccountId,
    x: u16,
    y: u16,
    clue_index: u8,
    bonus_bps: u32,
    crowded: bool,
    dug_at_ms: u64,
}

fn dig_views(room: &Room) -> Vec<DigView<'_>> {
    room.digs
        .iter()
        .map(|d| DigView {
            account: &room.players[d.player as usize],
            x: d.x,
            y: d.y,
            clue_index: d.clue_index,
            bonus_bps: Room::bonus_bps(d.clue_index),
            crowded: d.crowded,
            dug_at_ms: d.dug_at_ms,
        })
        .collect()
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RankedView<'a> {
    #[serde(flatten)]
    dig: DigView<'a>,
    distance: u64,
    closeness: u64,
    score: u64,
}

pub fn ranking_rows<'a>(room: &'a Room, ranking: &[Ranked]) -> Vec<RankedView<'a>> {
    let mut digs: Vec<Option<DigView<'a>>> = dig_views(room).into_iter().map(Some).collect();
    ranking
        .iter()
        .map(|r| RankedView {
            // Each dig appears once in a ranking, so it can be moved out rather than cloned.
            dig: digs[r.dig as usize].take().unwrap_or_else(|| env::panic_str("A dig ranked twice.")),
            distance: r.distance,
            closeness: r.closeness,
            score: r.score,
        })
        .collect()
}

/// What `live_state` and `get_rooms` give for an open room. `landmarks` is compact: each is
/// `[spot, kind, flip]`, where `spot` indexes the map's spot table and `kind` its roster, both of which the
/// browser already has. The full form costs ten times the bytes, once per room, once per second.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RoomSummary<'a> {
    room_id: u64,
    version: u64,
    name: &'a str,
    host: &'a AccountId,
    map: &'static str,
    fee: u64,
    pot: u64,
    duration_sec: u32,
    host_cut_bps: u16,
    closeness_range: u64,
    min_players: u8,
    max_players: u8,
    countdown_sec: u32,
    status: &'static str,
    created_ms: u64,
    deadline_ms: u64,
    start_at_ms: Option<u64>,
    started_ms: Option<u64>,
    ends_at_ms: Option<u64>,
    tip_index: u64,
    /// The next roll, once the round is live. Null when every roll is done.
    next_step: Option<u8>,
    next_due_ms: Option<u64>,
    reveal_deadline_ms: Option<u64>,
    locked: bool,
    lock_height: Option<u64>,
    players: &'a [AccountId],
    digs: Vec<DigView<'a>>,
    clues: Vec<ClueView>,
    candidates: &'a [u8],
    #[serde(skip_serializing_if = "Option::is_none")]
    landmarks: Option<Vec<[u16; 3]>>,
}

fn room_summary(room: &Room, with_landmarks: bool, closeness_range: u64) -> RoomSummary<'_> {
    use crate::rooms::Status;
    let live = room.status == Status::Live;
    let started = room.status != Status::Waiting;
    let step = if live { Some(room.next_step()) } else { None };
    let pending = if live { room.pending_roll() } else { None };
    RoomSummary {
        room_id: room.id,
        version: room.version,
        name: &room.name,
        host: &room.host,
        map: MAPS[room.map as usize].name,
        fee: room.fee,
        pot: room.pot(),
        duration_sec: room.duration_sec,
        host_cut_bps: room.host_cut_bps,
        closeness_range,
        min_players: room.min_players,
        max_players: room.max_players,
        countdown_sec: room.countdown_sec,
        status: room.status.name(),
        created_ms: room.created_ms,
        deadline_ms: room.deadline_ms(),
        start_at_ms: room.start_at_ms,
        started_ms: started.then_some(room.started_ms),
        ends_at_ms: started.then(|| room.ends_at_ms()),
        tip_index: room.tip_index,
        next_step: step,
        next_due_ms: step.map(|s| room.due_ms(s)),
        reveal_deadline_ms: step.map(|s| room.due_ms(s) + REVEAL_WINDOW_MS),
        locked: pending.is_some(),
        lock_height: pending.map(|r| r.lock_height),
        players: &room.players,
        digs: dig_views(room),
        clues: room.clues.iter().map(|c| ClueView::of(room.map, c)).collect(),
        candidates: &room.candidates,
        landmarks: with_landmarks.then(|| room.landmarks.iter().map(|l| [l.spot, l.kind as u16, l.flip as u16]).collect()),
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RollView {
    step: u8,
    due_ms: u64,
    lock_seed: String,
    digs_hash: String,
    lock_ms: u64,
    lock_height: u64,
    link: Option<String>,
    reveal_ms: Option<u64>,
    reveal_height: Option<u64>,
    roll_seed: Option<String>,
    /// What this roll revealed. Null for the treasure step, whose result is in `result`.
    clue: Option<ClueView>,
}

fn roll_view(room: &Room, r: &Roll) -> RollView {
    RollView {
        step: r.step,
        due_ms: room.due_ms(r.step),
        lock_seed: to_hex(&r.lock_seed),
        digs_hash: to_hex(&r.digs_hash),
        lock_ms: r.lock_ms,
        lock_height: r.lock_height,
        link: r.link.as_ref().map(|l| to_hex(l)),
        reveal_ms: r.link.map(|_| r.reveal_ms),
        reveal_height: r.link.map(|_| r.reveal_height),
        roll_seed: r.link.as_ref().map(|l| to_hex(&roll_seed(room.id, r.step, &r.lock_seed, l, &r.digs_hash))),
        clue: r.link.and_then(|_| room.clues.get(r.step as usize)).map(|c| ClueView::of(room.map, c)),
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AccountAmount<'a> {
    account: &'a AccountId,
    amount: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ResultView<'a> {
    ended_ms: u64,
    pot: u64,
    split: Option<crate::money::Split>,
    refund_reason: Option<&'static str>,
    treasure: Option<TreasureView>,
    winner: Option<&'a AccountId>,
    ranking: Vec<RankedView<'a>>,
    deed_owner: Option<&'a AccountId>,
    jackpot_win: Option<AccountAmount<'a>>,
    jackpot_before: u64,
    jackpot_after: u64,
    /// By place in the ranking. Empty with fewer than 3 digs.
    season_points: Vec<AccountAmount<'a>>,
}

fn result_view(room: &Room, closeness_range: u64) -> Option<ResultView<'_>> {
    let outcome = room.outcome.as_ref()?;
    let player_of = |dig: u8| &room.players[room.digs[dig as usize].player as usize];
    let ranked = outcome.treasure.as_ref().map(|t| room.ranking(t, closeness_range)).unwrap_or_default();
    let season_points = if ranked.len() >= SEASON_MIN_DIGS {
        ranked
            .iter()
            .zip(SEASON_POINTS_PER_NEAR)
            .map(|(row, per_near)| AccountAmount { account: player_of(row.dig), amount: room.pot() * per_near / 1000 })
            .collect()
    } else {
        Vec::new()
    };
    Some(ResultView {
        ended_ms: outcome.ended_ms,
        pot: room.pot(),
        split: outcome.treasure.map(|_| split_pot(room.pot(), room.host_cut_bps)),
        refund_reason: outcome.refund_reason.map(|r| r.name()),
        treasure: outcome.treasure.as_ref().map(TreasureView::of),
        winner: ranked.first().map(|r| player_of(r.dig)),
        ranking: ranking_rows(room, &ranked),
        deed_owner: outcome.deed_owner.as_ref(),
        jackpot_win: outcome.jackpot_win.map(|(dig, amount)| AccountAmount { account: player_of(dig), amount }),
        jackpot_before: outcome.jackpot_before,
        jackpot_after: outcome.jackpot_after,
        season_points,
    })
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RoomFull<'a> {
    #[serde(flatten)]
    summary: RoomSummary<'a>,
    created_height: u64,
    tip: String,
    block_seed: String,
    layout_seed: String,
    landmarks: Vec<LandmarkView>,
    rolls: Vec<RollView>,
    result: Option<ResultView<'a>>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RoomCreatedEvent<'a> {
    room_id: u64,
    name: &'a str,
    host: &'a AccountId,
    map: &'static str,
    fee: u64,
    bond: u64,
    duration_sec: u32,
    host_cut_bps: u16,
    closeness_range: u64,
    min_players: u8,
    max_players: u8,
    countdown_sec: u32,
    created_ms: u64,
    deadline_ms: u64,
    block_height: u64,
    tip_index: u64,
    tip: String,
    block_seed: String,
    layout_seed: String,
    landmarks: Vec<LandmarkView>,
}

impl<'a> RoomCreatedEvent<'a> {
    pub fn of(room: &'a Room, bond: u64, closeness_range: u64) -> Self {
        Self {
            room_id: room.id,
            name: &room.name,
            host: &room.host,
            map: MAPS[room.map as usize].name,
            fee: room.fee,
            bond,
            duration_sec: room.duration_sec,
            host_cut_bps: room.host_cut_bps,
            closeness_range,
            min_players: room.min_players,
            max_players: room.max_players,
            countdown_sec: room.countdown_sec,
            created_ms: room.created_ms,
            deadline_ms: room.deadline_ms(),
            block_height: room.created_height,
            tip_index: room.tip_index,
            tip: to_hex(&room.tip),
            block_seed: to_hex(&room.block_seed),
            layout_seed: to_hex(&room.layout_seed),
            landmarks: landmark_views(room),
        }
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct CommitmentsEvent {
    pub first_index: u64,
    pub count: usize,
    pub left: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AccountView {
    account_id: AccountId,
    balance: U128,
    season_points: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct HostView {
    finished: u32,
    expired: u32,
    open_rooms: u8,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SeasonEntryView<'a> {
    account: &'a AccountId,
    points: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SeasonWinnerView<'a> {
    account: &'a AccountId,
    prize: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SeasonView<'a> {
    number: u32,
    ends_at_ms: u64,
    pool: u64,
    /// The best ten who can win prizes, best first.
    top: Vec<SeasonEntryView<'a>>,
    last_winners: Vec<SeasonWinnerView<'a>>,
}

fn season_view<'a>(number: u32, ends_at_ms: u64, pool: u64, top: &'a [TopEntry], last: &'a [Winner]) -> SeasonView<'a> {
    SeasonView {
        number,
        ends_at_ms,
        pool,
        top: top.iter().map(|e| SeasonEntryView { account: &e.account, points: e.points }).collect(),
        last_winners: last.iter().map(|w| SeasonWinnerView { account: &w.account, prize: w.prize }).collect(),
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct NftView {
    token_id: String,
    map: &'static str,
    kind: &'static str,
    owner: Option<AccountId>,
    earned: u64,
    landings: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct FinishedSummary<'a> {
    room_id: u64,
    name: &'a str,
    host: &'a AccountId,
    map: &'static str,
    fee: u64,
    pot: u64,
    players: usize,
    digs: usize,
    status: &'static str,
    ended_ms: u64,
    refund_reason: Option<&'static str>,
    treasure: Option<TreasureView>,
    winner: Option<&'a AccountId>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Totals {
    /// Sum of every game balance, in yoctoNEAR.
    balances: U128,
    /// Fees and bonds locked in open rooms, in milliNEAR.
    held: u64,
    jackpot: u64,
    season_pool: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct LiveState<'a> {
    version: u64,
    now_ms: u64,
    jackpot: u64,
    season: SeasonView<'a>,
    commitments_left: u64,
    missed_reveals: u64,
    max_open_rooms: usize,
    rooms: Vec<RoomSummary<'a>>,
}

/// These views build JSON around rooms they load themselves, so the structs can't outlive the method.
/// Returning the bytes directly gives callers the same plain JSON as a normal return value.
fn return_json<T: Serialize>(value: &T) {
    env::value_return(&near_sdk::serde_json::to_vec(value).unwrap_or_default());
}

#[cfg(test)]
impl AccountView {
    pub fn balance_yocto(&self) -> u128 {
        self.balance.0
    }
}

#[cfg(test)]
impl HostView {
    pub fn expired(&self) -> u32 {
        self.expired
    }
}

/// The first room id on the current range. Kept under its own key, not in the contract's struct, so an upgrade that
/// adds it leaves every stored layout alone, and the old code could still read this state.
const CLOSENESS_NEW_FROM_KEY: &[u8] = b"closeness_new_from";

fn closeness_range_from(room_id: u64, new_from: u64) -> u64 {
    if room_id >= new_from {
        CLOSENESS_RANGE
    } else {
        CLOSENESS_RANGE_BEFORE
    }
}

impl Contract {
    /// Without the key, this is state from before the change, so every room is on the old range.
    pub(crate) fn closeness_new_from(&self) -> u64 {
        env::storage_read(CLOSENESS_NEW_FROM_KEY)
            .and_then(|bytes| bytes.try_into().ok())
            .map_or(u64::MAX, u64::from_le_bytes)
    }

    pub(crate) fn set_closeness_new_from(&self, first_room: u64) {
        env::storage_write(CLOSENESS_NEW_FROM_KEY, &first_room.to_le_bytes());
    }

    fn open_rooms(&self) -> Vec<Room> {
        self.open.iter().filter_map(|id| self.rooms.get(id)).collect()
    }

    pub(crate) fn live_state_json(&self) -> Vec<u8> {
        let rooms = self.open_rooms();
        let from = self.closeness_new_from();
        let state = LiveState {
            version: self.version,
            now_ms: env::block_timestamp_ms(),
            jackpot: self.jackpot,
            season: season_view(self.season.number, self.season.ends_at_ms, self.season.pool, &self.season.top, &self.season.last_winners),
            commitments_left: self.tip_tail - self.tip_head,
            missed_reveals: self.missed_reveals,
            max_open_rooms: MAX_OPEN_ROOMS,
            rooms: rooms.iter().map(|r| room_summary(r, true, closeness_range_from(r.id, from))).collect(),
        };
        near_sdk::serde_json::to_vec(&state).unwrap_or_default()
    }

    pub(crate) fn room_json(&self, room_id: u64) -> Vec<u8> {
        let room = self.load_room(room_id);
        let range = self.closeness_range_of(room_id);
        let full = RoomFull {
            summary: room_summary(&room, false, range),
            created_height: room.created_height,
            tip: to_hex(&room.tip),
            block_seed: to_hex(&room.block_seed),
            layout_seed: to_hex(&room.layout_seed),
            landmarks: landmark_views(&room),
            rolls: room.rolls.iter().map(|r| roll_view(&room, r)).collect(),
            result: result_view(&room, range),
        };
        near_sdk::serde_json::to_vec(&full).unwrap_or_default()
    }

    pub(crate) fn nfts(&self, from: u32, limit: u32) -> Vec<NftView> {
        (from as usize..DEED_COUNT)
            .take(limit.min(DEED_COUNT as u32) as usize)
            .map(|index| {
                let id = token_id(index);
                let def = &MAPS[index / KINDS_PER_MAP];
                let deed = self.deeds.get(&(index as u8)).unwrap_or_default();
                NftView {
                    owner: self.tokens.owner_by_id.get(&id),
                    token_id: id,
                    map: def.name,
                    kind: def.kinds[index % KINDS_PER_MAP].name,
                    earned: deed.earned,
                    landings: deed.landings,
                }
            })
            .collect()
    }

    pub(crate) fn account_view(&self, account_id: AccountId) -> Option<AccountView> {
        let record = self.accounts.get(&account_id)?;
        let season_points = if record.season == self.season.number { record.points } else { 0 };
        Some(AccountView { account_id, balance: U128(record.balance), season_points })
    }
}

#[near]
impl Contract {
    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_now_ms(&self) -> u64 {
        env::block_timestamp_ms()
    }

    /// One batched read of what the board and every open room need. The backend polls this once a second.
    pub fn live_state(&self) {
        env::value_return(&self.live_state_json());
    }

    /// Open rooms, oldest first, with no landmarks.
    pub fn get_rooms(&self, from: u32, limit: u32) {
        let rooms: Vec<Room> = self
            .open
            .iter()
            .skip(from as usize)
            .take(limit.min(MAX_OPEN_ROOMS as u32) as usize)
            .filter_map(|id| self.rooms.get(id))
            .collect();
        let from = self.closeness_new_from();
        let summaries: Vec<RoomSummary> = rooms.iter().map(|r| room_summary(r, false, closeness_range_from(r.id, from))).collect();
        return_json(&summaries);
    }

    /// Everything about one room, including landmarks, digs, clues and proof data. Fails once it's been
    /// deleted from the ring of recent rooms. The events still hold all of it.
    pub fn get_room(&self, id: u64) {
        env::value_return(&self.room_json(id));
    }

    /// The ring of finished and refunded rooms, newest first.
    pub fn get_recent_finished(&self) {
        let rooms: Vec<Room> = self.recent.iter().rev().filter_map(|id| self.rooms.get(id)).collect();
        let from = self.closeness_new_from();
        let rows: Vec<FinishedSummary> = rooms
            .iter()
            .map(|room| {
                let outcome = room.outcome.as_ref();
                let ranked = outcome.and_then(|o| o.treasure.as_ref()).map(|t| room.ranking(t, closeness_range_from(room.id, from))).unwrap_or_default();
                FinishedSummary {
                    room_id: room.id,
                    name: &room.name,
                    host: &room.host,
                    map: MAPS[room.map as usize].name,
                    fee: room.fee,
                    pot: room.pot(),
                    players: room.players.len(),
                    digs: room.digs.len(),
                    status: room.status.name(),
                    ended_ms: outcome.map_or(0, |o| o.ended_ms),
                    refund_reason: outcome.and_then(|o| o.refund_reason).map(|r| r.name()),
                    treasure: outcome.and_then(|o| o.treasure.as_ref()).map(TreasureView::of),
                    winner: ranked.first().map(|r| &room.players[room.digs[r.dig as usize].player as usize]),
                }
            })
            .collect();
        return_json(&rows);
    }

    /// Null for an account the contract has never credited.
    pub fn get_account(&self, id: AccountId) -> Option<AccountView> {
        self.account_view(id)
    }

    pub fn get_host(&self, id: AccountId) -> HostView {
        let record = self.accounts.get(&id).unwrap_or_default();
        HostView { finished: record.finished, expired: record.expired, open_rooms: record.open_rooms }
    }

    pub fn get_jackpot(&self) -> u64 {
        self.jackpot
    }

    pub fn get_season(&self) {
        return_json(&season_view(self.season.number, self.season.ends_at_ms, self.season.pool, &self.season.top, &self.season.last_winners));
    }

    pub fn get_nfts(&self, from: u32, limit: u32) -> Vec<NftView> {
        self.nfts(from, limit)
    }

    pub fn commitments_left(&self) -> u64 {
        self.tip_tail - self.tip_head
    }

    /// The index the next uploaded tip will get. The oracle derives the tip's secret from this.
    pub fn commitments_next_index(&self) -> u64 {
        self.tip_tail
    }

    /// The closeness range a room was or will be scored by, from its id alone, so this also answers for a round
    /// long gone from the ring. Rooms from before the range changed keep the old one.
    pub fn closeness_range_of(&self, room_id: u64) -> u64 {
        closeness_range_from(room_id, self.closeness_new_from())
    }

    pub fn missed_reveals(&self) -> u64 {
        self.missed_reveals
    }

    /// What the contract owes, for monitoring. Its NEAR balance should cover these plus its storage.
    pub fn get_totals(&self) -> Totals {
        Totals { balances: U128(self.total_balances), held: self.held, jackpot: self.jackpot, season_pool: self.season.pool }
    }
}

/// Prices the layout roll on a chosen seed, for the gas tests. Only in a test build, behind `gas-probe`.
#[cfg(feature = "gas-probe")]
#[near]
impl Contract {
    pub fn probe_layout(&mut self, map: String, seed: String) -> u32 {
        let seed = crate::rng::from_hex32(&seed).unwrap_or_else(|| env::panic_str("bad seed"));
        let map = crate::map_data::map_index(&map).unwrap_or_else(|| env::panic_str("bad map")) as usize;
        let mut stream = crate::rng::Stream::new(seed);
        let landmarks = crate::layout::roll_layout(map, &mut stream);
        env::log_str(&format!("landmarks {}", landmarks.len()));
        stream.draws
    }
}
