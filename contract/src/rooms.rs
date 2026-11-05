//! A room's whole life: create, join, leave, start, dig, then the lock and reveal of each roll,
//! ending in settlement or a refund. All of it is bounded by the 30-player cap.
use crate::ContractExt;
use crate::clues::{roll_clue, roll_treasure, Candidate, Clue, Treasure};
use crate::events::emit;
use crate::layout::{roll_layout, Landmark};
use crate::map_data::{deed_of, is_land, map_index, spot, token_id, MAPS};
use crate::money::{expired_penalty, settle, split_pot, yocto, Split};
use crate::rng::{digs_hash, from_hex32, layout_seed, roll_seed, sha256, to_hex, HashedDig, Stream};
use crate::rules::*;
use crate::scoring::{first_exact_hit, is_crowded, rank, score_dig, Ranked};
use crate::season::is_excluded;
use crate::views;
use crate::Contract;
use near_sdk::serde::Serialize;
use near_sdk::{env, near, require, AccountId};

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    Waiting,
    Live,
    Finished,
    Refunded,
}

impl Status {
    pub fn name(self) -> &'static str {
        match self {
            Status::Waiting => "waiting",
            Status::Live => "live",
            Status::Finished => "finished",
            Status::Refunded => "refunded",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RefundReason {
    TooFewDigs,
    Expired,
    MissedReveal,
}

impl RefundReason {
    pub fn name(self) -> &'static str {
        match self {
            RefundReason::TooFewDigs => "too-few-digs",
            RefundReason::Expired => "expired",
            RefundReason::MissedReveal => "missed-reveal",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug)]
pub struct Dig {
    /// Index into the room's players, which saves repeating a name of up to 64 bytes.
    pub player: u8,
    pub x: u16,
    pub y: u16,
    pub clue_index: u8,
    pub dug_at_ms: u64,
    pub crowded: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Roll {
    pub step: u8,
    pub lock_seed: [u8; 32],
    pub digs_hash: [u8; 32],
    pub lock_ms: u64,
    pub lock_height: u64,
    pub link: Option<[u8; 32]>,
    pub reveal_ms: u64,
    pub reveal_height: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Outcome {
    pub ended_ms: u64,
    pub treasure: Option<Treasure>,
    pub refund_reason: Option<RefundReason>,
    pub deed_owner: Option<AccountId>,
    /// (index into digs, milliNEAR).
    pub jackpot_win: Option<(u8, u64)>,
    pub jackpot_before: u64,
    pub jackpot_after: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Room {
    pub id: u64,
    pub name: String,
    pub host: AccountId,
    pub map: u8,
    pub fee: u64,
    pub duration_sec: u32,
    pub host_cut_bps: u16,
    pub min_players: u8,
    pub max_players: u8,
    pub countdown_sec: u32,
    pub status: Status,
    pub version: u64,
    pub created_ms: u64,
    pub created_height: u64,
    pub start_at_ms: Option<u64>,
    pub started_ms: u64,
    pub tip_index: u64,
    pub tip: [u8; 32],
    pub block_seed: [u8; 32],
    pub layout_seed: [u8; 32],
    pub landmarks: Vec<Landmark>,
    pub players: Vec<AccountId>,
    pub digs: Vec<Dig>,
    pub clues: Vec<Clue>,
    pub candidates: Vec<u8>,
    pub rolls: Vec<Roll>,
    pub outcome: Option<Outcome>,
}

impl Room {
    pub fn pot(&self) -> u64 {
        self.fee * self.players.len() as u64
    }

    pub fn deadline_ms(&self) -> u64 {
        self.created_ms + WAITING_DEADLINE_SEC * 1000
    }

    pub fn ends_at_ms(&self) -> u64 {
        self.started_ms + self.duration_sec as u64 * 1000
    }

    /// The step of the next roll: 1, 2, 3 for clues 2, 3, 4, then 4 for the treasure.
    pub fn next_step(&self) -> u8 {
        self.clues.len() as u8
    }

    /// When a step's roll comes due. The treasure's is the round's end, so it's rolled after digging closes.
    pub fn due_ms(&self, step: u8) -> u64 {
        if step >= CHAIN_STEPS {
            return self.ends_at_ms();
        }
        self.started_ms + CLUE_STARTS_AT[step as usize] * self.duration_sec as u64 * 10
    }

    pub fn pending_roll(&self) -> Option<&Roll> {
        self.rolls.last().filter(|r| r.link.is_none())
    }

    pub fn bonus_bps(clue_index: u8) -> u32 {
        CLUE_BONUS_BPS[clue_index as usize]
    }

    pub fn landmark_xy(&self, id: u8) -> (u16, u16) {
        let s = spot(self.map as usize, self.landmarks[id as usize].spot as usize);
        (s.x, s.y)
    }

    fn candidate_rows(&self) -> Vec<Candidate> {
        let kinds = &MAPS[self.map as usize].kinds;
        self.candidates
            .iter()
            .map(|&id| {
                let l = &self.landmarks[id as usize];
                Candidate {
                    id,
                    kind: l.kind,
                    category: kinds[l.kind as usize].category,
                    tags: spot(self.map as usize, l.spot as usize).tags,
                }
            })
            .collect()
    }

    fn digs_hash(&self) -> [u8; 32] {
        digs_hash(self.digs.iter().map(|d| HashedDig {
            account: self.players[d.player as usize].as_str(),
            x: d.x,
            y: d.y,
            clue_index: d.clue_index,
            dug_at_ms: d.dug_at_ms,
        }))
    }

    /// Worked out from the digs when needed, so finished rooms needn't store it.
    pub fn ranking(&self, treasure: &Treasure, range: u64) -> Vec<Ranked> {
        let mut rows: Vec<Ranked> = self
            .digs
            .iter()
            .enumerate()
            .map(|(i, d)| score_dig(i as u8, d.x, d.y, Self::bonus_bps(d.clue_index), d.crowded, d.dug_at_ms, treasure.x, treasure.y, range))
            .collect();
        rank(&mut rows);
        rows
    }
}

/// Line breaks and terminal controls, and the bidi controls that can make a name read as something else. Other
/// invisible marks stay allowed, because emoji and some scripts need joiners.
fn misleads_on_screen(c: char) -> bool {
    c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

// Event payloads. Field names here are the public API: README.md documents them.

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct PlayerEvent<'a> {
    room_id: u64,
    account: &'a AccountId,
    players: usize,
    start_at_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct StartedEvent<'a> {
    room_id: u64,
    by: &'a str,
    started_ms: u64,
    ends_at_ms: u64,
    block_height: u64,
    players: &'a [AccountId],
    pot: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct DigEvent<'a> {
    room_id: u64,
    account: &'a AccountId,
    x: u16,
    y: u16,
    clue_index: u8,
    bonus_bps: u32,
    crowded: bool,
    dug_at_ms: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct LockedEvent {
    room_id: u64,
    step: u8,
    lock_seed: String,
    digs_hash: String,
    digs_count: usize,
    lock_ms: u64,
    lock_height: u64,
    due_ms: u64,
    reveal_deadline_ms: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RevealedEvent {
    room_id: u64,
    step: u8,
    lock_seed: String,
    link: String,
    digs_hash: String,
    roll_seed: String,
    clue: Option<views::ClueView>,
    candidates_after: Option<Vec<u8>>,
    treasure: Option<views::TreasureView>,
    reveal_ms: u64,
    reveal_height: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RefundedEvent<'a> {
    room_id: u64,
    reason: &'static str,
    host: &'a AccountId,
    players: &'a [AccountId],
    fee: u64,
    pot: u64,
    bond: u64,
    bond_returned: u64,
    bond_penalty: u64,
    jackpot_after: u64,
    digs_count: usize,
    ended_ms: u64,
    block_height: u64,
    missed_reveals: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct DeedEvent {
    token_id: String,
    owner: Option<AccountId>,
    paid: u64,
    earned: u64,
    landings: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct JackpotWinEvent<'a> {
    account: &'a AccountId,
    amount: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct PointsEvent<'a> {
    account: &'a AccountId,
    points: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FinishedEvent<'a> {
    room_id: u64,
    map: &'static str,
    host: &'a AccountId,
    players: &'a [AccountId],
    fee: u64,
    host_cut_bps: u16,
    closeness_range: u64,
    bond: u64,
    pot: u64,
    split: Split,
    treasure: views::TreasureView,
    winner: &'a AccountId,
    ranking: Vec<views::RankedView<'a>>,
    deed: DeedEvent,
    jackpot_before: u64,
    jackpot_after: u64,
    jackpot_win: Option<JackpotWinEvent<'a>>,
    season_number: u32,
    season_pool_after: u64,
    season_points: Vec<PointsEvent<'a>>,
    ended_ms: u64,
    block_height: u64,
}

impl Contract {
    pub(crate) fn load_room(&self, id: u64) -> Room {
        self.rooms.get(&id).unwrap_or_else(|| env::panic_str("No such room."))
    }

    pub(crate) fn save_room(&mut self, room: &mut Room) {
        self.version += 1;
        room.version = self.version;
        self.rooms.insert(&room.id, room);
    }

    fn take_next_tip(&mut self) -> (u64, [u8; 32]) {
        if self.tip_head >= self.tip_tail {
            env::panic_str("No round seeds are ready right now. Your coins are safe, so try again in a moment.");
        }
        let index = self.tip_head;
        let tip = self.tips.remove(&index).unwrap_or_else(|| env::panic_str("Missing commitment."));
        self.tip_head += 1;
        (index, tip)
    }

    fn begin(&mut self, room: &mut Room, by: &str) {
        let now = env::block_timestamp_ms();
        room.status = Status::Live;
        room.start_at_ms = None;
        room.started_ms = now;
        room.clues.push(Clue::Yolo);
        emit(
            "started",
            &StartedEvent {
                room_id: room.id,
                by,
                started_ms: now,
                ends_at_ms: room.ends_at_ms(),
                block_height: env::block_height(),
                players: &room.players,
                pot: room.pot(),
            },
        );
        self.save_room(room);
    }

    fn lock(&mut self, room: &mut Room, step: u8) {
        let roll = Roll {
            step,
            lock_seed: env::random_seed_array(),
            digs_hash: room.digs_hash(),
            lock_ms: env::block_timestamp_ms(),
            lock_height: env::block_height(),
            link: None,
            reveal_ms: 0,
            reveal_height: 0,
        };
        let due = room.due_ms(step);
        emit(
            "locked",
            &LockedEvent {
                room_id: room.id,
                step,
                lock_seed: to_hex(&roll.lock_seed),
                digs_hash: to_hex(&roll.digs_hash),
                digs_count: room.digs.len(),
                lock_ms: roll.lock_ms,
                lock_height: roll.lock_height,
                due_ms: due,
                reveal_deadline_ms: due + REVEAL_WINDOW_MS,
            },
        );
        room.rolls.push(roll);
        self.save_room(room);
    }

    /// Takes the room off the open list and into the ring of recent ones, deleting the oldest.
    fn archive(&mut self, room: &mut Room) {
        self.open.retain(|&id| id != room.id);
        self.recent.push(room.id);
        if self.recent.len() > RECENT_ROOMS {
            let oldest = self.recent.remove(0);
            self.rooms.remove(&oldest);
        }
        let mut host = self.accounts.get(&room.host).unwrap_or_default();
        host.open_rooms = host.open_rooms.saturating_sub(1);
        match room.outcome.as_ref().and_then(|o| o.refund_reason) {
            None => host.finished += 1,
            Some(RefundReason::Expired) => host.expired += 1,
            Some(_) => {}
        }
        self.accounts.insert(&room.host, &host);
        self.save_room(room);
    }

    /// Every player gets the fee back. Only an expired room costs the host anything.
    fn refund(&mut self, room: &mut Room, reason: RefundReason) {
        let now = env::block_timestamp_ms();
        let bond = self.config.host_bond;
        let penalty = if reason == RefundReason::Expired { expired_penalty(bond) } else { 0 };
        let jackpot_before = self.jackpot;
        for i in 0..room.players.len() {
            let player = room.players[i].clone();
            self.credit_milli(&player, room.fee, "refund");
        }
        self.credit_milli(&room.host.clone(), bond - penalty, "bond_returned");
        self.jackpot += penalty;
        self.held -= bond + room.pot();
        if reason == RefundReason::MissedReveal {
            self.missed_reveals += 1;
        }
        room.status = Status::Refunded;
        room.start_at_ms = None;
        room.outcome = Some(Outcome {
            ended_ms: now,
            treasure: None,
            refund_reason: Some(reason),
            deed_owner: None,
            jackpot_win: None,
            jackpot_before,
            jackpot_after: self.jackpot,
        });
        emit(
            "refunded",
            &RefundedEvent {
                room_id: room.id,
                reason: reason.name(),
                host: &room.host,
                players: &room.players,
                fee: room.fee,
                pot: room.pot(),
                bond,
                bond_returned: bond - penalty,
                bond_penalty: penalty,
                jackpot_after: self.jackpot,
                digs_count: room.digs.len(),
                ended_ms: now,
                block_height: env::block_height(),
                missed_reveals: self.missed_reveals,
            },
        );
        self.archive(room);
    }

    fn add_season_points(&mut self, account: &AccountId, points: u64) {
        let mut record = self.accounts.get(account).unwrap_or_default();
        if record.season != self.season.number {
            record.season = self.season.number;
            record.points = 0;
        }
        record.points += points;
        let total = record.points;
        self.accounts.insert(account, &record);
        if !is_excluded(account.as_str(), &self.config.prize_excluded_suffix) {
            self.season.record(account, total);
        }
    }

    /// Moves a finished room's money, in the order the rules state.
    fn finish(&mut self, room: &mut Room, treasure: Treasure) {
        let now = env::block_timestamp_ms();
        let bond = self.config.host_bond;
        let pot = room.pot();
        let closeness_range = self.closeness_range_of(room.id);
        let ranking = room.ranking(&treasure, closeness_range);
        let hit = first_exact_hit(room.digs.iter().map(|d| (d.x, d.y, d.dug_at_ms)), treasure.x, treasure.y);
        let kind = room.landmarks[treasure.landmark_id as usize].kind;
        let deed_index = deed_of(room.map, kind);
        let deed_token = token_id(deed_index as usize);
        // An owner this contract can't pay counts as no owner, so the share goes to the jackpot and is never stranded.
        let share = split_pot(pot, room.host_cut_bps).deed;
        let deed_owner = self.tokens.owner_by_id.get(&deed_token).filter(|owner| self.can_take_share(owner, share));
        let jackpot_before = self.jackpot;
        let settled = settle(pot, room.host_cut_bps, &ranking, hit.is_some(), deed_owner.is_some(), jackpot_before);
        let split = settled.split;
        let player_of = |dig: u8| &room.players[room.digs[dig as usize].player as usize];

        self.held -= bond + pot;
        let winner = player_of(ranking[0].dig);
        self.credit_milli(&room.host.clone(), bond, "bond_returned");
        self.credit_milli(&room.host.clone(), split.host_cut, "host_cut");
        self.credit_milli(winner, split.prize, "prize");
        self.season.pool += split.season;
        self.jackpot = settled.jackpot_after;

        let mut deed = self.deeds.get(&deed_index).unwrap_or_default();
        deed.landings += 1;
        deed.earned += settled.deed_paid;
        self.deeds.insert(&deed_index, &deed);
        if let Some(owner) = &deed_owner {
            if settled.deed_paid > 0 {
                self.credit_paying_for_record(owner, yocto(settled.deed_paid), "deed_share");
            }
        }

        let jackpot_win = hit.map(|h| (h as u8, settled.jackpot_win));
        if let Some((h, amount)) = jackpot_win {
            self.credit_milli(player_of(h), amount, "jackpot");
        }

        let mut season_points = Vec::with_capacity(settled.season_points.len());
        for (place, &points) in settled.season_points.iter().enumerate() {
            let account = player_of(ranking[place].dig);
            self.add_season_points(account, points);
            season_points.push(PointsEvent { account, points });
        }

        emit(
            "finished",
            &FinishedEvent {
                room_id: room.id,
                map: MAPS[room.map as usize].name,
                host: &room.host,
                players: &room.players,
                fee: room.fee,
                host_cut_bps: room.host_cut_bps,
                closeness_range,
                bond,
                pot,
                split,
                treasure: views::TreasureView::of(&treasure),
                winner,
                ranking: views::ranking_rows(room, &ranking),
                deed: DeedEvent {
                    token_id: deed_token,
                    owner: deed_owner.clone(),
                    paid: settled.deed_paid,
                    earned: deed.earned,
                    landings: deed.landings,
                },
                jackpot_before,
                jackpot_after: self.jackpot,
                jackpot_win: jackpot_win.map(|(h, amount)| JackpotWinEvent { account: player_of(h), amount }),
                season_number: self.season.number,
                season_pool_after: self.season.pool,
                season_points,
                ended_ms: now,
                block_height: env::block_height(),
            },
        );

        room.status = Status::Finished;
        room.outcome = Some(Outcome {
            ended_ms: now,
            treasure: Some(treasure),
            refund_reason: None,
            deed_owner,
            jackpot_win,
            jackpot_before,
            jackpot_after: self.jackpot,
        });
        self.archive(room);
    }
}

#[cfg(test)]
impl Contract {
    pub fn bonus_of(clue_index: u8) -> u32 {
        Room::bonus_bps(clue_index)
    }

    pub fn deposit_for_test(&mut self, id: AccountId, amount: u128) {
        self.credit(&id, amount, "test");
    }
}

#[near]
impl Contract {
    /// Opens a room, locks the host's bond and rolls the layout. A validator could only influence where
    /// landmarks stand before anyone has joined, which decides nothing, so this needs no two-step roll.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_room(
        &mut self,
        name: String,
        map: String,
        fee: u64,
        duration_sec: u32,
        host_cut_bps: u16,
        min_players: u8,
        max_players: u8,
        countdown_sec: u32,
    ) -> u64 {
        self.take_attached();
        let host = env::predecessor_account_id();
        let name = name.trim().to_string();
        require!(!name.is_empty(), "Give the game a name.");
        require!(name.len() <= MAX_ROOM_NAME_BYTES, "That name is too long.");
        require!(!name.chars().any(misleads_on_screen), "That name has characters we can't show. Try another.");
        let map_id = map_index(&map).unwrap_or_else(|| env::panic_str("There's no such map."));
        require!(fee > 0, "Set an entry fee above 0.");
        require!(fee <= MAX_FEE_MILLI, "That entry fee is too high.");
        require!(host_cut_bps <= MAX_HOST_CUT_BPS, "The host can keep at most 20% of the pot.");
        require!(TIMER_CHOICES.contains(&duration_sec), "Pick a timer of 60, 180, 300 or 600 seconds.");
        require!(COUNTDOWN_CHOICES.contains(&countdown_sec), "Pick a countdown of 0, 30, 60 or 120 seconds.");
        require!(min_players >= MIN_PLAYERS_FLOOR, "A game needs at least 2 players.");
        require!(max_players <= MAX_PLAYERS_CAP, "A game can have at most 30 players.");
        require!(min_players <= max_players, "The minimum can't be above the maximum.");

        // The bond stays in the contract while the room is open, and that's what pays for the room's storage.
        let bond = self.config.host_bond;
        let worst_bytes = ROOM_BASE_BYTES + max_players as u64 * ROOM_BYTES_PER_PLAYER;
        let worst_cost = worst_bytes as u128 * env::storage_byte_cost().as_yoctonear();
        require!(yocto(bond) >= worst_cost, "The host bond can't cover a room this size.");

        require!(self.open.len() < MAX_OPEN_ROOMS, "Too many games are open right now. Try again soon.");
        let mut record = self.accounts.get(&host).unwrap_or_default();
        require!(record.open_rooms < MAX_OPEN_ROOMS_PER_HOST, "You can host at most 3 open games at once.");

        self.debit_milli(&host, bond, "bond");
        self.held += bond;
        // Read after the debit, which rewrote the record.
        record = self.accounts.get(&host).unwrap_or_default();
        record.open_rooms += 1;
        self.accounts.insert(&host, &record);

        let (tip_index, tip) = self.take_next_tip();
        let id = self.next_room_id;
        self.next_room_id += 1;
        let block_seed = env::random_seed_array();
        let seed = layout_seed(id, &block_seed, &tip);
        let landmarks = roll_layout(map_id as usize, &mut Stream::new(seed));
        let now = env::block_timestamp_ms();
        let candidates = (0..landmarks.len() as u8).collect();
        let mut room = Room {
            id,
            name,
            host,
            map: map_id,
            fee,
            duration_sec,
            host_cut_bps,
            min_players,
            max_players,
            countdown_sec,
            status: Status::Waiting,
            version: 0,
            created_ms: now,
            created_height: env::block_height(),
            start_at_ms: None,
            started_ms: 0,
            tip_index,
            tip,
            block_seed,
            layout_seed: seed,
            landmarks,
            players: Vec::new(),
            digs: Vec::new(),
            clues: Vec::new(),
            candidates,
            rolls: Vec::new(),
            outcome: None,
        };
        self.open.push(id);
        self.save_room(&mut room);
        emit("room_created", &views::RoomCreatedEvent::of(&room, bond, self.closeness_range_of(room.id)));
        self.flush_balance_events();
        id
    }

    /// The fee comes out of the balance, after anything attached has gone into it.
    #[payable]
    pub fn join(&mut self, room_id: u64) {
        self.take_attached();
        let account = env::predecessor_account_id();
        let mut room = self.load_room(room_id);
        let now = env::block_timestamp_ms();
        require!(room.status == Status::Waiting, "This round has already started.");
        require!(room.start_at_ms.is_none_or(|t| now < t), "This round is starting.");
        require!(now < room.deadline_ms(), "This room has run out of time.");
        require!(!room.players.contains(&account), "You already joined this game.");
        require!(room.players.len() < room.max_players as usize, "This game is full.");

        self.debit_milli(&account, room.fee, "join");
        self.held += room.fee;
        room.players.push(account.clone());

        // A full room starts soon whatever the countdown says. Otherwise reaching the minimum starts the countdown.
        let count = room.players.len();
        if count >= room.max_players as usize {
            let soon = now + FULL_ROOM_START_SEC * 1000;
            room.start_at_ms = Some(room.start_at_ms.map_or(soon, |t| t.min(soon)));
        } else if count >= room.min_players as usize && room.countdown_sec > 0 && room.start_at_ms.is_none() {
            room.start_at_ms = Some(now + room.countdown_sec as u64 * 1000);
        }
        emit("joined", &PlayerEvent { room_id, account: &account, players: count, start_at_ms: room.start_at_ms });
        self.save_room(&mut room);
        self.flush_balance_events();
    }

    /// Only before the start. The fee goes back to the balance.
    pub fn leave(&mut self, room_id: u64) {
        let account = env::predecessor_account_id();
        let mut room = self.load_room(room_id);
        let now = env::block_timestamp_ms();
        require!(room.status == Status::Waiting, "You can only leave before the round starts.");
        require!(room.start_at_ms.is_none_or(|t| now < t), "This round is starting.");
        require!(now < room.deadline_ms(), "This room has run out of time.");
        let at = room.players.iter().position(|p| p == &account);
        let at = at.unwrap_or_else(|| env::panic_str("You haven't joined this game."));
        let was_full = room.players.len() >= room.max_players as usize;
        room.players.remove(at);
        self.held -= room.fee;
        self.credit_milli(&account, room.fee, "leave");
        if room.players.len() < room.min_players as usize || room.countdown_sec == 0 {
            room.start_at_ms = None;
        } else if was_full {
            // Filling a room shortens its timer, so someone could join and leave to rush a start past everyone
            // still on their way. What was left of the old countdown isn't stored, so it runs again, which at
            // worst delays a start by a griefer filling the room each time, up to the deadline the host can beat.
            room.start_at_ms = Some(now + room.countdown_sec as u64 * 1000);
        }
        emit("left", &PlayerEvent { room_id, account: &account, players: room.players.len(), start_at_ms: room.start_at_ms });
        self.save_room(&mut room);
        self.flush_balance_events();
    }

    /// Host only, at the minimum.
    pub fn start(&mut self, room_id: u64) {
        let mut room = self.load_room(room_id);
        require!(room.status == Status::Waiting, "This round has already started.");
        require!(env::predecessor_account_id() == room.host, "Only the host can start this game.");
        require!(room.players.len() >= room.min_players as usize, "This game doesn't have enough players to start.");
        self.begin(&mut room, "host");
    }

    /// `seen_clue` is how many clues the player could see. A clue arriving while the dig is on its way
    /// would quietly cost them bonus, so the dig is turned down instead and they can decide again.
    pub fn dig(&mut self, room_id: u64, x: u16, y: u16, seen_clue: u8) {
        let account = env::predecessor_account_id();
        let mut room = self.load_room(room_id);
        let now = env::block_timestamp_ms();
        require!(room.status != Status::Waiting, "The round hasn't started yet.");
        require!(room.status == Status::Live && now < room.ends_at_ms(), "This game has ended.");
        let player = room.players.iter().position(|p| p == &account);
        let player = player.unwrap_or_else(|| env::panic_str("Only players who joined before the start can dig."));
        require!(!room.digs.iter().any(|d| d.player as usize == player), "You already dug in this game.");
        require!(is_land(room.map as usize, x as i32, y as i32), "That spot is water. Pick a spot on land.");
        // The oracle holds every link, so once a lock fixes the seed it can work out the next clue. Digging here on
        // the old clue's bonus would be digging with the answer. A withheld reveal keeps digging shut and the room
        // refunds, so holding back buys nothing. No timeout reopens it, because that would hand the same lead back.
        require!(room.pending_roll().is_none(), "A new clue is arriving. Try again in a moment.");
        require!(seen_clue as usize == room.clues.len(), "A new clue just arrived. Check it, then dig again.");

        let clue_index = (room.clues.len() - 1) as u8;
        let crowded = is_crowded(room.digs.iter().map(|d| (d.x, d.y)), x, y);
        room.digs.push(Dig { player: player as u8, x, y, clue_index, dug_at_ms: now, crowded });
        emit(
            "dig",
            &DigEvent {
                room_id,
                account: &account,
                x,
                y,
                clue_index,
                bonus_bps: Room::bonus_bps(clue_index),
                crowded,
                dug_at_ms: now,
            },
        );
        self.save_room(&mut room);
    }

    /// Anyone can call this. It does the first thing that's due and nothing otherwise, so a room can always
    /// move on, and always refund, without the backend. Returns what it did: `started`, `locked`, `refunded` or `none`.
    pub fn poke(&mut self, room_id: u64) -> String {
        let mut room = self.load_room(room_id);
        let now = env::block_timestamp_ms();
        let done = match room.status {
            Status::Waiting => {
                if room.start_at_ms.is_some_and(|t| now >= t) {
                    self.begin(&mut room, "timer");
                    "started"
                } else if now >= room.deadline_ms() {
                    if room.players.len() >= room.min_players as usize {
                        self.begin(&mut room, "deadline");
                        "started"
                    } else {
                        self.refund(&mut room, RefundReason::Expired);
                        "refunded"
                    }
                } else {
                    "none"
                }
            }
            Status::Live => {
                let step = room.next_step();
                let due = room.due_ms(step);
                if now >= room.ends_at_ms() && room.digs.len() < MIN_DIGS {
                    self.refund(&mut room, RefundReason::TooFewDigs);
                    "refunded"
                } else if now >= due + REVEAL_WINDOW_MS {
                    self.refund(&mut room, RefundReason::MissedReveal);
                    "refunded"
                } else if now >= due && room.pending_roll().is_none() {
                    self.lock(&mut room, step);
                    "locked"
                } else {
                    "none"
                }
            }
            Status::Finished | Status::Refunded => "none",
        };
        self.flush_balance_events();
        done.to_string()
    }

    /// Anyone holding the right preimage. Validator seed first, ours second: the validator can't know the
    /// result when deciding on the lock, and all we can do is refuse, which visibly refunds the round.
    pub fn reveal(&mut self, room_id: u64, link: String) {
        let mut room = self.load_room(room_id);
        let now = env::block_timestamp_ms();
        require!(room.status == Status::Live, "This game isn't live.");
        let pending = room.pending_roll().cloned().unwrap_or_else(|| env::panic_str("No roll is waiting for a reveal."));
        require!(env::block_height() > pending.lock_height, "A reveal must come in a later block than its lock.");
        require!(now < room.due_ms(pending.step) + REVEAL_WINDOW_MS, "The reveal deadline has passed.");

        let link = from_hex32(&link).unwrap_or_else(|| env::panic_str("A link is 64 lowercase hex characters."));
        let previous = if pending.step == 1 {
            room.tip
        } else {
            room.rolls[pending.step as usize - 2].link.unwrap_or_else(|| env::panic_str("Rolls out of order."))
        };
        require!(sha256(&link) == previous, "That link doesn't match this room's commitment.");

        let seed = roll_seed(room.id, pending.step, &pending.lock_seed, &link, &pending.digs_hash);
        let roll = room.rolls.last_mut().unwrap_or_else(|| env::panic_str("No roll is waiting for a reveal."));
        roll.link = Some(link);
        roll.reveal_ms = now;
        roll.reveal_height = env::block_height();

        let mut stream = Stream::new(seed);
        let mut event = RevealedEvent {
            room_id,
            step: pending.step,
            lock_seed: to_hex(&pending.lock_seed),
            link: to_hex(&link),
            digs_hash: to_hex(&pending.digs_hash),
            roll_seed: to_hex(&seed),
            clue: None,
            candidates_after: None,
            treasure: None,
            reveal_ms: now,
            reveal_height: env::block_height(),
        };
        if pending.step < CHAIN_STEPS {
            let (clue, after) = roll_clue(room.clues.len(), &room.candidate_rows(), &mut stream);
            room.clues.push(clue);
            room.candidates = after;
            event.clue = Some(views::ClueView::of(room.map, &clue));
            event.candidates_after = Some(room.candidates.clone());
            emit("revealed", &event);
            self.save_room(&mut room);
        } else {
            let places: Vec<(u8, u16, u16)> = room
                .candidates
                .iter()
                .map(|&id| {
                    let (x, y) = room.landmark_xy(id);
                    (id, x, y)
                })
                .collect();
            let treasure = roll_treasure(room.map as usize, &places, &mut stream);
            event.treasure = Some(views::TreasureView::of(&treasure));
            emit("revealed", &event);
            self.finish(&mut room, treasure);
        }
        self.flush_balance_events();
    }

    /// Oracle only. Each tip is `H(H(H(H(s))))`, in hex. Its index is its place in the order uploaded,
    /// which is what the oracle derives `s` from, so it stores nothing else. `first_index` is where the
    /// oracle thinks these go: a lost upload landing late could otherwise put one chain in two rooms,
    /// and the second room's links would be public once the first ended.
    pub fn add_commitments(&mut self, tips: Vec<String>, first_index: Option<u64>) -> u64 {
        require!(env::predecessor_account_id() == self.config.oracle, "Only the oracle can add commitments.");
        require!(first_index.is_none_or(|i| i == self.tip_tail), "The commitment index has moved. Read it again and retry.");
        require!(tips.len() <= MAX_TIPS_PER_CALL, "Too many commitments in one call.");
        require!(self.tip_tail - self.tip_head + tips.len() as u64 <= MAX_TIP_POOL, "The commitment pool is full.");
        let first_index = self.tip_tail;
        for tip in &tips {
            let tip = from_hex32(tip).unwrap_or_else(|| env::panic_str("A tip is 64 lowercase hex characters."));
            self.tips.insert(&self.tip_tail, &tip);
            self.tip_tail += 1;
        }
        emit("commitments_added", &views::CommitmentsEvent { first_index, count: tips.len(), left: self.tip_tail - self.tip_head });
        self.tip_tail - self.tip_head
    }
}
