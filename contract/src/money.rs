//! The pot split and settlement arithmetic in milliNEAR, and the game balances in yoctoNEAR.
use crate::ContractExt;
use crate::events::emit;
use crate::rules::*;
use crate::scoring::Ranked;
use crate::Contract;
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

/// The failure path burned 1.85 Tgas on a short name in the sandbox. Run out here and a failed transfer's coins are lost.
const GAS_FOR_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(5);
/// The transfer, the callback and the work before them.
const MIN_GAS_FOR_WITHDRAW: Gas = Gas::from_tgas(10);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Split {
    pub host_cut: u64,
    pub jackpot: u64,
    pub deed: u64,
    pub season: u64,
    pub prize: u64,
}

pub fn split_pot(pot: u64, host_cut_bps: u16) -> Split {
    let share = |bps: u64| pot * bps / 10000;
    let host_cut = share(host_cut_bps as u64);
    let jackpot = share(JACKPOT_BPS);
    let deed = share(DEED_BPS);
    let season = share(SEASON_BPS);
    Split { host_cut, jackpot, deed, season, prize: pot - host_cut - jackpot - deed - season }
}

#[derive(Debug)]
pub struct Settlement {
    pub split: Split,
    pub jackpot_after: u64,
    /// What the deed's owner gets. 0 when nobody owns it, because the share went to the jackpot instead.
    pub deed_paid: u64,
    pub jackpot_win: u64,
    /// By place in the ranking. Points of 0 still count as an entry.
    pub season_points: Vec<u64>,
}

/// Steps 2 to 5 of settling a room, in order, because the jackpot win depends on the steps before it.
pub fn settle(pot: u64, host_cut_bps: u16, ranking: &[Ranked], exact_hit: bool, deed_owned: bool, jackpot_before: u64) -> Settlement {
    let split = split_pot(pot, host_cut_bps);
    let mut jackpot = jackpot_before + split.jackpot;
    let deed_paid = if deed_owned {
        split.deed
    } else {
        jackpot += split.deed;
        0
    };
    let jackpot_win = if exact_hit { (jackpot * JACKPOT_PAY_BPS / 10000).min(pot * JACKPOT_CAP_POTS) } else { 0 };
    jackpot -= jackpot_win;
    let season_points = if ranking.len() >= SEASON_MIN_DIGS {
        SEASON_POINTS_PER_NEAR.iter().map(|per_near| pot * per_near / 1000).collect()
    } else {
        Vec::new()
    };
    Settlement { split, jackpot_after: jackpot, deed_paid, jackpot_win, season_points }
}

/// What an expired room's host loses to the jackpot. Every other refund returns the bond whole.
pub fn expired_penalty(bond: u64) -> u64 {
    bond * EXPIRED_BOND_PENALTY_BPS / 10000
}

pub fn yocto(milli: u64) -> u128 {
    milli as u128 * YOCTO_PER_MILLI
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Account {
    pub balance: u128,
    /// The season `points` belong to. Any other season means 0, so closing a season touches no records.
    pub season: u32,
    pub points: u64,
    pub open_rooms: u8,
    pub finished: u32,
    pub expired: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BalanceChange {
    account: AccountId,
    /// Signed yoctoNEAR, as a string.
    delta: String,
    balance: U128,
    reason: &'static str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct BalanceEvent<'a> {
    changes: &'a [BalanceChange],
}

impl Contract {
    fn note_change(&mut self, account: &AccountId, sign: &str, amount: u128, balance: u128, reason: &'static str) {
        self.pending_changes.push(BalanceChange {
            account: account.clone(),
            delta: format!("{sign}{amount}"),
            balance: U128(balance),
            reason,
        });
    }

    /// Credits an account that may be new. A new account's record is paid for out of this credit, at
    /// the exact cost measured, so nobody can grow the contract's state for free.
    pub(crate) fn credit_paying_for_record(&mut self, id: &AccountId, amount: u128, reason: &'static str) {
        if self.accounts.get(id).is_some() {
            return self.credit(id, amount, reason);
        }
        let before = env::storage_usage();
        self.accounts.insert(id, &Account::default());
        let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
        require!(
            amount >= cost,
            format!("Your first deposit must be at least {cost} yoctoNEAR, to cover your record.")
        );
        self.credit(id, amount, reason);
        self.debit(id, cost, "storage");
    }

    /// Whether a deed's owner can be paid a share. A market buyer may have no record, so their first share has to
    /// pay for one. Receiving an NFT can't make the record, because anyone could then grow storage for free by
    /// passing a token around fresh accounts. Nothing to pay needs no record.
    pub(crate) fn can_take_share(&mut self, owner: &AccountId, share_milli: u64) -> bool {
        if share_milli == 0 || self.accounts.get(owner).is_some() {
            return true;
        }
        let before = env::storage_usage();
        self.accounts.insert(owner, &Account::default());
        let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
        self.accounts.remove(owner);
        yocto(share_milli) >= cost
    }

    /// Only for accounts that have a record: everyone paid by a room joined or hosted it, and a deed's owner got
    /// one through `credit_paying_for_record`. A missing record can't fail a settlement, though, so it's created
    /// here rather than panicking.
    pub(crate) fn credit(&mut self, id: &AccountId, amount: u128, reason: &'static str) {
        if amount == 0 {
            return;
        }
        let mut account = self.accounts.get(id).unwrap_or_default();
        account.balance += amount;
        self.total_balances += amount;
        self.accounts.insert(id, &account);
        self.note_change(id, "", amount, account.balance, reason);
    }

    pub(crate) fn credit_milli(&mut self, id: &AccountId, milli: u64, reason: &'static str) {
        self.credit(id, yocto(milli), reason);
    }

    pub(crate) fn debit(&mut self, id: &AccountId, amount: u128, reason: &'static str) {
        let mut account = self.accounts.get(id).unwrap_or_default();
        require!(account.balance >= amount, "Not enough coins in your balance.");
        account.balance -= amount;
        self.total_balances -= amount;
        self.accounts.insert(id, &account);
        self.note_change(id, "-", amount, account.balance, reason);
    }

    pub(crate) fn debit_milli(&mut self, id: &AccountId, milli: u64, reason: &'static str) {
        self.debit(id, yocto(milli), reason);
    }

    /// Whatever a payable method was sent goes to the caller's balance first, and its cost comes out of
    /// the balance. So a wallet tops up once, and a function-call key then pays with nothing attached,
    /// for the methods that allow it. `mint_nft` doesn't.
    pub(crate) fn take_attached(&mut self) {
        let attached = env::attached_deposit().as_yoctonear();
        if attached > 0 {
            let id = env::predecessor_account_id();
            self.credit_paying_for_record(&id, attached, "deposit");
        }
    }

    pub(crate) fn flush_balance_events(&mut self) {
        if !self.pending_changes.is_empty() {
            let changes = std::mem::take(&mut self.pending_changes);
            emit("balance", &BalanceEvent { changes: &changes });
        }
    }
}

#[near]
impl Contract {
    #[payable]
    pub fn deposit(&mut self) {
        require!(env::attached_deposit() > NearToken::from_yoctonear(0), "Attach some NEAR to deposit.");
        self.take_attached();
        self.flush_balance_events();
    }

    /// Credits someone else's balance. Their record, if they have none yet, is paid out of the amount.
    #[payable]
    pub fn deposit_for(&mut self, account_id: AccountId) {
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached > 0, "Attach some NEAR to deposit.");
        self.credit_paying_for_record(&account_id, attached, "deposit");
        self.flush_balance_events();
    }

    /// Needs exactly 1 yocto, which a function-call key can't attach, so a browser's key can't call this.
    /// Deducts first, and the callback restores the amount only if the transfer failed.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        require!(amount.0 > 0, "Enter an amount above 0.");
        require!(env::prepaid_gas() >= MIN_GAS_FOR_WITHDRAW, "Attach at least 10 Tgas to withdraw.");
        let account = env::predecessor_account_id();
        self.debit(&account, amount.0, "withdraw");
        self.flush_balance_events();
        Promise::new(account.clone()).transfer(NearToken::from_yoctonear(amount.0)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_WITHDRAW_CALLBACK)
                .with_unused_gas_weight(0)
                .on_withdraw(account, amount),
        )
    }

    /// Must not panic: this is the only way back for coins from a failed transfer.
    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            return true;
        }
        self.credit(&account_id, amount.0, "withdraw_failed");
        self.flush_balance_events();
        false
    }
}
