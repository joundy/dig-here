//! One NFT per kind of landmark per map, like `snowy:penguin`. NEP-171, 177, 178 and 181 come from
//! near-contract-standards. This file adds the mint and the market, and keeps a listing from outliving its owner.
use crate::ContractExt;
use crate::events::emit;
use crate::map_data::deed_index;
use crate::money::yocto;
use crate::rules::MAX_FEE_MILLI;
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
use near_sdk::{env, near, require, AccountId, NearToken, Promise, PromiseOrValue};
use std::collections::HashMap;

/// Exists from a kind's first landing or listing. There are only 36 kinds, so this can't grow further.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Deed {
    /// What the owner is asking, in milliNEAR. None means it isn't listed.
    pub price: Option<u64>,
    pub earned: u64,
    pub landings: u32,
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
struct ListedEvent<'a> {
    token_id: &'a str,
    owner: &'a AccountId,
    price: Option<u64>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SoldEvent<'a> {
    token_id: &'a str,
    seller: &'a AccountId,
    buyer: &'a AccountId,
    price: u64,
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

    /// A listing belongs to the owner who made it. Any other change of owner ends it.
    fn cancel_listing(&mut self, token_id: &str, reason: &'static str) {
        let Some(index) = deed_index(token_id) else { return };
        let Some(mut deed) = self.deeds.get(&index) else { return };
        if deed.price.take().is_some() {
            self.deeds.insert(&index, &deed);
            emit("nft_listing_cancelled", &ListingCancelledEvent { token_id, reason });
        }
    }

    /// Settlements and sales credit an NFT's owner and must never have to create a record. So a new
    /// owner needs one already, which `deposit_for` lets the sender pay for.
    fn require_record(&self, account: &AccountId) {
        require!(self.accounts.get(account).is_some(), "The receiver needs a Dig Here balance first. Use deposit_for.");
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
    #[payable]
    pub fn mint_nft(&mut self, token_id: TokenId) {
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

    /// Owner only. Lists at `price` in milliNEAR, or takes it off the market with null.
    pub fn list_nft(&mut self, token_id: TokenId, price: Option<u64>) {
        let index = self.deed_index_of(&token_id);
        let caller = env::predecessor_account_id();
        require!(self.tokens.owner_by_id.get(&token_id).as_ref() == Some(&caller), "You don't own this NFT.");
        if let Some(p) = price {
            require!(p > 0, "Set a price above 0.");
            require!(p <= MAX_FEE_MILLI, "That price is too high.");
        }
        let mut deed = self.deeds.get(&index).unwrap_or_default();
        deed.price = price;
        self.deeds.insert(&index, &deed);
        emit("nft_listed", &ListedEvent { token_id: &token_id, owner: &caller, price });
    }

    /// `seen_price` is the price the buyer agreed to, so an owner raising it while the purchase is on its
    /// way can't cost them more than they expected. Pays the owner's game balance.
    ///
    /// Needs a yocto, which a function-call key can't attach. Otherwise a stolen browser key could buy a thief's
    /// NFT listed at the victim's whole balance, which turns the balance into the thief's withdrawable coins.
    #[payable]
    pub fn buy_nft(&mut self, token_id: TokenId, seen_price: u64) {
        require!(env::attached_deposit().as_yoctonear() >= 1, "Attach at least 1 yoctoNEAR to buy, from a wallet.");
        self.take_attached();
        let buyer = env::predecessor_account_id();
        let index = self.deed_index_of(&token_id);
        let seller = self.tokens.owner_by_id.get(&token_id);
        let seller = seller.unwrap_or_else(|| env::panic_str("This NFT hasn't been minted yet."));
        require!(seller != buyer, "You already own this NFT.");
        let mut deed = self.deeds.get(&index).unwrap_or_default();
        let price = deed.price.unwrap_or_else(|| env::panic_str("This NFT isn't for sale."));
        require!(seen_price == price, "The price just changed. Check it and try again.");

        self.debit_milli(&buyer, price, "nft_buy");
        self.credit_milli(&seller, price, "nft_sale");
        deed.price = None;
        self.deeds.insert(&index, &deed);
        let (_, approvals) = self.tokens.internal_transfer(&seller, &buyer, &token_id, None, None);
        emit("nft_sold", &SoldEvent { token_id: &token_id, seller: &seller, buyer: &buyer, price });
        self.flush_balance_events();
        // The sale cleared the seller's approvals, so what they paid to store them goes back, as `nft_transfer` does.
        // Same sum as the library's own, whose helper isn't public.
        let bytes: u128 = approvals.iter().flatten().map(|(id, _)| id.as_str().len() as u128 + 4 + 8).sum();
        if bytes > 0 {
            Promise::new(seller).transfer(NearToken::from_yoctonear(bytes * env::storage_byte_cost().as_yoctonear())).detach();
        }
    }
}

#[near]
impl NonFungibleTokenCore for Contract {
    /// Needs 1 yocto, so a guest's function-call key can't send one. That's on purpose.
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.require_record(&receiver_id);
        self.tokens.nft_transfer(receiver_id, token_id.clone(), approval_id, memo);
        self.cancel_listing(&token_id, "transferred");
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.require_record(&receiver_id);
        let result = self.tokens.nft_transfer_call(receiver_id, token_id.clone(), approval_id, memo, msg);
        self.cancel_listing(&token_id, "transferred");
        result
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    /// The receiver may have listed the token during the call. If it's coming back, that listing must not survive.
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let kept = self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id.clone(), approved_account_ids);
        if !kept {
            self.cancel_listing(&token_id, "transfer_returned");
        }
        kept
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
        self.tokens.nft_revoke(token_id, account_id)
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id)
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
