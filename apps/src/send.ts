// Sends one Wormhole message from Solana using Anchor (devnet Core).

import "dotenv/config";
import {
  AnchorProvider,
  Program,
  setProvider,
  type Idl,
} from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v.trim();
}

export async function sendOnce(payloadStr: string) {
  // Wormhole Core (devnet)
  const CORE_PID = new PublicKey(
    "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5"
  );

  const provider = AnchorProvider.env(); // uses env provider
  setProvider(provider);

  // Loads IDL; expects "address" to contain the program id
  const idlPath = req("IDL_PATH");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;

  // Uses idl.address as default programId
  const program = new Program(idl, provider);
  const programId = program.programId as PublicKey;

  const [emitter] = PublicKey.findProgramAddressSync(
    [Buffer.from("emitter")],
    programId
  );

  const bridge = PublicKey.findProgramAddressSync(
    [Buffer.from("Bridge")],
    CORE_PID
  )[0];

  const feeCollector = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_collector")],
    CORE_PID
  )[0];

  // Correct: derive sequence by emitter
  const sequenceByEmitter = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), emitter.toBuffer()],
    CORE_PID
  )[0];

  // Wrong (for reference): programId-based derivation
  const sequenceByProgId = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), programId.toBuffer()],
    CORE_PID
  )[0];

  // New message account (external tx signs it)
  const message = Keypair.generate();

  console.log("[keys] programId        =", programId.toBase58());
  console.log("[keys] emitter PDA      =", emitter.toBase58());
  console.log("[keys] bridge (config)  =", bridge.toBase58());
  console.log("[keys] feeCollector     =", feeCollector.toBase58());
  console.log("[keys] sequenceByEmitter=", sequenceByEmitter.toBase58(), "<- use this");
  console.log("[keys] sequenceByProgId =", sequenceByProgId.toBase58(), "(wrong)");
  console.log("[keys] message (new)    =", message.publicKey.toBase58());

  // No pre-transfer of fee; paid on-chain
  const sig = await (program as any).methods
    .postWormholeMessage(
      new BN(0), // batch_id: u32
      Buffer.from(payloadStr), // payload: Vec<u8>
      1 // finality_flag: u8 (1=Finalized)
    )
    .accounts({
      config: bridge,
      message: message.publicKey, // signed externally
      emitter,
      sequence: sequenceByEmitter, // emitter-based
      payer: provider.wallet.publicKey, // fee payer
      feeCollector,
      clock: SYSVAR_CLOCK_PUBKEY,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
      wormholeProgram: CORE_PID,
    })
    .signers([message]) // message signs (Core requirement)
    .rpc();

  console.log(sig);
}

if (require.main === module) {
  const payload = process.argv.slice(2).join(" ") || "hello aztec!";
  sendOnce(payload).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
