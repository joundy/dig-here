//! The season: a pool, and a top list kept up to date as points arrive, so closing never walks every player.
//! Points only rise within a season, so the top list stays exact: anyone out of it has ten better than them
//! for good. Accounts with the excluded suffix never enter it, so whoever ranks below them moves up.
use crate::{Contract, ContractExt};
use crate::rules::{SEASON_PRIZE_BPS, SEASON_TOP};
use near_sdk::{near, AccountId};

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct TopEntry {
    pub account: AccountId,
    pub points: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Winner {
    pub account: AccountId,
    pub prize: u64,
}

#[near(serializers = [borsh])]
#[derive(Debug)]
pub struct Season {
    pub number: u32,
    pub ends_at_ms: u64,
    pub pool: u64,
    pub top: Vec<TopEntry>,
    pub last_winners: Vec<Winner>,
}

pub fn is_excluded(account: &str, suffix: &str) -> bool {
    !suffix.is_empty() && account.ends_with(suffix)
}

impl Season {
    /// `points` is the account's new total. Equal points go by account name, byte by byte.
    pub fn record(&mut self, account: &AccountId, points: u64) {
        self.top.retain(|e| &e.account != account);
        let at = self
            .top
            .iter()
            .position(|e| e.points < points || (e.points == points && e.account.as_bytes() > account.as_bytes()))
            .unwrap_or(self.top.len());
        if at < SEASON_TOP {
            self.top.insert(at, TopEntry { account: account.clone(), points });
            self.top.truncate(SEASON_TOP);
        }
    }

    /// Places 1, 2, 3 of the starting pool. What isn't won stays in the pool. Prizes of 0 are still listed.
    pub fn prizes(&self) -> Vec<Winner> {
        self.top
            .iter()
            .zip(SEASON_PRIZE_BPS)
            .map(|(entry, bps)| Winner { account: entry.account.clone(), prize: self.pool * bps / 10000 })
            .collect()
    }
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
struct WinnerEvent {
    account: AccountId,
    prize: u64,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SeasonClosedEvent {
    season: u32,
    starting_pool: u64,
    pool_after: u64,
    prizes: Vec<WinnerEvent>,
    next_season: u32,
    next_ends_at_ms: u64,
}

#[near]
impl Contract {
    /// Anyone, after the end time. Pays the top three, and the next season starts. Bounded: accounts keep
    /// their own season number, so nobody's points need clearing.
    pub fn close_season(&mut self) {
        let now = near_sdk::env::block_timestamp_ms();
        near_sdk::require!(now >= self.season.ends_at_ms, "This season hasn't ended yet.");
        let starting_pool = self.season.pool;
        let prizes = self.season.prizes();
        for winner in &prizes {
            self.credit_milli(&winner.account, winner.prize, "season_prize");
            self.season.pool -= winner.prize;
        }
        let closed = self.season.number;
        self.season.number += 1;
        self.season.ends_at_ms = now + self.config.season_length_sec * 1000;
        self.season.top.clear();
        crate::events::emit(
            "season_closed",
            &SeasonClosedEvent {
                season: closed,
                starting_pool,
                pool_after: self.season.pool,
                prizes: prizes.iter().map(|w| WinnerEvent { account: w.account.clone(), prize: w.prize }).collect(),
                next_season: self.season.number,
                next_ends_at_ms: self.season.ends_at_ms,
            },
        );
        self.season.last_winners = prizes;
        self.flush_balance_events();
    }
}
