//! Only for tests. The real game contract can't be made to run out of gas on demand, so this stands in for it.
use near_sdk::serde_json::Value;
use near_sdk::{env, ext_contract, near, AccountId, Gas, GasWeight, PanicOnDefault, Promise, YieldId};

#[allow(dead_code)]
#[ext_contract(ext_market)]
trait Market {
    fn nft_on_approve(&mut self, token_id: String, owner_id: AccountId, approval_id: u64, msg: String);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mock {
    mode: String,
    next_approval: u64,
    held: Option<YieldId>,
}

#[near]
impl Mock {
    #[init]
    pub fn new() -> Self {
        Self { mode: "ok".to_string(), next_approval: 1, held: None }
    }

    pub fn set_mode(&mut self, mode: String) {
        self.mode = mode;
    }

    /// Stands in for `nft_approve`, naming whoever it's told as the owner.
    pub fn list(&mut self, market: AccountId, token_id: String, owner_id: AccountId, msg: String) -> Promise {
        self.next_approval += 1;
        ext_market::ext(market).with_static_gas(Gas::from_tgas(20)).nft_on_approve(token_id, owner_id, self.next_approval, msg)
    }

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        let _ = (receiver_id, token_id, approval_id, memo);
        match self.mode.as_str() {
            "panic" => env::panic_str("mock: this transfer fails"),
            "burn" => loop {
                // Host calls are what cost gas, so this reaches the receipt's limit quickly.
                env::sha256(&[0u8; 1024]);
            },
            // Waits for `release`, which keeps a sale in flight for as long as a test needs.
            "hold" => {
                let (promise, id) = env::promise_yield_create_id("on_released", [], Gas::from_tgas(3), GasWeight(0));
                self.held = Some(id);
                env::promise_return(promise);
            }
            _ => {}
        }
    }

    pub fn release(&mut self) {
        let id = self.held.take().unwrap_or_else(|| env::panic_str("nothing is held"));
        let _ = id.resume(&[]);
    }

    #[private]
    pub fn on_released(&self) {}

    /// `mode` "garbage" answers with something a token can never be.
    pub fn nft_token(&self, token_id: String) -> Value {
        let _ = token_id;
        match self.mode.as_str() {
            "garbage" => Value::String("no".to_string()),
            "panic" => env::panic_str("mock: can't read"),
            "gone" => Value::Null,
            _ => Value::Null,
        }
    }
}
