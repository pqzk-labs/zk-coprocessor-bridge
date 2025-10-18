# ZK Coprocessor Bridge 🛡️

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE-MIT)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE-APACHE)
[![CI](https://github.com/pqzk-labs/zk-coprocessor-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/pqzk-labs/zk-coprocessor-bridge/actions/workflows/ci.yml)

**ZK Coprocessor for Solana** — a bridge enabling private ZK computations on Aztec via Ethereum and Wormhole, with replay-safe finality.  
Solana ⇄ Wormhole ⇄ Ethereum ⇄ Aztec (ZK proofs) ✅

## ⚙️ What it does
- Uses **Aztec** as a privacy coprocessor for Solana via Wormhole.
- **Forward:** Solana posts → Wormhole VAA → Sepolia Portal verifies & blocks replays → enqueues L1→L2 into Aztec Inbox → (optional) relayer consumes on Aztec.
- **Return (optional):** Portal publishes a receipt VAA; the Solana program records it.
- **Included tooling:** Anchor program, Solidity Portal, Noir contract, and TS CLI/relayers.

**Key properties**
- Replay‑safe on EVM, allowlisted chain/emitter.
- Runs today on Solana devnet, Sepolia, Aztec testnet.

## 📂 Layout
- solana-program/ — Anchor program: post_message + record receipts  
- evm-contracts/ — Solidity: Portal (verify VAA → enqueue to Aztec Inbox)  
- aztec-contracts/ — Noir contract: consume L1→L2 message  
- apps/ — CLI & relayers (TypeScript)  

## ⚖️ License
This project is dual-licensed under either:

- MIT License (see LICENSE-MIT)
- Apache License, Version 2.0 (see LICENSE-APACHE)

at your option.  
