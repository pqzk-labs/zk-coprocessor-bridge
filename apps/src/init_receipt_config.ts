// Initializes the receipt configuration account on Solana.

import "dotenv/config";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ethers } from "ethers";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v.trim();
}

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(req("SOLANA_PROGRAM_ID"));
const PAYER_JSON = req("SOLANA_PAYER_KEYPAIR");
const PORTAL_ADDRESS = req("PORTAL_ADDRESS");
const EVM_CHAIN = Number(process.env.RECEIPT_EVM_CHAIN || "2");

function evmAddressToEmitter32(address: string): Buffer {
  const a = ethers.utils.getAddress(address);
  const bytes = ethers.utils.arrayify(a);
  const padded = Buffer.alloc(32);
  Buffer.from(bytes).copy(padded, 12);
  return padded;
}

function deriveCfgPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("cfg")], programId);
  return pda;
}

// data = disc(8) + evm_chain(u16 LE) + emitter([u8;32])
function buildIxDataInit(evmChain: number, emitter32: Buffer): Buffer {
  const discHex = ethers.utils.sha256(ethers.utils.toUtf8Bytes("global:init_receipt_config")).slice(2);
  const disc = Buffer.from(discHex, "hex").subarray(0, 8);
  const chainLe = Buffer.alloc(2); chainLe.writeUInt16LE(evmChain);
  if (emitter32.length !== 32) throw new Error("emitter32 length");
  return Buffer.concat([disc, chainLe, emitter32]);
}

function loadPayer(): Keypair {
  const raw = require("fs").readFileSync(PAYER_JSON, "utf8");
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

(async () => {
  const conn = new Connection(SOLANA_RPC_URL, { commitment: "finalized" });
  const payer = loadPayer();
  const cfg = deriveCfgPda(PROGRAM_ID);
  const emitter32 = evmAddressToEmitter32(PORTAL_ADDRESS);
  const data = buildIxDataInit(EVM_CHAIN, emitter32);

  const keys = [
    { pubkey: cfg,            isSigner: false, isWritable: true  },
    { pubkey: payer.publicKey,isSigner: true,  isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "finalized" });
  console.log("[init] cfg created:", cfg.toBase58(), "sig:", sig);
})().catch((e) => { console.error(e); process.exit(1); });
