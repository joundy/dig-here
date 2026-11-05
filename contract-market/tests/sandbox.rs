//! The market and the real game contract together on a local node, plus a stand-in NFT contract for what the real one
//! can't be made to do on demand. Build all three wasm files first: see `README.md`. One test at a time, since each
//! starts a node:
//!   cargo test --test sandbox -- --test-threads=1 --nocapture
use anyhow::Result;
use dig_here::map_data::{is_land, map_index};
use dig_here::rng::{sha256, to_hex};
use futures::future::join_all;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const MILLI: u128 = 1_000_000_000_000_000_000_000;
const MINT_PRICE: u64 = 500;
const BOND: u64 = 100;
const BYTE: u128 = 10_000_000_000_000_000_000;
/// What the README tells the frontend to send.
const BUY_TGAS: u64 = 60;
const LIST_TGAS: u64 = 30;
const LIST_DEPOSIT: u128 = MILLI;
/// `MIN_GAS_FOR_BUY` in the contract.
const MIN_BUY_TGAS: u64 = 38;
const PENGUIN: &str = "snowy:penguin";

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

fn wasm(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|_| panic!("{path} is missing. Build it first: see README.md."))
}

fn market_code() -> Vec<u8> {
    wasm("../contract/target/near/dig_here_market.wasm")
}

struct World {
    worker: Worker<Sandbox>,
    root: Account,
    game: Contract,
    market: Contract,
    oracle: Account,
}

async fn deploy_market(root: &Account, name: &str, nft: &AccountId, balance: NearToken) -> Result<Contract> {
    let account = root.create_subaccount(name).initial_balance(balance).transact().await?.into_result()?;
    let market = account.deploy(&market_code()).await?.into_result()?;
    market.call("new").args_json(json!({ "nft_contract": nft })).transact().await?.into_result()?;
    Ok(market)
}

async fn world() -> Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let game_account = root.create_subaccount("game").initial_balance(near(100)).transact().await?.into_result()?;
    let game = game_account.deploy(&wasm("../contract/target/near/dig_here.wasm")).await?.into_result()?;
    let oracle = root.create_subaccount("oracle").initial_balance(near(10)).transact().await?.into_result()?;
    let treasury = root.create_subaccount("treasury").initial_balance(near(1)).transact().await?.into_result()?;
    game.call("new")
        .args_json(json!({"config": {
            "oracle": oracle.id(), "treasury": treasury.id(), "mint_price": MINT_PRICE, "host_bond": BOND,
            "season_length_sec": 3600, "prize_excluded_suffix": ".bots.test.near",
        }}))
        .transact()
        .await?
        .into_result()?;
    let market = deploy_market(&root, "market", game.id(), near(5)).await?;
    Ok(World { worker, root, game, market, oracle })
}

async fn send(who: &Account, to: &AccountId, method: &str, args: Value, attached: u128, tgas: u64) -> Result<ExecutionFinalResult> {
    Ok(who.call(to, method).args_json(args).deposit(NearToken::from_yoctonear(attached)).gas(Gas::from_tgas(tgas)).transact().await?)
}

fn logged(result: &ExecutionFinalResult) -> Vec<Value> {
    result.logs().iter().filter_map(|l| l.strip_prefix("EVENT_JSON:")).map(|l| serde_json::from_str(l).expect("event is JSON")).collect()
}

fn event<'a>(all: &'a [Value], name: &str) -> &'a Value {
    all.iter().find(|e| e["event"] == name).unwrap_or_else(|| panic!("no {name} event in {all:?}"))
}

/// The call itself failed, as opposed to a receipt further on.
#[track_caller]
fn refused(result: &ExecutionFinalResult, why: &str) {
    assert!(result.is_failure(), "expected this call to fail with: {why}");
    let text = format!("{:?}", result.failures());
    assert!(text.contains(why), "expected {why}, got {text}");
}

/// A sale's outcome shows up in the logs, because `buy` itself returns before any of it happens.
#[track_caller]
fn receipt_failed(result: &ExecutionFinalResult, why: &str) {
    let text = format!("{:?}", result.failures());
    assert!(text.contains(why), "expected {why} among the failures, got {text}");
}

impl World {
    async fn player(&self, name: &str) -> Result<Account> {
        Ok(self.root.create_subaccount(name).initial_balance(near(50)).transact().await?.into_result()?)
    }

    /// The longest legal name under the root, for worst-case numbers.
    async fn long_player(&self, n: usize) -> Result<Account> {
        self.player(&format!("{n:0>54}")).await
    }

    async fn mint(&self, who: &Account, token_id: &str) -> Result<()> {
        send(who, self.game.id(), "mint_nft", json!({ "token_id": token_id }), MINT_PRICE as u128 * MILLI * 2, 30).await?.into_result()?;
        Ok(())
    }

    async fn list(&self, who: &Account, token_id: &str, price: u128) -> Result<ExecutionFinalResult> {
        let msg = json!({ "price": price.to_string() }).to_string();
        send(who, self.game.id(), "nft_approve", json!({"token_id": token_id, "account_id": self.market.id(), "msg": msg}), LIST_DEPOSIT, LIST_TGAS).await
    }

    async fn listed(&self, who: &Account, token_id: &str, price: u128) -> Result<()> {
        let out = self.list(who, token_id, price).await?;
        assert!(out.is_success(), "{:?}", out.failures());
        Ok(())
    }

    async fn buy(&self, who: &Account, token_id: &str, attached: u128) -> Result<ExecutionFinalResult> {
        send(who, self.market.id(), "buy", json!({ "token_id": token_id }), attached, BUY_TGAS).await
    }

    async fn listing(&self, token_id: &str) -> Result<Value> {
        Ok(self.market.view("get_listing").args_json(json!({ "token_id": token_id })).await?.json()?)
    }

    async fn owner(&self, token_id: &str) -> Result<Value> {
        let token: Value = self.game.view("nft_token").args_json(json!({ "token_id": token_id })).await?.json()?;
        Ok(token["owner_id"].clone())
    }

    async fn unclaimed(&self, id: &AccountId) -> Result<u128> {
        let v: String = self.market.view("get_unclaimed").args_json(json!({ "account_id": id })).await?.json()?;
        Ok(v.parse()?)
    }

    /// The market must always hold what it owes plus its storage. Everything in flight has landed by now.
    async fn assert_market_solvent(&self) -> Result<()> {
        assert_contract_solvent(&self.market).await
    }

    /// The game's own coins aren't touched by any of this.
    async fn assert_game_solvent(&self) -> Result<()> {
        let totals: Value = self.game.view("get_totals").await?.json()?;
        let owed: u128 = totals["balances"].as_str().unwrap().parse::<u128>()?
            + (totals["held"].as_u64().unwrap() + totals["jackpot"].as_u64().unwrap() + totals["season_pool"].as_u64().unwrap()) as u128 * MILLI;
        let account = self.game.view_account().await?;
        let storage = account.storage_usage as u128 * BYTE;
        assert!(account.balance.as_yoctonear() >= owed + storage);
        Ok(())
    }

    /// Lets the gas refunds of earlier calls land, so a wallet comparison is about the coins of this one.
    async fn settle(&self) -> Result<()> {
        self.worker.fast_forward(4).await?;
        Ok(())
    }
}

async fn assert_contract_solvent(market: &Contract) -> Result<()> {
    let totals: Value = market.view("get_totals").await?.json()?;
    let owed: u128 = totals["held_for_sales"].as_str().unwrap().parse::<u128>()? + totals["unclaimed"].as_str().unwrap().parse::<u128>()?;
    let account = market.view_account().await?;
    let storage = account.storage_usage as u128 * BYTE;
    assert!(account.balance.as_yoctonear() >= owed + storage, "holding {}, owed {owed}, storage {storage}", account.balance.as_yoctonear());
    Ok(())
}

async fn wallet(who: &Account) -> Result<u128> {
    Ok(who.view_account().await?.balance.as_yoctonear())
}

/// A wallet's change, give or take gas. `close` is how far it may fall short of `expected`.
#[track_caller]
fn about(before: u128, after: u128, expected_gain: i128, slack: u128) {
    let change = after as i128 - before as i128;
    assert!(
        change <= expected_gain + slack as i128 && change >= expected_gain - slack as i128,
        "wallet moved {change}, expected about {expected_gain}, within {slack}"
    );
}

/// Well above any gas in these tests, far below any price or refund they check.
const GAS_SLACK: u128 = 30 * MILLI;

fn tgas_of(result: &ExecutionFinalResult, method_note: &str) {
    let total: u64 = result.total_gas_burnt.as_gas() / 1_000_000_000;
    let receipts: Vec<String> = result
        .receipt_outcomes()
        .iter()
        .map(|o| format!("{}={:.2}", o.executor_id, o.gas_burnt.as_gas() as f64 / 1e12))
        .collect();
    println!("{method_note}: {:.3} Tgas in all [{}]", total as f64 / 1000.0, receipts.join(", "));
}

#[tokio::test]
async fn a_sale_from_mint_to_paid_seller_with_the_real_game() -> Result<()> {
    let w = world().await?;
    let alice = w.player("alice").await?;
    let bob = w.player("bob").await?;
    let carol = w.player("carol").await?;
    w.mint(&alice, PENGUIN).await?;
    let price = 100 * MILLI;

    // Listing, with exactly the JSON, gas and deposit the README gives. The deposit's unused part comes straight back.
    w.settle().await?;
    let before = wallet(&alice).await?;
    let listed = w.list(&alice, PENGUIN, price).await?;
    assert!(listed.is_success(), "{:?}", listed.failures());
    tgas_of(&listed, "nft_approve with msg, first");
    w.settle().await?;
    about(before, wallet(&alice).await?, -((w.market.id().as_str().len() as i128 + 12) * BYTE as i128), GAS_SLACK);
    let all = logged(&listed);
    let e = event(&all, "nft_listed");
    assert_eq!(e["standard"], "dig-here-market");
    assert_eq!(e["version"], "1.0.0");
    assert_eq!(e["data"]["token_id"], PENGUIN);
    assert_eq!(e["data"]["seller"], alice.id().as_str());
    assert_eq!(e["data"]["price"], price.to_string());
    assert_eq!(e["data"]["replaced"], false);
    let view = w.listing(PENGUIN).await?;
    assert_eq!(view, json!({"token_id": PENGUIN, "seller": alice.id(), "price": price.to_string(), "approval_id": 1, "in_progress": false}));
    let rows: Vec<Value> = w.market.view("get_listings").args_json(json!({"from": 0, "limit": 36})).await?.json()?;
    assert_eq!(rows, vec![view.clone()]);
    assert_eq!(w.market.view("get_listings").args_json(json!({})).await?.json::<Vec<Value>>()?.len(), 1, "from and limit are optional");
    assert!(w.market.view("get_listings").args_json(json!({"from": 1, "limit": 36})).await?.json::<Vec<Value>>()?.is_empty());
    assert!(w.listing("snowy:seal").await?.is_null());
    assert_eq!(w.market.view("get_nft_contract").await?.json::<String>()?, w.game.id().as_str());

    // Changing the price needs the yocto, and only the seller can.
    refused(&send(&alice, w.market.id(), "update_price", json!({"token_id": PENGUIN, "price": "1"}), 0, 10).await?, "Requires attached deposit of exactly 1 yoctoNEAR");
    refused(&send(&bob, w.market.id(), "update_price", json!({"token_id": PENGUIN, "price": "1"}), 1, 10).await?, "Only the seller");
    refused(&send(&alice, w.market.id(), "update_price", json!({"token_id": PENGUIN, "price": "0"}), 1, 10).await?, "above 0");
    let changed = send(&alice, w.market.id(), "update_price", json!({"token_id": PENGUIN, "price": (price * 2).to_string()}), 1, 10).await?;
    assert!(changed.is_success(), "{:?}", changed.failures());
    tgas_of(&changed, "update_price");
    let all = logged(&changed);
    assert_eq!(event(&all, "nft_price_changed")["data"]["old_price"], price.to_string());
    assert_eq!(event(&all, "nft_price_changed")["data"]["price"], (price * 2).to_string());

    // A re-approval replaces the listing, and the old approval id is gone with it.
    let again = w.list(&alice, PENGUIN, price).await?;
    assert!(again.is_success(), "{:?}", again.failures());
    tgas_of(&again, "nft_approve with msg, replacing");
    assert_eq!(event(&logged(&again), "nft_listed")["data"]["replaced"], true);
    let view = w.listing(PENGUIN).await?;
    assert_eq!(view["approval_id"], 2);
    assert_eq!(view["price"], price.to_string());

    // A buyer with no game record pays more than the price, and gets the rest back.
    let excess = 7 * MILLI;
    w.settle().await?;
    let (seller_before, buyer_before) = (wallet(&alice).await?, wallet(&bob).await?);
    let bought = w.buy(&bob, PENGUIN, price + excess).await?;
    assert!(bought.is_success(), "{:?}", bought.failures());
    tgas_of(&bought, "buy");
    let all = logged(&bought);
    assert_eq!(bought.clone().json::<bool>()?, true);
    w.settle().await?;
    let approval_back = (w.market.id().as_str().len() as u128 + 12) * BYTE;
    assert_eq!(wallet(&alice).await? - seller_before, price + approval_back, "the seller's wallet got the price and the approval's deposit, to the yocto");
    about(buyer_before, wallet(&bob).await?, -(price as i128), GAS_SLACK);
    assert_eq!(w.owner(PENGUIN).await?, bob.id().as_str());
    assert!(w.listing(PENGUIN).await?.is_null());
    let sold = &event(&all, "nft_sold")["data"];
    assert_eq!(sold["seller"], alice.id().as_str());
    assert_eq!(sold["buyer"], bob.id().as_str());
    assert_eq!(sold["price"], price.to_string());
    assert_eq!(sold["paid"], (price + excess).to_string());
    assert!(bought.logs().iter().any(|l| l.contains("nep171") && l.contains("nft_transfer")));
    let record: Value = w.game.view("get_account").args_json(json!({"id": bob.id()})).await?.json()?;
    assert!(record.is_null(), "buying makes no game record");
    assert_eq!(w.unclaimed(bob.id()).await?, 0);

    // The approval is gone with the sale, so the market can't move it again, and the sold listing can't be bought.
    let token: Value = w.game.view("nft_token").args_json(json!({"token_id": PENGUIN})).await?.json()?;
    assert_eq!(token["approved_account_ids"], json!({}));
    refused(&w.buy(&carol, PENGUIN, price).await?, "isn't for sale");

    // The new owner can sell it on straight away, and it pays them.
    w.listed(&bob, PENGUIN, price * 3).await?;
    let bought = w.buy(&carol, PENGUIN, price * 3).await?;
    assert!(bought.is_success(), "{:?}", bought.failures());
    assert_eq!(w.owner(PENGUIN).await?, carol.id().as_str());
    assert_eq!(event(&logged(&bought), "nft_sold")["data"]["seller"], bob.id().as_str());

    // The seller takes it off the market, and only with the yocto.
    w.listed(&carol, PENGUIN, price).await?;
    refused(&send(&carol, w.market.id(), "delist", json!({"token_id": PENGUIN}), 0, 10).await?, "exactly 1 yoctoNEAR");
    let off = send(&carol, w.market.id(), "delist", json!({"token_id": PENGUIN}), 1, 10).await?;
    assert!(off.is_success(), "{:?}", off.failures());
    tgas_of(&off, "delist by the seller");
    let all = logged(&off);
    assert_eq!(off.json::<bool>()?, true);
    assert_eq!(event(&all, "nft_delisted")["data"]["reason"], "seller");
    assert!(w.listing(PENGUIN).await?.is_null());
    refused(&send(&carol, w.market.id(), "delist", json!({"token_id": PENGUIN}), 1, 10).await?, "isn't for sale");
    w.assert_market_solvent().await?;
    w.assert_game_solvent().await
}

/// Each way `buy` can be turned down before anything moves. All of them give back what was attached.
#[tokio::test]
async fn buy_refuses_with_everything_returned() -> Result<()> {
    let w = world().await?;
    let alice = w.player("alice").await?;
    let bob = w.player("bob").await?;
    w.mint(&alice, PENGUIN).await?;
    let price = 100 * MILLI;

    w.settle().await?;
    let before = wallet(&bob).await?;
    refused(&w.buy(&bob, PENGUIN, price).await?, "isn't for sale");
    w.listed(&alice, PENGUIN, price).await?;
    refused(&w.buy(&bob, PENGUIN, price - 1).await?, "at least the price");
    refused(&w.buy(&bob, PENGUIN, 0).await?, "at least the price");
    refused(&w.buy(&alice, PENGUIN, price).await?, "already own");
    for tgas in [1, 10, MIN_BUY_TGAS - 1] {
        refused(&send(&bob, w.market.id(), "buy", json!({"token_id": PENGUIN}), price, tgas).await?, "Attach at least");
    }
    w.settle().await?;
    about(before, wallet(&bob).await?, 0, GAS_SLACK);
    assert_eq!(w.listing(PENGUIN).await?["in_progress"], false);
    assert_eq!(w.owner(PENGUIN).await?, alice.id().as_str());

    // A function-call key can't reach the market's paying methods, because the node refuses its deposit.
    let key = SecretKey::from_random(KeyType::ED25519);
    bob.batch(bob.id()).add_key(key.public_key(), AccessKey::function_call_access(w.market.id(), &[], Some(near(1)))).transact().await?.into_result()?;
    let limited = Account::from_secret_key(bob.id().clone(), key, &w.worker);
    let out = limited.call(w.market.id(), "buy").args_json(json!({"token_id": PENGUIN})).deposit(NearToken::from_yoctonear(price)).gas(Gas::from_tgas(BUY_TGAS)).transact().await;
    assert!(format!("{out:?}").contains("Deposit") || out.is_err(), "{out:?}");
    w.assert_market_solvent().await
}

/// Two buyers in the same moment: the listing is marked before any promise, so one sale happens and the other is refused.
#[tokio::test]
async fn a_listing_cannot_be_bought_twice() -> Result<()> {
    let w = world().await?;
    let alice = w.player("alice").await?;
    let buyers = vec![w.player("bob").await?, w.player("carol").await?, w.player("dave").await?];
    w.mint(&alice, PENGUIN).await?;
    let price = 100 * MILLI;
    w.listed(&alice, PENGUIN, price).await?;
    w.settle().await?;
    let seller_before = wallet(&alice).await?;
    let wallets_before = join_all(buyers.iter().map(wallet)).await;
    let all = join_all(buyers.iter().map(|b| w.buy(b, PENGUIN, price))).await;
    let mut sold = 0;
    for out in all {
        let out = out?;
        if out.is_success() && out.logs().iter().any(|l| l.contains("nft_sold")) {
            sold += 1;
        } else {
            let text = format!("{:?}", out.failures());
            assert!(text.contains("in progress") || text.contains("isn't for sale"), "{text}");
        }
    }
    assert_eq!(sold, 1, "exactly one sale");
    w.settle().await?;
    let approval_back = (w.market.id().as_str().len() as u128 + 12) * BYTE;
    assert_eq!(wallet(&alice).await? - seller_before, price + approval_back, "the seller is paid once");
    let owner = w.owner(PENGUIN).await?;
    for (buyer, before) in buyers.iter().zip(wallets_before) {
        let gained = if owner == buyer.id().as_str() { -(price as i128) } else { 0 };
        about(before?, wallet(buyer).await?, gained, GAS_SLACK);
    }
    w.assert_market_solvent().await
}

/// While a sale is on its way nothing else may touch its listing. The stand-in's slow chain keeps one open long enough.
#[tokio::test]
async fn a_sale_in_flight_blocks_every_other_change() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let nft = root.create_subaccount("nft").initial_balance(near(10)).transact().await?.into_result()?;
    let mock = nft.deploy(&wasm("../contract/target/near-mock/mock_nft.wasm")).await?.into_result()?;
    mock.call("new").args_json(json!({})).transact().await?.into_result()?;
    let market = deploy_market(&root, "market", mock.id(), near(5)).await?;
    let seller = root.create_subaccount("seller").initial_balance(near(10)).transact().await?.into_result()?;
    let buyer = root.create_subaccount("buyer").initial_balance(near(10)).transact().await?.into_result()?;
    let other = root.create_subaccount("other").initial_balance(near(10)).transact().await?.into_result()?;
    let price = 100 * MILLI;
    let msg = json!({ "price": price.to_string() }).to_string();
    let list = || {
        root.call(mock.id(), "list")
            .args_json(json!({"market": market.id(), "token_id": "a", "owner_id": seller.id(), "msg": msg}))
            .gas(Gas::from_tgas(100))
            .transact()
    };
    list().await?.into_result()?;
    root.call(mock.id(), "set_mode").args_json(json!({ "mode": "hold" })).transact().await?.into_result()?;

    let buying = buyer.call(market.id(), "buy").args_json(json!({"token_id": "a"})).deposit(NearToken::from_yoctonear(price)).gas(Gas::from_tgas(BUY_TGAS)).transact_async().await?;
    for _ in 0..60 {
        let view: Value = market.view("get_listing").args_json(json!({"token_id": "a"})).await?.json()?;
        if view["in_progress"] == true {
            break;
        }
        worker.fast_forward(1).await?;
    }
    let view: Value = market.view("get_listing").args_json(json!({"token_id": "a"})).await?.json()?;
    assert_eq!(view["in_progress"], true);
    let totals: Value = market.view("get_totals").await?.json()?;
    assert_eq!(totals["in_progress"], 1);
    assert_eq!(totals["held_for_sales"], price.to_string());
    let (a, b, c, d, e) = futures::join!(
        send(&seller, market.id(), "update_price", json!({"token_id": "a", "price": "5"}), 1, 10),
        send(&seller, market.id(), "delist", json!({"token_id": "a"}), 1, 10),
        send(&other, market.id(), "buy", json!({"token_id": "a"}), price, BUY_TGAS),
        send(&other, market.id(), "delist", json!({"token_id": "a"}), 0, 30),
        list(),
    );
    for out in [a?, b?, c?, d?, e?] {
        let text = format!("{:?}", out.failures());
        assert!(text.contains("in progress"), "{text}");
    }
    let view: Value = market.view("get_listing").args_json(json!({"token_id": "a"})).await?.json()?;
    assert_eq!(view["price"], price.to_string(), "nothing moved");
    root.call(mock.id(), "release").args_json(json!({})).transact().await?.into_result()?;
    let done = finished(&buying, &worker).await?;
    assert_eq!(done.json::<bool>()?, true);
    let view: Value = market.view("get_listing").args_json(json!({"token_id": "a"})).await?.json()?;
    assert!(view.is_null());
    let totals: Value = market.view("get_totals").await?.json()?;
    assert_eq!(totals["held_for_sales"], "0");
    assert_contract_solvent(&market).await
}

/// `status` answers as soon as it has an outcome, which can be before the last receipts ran. Those land in a few blocks.
async fn finished(tx: &near_workspaces::operations::TransactionStatus, worker: &Worker<Sandbox>) -> Result<ExecutionFinalResult> {
    while tx.status().await?.is_pending() {}
    worker.fast_forward(6).await?;
    match tx.status().await? {
        std::task::Poll::Ready(result) => Ok(result),
        std::task::Poll::Pending => anyhow::bail!("the transaction went back to pending"),
    }
}

/// The listing outlives its approval in three ways that the notice misses: a transfer or revoke with too little gas
/// left for a notice, and an approval replaced without a `msg`. Each buy is refunded in full and removes the listing.
#[tokio::test]
async fn a_failed_transfer_refunds_in_full_and_removes_the_listing() -> Result<()> {
    let w = world().await?;
    let alice = w.player("alice").await?;
    let bob = w.player("bob").await?;
    let carol = w.player("carol").await?;
    let price = 100 * MILLI;
    let attached = price + 3 * MILLI;

    // These fall short of the notice's own gas, which is what lets the listing live on here.
    let quiet = 6;
    let tokens = ["snowy:penguin", "snowy:seal", "snowy:igloo"];
    for t in tokens {
        w.mint(&alice, t).await?;
        w.listed(&alice, t, price).await?;
    }

    // The owner moved it.
    send(&alice, w.game.id(), "nft_transfer", json!({"receiver_id": carol.id(), "token_id": tokens[0]}), 1, quiet).await?.into_result()?;
    assert_eq!(w.listing(tokens[0]).await?["seller"], alice.id().as_str(), "the stale listing lives on");
    // The owner revoked it.
    send(&alice, w.game.id(), "nft_revoke", json!({"token_id": tokens[1], "account_id": w.market.id()}), 1, quiet).await?.into_result()?;
    assert!(!w.listing(tokens[1]).await?.is_null());
    // The owner replaced the approval and gave no msg, so the market's approval id is out of date.
    send(&alice, w.game.id(), "nft_approve", json!({"token_id": tokens[2], "account_id": w.market.id()}), LIST_DEPOSIT, LIST_TGAS).await?.into_result()?;
    assert!(!w.listing(tokens[2]).await?.is_null());

    for (i, t) in tokens.iter().enumerate() {
        w.settle().await?;
        let before = wallet(&bob).await?;
        let seller_before = wallet(&alice).await?;
        let out = w.buy(&bob, t, attached).await?;
        tgas_of(&out, "buy, transfer fails");
        let all = logged(&out);
        receipt_failed(&out, if i == 2 { "different from the given approval_id" } else { "Sender not approved" });
        assert_eq!(out.json::<bool>()?, false, "buy answers that it didn't happen");
        assert_eq!(event(&all, "nft_sale_failed")["data"]["refund"], attached.to_string());
        assert_eq!(event(&all, "nft_delisted")["data"]["reason"], "transfer_failed");
        w.settle().await?;
        about(before, wallet(&bob).await?, 0, GAS_SLACK);
        assert_eq!(wallet(&alice).await?, seller_before, "nobody was paid");
        assert!(w.listing(t).await?.is_null());
        assert_ne!(w.owner(t).await?, bob.id().as_str());
        assert_eq!(w.unclaimed(bob.id()).await?, 0);
    }
    let totals: Value = w.market.view("get_totals").await?.json()?;
    assert_eq!(totals["held_for_sales"], "0");
    w.assert_market_solvent().await
}

/// What the real contract can't be made to do: a transfer that panics, and one that burns every bit of its gas. At the
/// minimum gas `buy` accepts, which is the least the callback can ever be left with.
#[tokio::test]
async fn no_gas_left_in_the_transfer_still_refunds() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let nft = root.create_subaccount("nft").initial_balance(near(10)).transact().await?.into_result()?;
    let mock = nft.deploy(&wasm("../contract/target/near-mock/mock_nft.wasm")).await?.into_result()?;
    mock.call("new").args_json(json!({})).transact().await?.into_result()?;
    let market = deploy_market(&root, "market", mock.id(), near(5)).await?;
    let seller = root.create_subaccount("seller").initial_balance(near(10)).transact().await?.into_result()?;
    let buyer = root.create_subaccount("buyer").initial_balance(near(50)).transact().await?.into_result()?;
    let price = 100 * MILLI;
    let msg = json!({ "price": price.to_string() }).to_string();
    let list = |token: &'static str| {
        root.call(mock.id(), "list")
            .args_json(json!({"market": market.id(), "token_id": token, "owner_id": seller.id(), "msg": msg}))
            .gas(Gas::from_tgas(100))
            .transact()
    };

    for (mode, token, tgas) in [("panic", "a", MIN_BUY_TGAS), ("burn", "b", MIN_BUY_TGAS), ("burn", "c", BUY_TGAS), ("burn", "d", 300)] {
        root.call(mock.id(), "set_mode").args_json(json!({ "mode": mode })).transact().await?.into_result()?;
        list(token).await?.into_result()?;
        worker.fast_forward(4).await?;
        let (before, seller_before) = (wallet(&buyer).await?, wallet(&seller).await?);
        let out = send(&buyer, market.id(), "buy", json!({"token_id": token}), price, tgas).await?;
        tgas_of(&out, &format!("buy with {tgas} Tgas, the transfer does: {mode}"));
        let text = format!("{:?}", out.failures());
        assert!(text.contains(if mode == "panic" { "this transfer fails" } else { "Exceeded the prepaid gas" }), "{text}");
        let all = logged(&out);
        assert_eq!(event(&all, "nft_sale_failed")["data"]["refund"], price.to_string());
        worker.fast_forward(4).await?;
        about(before, wallet(&buyer).await?, 0, GAS_SLACK * 2);
        assert_eq!(wallet(&seller).await?, seller_before);
        let view: Value = market.view("get_listing").args_json(json!({"token_id": token})).await?.json()?;
        assert!(view.is_null());
    }
    assert_contract_solvent(&market).await
}

/// A sale can't be undone once the token moved, so coins that can't reach the seller go to the buyer, to claim.
#[tokio::test]
async fn a_deleted_seller_leaves_the_buyer_with_the_nft_and_the_coins() -> Result<()> {
    let w = world().await?;
    let seller = w.player("seller").await?;
    let bob = w.player("bob").await?;
    let beneficiary = w.player("beneficiary").await?;
    w.mint(&seller, PENGUIN).await?;
    let price = 100 * MILLI;
    w.listed(&seller, PENGUIN, price).await?;
    seller.clone().delete_account(beneficiary.id()).await?.into_result()?;

    w.settle().await?;
    let before = wallet(&bob).await?;
    let out = w.buy(&bob, PENGUIN, price + 2 * MILLI).await?;
    tgas_of(&out, "buy, deleted seller");
    assert_eq!(w.owner(PENGUIN).await?, bob.id().as_str());
    receipt_failed(&out, "AccountDoesNotExist");
    let all = logged(&out);
    assert_eq!(event(&all, "nft_sold")["data"]["seller"], seller.id().as_str());
    let added = &event(&all, "unclaimed_added")["data"];
    assert_eq!(added["reason"], "seller_gone");
    assert_eq!(added["amount"], price.to_string());
    let bytes: u128 = 1 + 4 + bob.id().as_str().len() as u128 + 16 + 40;
    let stored = price - bytes * BYTE;
    assert_eq!(added["stored"], stored.to_string(), "the record pays for itself");
    assert_eq!(w.unclaimed(bob.id()).await?, stored);
    w.settle().await?;
    about(before, wallet(&bob).await?, -(price as i128), GAS_SLACK);
    let totals: Value = w.market.view("get_totals").await?.json()?;
    assert_eq!(totals["unclaimed"], stored.to_string());
    w.assert_market_solvent().await?;

    // Only they can claim it, only with the yocto, and only once.
    refused(&send(&w.root, w.market.id(), "claim_unclaimed", json!({}), 1, 30).await?, "nothing to claim");
    refused(&send(&bob, w.market.id(), "claim_unclaimed", json!({}), 0, 30).await?, "exactly 1 yoctoNEAR");
    refused(&send(&bob, w.market.id(), "claim_unclaimed", json!({}), 1, 5).await?, "at least 10 Tgas");
    w.settle().await?;
    let before = wallet(&bob).await?;
    let claimed = send(&bob, w.market.id(), "claim_unclaimed", json!({}), 1, 30).await?;
    assert!(claimed.is_success(), "{:?}", claimed.failures());
    tgas_of(&claimed, "claim_unclaimed");
    w.settle().await?;
    about(before, wallet(&bob).await?, stored as i128, GAS_SLACK);
    assert_eq!(w.unclaimed(bob.id()).await?, 0);
    refused(&send(&bob, w.market.id(), "claim_unclaimed", json!({}), 1, 30).await?, "nothing to claim");
    let totals: Value = w.market.view("get_totals").await?.json()?;
    assert_eq!(totals["unclaimed"], "0");
    w.assert_market_solvent().await
}

/// Deleted while their buy is on its way. There's no way to pay them, so the coins wait, and they can be claimed if the
/// account comes back. Sent with a slow stale path so the deletion lands first.
#[tokio::test]
async fn a_deleted_buyer_loses_nothing_that_can_be_kept_for_them() -> Result<()> {
    let w = world().await?;
    let alice = w.player("alice").await?;
    let beneficiary = w.player("beneficiary").await?;
    let price = 100 * MILLI;
    let t = ["snowy:penguin", "snowy:seal", "snowy:igloo", "snowy:pine"];
    for token in t {
        w.mint(&alice, token).await?;
    }

    /// `buy` from an account deleted straight after sending it. Returns the outcome of the buy.
    async fn buy_then_vanish(w: &World, buyer: &Account, beneficiary: &Account, token: &str, attached: u128) -> Result<ExecutionFinalResult> {
        let buying = buyer
            .call(w.market.id(), "buy")
            .args_json(json!({ "token_id": token }))
            .deposit(NearToken::from_yoctonear(attached))
            .gas(Gas::from_tgas(BUY_TGAS))
            .transact_async()
            .await?;
        buyer.clone().delete_account(beneficiary.id()).await?.into_result()?;
        finished(&buying, &w.worker).await
    }

    // A successful sale with excess: the seller is paid, the token is theirs, and the excess waits.
    let buyer = w.player("gone-after-success").await?;
    w.listed(&alice, t[0], price).await?;
    w.settle().await?;
    let seller_before = wallet(&alice).await?;
    let out = buy_then_vanish(&w, &buyer, &beneficiary, t[0], price + 5 * MILLI).await?;
    w.settle().await?;
    assert!(buyer.view_account().await.is_err(), "the buyer really is gone");
    assert_eq!(w.owner(t[0]).await?, buyer.id().as_str());
    assert_eq!(wallet(&alice).await? - seller_before, price + (w.market.id().as_str().len() as u128 + 12) * BYTE);
    let all = logged(&out);
    assert_eq!(event(&all, "unclaimed_added")["data"]["reason"], "buyer_gone");
    assert_eq!(w.unclaimed(buyer.id()).await?, 5 * MILLI - (1 + 4 + buyer.id().as_str().len() as u128 + 16 + 40) * BYTE);
    w.assert_market_solvent().await?;

    // A failed transfer: the whole amount waits.
    let buyer = w.player("gone-after-failure").await?;
    w.listed(&alice, t[1], price).await?;
    send(&alice, w.game.id(), "nft_revoke", json!({"token_id": t[1], "account_id": w.market.id()}), 1, 6).await?.into_result()?;
    let out = buy_then_vanish(&w, &buyer, &beneficiary, t[1], price).await?;
    w.settle().await?;
    assert!(buyer.view_account().await.is_err());
    receipt_failed(&out, "Sender not approved");
    let all = logged(&out);
    assert_eq!(event(&all, "nft_sale_failed")["data"]["refund"], price.to_string());
    assert_eq!(event(&all, "unclaimed_added")["data"]["amount"], price.to_string());
    let waiting = price - (1 + 4 + buyer.id().as_str().len() as u128 + 16 + 40) * BYTE;
    assert_eq!(w.unclaimed(buyer.id()).await?, waiting);
    assert!(w.listing(t[1]).await?.is_null());
    w.assert_market_solvent().await?;

    // The account comes back and collects, which proves nothing was stranded.
    let returned = w.root.create_subaccount("gone-after-failure").initial_balance(near(1)).transact().await?.into_result()?;
    w.settle().await?;
    let before = wallet(&returned).await?;
    send(&returned, w.market.id(), "claim_unclaimed", json!({}), 1, 30).await?.into_result()?;
    w.settle().await?;
    about(before, wallet(&returned).await?, waiting as i128, GAS_SLACK);

    // Seller and buyer both gone: the price waits for the buyer, whose NFT is theirs.
    let short_lived = w.player("short-lived-seller").await?;
    w.mint(&short_lived, "desert:cactus").await?;
    w.listed(&short_lived, "desert:cactus", price).await?;
    short_lived.clone().delete_account(beneficiary.id()).await?.into_result()?;
    let buyer = w.player("gone-as-well").await?;
    let out = buy_then_vanish(&w, &buyer, &beneficiary, "desert:cactus", price).await?;
    w.settle().await?;
    assert_eq!(event(&logged(&out), "unclaimed_added")["data"]["reason"], "seller_gone");
    assert_eq!(w.unclaimed(buyer.id()).await?, price - (1 + 4 + buyer.id().as_str().len() as u128 + 16 + 40) * BYTE);
    w.assert_market_solvent().await?;

    // An amount too small to pay for its own record stays in the reserve, and grows nothing.
    let tiny_seller = w.player("tiny-seller").await?;
    w.mint(&tiny_seller, "desert:well").await?;
    w.listed(&tiny_seller, "desert:well", 1000).await?;
    tiny_seller.clone().delete_account(beneficiary.id()).await?.into_result()?;
    let tiny_buyer = w.player("tiny-buyer").await?;
    let storage_before = w.market.view_account().await?.storage_usage;
    let out = w.buy(&tiny_buyer, "desert:well", 1000).await?;
    assert_eq!(event(&logged(&out), "unclaimed_added")["data"]["stored"], "0");
    assert_eq!(w.unclaimed(tiny_buyer.id()).await?, 0);
    w.settle().await?;
    assert!(w.market.view_account().await?.storage_usage <= storage_before);
    w.assert_market_solvent().await
}

/// The game tells the market when an approval ends, so the market's own view stops offering the listing.
#[tokio::test]
async fn a_stale_listing_is_dropped_by_notice_or_removed_by_anyone() -> Result<()> {
    let w = world().await?;
    let alice = w.player("alice").await?;
    let bob = w.player("bob").await?;
    let price = 100 * MILLI;
    let t = ["snowy:penguin", "snowy:seal", "snowy:igloo", "snowy:pine", "tropical:cow"];
    for token in t {
        w.mint(&alice, token).await?;
        w.listed(&alice, token, price).await?;
    }

    // A normal transfer: the notice removes it. The notice is a plain receipt of the same transaction.
    let moved = send(&alice, w.game.id(), "nft_transfer", json!({"receiver_id": bob.id(), "token_id": t[0]}), 1, 30).await?;
    assert!(moved.is_success(), "{:?}", moved.failures());
    tgas_of(&moved, "nft_transfer, with a notice");
    assert!(w.listing(t[0]).await?.is_null());
    assert_eq!(event(&logged(&moved), "nft_delisted")["data"]["reason"], "stale");
    // A revoke, and a revoke of them all.
    let revoked = send(&alice, w.game.id(), "nft_revoke", json!({"token_id": t[1], "account_id": w.market.id()}), 1, 30).await?;
    assert!(revoked.is_success(), "{:?}", revoked.failures());
    assert!(w.listing(t[1]).await?.is_null());
    let revoked = send(&alice, w.game.id(), "nft_revoke_all", json!({"token_id": t[2]}), 1, 30).await?;
    assert!(revoked.is_success(), "{:?}", revoked.failures());
    assert!(w.listing(t[2]).await?.is_null());

    // A fresh listing with a newer approval isn't touched by an old notice, which only the game can send anyway.
    let no = send(&alice, w.market.id(), "nft_on_approval_ended", json!({"token_id": t[3], "owner_id": alice.id(), "approval_id": 1}), 0, 10).await?;
    refused(&no, "Only the NFT contract");
    assert!(!w.listing(t[3]).await?.is_null());

    // Anyone can remove a stale listing, but not a good one. Too little gas for the notice leaves one behind.
    assert_eq!(send(&bob, w.market.id(), "delist", json!({"token_id": t[3]}), 0, 30).await?.into_result()?.json::<bool>()?, false);
    assert!(!w.listing(t[3]).await?.is_null(), "a good listing stays");
    send(&alice, w.game.id(), "nft_transfer", json!({"receiver_id": bob.id(), "token_id": t[3]}), 1, 6).await?.into_result()?;
    assert_eq!(w.listing(t[3]).await?["seller"], alice.id().as_str(), "this one was left behind");
    let removed = send(&w.root, w.market.id(), "delist", json!({"token_id": t[3]}), 0, 30).await?;
    assert!(removed.is_success(), "{:?}", removed.failures());
    tgas_of(&removed, "delist of a stale listing by anyone");
    assert_eq!(event(&logged(&removed), "nft_delisted")["data"]["reason"], "stale");
    assert_eq!(removed.json::<bool>()?, true);
    assert!(w.listing(t[3]).await?.is_null());

    // An owner who revokes and re-lists keeps the new listing, which a stale check from before must not remove.
    let check_gas = 30;
    w.listed(&alice, t[4], price).await?;
    let (first, second) = futures::join!(
        send(&bob, w.market.id(), "delist", json!({"token_id": t[4]}), 0, check_gas),
        w.list(&alice, t[4], price * 2),
    );
    assert!(first?.is_success());
    assert!(second?.is_success());
    assert_eq!(w.listing(t[4]).await?["price"], (price * 2).to_string(), "the re-listing stands");

    // Only the NFT contract can list, and the callbacks are private.
    let forged = send(&bob, w.market.id(), "nft_on_approve", json!({"token_id": t[0], "owner_id": bob.id(), "approval_id": 9, "msg": "{\"price\":\"1\"}"}), 0, 10).await?;
    refused(&forged, "Only the NFT contract");
    for (method, args) in [
        ("on_transfer", json!({"token_id": t[4]})),
        ("on_payout", json!({"buyer": bob.id(), "amount": "1", "reason": "x"})),
        ("on_stale_check", json!({"token_id": t[4], "seller": alice.id(), "approval_id": 1, "by": bob.id()})),
    ] {
        refused(&send(&bob, w.market.id(), method, args, 0, 10).await?, "is private");
    }
    // The contract's own `new` can't run twice or for a stranger.
    refused(&send(&bob, w.market.id(), "new", json!({"nft_contract": bob.id()}), 0, 10).await?, "private");
    // A malformed message: the approval is recorded, the listing isn't.
    for bad in ["not json", "{\"price\":1}", "{}", "{\"price\":\"0\"}", "{\"price\":\"x\"}"] {
        let out = send(&alice, w.game.id(), "nft_approve", json!({"token_id": t[3].replace("pine", "seal"), "account_id": w.market.id(), "msg": bad}), LIST_DEPOSIT, LIST_TGAS).await?;
        assert!(out.is_failure() || !out.failures().is_empty(), "{bad}");
    }
    w.assert_market_solvent().await
}

/// A stand-in NFT contract answers the stale check in ways the real one won't.
#[tokio::test]
async fn an_answer_that_proves_nothing_leaves_the_listing_alone() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let nft = root.create_subaccount("nft").initial_balance(near(10)).transact().await?.into_result()?;
    let mock = nft.deploy(&wasm("../contract/target/near-mock/mock_nft.wasm")).await?.into_result()?;
    mock.call("new").args_json(json!({})).transact().await?.into_result()?;
    let market = deploy_market(&root, "market", mock.id(), near(5)).await?;
    let seller = root.create_subaccount("seller").initial_balance(near(10)).transact().await?.into_result()?;
    let stranger = root.create_subaccount("stranger").initial_balance(near(10)).transact().await?.into_result()?;
    let msg = json!({ "price": "1000" }).to_string();
    root.call(mock.id(), "list")
        .args_json(json!({"market": market.id(), "token_id": "a", "owner_id": seller.id(), "msg": msg}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    for mode in ["garbage", "panic"] {
        root.call(mock.id(), "set_mode").args_json(json!({ "mode": mode })).transact().await?.into_result()?;
        let out = send(&stranger, market.id(), "delist", json!({"token_id": "a"}), 0, 30).await?;
        assert_eq!(out.json::<bool>()?, false, "{mode}");
        let view: Value = market.view("get_listing").args_json(json!({"token_id": "a"})).await?.json()?;
        assert!(!view.is_null(), "{mode}");
    }
    // A token that no longer exists: null is a real answer, so the listing goes.
    root.call(mock.id(), "set_mode").args_json(json!({ "mode": "gone" })).transact().await?.into_result()?;
    let out = send(&stranger, market.id(), "delist", json!({"token_id": "a"}), 0, 30).await?;
    assert_eq!(out.json::<bool>()?, true);
    Ok(())
}

/// The storage reserve, with every listing there can be, at the longest names, and each sold from a market holding
/// only what the README says to fund it with. Also the worst gas: the most state, the longest names.
#[tokio::test]
async fn the_reserve_covers_every_listing_and_the_worst_gas_fits() -> Result<()> {
    let w = world().await?;
    let code = market_code();
    // The README's number: the code, the state of 36 full listings, and a little for the yoctos sent with each transfer.
    let reserve = 12 * NearToken::from_near(1).as_yoctonear() / 100;
    let funded = code.len() as u128 * BYTE + reserve;
    let market_account = w.root.create_subaccount("tight").initial_balance(NearToken::from_yoctonear(funded + 10 * MILLI)).transact().await?.into_result()?;
    let tight = market_account.deploy(&code).await?.into_result()?;
    tight.call("new").args_json(json!({ "nft_contract": w.game.id() })).transact().await?.into_result()?;
    let market_id = tight.id().clone();
    println!("market: {} bytes of code, funded with {funded} yocto", code.len());

    // 36 tokens, each owned by a 64-character name. Each mint and listing is one account's, so there's a limit on who
    // can fit: one seller with a long name lists them all, which is what fills the market.
    let seller = w.long_player(0).await?;
    let buyer = w.long_player(1).await?;
    send(&seller, w.game.id(), "deposit", json!({}), (MINT_PRICE as u128 + 1) * MILLI * 36 + 2 * MILLI, 30).await?.into_result()?;
    let nfts: Vec<Value> = w.game.view("get_nfts").args_json(json!({"from": 0, "limit": 36})).await?.json()?;
    let tokens: Vec<String> = nfts.iter().map(|n| n["token_id"].as_str().unwrap().to_string()).collect();
    assert_eq!(tokens.len(), 36);
    let price = 10 * MILLI;
    let msg = json!({ "price": price.to_string() }).to_string();
    let empty = tight.view_account().await?.storage_usage;
    let mut approve_tgas = 0f64;
    for token in &tokens {
        send(&seller, w.game.id(), "mint_nft", json!({ "token_id": token }), 1, 30).await?.into_result()?;
        let out = send(&seller, w.game.id(), "nft_approve", json!({"token_id": token, "account_id": market_id, "msg": msg}), LIST_DEPOSIT, LIST_TGAS).await?;
        assert!(out.is_success(), "{token}: {:?}", out.failures());
        approve_tgas = out.total_gas_burnt.as_gas() as f64 / 1e12;
    }
    let full = tight.view_account().await?;
    println!("market: empty {empty} bytes, 36 listings {} bytes, {} bytes per listing", full.storage_usage, (full.storage_usage - empty) / 36);
    println!("nft_approve, 36th listing, longest names: {approve_tgas:.3} Tgas");
    assert!((full.storage_usage as u128 - code.len() as u128) * BYTE <= reserve, "the reserve has to cover the state");
    assert_contract_solvent(&tight).await?;

    // One more can't get in: the market is full, whatever the NFT contract says. Only reachable through a stand-in.
    let views = [("get_listings, all 36", json!({"from": 0, "limit": 36}))];
    for (name, args) in views {
        let out = tight.view("get_listings").args_json(args).await?;
        println!("{name}: {} bytes", out.result.len());
    }

    // Every sale from here, at the minimum gas, with the longest names, an excess to refund, and the most state.
    let mut most_callback = 0.0f64;
    for token in tokens.iter().take(3) {
        let out = send(&buyer, &market_id, "buy", json!({ "token_id": token }), price + MILLI, MIN_BUY_TGAS).await?;
        assert!(out.is_success() && logged(&out).iter().any(|e| e["event"] == "nft_sold"), "{token}: {:?}", out.failures());
        tgas_of(&out, "buy at the minimum gas, longest names, most state");
        for o in out.receipt_outcomes() {
            if o.executor_id == market_id {
                most_callback = most_callback.max(o.gas_burnt.as_gas() as f64 / 1e12);
            }
        }
        assert_eq!(w.owner(token).await?, buyer.id().as_str());
    }
    println!("market receipts: at most {most_callback:.3} Tgas each");

    // A deleted buyer on the failure path at minimum gas: the longest path through the callbacks.
    let token = &tokens[3];
    send(&seller, w.game.id(), "nft_revoke", json!({"token_id": token, "account_id": market_id}), 1, 6).await?.into_result()?;
    let doomed = w.long_player(2).await?;
    let buying = doomed.call(&market_id, "buy").args_json(json!({ "token_id": token })).deposit(NearToken::from_yoctonear(price)).gas(Gas::from_tgas(MIN_BUY_TGAS)).transact_async().await?;
    doomed.clone().delete_account(w.root.id()).await?.into_result()?;
    let out = finished(&buying, &w.worker).await?;
    tgas_of(&out, "buy at minimum gas, transfer fails, buyer deleted, longest names");
    assert_eq!(event(&logged(&out), "unclaimed_added")["data"]["reason"], "buyer_gone");
    let parked: String = tight.view("get_unclaimed").args_json(json!({"account_id": doomed.id()})).await?.json()?;
    assert_eq!(parked.parse::<u128>()?, price - (1 + 4 + 64 + 16 + 40) * BYTE);
    assert_contract_solvent(&tight).await?;

    // Selling out returns the storage to the reserve and leaves it solvent.
    for token in tokens.iter().skip(4) {
        let out = send(&buyer, &market_id, "buy", json!({ "token_id": token }), price, BUY_TGAS).await?;
        assert!(out.is_success(), "{token}: {:?}", out.failures());
    }
    let totals: Value = tight.view("get_totals").await?.json()?;
    assert_eq!(totals["listings"], 0);
    assert_contract_solvent(&tight).await?;
    w.assert_game_solvent().await
}

/// A market buyer with no game record earns on the NFT they bought, in a real round.
#[tokio::test]
async fn a_market_buyer_earns_the_deed_share_with_no_prior_record() -> Result<()> {
    let w = world().await?;
    let tips: Vec<String> = vec![to_hex(&links_of(0).0)];
    send(&w.oracle, w.game.id(), "add_commitments", json!({ "tips": tips }), 0, 30).await?.into_result()?;
    let seller = w.player("seller").await?;
    let buyer = w.player("a-buyer-with-no-record").await?;
    let host = w.player("host").await?;
    let players = [w.player("p1").await?, w.player("p2").await?, w.player("p3").await?];
    let kinds = ["lighthouse", "well", "hut", "windmill", "pine", "apple", "scarecrow", "cow", "sheep", "duck", "boat", "palm"];
    for kind in kinds {
        let token = format!("tropical:{kind}");
        w.mint(&seller, &token).await?;
        w.listed(&seller, &token, MILLI).await?;
        w.buy(&buyer, &token, MILLI).await?.into_result()?;
    }
    let args = json!({"name": "Sandbox", "map": "tropical", "fee": 1000, "duration_sec": 60, "host_cut_bps": 500, "min_players": 2, "max_players": 30, "countdown_sec": 0});
    let room: u64 = send(&host, w.game.id(), "create_room", args, (BOND as u128 + 10) * MILLI, 60).await?.into_result()?.json()?;
    for p in &players {
        send(p, w.game.id(), "join", json!({ "room_id": room }), 1002 * MILLI, 10).await?.into_result()?;
    }
    send(&host, w.game.id(), "start", json!({ "room_id": room }), 0, 10).await?.into_result()?;
    let spots = land_spots("tropical", players.len());
    for (p, (x, y)) in players.iter().zip(&spots) {
        send(p, w.game.id(), "dig", json!({"room_id": room, "x": x, "y": y, "seen_clue": 1}), 0, 5).await?.into_result()?;
    }
    let (_, links) = links_of(0);
    let mut settled = None;
    for link in &links {
        let view: Value = w.game.view("get_room").args_json(json!({ "id": room })).await?.json()?;
        warp_to(&w, view["next_due_ms"].as_u64().unwrap()).await?;
        assert_eq!(send(&w.root, w.game.id(), "poke", json!({ "room_id": room }), 0, 30).await?.into_result()?.json::<String>()?, "locked");
        settled = Some(send(&w.root, w.game.id(), "reveal", json!({"room_id": room, "link": to_hex(link)}), 0, 30).await?.into_result()?);
    }
    let settled = settled.unwrap();
    let all: Vec<Value> = settled.logs().iter().filter_map(|l| l.strip_prefix("EVENT_JSON:")).map(|l| serde_json::from_str(l).unwrap()).collect();
    let deed = &event(&all, "finished")["data"]["deed"];
    assert_eq!(deed["owner"], buyer.id().as_str());
    assert_eq!(deed["paid"], 60);
    let record: Value = w.game.view("get_account").args_json(json!({"id": buyer.id()})).await?.json()?;
    let balance: u128 = record["balance"].as_str().unwrap().parse()?;
    assert_eq!(balance, 60 * MILLI - (1 + 4 + buyer.id().as_str().len() as u128 + 37 + 40) * BYTE);
    w.assert_game_solvent().await?;
    w.assert_market_solvent().await
}

async fn warp_to(w: &World, target: u64) -> Result<()> {
    for _ in 0..200 {
        let now: u64 = w.game.view("get_now_ms").await?.json()?;
        if now >= target {
            return Ok(());
        }
        w.worker.fast_forward(((target - now) / 1000).clamp(1, 2000)).await?;
    }
    anyhow::bail!("time never reached {target}")
}

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
    out
}
