//! NEP-297 events. These are the permanent record: rooms get deleted, so anything a proof needs is logged here.
use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json};

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Event<'a, T: Serialize> {
    standard: &'static str,
    version: &'static str,
    event: &'a str,
    data: &'a T,
}

pub fn emit<T: Serialize>(event: &str, data: &T) {
    let body = Event { standard: "dig-here", version: "1.0.0", event, data };
    env::log_str(&format!("EVENT_JSON:{}", serde_json::to_string(&body).unwrap_or_default()));
}
