//! Dig Here. Every rule, roll and coin of the game lives here. `src/lib/game/` is the same rules in TypeScript,
//! and `tests/vectors.json` holds the two to the same answers. See `README.md` for every method and event.
// Public only so the sandbox tests can recompute a roll and rewrite a room. No contract method comes from this.
pub mod clues;
mod events;
pub mod layout;
pub mod map_data;
mod money;
mod nft;
pub mod rng;
pub mod rooms;
pub mod rules;
mod scoring;
mod season;
mod views;

#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod vector_tests;

use events::emit;
use money::{Account, BalanceChange};
use near_contract_standards::non_fungible_token::NonFungibleToken;
use near_sdk::collections::LookupMap;
use near_sdk::serde::Serialize;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};
use nft::Deed;
use rooms::Room;
use season::Season;

/// All money amounts here are whole milliNEAR. Fixed at init, and nothing can change them afterwards.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub oracle: AccountId,
    pub treasury: AccountId,
    pub mint_price: u64,
    pub host_bond: u64,
    pub season_length_sec: u64,
    pub prize_excluded_suffix: String,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Prefix {
    Accounts,
    Rooms,
    Tips,
    Deeds,
    NftOwners,
    NftMetadata,
    NftEnumeration,
    NftApprovals,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct ClosenessChanged {
    range_before: u64,
    range: u64,
    first_room: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    config: Config,
    accounts: LookupMap<AccountId, Account>,
    rooms: LookupMap<u64, Room>,
    /// Waiting and live rooms, oldest first. At most `MAX_OPEN_ROOMS`.
    open: Vec<u64>,
    /// Finished and refunded rooms still kept, oldest first. At most `RECENT_ROOMS`.
    recent: Vec<u64>,
    next_room_id: u64,

    tips: LookupMap<u64, [u8; 32]>,
    tip_head: u64,
    tip_tail: u64,

    jackpot: u64,
    missed_reveals: u64,
    season: Season,

    /// Sum of every game balance, in yocto.
    total_balances: u128,
    /// Fees and bonds locked in open rooms, in milli.
    held: u64,
    /// Rises on every change to a room, so a poller can tell cheaply whether anything moved.
    version: u64,

    deeds: LookupMap<u8, Deed>,
    tokens: NonFungibleToken,

    /// This receipt's balance changes, logged together as one event at the end of the method.
    #[borsh(skip)]
    pending_changes: Vec<BalanceChange>,
}

#[near]
impl Contract {
    /// Private, so nobody can front-run the deploy with their own config. There's no admin method after this.
    #[init]
    #[private]
    pub fn new(config: Config) -> Self {
        require!(config.mint_price > 0, "mint_price must be above 0");
        require!(config.host_bond > 0, "host_bond must be above 0");
        require!(config.season_length_sec > 0, "season_length_sec must be above 0");
        require!(config.prize_excluded_suffix.len() <= 64, "prize_excluded_suffix is too long");
        let season = Season {
            number: 1,
            ends_at_ms: env::block_timestamp_ms() + config.season_length_sec * 1000,
            pool: 0,
            top: Vec::new(),
            last_winners: Vec::new(),
        };
        let mut this = Self {
            accounts: LookupMap::new(Prefix::Accounts),
            rooms: LookupMap::new(Prefix::Rooms),
            open: Vec::new(),
            recent: Vec::new(),
            next_room_id: 1,
            tips: LookupMap::new(Prefix::Tips),
            tip_head: 0,
            tip_tail: 0,
            jackpot: 0,
            missed_reveals: 0,
            season,
            total_balances: 0,
            held: 0,
            version: 0,
            deeds: LookupMap::new(Prefix::Deeds),
            tokens: NonFungibleToken::new(
                Prefix::NftOwners,
                env::current_account_id(),
                Some(Prefix::NftMetadata),
                Some(Prefix::NftEnumeration),
                Some(Prefix::NftApprovals),
            ),
            pending_changes: Vec::new(),
            config,
        };
        // The treasury is paid from its game balance, so it needs a record before the first mint.
        this.accounts.insert(&this.config.treasury.clone(), &Account::default());
        this.set_closeness_new_from(1);
        this
    }

    /// The upgrade to the market and the new closeness range, deployed together with this in one transaction, so no
    /// room can be created in between. Rooms already open keep the range their players joined under. Old listings stop
    /// existing, since the market replaces them. Only the contract's own account can call it, and only once.
    #[private]
    pub fn upgrade_to_market(&mut self) {
        require!(self.closeness_new_from() == u64::MAX, "This upgrade has already run.");
        let from = self.next_room_id;
        self.set_closeness_new_from(from);
        emit(
            "closeness_range_changed",
            &ClosenessChanged { range_before: rules::CLOSENESS_RANGE_BEFORE, range: rules::CLOSENESS_RANGE, first_room: from },
        );
        self.retire_old_listings();
    }
}
