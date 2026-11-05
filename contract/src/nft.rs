//! One NFT per kind of landmark per map, like `snowy:penguin`. NEP-171, 177, 178 and 181 come from
//! near-contract-standards. This file adds the mint and tells an approved market when its approval ends. Selling
//! happens in the market contract, through approvals.
use crate::ContractExt;
use crate::events::emit;
use crate::map_data::{deed_index, token_id, DEED_COUNT};
use crate::money::yocto;
use crate::Contract;
use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use std::collections::HashMap;

/// Burned at most about 2 Tgas with 36 listings in the market, measured in the sandbox.
const GAS_FOR_APPROVAL_NOTICE: Gas = Gas::from_tgas(5);
/// What a notice needs left to be worth sending, beyond its own gas: creating the promise and finishing this call.
const GAS_TO_FINISH_AFTER_NOTICE: Gas = Gas::from_tgas(2);
/// A token can carry any number of approvals, which its owner pays for. Telling a few is the point, and it keeps
/// the transfer's gas bounded. A market left out can still find out, because `delist` checks the token.
const MAX_APPROVAL_NOTICES: usize = 4;

/// Exists from a kind's first landing. There are only 36 kinds, so this can't grow further.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Deed {
    /// Was the asking price, before the market contract. Nothing reads it, and it stays so stored deeds keep their layout.
    pub retired_price: Option<u64>,
    pub earned: u64,
    pub landings: u32,
}

#[allow(dead_code)]
#[ext_contract(ext_approval_listener)]
trait ApprovalListener {
    fn nft_on_approval_ended(&mut self, token_id: TokenId, owner_id: AccountId, approval_id: u64);
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MintedEvent<'a> {
    token_id: &'a str,
    owner: &'a AccountId,
    price: u64,
    treasury: &'a AccountId,
    treasury_received: U128,
    storage_cost: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct ListingCancelledEvent<'a> {
    token_id: &'a str,
    reason: &'static str,
}

impl Contract {
    fn deed_index_of(&self, token_id: &str) -> u8 {
        deed_index(token_id).unwrap_or_else(|| env::panic_str("There's no such NFT."))
    }

    /// Who holds a token and who's approved on it, read before a call that will clear them.
    fn approvals_of(&self, token_id: &TokenId) -> Option<(AccountId, HashMap<AccountId, u64>)> {
        let owner = self.tokens.owner_by_id.get(token_id)?;
        let approvals = self.tokens.approvals_by_id.as_ref().and_then(|by_id| by_id.get(token_id))?;
        Some((owner, approvals))
    }

    /// Lets a market drop a listing that can no longer sell. A market's own transfer needs no notice, and a call
    /// with too little gas left skips it: this must never be why a transfer fails.
    fn notify_approvals_ended(&self, token_id: &TokenId, ended: Option<(AccountId, HashMap<AccountId, u64>)>) {
        let Some((owner, approvals)) = ended else { return };
        let caller = env::predecessor_account_id();
        for (account, approval_id) in approvals.into_iter().filter(|(account, _)| *account != caller).take(MAX_APPROVAL_NOTICES) {
            let needed = GAS_FOR_APPROVAL_NOTICE.as_gas() + GAS_TO_FINISH_AFTER_NOTICE.as_gas();
            if env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas()) < needed {
                return;
            }
            ext_approval_listener::ext(account)
                .with_static_gas(GAS_FOR_APPROVAL_NOTICE)
                .with_unused_gas_weight(0)
                .nft_on_approval_ended(token_id.clone(), owner.clone(), approval_id)
                .detach();
        }
    }

    /// The owner paid to store these approvals, which the transfer just cleared. The library's `nft_transfer` keeps that
    /// deposit, though its `nft_transfer_call` returns it, so this returns it the same way. Same sum as the library's
    /// own, whose helper isn't public. If the owner's account is gone, the coins come back to this contract's reserve.
    fn refund_approvals(&self, ended: &Option<(AccountId, HashMap<AccountId, u64>)>) {
        let Some((owner, approvals)) = ended else { return };
        let bytes: u128 = approvals.keys().map(|id| id.as_str().len() as u128 + 4 + 8).sum();
        if bytes > 0 {
            Promise::new(owner.clone()).transfer(NearToken::from_yoctonear(bytes * env::storage_byte_cost().as_yoctonear())).detach();
        }
    }

    /// Part of the upgrade to the market. At most 36 deeds, so this fits one call.
    pub(crate) fn retire_old_listings(&mut self) {
        for index in 0..DEED_COUNT {
            let Some(mut deed) = self.deeds.get(&(index as u8)) else { continue };
            if deed.retired_price.take().is_some() {
                self.deeds.insert(&(index as u8), &deed);
                emit("nft_listing_cancelled", &ListingCancelledEvent { token_id: &token_id(index), reason: "market_moved" });
            }
        }
    }

    fn metadata_for(token_id: &str) -> TokenMetadata {
        TokenMetadata {
            title: Some(format!("Dig Here deed: {token_id}")),
            description: Some("Earns a share of every Dig Here pot whose treasure lands by this kind of landmark.".to_string()),
            copies: Some(1),
            ..Default::default()
        }
    }
}

#[near]
impl Contract {
    /// The first owner pays exactly `mint_price`. The NFT's storage comes out of that, and the treasury's
    /// game balance gets the rest. It collects with `withdraw`, so minting needs no outgoing transfer.
    ///
    /// Needs a yocto, which a function-call key can't attach, so a stolen browser key can't spend a balance on this.
    #[payable]
    pub fn mint_nft(&mut self, token_id: TokenId) {
        require!(env::attached_deposit().as_yoctonear() >= 1, "Attach at least 1 yoctoNEAR to mint, from a wallet.");
        self.take_attached();
        let minter = env::predecessor_account_id();
        self.deed_index_of(&token_id);
        require!(self.tokens.owner_by_id.get(&token_id).is_none(), "This NFT has already been minted.");
        let price = self.config.mint_price;
        self.debit_milli(&minter, price, "mint");

        let before = env::storage_usage();
        let metadata = Self::metadata_for(&token_id);
        self.tokens.internal_mint_with_refund(token_id.clone(), minter.clone(), Some(metadata), None);
        let storage_cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
        let received = yocto(price).checked_sub(storage_cost);
        let received = received.unwrap_or_else(|| env::panic_str("mint_price can't cover this NFT's storage."));
        let treasury = self.config.treasury.clone();
        self.credit(&treasury, received, "mint_income");

        NftMint { owner_id: &minter, token_ids: &[&token_id], memo: None }.emit();
        emit(
            "nft_minted",
            &MintedEvent {
                token_id: &token_id,
                owner: &minter,
                price,
                treasury: &treasury,
                treasury_received: U128(received),
                storage_cost: U128(storage_cost),
            },
        );
        self.flush_balance_events();
    }
}

#[near]
impl NonFungibleTokenCore for Contract {
    /// Needs 1 yocto, so a browser's function-call key can't send one. That's on purpose. The receiver needs no
    /// record: their first deed share pays for one, and this contract never owes them anything before that.
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        let ended = self.approvals_of(&token_id);
        self.tokens.nft_transfer(receiver_id, token_id.clone(), approval_id, memo);
        self.refund_approvals(&ended);
        self.notify_approvals_ended(&token_id, ended);
    }

    /// The library hands nearly all the gas to the receiver, so a notice usually doesn't fit here. `delist` covers that.
    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let ended = self.approvals_of(&token_id);
        let result = self.tokens.nft_transfer_call(receiver_id, token_id.clone(), approval_id, memo, msg);
        self.notify_approvals_ended(&token_id, ended);
        result
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenApproval for Contract {
    #[payable]
    fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        let ended = self.approvals_of(&token_id).map(|(owner, mut approvals)| {
            approvals.retain(|account, _| *account == account_id);
            (owner, approvals)
        });
        self.tokens.nft_revoke(token_id.clone(), account_id);
        self.notify_approvals_ended(&token_id, ended);
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        let ended = self.approvals_of(&token_id);
        self.tokens.nft_revoke_all(token_id.clone());
        self.notify_approvals_ended(&token_id, ended);
    }

    fn nft_is_approved(&self, token_id: TokenId, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        self.tokens.nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Dig Here deeds".to_string(),
            symbol: "DIGHERE".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}
