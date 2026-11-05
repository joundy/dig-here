//! The number stream and the hashes that feed it. `src/lib/game/random.ts` is the same thing in TypeScript.

/// Host hashing on chain. Native builds use a library, so unit tests can roll thousands of layouts
/// without the mocked VM counting gas.
#[cfg(target_arch = "wasm32")]
pub fn sha256(data: &[u8]) -> [u8; 32] {
    near_sdk::env::sha256_array(data)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).into()
}

pub struct Stream {
    seed: [u8; 32],
    next_block: u32,
    block: [u8; 32],
    at: usize,
    pub draws: u32,
}

impl Stream {
    pub fn new(seed: [u8; 32]) -> Self {
        Self { seed, next_block: 0, block: [0; 32], at: 32, draws: 0 }
    }

    fn next_word(&mut self) -> u32 {
        if self.at >= 32 {
            let mut input = [0u8; 36];
            input[..32].copy_from_slice(&self.seed);
            input[32..].copy_from_slice(&self.next_block.to_le_bytes());
            self.block = sha256(&input);
            self.next_block += 1;
            self.at = 0;
        }
        let bytes = [self.block[self.at], self.block[self.at + 1], self.block[self.at + 2], self.block[self.at + 3]];
        self.at += 4;
        u32::from_le_bytes(bytes)
    }

    /// Words at or above the largest multiple of n are thrown away, so no result is likelier than another.
    /// `below(1)` still uses a word: the stream's position can't depend on the answer.
    pub fn below(&mut self, n: u32) -> u32 {
        self.draws += 1;
        const TWO_32: u64 = 1 << 32;
        let n64 = n as u64;
        let limit = TWO_32 - TWO_32 % n64;
        loop {
            let word = self.next_word() as u64;
            if word < limit {
                return (word % n64) as u32;
            }
        }
    }
}

pub fn roll_seed(room_id: u64, step: u8, lock_seed: &[u8; 32], link: &[u8; 32], digs_hash: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(11 + 8 + 1 + 96);
    input.extend_from_slice(b"dig-here-v1");
    input.extend_from_slice(&room_id.to_le_bytes());
    input.push(step);
    input.extend_from_slice(lock_seed);
    input.extend_from_slice(link);
    input.extend_from_slice(digs_hash);
    sha256(&input)
}

pub fn layout_seed(room_id: u64, block_seed: &[u8; 32], tip: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(18 + 8 + 64);
    input.extend_from_slice(b"dig-here-layout-v1");
    input.extend_from_slice(&room_id.to_le_bytes());
    input.extend_from_slice(block_seed);
    input.extend_from_slice(tip);
    sha256(&input)
}

pub struct HashedDig<'a> {
    pub account: &'a str,
    pub x: u16,
    pub y: u16,
    pub clue_index: u8,
    pub dug_at_ms: u64,
}

pub fn digs_hash<'a>(digs: impl Iterator<Item = HashedDig<'a>>) -> [u8; 32] {
    let mut input = Vec::new();
    for d in digs {
        input.extend_from_slice(d.account.as_bytes());
        input.push(0);
        input.extend_from_slice(&d.x.to_le_bytes());
        input.extend_from_slice(&d.y.to_le_bytes());
        input.push(d.clue_index);
        input.extend_from_slice(&d.dug_at_ms.to_le_bytes());
    }
    sha256(&input)
}

/// The oracle's side of a commitment, kept here so the tests can check it agrees with the TypeScript.
/// Returns the tip and the links in reveal order.
#[cfg(test)]
pub fn hash_chain(secret: [u8; 32]) -> ([u8; 32], Vec<[u8; 32]>) {
    use crate::rules::CHAIN_STEPS;
    let mut hashes = vec![secret];
    for i in 0..CHAIN_STEPS as usize {
        let next = sha256(&hashes[i]);
        hashes.push(next);
    }
    let tip = hashes[CHAIN_STEPS as usize];
    hashes.truncate(CHAIN_STEPS as usize);
    hashes.reverse();
    (tip, hashes)
}

pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// Lowercase only, as everywhere else in the game's data.
pub fn from_hex32(text: &str) -> Option<[u8; 32]> {
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = digit(bytes[i * 2])? << 4 | digit(bytes[i * 2 + 1])?;
    }
    Some(out)
}
