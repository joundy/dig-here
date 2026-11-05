//! Every rule constant, mirroring `src/lib/game/rules.ts`. `host_bond`, `mint_price` and the season
//! length are the three numbers set at init instead, so testnet can use smaller coins.

pub const MAX_HOST_CUT_BPS: u16 = 2000;
pub const JACKPOT_BPS: u64 = 300;
pub const DEED_BPS: u64 = 200;
pub const SEASON_BPS: u64 = 100;

pub const MIN_PLAYERS_FLOOR: u8 = 2;
pub const MAX_PLAYERS_CAP: u8 = 30;
pub const MIN_DIGS: usize = 2;

/// Percent of the round gone when each clue is due. The first says nothing and is out at the start.
pub const CLUE_STARTS_AT: [u64; 4] = [0, 30, 60, 85];
pub const CLUE_BONUS_BPS: [u32; 4] = [25000, 15000, 12500, 10000];

/// The range for rooms created since the upgrade that set `closeness_new_from`. See `Contract::closeness_range_of`.
pub const CLOSENESS_RANGE: u64 = 96;
/// What every room before that was scored by. It stays so those rounds still recompute the same.
pub const CLOSENESS_RANGE_BEFORE: u64 = 48;
pub const TREASURE_SCATTER: i32 = 13;
pub const TREASURE_ATTEMPTS: u32 = 60;
pub const CROWD_RADIUS: i64 = 6;
pub const CROWD_BPS: u64 = 8500;

pub const TIMER_CHOICES: [u32; 4] = [60, 180, 300, 600];
pub const COUNTDOWN_CHOICES: [u32; 4] = [0, 30, 60, 120];
pub const FULL_ROOM_START_SEC: u64 = 5;
pub const WAITING_DEADLINE_SEC: u64 = 900;

pub const EXPIRED_BOND_PENALTY_BPS: u64 = 1000;
pub const MAX_OPEN_ROOMS_PER_HOST: u8 = 3;

pub const JACKPOT_PAY_BPS: u64 = 8000;
pub const JACKPOT_CAP_POTS: u64 = 100;

pub const SEASON_POINTS_PER_NEAR: [u64; 3] = [100, 30, 10];
pub const SEASON_MIN_DIGS: usize = 3;
pub const SEASON_PRIZE_BPS: [u64; 3] = [6000, 3000, 1000];

// The layout roll, as in `map.ts`.
pub const MIN_SPACING: i64 = 20;
pub const BOX_GAP: i32 = 2;
pub const KIND_SPREAD: [i64; 4] = [90, 70, 50, 36];
pub const LAYOUT_TRIES: u32 = 150;
pub const LAYOUT_SAMPLES: u32 = 8;
pub const LAYOUT_RESTARTS: u32 = 20;

// Below here are limits only the contract needs, none of which change who wins what.

/// One link per roll: clues 2, 3, 4 and the treasure.
pub const CHAIN_STEPS: u8 = 4;
pub const REVEAL_WINDOW_MS: u64 = 120_000;
pub const YOCTO_PER_MILLI: u128 = 1_000_000_000_000_000_000_000;

/// `live_state` returns every open room, so this is what keeps it inside a view's gas limit.
pub const MAX_OPEN_ROOMS: usize = 30;
/// Finished rooms kept for reading. The events keep the rest of history.
pub const RECENT_ROOMS: usize = 30;
pub const SEASON_TOP: usize = 10;

pub const MAX_ROOM_NAME_BYTES: usize = 40;
/// Well above any real fee, and low enough that pots, shares and points all fit a u64 and a JS number.
pub const MAX_FEE_MILLI: u64 = 100_000_000_000;

pub const MAX_TIPS_PER_CALL: usize = 100;
/// The contract pays for waiting commitments, so the pool is capped: 200 * 81 bytes is 0.162 NEAR.
pub const MAX_TIP_POOL: u64 = 200;

/// Bytes a room can take with no players, at the longest name and with everything rolled.
/// `room_bytes_stay_inside_the_bond_check` holds this to the real encoding.
pub const ROOM_BASE_BYTES: u64 = 1300;
/// A 64-character account (68 bytes) and its dig (15 bytes).
pub const ROOM_BYTES_PER_PLAYER: u64 = 83;
