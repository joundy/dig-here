//! The Dig Here market. The NFT stays in the game contract, and an owner lists it by approving this account
//! (NEP-178). There's no owner and no admin method. See `README.md` for every method and event.
//!
//! Coins are only ever held for the moment a sale is on its way, plus anything that couldn't reach a deleted
//! account, which `get_totals` shows. The rest of this account's balance is the reserve that pays for its storage.
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
use std::collections::HashMap;

/// The game has 36 NFTs and each has one listing, so this only guards the reserve against a different `nft_contract`.
const MAX_LISTINGS: usize = 36;
const MAX_TOKEN_ID_BYTES: usize = 64;

/// Worst case measured in the sandbox: see `README.md`. Only what's left over after these is ever given to the callback.
const GAS_FOR_NFT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_PAYOUT: Gas = Gas::from_tgas(5);
/// Its own work, plus a transfer and its callback for the seller and another for any excess.
const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(18);
const GAS_FOR_BUY: Gas = Gas::from_tgas(5);
const MIN_GAS_FOR_BUY: Gas = Gas::from_gas(GAS_FOR_BUY.as_gas() + GAS_FOR_NFT_TRANSFER.as_gas() + GAS_FOR_ON_TRANSFER.as_gas());
const GAS_FOR_NFT_TOKEN: Gas = Gas::from_tgas(5);
const GAS_FOR_ON_STALE_CHECK: Gas = Gas::from_tgas(5);
const MIN_GAS_FOR_CLAIM: Gas = Gas::from_tgas(10);

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Prefix {
    Unclaimed,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Sale {
    pub buyer: AccountId,
    /// All the buyer attached, so a failure can return every yocto.
    pub paid: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub token_id: String,
    pub seller: AccountId,
    pub price: u128,
    pub approval_id: u64,
    /// Set before the transfer goes out, so one listing can never be sold twice.
    pub sale: Option<Sale>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    nft_contract: AccountId,
    /// A plain list because it's at most 36 short rows, and the views want a stable order.
    listings: Vec<Listing>,
    /// Coins that couldn't reach a deleted account, waiting for the account to come back.
    unclaimed: LookupMap<AccountId, u128>,
    total_unclaimed: u128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ListingView {
    token_id: String,
    seller: AccountId,
    price: U128,
    approval_id: u64,
    in_progress: bool,
}

impl From<&Listing> for ListingView {
    fn from(l: &Listing) -> Self {
        Self {
            token_id: l.token_id.clone(),
            seller: l.seller.clone(),
            price: U128(l.price),
            approval_id: l.approval_id,
            in_progress: l.sale.is_some(),
        }
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Totals {
    listings: u32,
    in_progress: u32,
    /// Coins of buyers whose sale is on its way.
    held_for_sales: U128,
    unclaimed: U128,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ListingMsg {
    price: U128,
}

/// The two fields of a NEP-171 token that say whether a listing still holds.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct TokenView {
    owner_id: AccountId,
    approved_account_ids: Option<HashMap<AccountId, u64>>,
}

#[allow(dead_code)]
#[ext_contract(ext_nft)]
trait NftContract {
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>);
    fn nft_token(&self, token_id: String) -> Option<near_sdk::serde_json::Value>;
}

#[near(event_json(standard = "dig-here-market"))]
enum MarketEvent<'a> {
    #[event_version("1.0.0")]
    NftListed { token_id: &'a str, seller: &'a AccountId, price: U128, approval_id: u64, replaced: bool },
    #[event_version("1.0.0")]
    NftPriceChanged { token_id: &'a str, seller: &'a AccountId, old_price: U128, price: U128 },
    #[event_version("1.0.0")]
    NftDelisted { token_id: &'a str, seller: &'a AccountId, by: &'a AccountId, reason: &'a str },
    #[event_version("1.0.0")]
    NftSold { token_id: &'a str, seller: &'a AccountId, buyer: &'a AccountId, price: U128, paid: U128, approval_id: u64 },
    #[event_version("1.0.0")]
    NftSaleFailed { token_id: &'a str, seller: &'a AccountId, buyer: &'a AccountId, refund: U128 },
    #[event_version("1.0.0")]
    UnclaimedAdded { account: &'a AccountId, amount: U128, stored: U128, reason: &'a str },
    #[event_version("1.0.0")]
    UnclaimedClaimed { account: &'a AccountId, amount: U128 },
}

/// Reads no more of the answer than it must. All these callbacks care about is whether the call failed.
fn last_promise_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

impl Market {
    fn position(&self, token_id: &str) -> Option<usize> {
        self.listings.iter().position(|l| l.token_id == token_id)
    }

    fn open_listing(&self, token_id: &str) -> usize {
        let at = self.position(token_id).unwrap_or_else(|| env::panic_str("This NFT isn't for sale."));
        require!(self.listings[at].sale.is_none(), "A sale of this NFT is in progress. Try again in a moment.");
        at
    }

    /// The transfer's coins came back to this account, or never left it. The amount pays for its own record, so
    /// nobody can grow this contract's storage for free. An amount too small for that stays in the reserve.
    /// Must not panic: this is the last stop for those coins.
    fn park(&mut self, account: &AccountId, amount: u128, reason: &str) {
        let already = self.unclaimed.get(account);
        let cost = if already.is_some() {
            0
        } else {
            let before = env::storage_usage();
            self.unclaimed.insert(account, &0);
            (env::storage_usage().saturating_sub(before)) as u128 * env::storage_byte_cost().as_yoctonear()
        };
        let stored = amount.saturating_sub(cost);
        if stored == 0 && already.is_none() {
            self.unclaimed.remove(account);
        } else {
            self.unclaimed.insert(account, &(already.unwrap_or(0) + stored));
            self.total_unclaimed += stored;
        }
        MarketEvent::UnclaimedAdded { account, amount: U128(amount), stored: U128(stored), reason }.emit();
    }

    fn pay(&self, to: &AccountId, amount: u128, buyer: &AccountId, reason: &str) {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PAYOUT)
                    .with_unused_gas_weight(0)
                    .on_payout(buyer.clone(), U128(amount), reason.to_string()),
            )
            .detach();
    }
}

#[near]
impl Market {
    /// Private, so nobody can front-run the deploy with a contract of their own.
    #[init]
    #[private]
    pub fn new(nft_contract: AccountId) -> Self {
        Self { nft_contract, listings: Vec::new(), unclaimed: LookupMap::new(Prefix::Unclaimed), total_unclaimed: 0 }
    }

    /// NEP-178. Only the NFT contract can call this, and it says who the owner is, so this can trust `owner_id`.
    /// A panic leaves the approval on the NFT contract with no listing, which is harmless: only a listing moves a token.
    pub fn nft_on_approve(&mut self, token_id: String, owner_id: AccountId, approval_id: u64, msg: String) {
        require!(env::predecessor_account_id() == self.nft_contract, "Only the NFT contract can list here.");
        require!(token_id.len() <= MAX_TOKEN_ID_BYTES, "That token id is too long.");
        let parsed: ListingMsg =
            near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"price\":\"<yocto>\"}."));
        require!(parsed.price.0 > 0, "Set a price above 0.");
        let at = self.position(&token_id);
        if let Some(i) = at {
            require!(self.listings[i].sale.is_none(), "A sale of this NFT is in progress. Try again in a moment.");
        } else {
            require!(self.listings.len() < MAX_LISTINGS, "The market is full.");
        }
        let listing = Listing { token_id: token_id.clone(), seller: owner_id.clone(), price: parsed.price.0, approval_id, sale: None };
        match at {
            Some(i) => self.listings[i] = listing,
            None => self.listings.push(listing),
        }
        MarketEvent::NftListed { token_id: &token_id, seller: &owner_id, price: parsed.price, approval_id, replaced: at.is_some() }.emit();
    }

    /// Payable, at least the price. Anything above it comes back, so what a buyer attaches is the most they can pay.
    /// Answers `true` once sold, or `false` once the transfer failed and the buyer was refunded.
    #[payable]
    pub fn buy(&mut self, token_id: String) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_FOR_BUY, "Attach at least 38 Tgas to buy.");
        let at = self.open_listing(&token_id);
        let buyer = env::predecessor_account_id();
        let paid = env::attached_deposit().as_yoctonear();
        let listing = &mut self.listings[at];
        require!(buyer != listing.seller, "You already own this NFT.");
        require!(paid >= listing.price, "Attach at least the price.");
        listing.sale = Some(Sale { buyer: buyer.clone(), paid });
        let approval_id = listing.approval_id;
        ext_nft::ext(self.nft_contract.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_NFT_TRANSFER)
            .with_unused_gas_weight(0)
            .nft_transfer(buyer, token_id.clone(), Some(approval_id), None)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_ON_TRANSFER).on_transfer(token_id))
    }

    /// Must not panic: nothing else can hand back the buyer's coins. So every lookup that can miss just returns.
    #[private]
    pub fn on_transfer(&mut self, token_id: String) -> bool {
        let Some(at) = self.position(&token_id) else { return false };
        if self.listings[at].sale.is_none() {
            return false;
        }
        let listing = self.listings.remove(at);
        let Some(sale) = listing.sale else { return false };
        let sold = last_promise_succeeded();
        if sold {
            MarketEvent::NftSold {
                token_id: &token_id,
                seller: &listing.seller,
                buyer: &sale.buyer,
                price: U128(listing.price),
                paid: U128(sale.paid),
                approval_id: listing.approval_id,
            }
            .emit();
            self.pay(&listing.seller, listing.price, &sale.buyer, "seller_gone");
            let excess = sale.paid.saturating_sub(listing.price);
            if excess > 0 {
                self.pay(&sale.buyer, excess, &sale.buyer, "buyer_gone");
            }
        } else {
            MarketEvent::NftDelisted { token_id: &token_id, seller: &listing.seller, by: &sale.buyer, reason: "transfer_failed" }.emit();
            MarketEvent::NftSaleFailed { token_id: &token_id, seller: &listing.seller, buyer: &sale.buyer, refund: U128(sale.paid) }.emit();
            self.pay(&sale.buyer, sale.paid, &sale.buyer, "buyer_gone");
        }
        sold
    }

    /// A transfer to a deleted account fails and its coins come back here, so they're parked for the buyer. That's the
    /// price too when a seller is gone: the buyer has the NFT, but there's nobody to pay, and a stranger could claim a
    /// deleted seller's name. Pulled rather than sent, because the coins may not have landed back here yet.
    #[private]
    pub fn on_payout(&mut self, buyer: AccountId, amount: U128, reason: String) {
        if !last_promise_succeeded() {
            self.park(&buyer, amount.0, &reason);
        }
    }

    /// Exactly 1 yocto, seller only.
    #[payable]
    pub fn update_price(&mut self, token_id: String, price: U128) {
        assert_one_yocto();
        require!(price.0 > 0, "Set a price above 0.");
        let at = self.open_listing(&token_id);
        let caller = env::predecessor_account_id();
        let listing = &mut self.listings[at];
        require!(listing.seller == caller, "Only the seller can change the price.");
        let old_price = U128(listing.price);
        listing.price = price.0;
        MarketEvent::NftPriceChanged { token_id: &token_id, seller: &caller, old_price, price }.emit();
    }

    /// The seller, with exactly 1 yocto. Anyone else, if the listing is stale, which this asks the NFT contract and
    /// answers `true` once removed. That needs no yocto, because it can't take anything from anyone.
    #[payable]
    pub fn delist(&mut self, token_id: String) -> PromiseOrValue<bool> {
        let at = self.open_listing(&token_id);
        let caller = env::predecessor_account_id();
        if self.listings[at].seller == caller {
            assert_one_yocto();
            self.listings.remove(at);
            MarketEvent::NftDelisted { token_id: &token_id, seller: &caller, by: &caller, reason: "seller" }.emit();
            return PromiseOrValue::Value(true);
        }
        require!(env::attached_deposit().as_yoctonear() <= 1, "Removing a stale listing costs nothing. Attach at most 1 yocto.");
        let (seller, approval_id) = (self.listings[at].seller.clone(), self.listings[at].approval_id);
        ext_nft::ext(self.nft_contract.clone())
            .with_static_gas(GAS_FOR_NFT_TOKEN)
            .with_unused_gas_weight(0)
            .nft_token(token_id.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_STALE_CHECK)
                    .with_unused_gas_weight(0)
                    .on_stale_check(token_id, seller, approval_id, caller),
            )
            .into()
    }

    /// Compares against the listing the check started from, so a fresh listing made meanwhile survives.
    #[private]
    pub fn on_stale_check(&mut self, token_id: String, seller: AccountId, approval_id: u64, by: AccountId) -> bool {
        let Some(at) = self.position(&token_id) else { return false };
        let listing = &self.listings[at];
        if listing.sale.is_some() || listing.seller != seller || listing.approval_id != approval_id {
            return false;
        }
        // An unreadable answer proves nothing, so it leaves the listing alone. Null means no such token.
        let Ok(bytes) = env::promise_result_checked(0, 16_384) else { return false };
        let Ok(token) = near_sdk::serde_json::from_slice::<Option<TokenView>>(&bytes) else { return false };
        let me = env::current_account_id();
        let holds = token.is_some_and(|t| {
            t.owner_id == seller && t.approved_account_ids.is_some_and(|ids| ids.get(&me) == Some(&approval_id))
        });
        if holds {
            return false;
        }
        self.listings.remove(at);
        MarketEvent::NftDelisted { token_id: &token_id, seller: &seller, by: &by, reason: "stale" }.emit();
        true
    }

    /// The NFT contract says an approval ended, because the token moved or the owner revoked it. Best effort on its
    /// side, so `delist` is still there for anything this misses. A listing with a newer approval isn't this one.
    pub fn nft_on_approval_ended(&mut self, token_id: String, owner_id: AccountId, approval_id: u64) {
        require!(env::predecessor_account_id() == self.nft_contract, "Only the NFT contract can say this.");
        let Some(at) = self.position(&token_id) else { return };
        let listing = &self.listings[at];
        if listing.sale.is_none() && listing.seller == owner_id && listing.approval_id == approval_id {
            self.listings.remove(at);
            let by = env::predecessor_account_id();
            MarketEvent::NftDelisted { token_id: &token_id, seller: &owner_id, by: &by, reason: "stale" }.emit();
        }
    }

    /// Exactly 1 yocto. Sends the caller what's parked for them, and restores it if that fails.
    #[payable]
    pub fn claim_unclaimed(&mut self) -> Promise {
        assert_one_yocto();
        require!(env::prepaid_gas() >= MIN_GAS_FOR_CLAIM, "Attach at least 10 Tgas to claim.");
        let account = env::predecessor_account_id();
        let amount = self.unclaimed.remove(&account).unwrap_or(0);
        require!(amount > 0, "There's nothing to claim.");
        self.total_unclaimed -= amount;
        MarketEvent::UnclaimedClaimed { account: &account, amount: U128(amount) }.emit();
        Promise::new(account.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_PAYOUT)
                .with_unused_gas_weight(0)
                .on_payout(account, U128(amount), "buyer_gone".to_string()),
        )
    }

    pub fn get_listing(&self, token_id: String) -> Option<ListingView> {
        self.position(&token_id).map(|i| ListingView::from(&self.listings[i]))
    }

    pub fn get_listings(&self, from: Option<u32>, limit: Option<u32>) -> Vec<ListingView> {
        let limit = limit.unwrap_or(MAX_LISTINGS as u32).min(MAX_LISTINGS as u32) as usize;
        self.listings.iter().skip(from.unwrap_or(0) as usize).take(limit).map(ListingView::from).collect()
    }

    pub fn get_nft_contract(&self) -> AccountId {
        self.nft_contract.clone()
    }

    pub fn get_unclaimed(&self, account_id: AccountId) -> U128 {
        U128(self.unclaimed.get(&account_id).unwrap_or(0))
    }

    /// What this contract is holding for other people. Its NEAR balance must cover these plus its storage.
    pub fn get_totals(&self) -> Totals {
        let sales = self.listings.iter().filter_map(|l| l.sale.as_ref());
        Totals {
            listings: self.listings.len() as u32,
            in_progress: sales.clone().count() as u32,
            held_for_sales: U128(sales.map(|s| s.paid).sum()),
            unclaimed: U128(self.total_unclaimed),
        }
    }
}
