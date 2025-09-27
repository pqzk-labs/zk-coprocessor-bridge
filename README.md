# ZK Coprocessor Bridge 🛡️

**Status:** ⚠️ In Development (built for the **Solana Cypherpunk Hackathon**)   
**Tagline:** Privacy coprocessor for Solana: bridge Solana to Aztec private functions via Ethereum using Wormhole VAAs — with finality guarantees and replay‑safe L1→L2 queues.

**Project Page:** https://arena.colosseum.org/projects/explore/zk-coprocessor-bridge

## 📂 Layout
- evm-contracts/ — Foundry contracts: receive Wormhole VAAs and forward to Aztec Portal  
- solana-program/ — Rust program: post messages to Wormhole Core on Solana  
- aztec-contracts/ — Aztec L2: private consumer contracts for queued L1→L2 messages  
- relayer/ — off-chain service: fetch VAAs and submit to EVM (with retry/redelivery)  
- apps/ — combined user entrypoints for hackathon presentation  

## ⚖️ License
This project is dual-licensed under either:

- MIT License (see LICENSE-MIT)
- Apache License, Version 2.0 (see LICENSE-APACHE)

at your option.  
