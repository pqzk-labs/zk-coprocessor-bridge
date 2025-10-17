// Relayer daemon: (1) drain Solana->Wormhole VAAs to EVM Portal, (2) write back Aztec completion to Solana as receipts.
// Uses ethers v5 and @solana/web3.js; default receipt mode is "direct", optional "wormhole" uses Wormhole SDK.
// Run: `npm run relayer` (drain) or `npm run relayer -- --job receipt`.

import "dotenv/config";
import axios from "axios";
import { ethers } from "ethers";
import { Connection, PublicKey, ConfirmedSignatureInfo, VersionedTransactionResponse, Transaction, SystemProgram, Keypair, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

/* tiny logger */
const TS = () => new Date().toISOString();
const log = (...a: any[]) => console.log(TS(), ...a);
const warn = (...a: any[]) => console.warn(TS(), ...a);

/* env helpers */
function req(name: string): string { const v = process.env[name]; if (!v) throw new Error(`Missing env: ${name}`); return v.trim(); }
function opt(name: string, dflt: string): string { const v = process.env[name]; return (v ?? dflt).trim(); }

/* core env */
const SEPOLIA_RPC_URL = req("SEPOLIA_RPC_URL");
const PRIVATE_KEY = req("PRIVATE_KEY");
const PORTAL_ADDRESS = req("PORTAL_ADDRESS");
const VAA_CHAIN = opt("VAA_CHAIN", "1");
const VAA_EMITTER_HEX = req("VAA_EMITTER").replace(/^0x/i, "").toLowerCase();
if (VAA_EMITTER_HEX.length !== 64) throw new Error("VAA_EMITTER must be 32-byte hex");
const WORMHOLE_API = opt("WORMHOLE_API", "https://api.testnet.wormholescan.io").replace(/\/+$/, "");
const SOLANA_RPC_URL = opt("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const SOLANA_PROGRAM_ID = new PublicKey(req("SOLANA_PROGRAM_ID"));

/* Aztec (optional) */
const AZTEC_NODE_URL = opt("AZTEC_NODE_URL", opt("NODE_URL", "https://aztec-testnet-fullnode.zkv.xyz"));
const AZTEC_CONTRACT = opt("AZTEC_CONTRACT", "");
const AZTEC_WALLET_FROM = opt("AZTEC_WALLET_FROM", "accounts:my-wallet");
const AZTEC_PAYMENT = opt("AZTEC_PAYMENT", "method=fpc-sponsored,fpc=contracts:sponsoredfpc");
const AZTEC_WALLET_BIN = opt("AZTEC_WALLET_BIN", "aztec-wallet");
const AZTEC_AUTO_CONSUME = opt("AZTEC_AUTO_CONSUME", "1") === "1";
const AZTEC_SECRET_SEED = opt("AZTEC_SECRET_SEED", "");
const AZTEC_ARTIFACT = opt("AZTEC_ARTIFACT", "");
const AZTEC_REQUIRE_JS = opt("AZTEC_REQUIRE_JS", "0") === "1";

/* optional scan start */
const PORTAL_FROM_BLOCK = process.env.PORTAL_FROM_BLOCK ? Number(process.env.PORTAL_FROM_BLOCK) : undefined;

/* params */
const POLL_MS = 5_000, BOOTSTRAP_LIMIT = 200, FETCH_VAA_RETRY_MS = 4_000, FETCH_VAA_RETRY_MAX = 60;
const STATE_FILE = path.join(process.env.HOME || ".", ".zkcb", "relayer-state.json");
const CONSUME_RETRY_MAX = Number(opt("AZTEC_CONSUME_RETRY_MAX", "120"));
const CONSUME_RETRY_MS = Number(opt("AZTEC_CONSUME_RETRY_MS", "10000"));

/* EVM provider/contract */
const evmProvider = new ethers.providers.JsonRpcProvider(SEPOLIA_RPC_URL);
const evmWallet = new ethers.Wallet(PRIVATE_KEY, evmProvider);

/* Portal ABI */
const portalAbi = [
  "function consume(bytes) returns (bytes32 vmHash, uint64 sequence)",
  "function consumeWithSecret(bytes,bytes32) returns (bytes32 vmHash, uint64 sequence)",
  "event VaaConsumed(bytes32 indexed vmHash, uint64 indexed sequence, bytes payload, bytes32 aztecL2Key)",
  "event InboxEnqueued(bytes32 indexed vmHash, uint64 indexed sequence, bytes32 contentFr, bytes32 key, uint256 leafIndex, bytes32 secretHash)",
  "function publishReceipt(uint16,bytes32,uint64,bytes32,bytes32,uint256,bytes32,bytes32,uint8) payable returns (uint64)",
  "event ReceiptPublished(uint64 indexed sequence, bytes payload)",
  "function wormhole() view returns (address)",
];
const portalIface = new ethers.utils.Interface(portalAbi);
const topicVaa = ethers.utils.id("VaaConsumed(bytes32,uint64,bytes,bytes32)");
const topicEnq = ethers.utils.id("InboxEnqueued(bytes32,uint64,bytes32,bytes32,uint256,bytes32)");
const topicReceipt = ethers.utils.id("ReceiptPublished(uint64,bytes)");
const portal = new ethers.Contract(PORTAL_ADDRESS, portalAbi, evmWallet);

/* receipt job env */
const RECEIPT_MODE = opt("RECEIPT_MODE", "direct");
const SOLANA_PAYER_KEYPAIR = req("SOLANA_PAYER_KEYPAIR");
const RECEIPT_CHAIN = opt("RECEIPT_CHAIN", "2");
const RECEIPT_CONSISTENCY = Number(opt("RECEIPT_CONSISTENCY", "1"));
const RECEIPT_RESULT_HASH = opt("RECEIPT_RESULT_HASH", "0x" + "00".repeat(32));

/* state (drain) */
type State = { lastProcessed: number };
function readState(): State { try { const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); log("[state] loaded", STATE_FILE, s); return s; } catch { const s = { lastProcessed: -1 }; log("[state] init", STATE_FILE, s); return s; } }
function writeState(s: State) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); log("[state] saved", s); }

/* helpers */
const fromB64 = (b64: string) => Buffer.from(b64, "base64");
async function fetchVaa(chain: string, emitterHex: string, seq: number): Promise<Buffer> {
  const urls = [`${WORMHOLE_API}/api/v1/signed_vaa/${chain}/${emitterHex}/${seq}`, `${WORMHOLE_API}/v1/signed_vaa/${chain}/${emitterHex}/${seq}`];
  let lastErr: unknown;
  for (const u of urls) {
    try {
      log("[vaa] GET", u);
      const { data, status } = await axios.get(u, { timeout: 20_000, validateStatus: () => true });
      log("[vaa] status", status);
      if (status >= 400) { lastErr = `HTTP ${status}`; continue; }
      const b64 = data?.vaaBytes || data?.vaa_bytes || data?.vaa?.bytes;
      if (typeof b64 === "string" && b64.length > 0) { const bytes = fromB64(b64); log("[vaa] ok size", bytes.length); return bytes; }
      lastErr = "empty body";
    } catch (e) { lastErr = e; warn("[vaa] error", String(e)); }
  }
  throw new Error(`VAA not found: ${String(lastErr)}`);
}

/* Aztec secret/secretHash */
const FR_MODULUS = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
function toFieldHex32(x: string): string { let n = BigInt(x); n = n % FR_MODULUS; return ethers.utils.hexZeroPad("0x" + n.toString(16), 32); }
function deriveSecretPreimage(seq: number, vmHash: string): string {
  const seed = (AZTEC_SECRET_SEED || evmWallet.address).toLowerCase();
  const h = ethers.utils.solidityKeccak256(["string", "address", "bytes32", "uint64"], ["zkcb-secret-v1", seed, vmHash as `0x${string}`, seq]);
  return toFieldHex32(h);
}
async function computeSecretHashFromAztecJS(secretFrHex: string): Promise<string> {
  const tryImports = ["@aztec/aztec.js/node", "@aztec/aztec.js"]; let mod: any | undefined; let lastErr: any;
  for (const ent of tryImports) { try { mod = await import(ent); break; } catch (e) { lastErr = e; } }
  if (!mod || typeof mod.computeSecretHash !== "function") {
    if (AZTEC_REQUIRE_JS) throw new Error(`computeSecretHash unavailable (${String(lastErr || "no module")})`);
    warn("[aztec] computeSecretHash unavailable; using keccak256 fallback");
    const k = ethers.utils.keccak256(secretFrHex as `0x${string}`);
    return toFieldHex32(k);
  }
  const fr = mod.Fr?.fromString ? mod.Fr.fromString(secretFrHex) : secretFrHex;
  const out = await mod.computeSecretHash(fr);
  if (typeof out === "string") return toFieldHex32(out);
  if (typeof out === "bigint") return ethers.utils.hexZeroPad("0x" + (out % FR_MODULUS).toString(16), 32);
  if (out?.toString) return toFieldHex32(out.toString());
  throw new Error("computeSecretHash returned unexpected type");
}

/* log decoders & L2 consume */
const ZERO32 = "0x" + "00".repeat(32);
type VaaConsumedDecoded = { vmHash: string; sequence: string; payloadHex: string; payloadUtf8?: string; aztecL2Key: string; };
type InboxEnqueuedDecoded = { vmHash: string; sequence: string; contentFr: string; key: string; leafIndex: string; secretHash: string; };
function stripTrailingNulls(hex: string): string { if (!hex.startsWith("0x")) return hex; let h = hex.slice(2); while (h.endsWith("00")) h = h.slice(0, -2); return "0x" + h; }
function decodeVaaConsumedFromLogs(logs: readonly any[]): VaaConsumedDecoded[] {
  const out: VaaConsumedDecoded[] = [];
  for (const l of logs) {
    if (!l || typeof l !== "object") continue;
    const addr = (l.address || "").toLowerCase(); if (addr !== PORTAL_ADDRESS.toLowerCase()) continue;
    const t0: string = Array.isArray(l.topics) && l.topics[0] ? String(l.topics[0]) : ""; if (t0.toLowerCase() !== topicVaa.toLowerCase()) continue;
    try {
      const decoded = portalIface.decodeEventLog("VaaConsumed", l.data, l.topics) as any;
      const vmHash: string = decoded.vmHash as string;
      const sequence: string = (decoded.sequence as ethers.BigNumber).toString();
      const payloadHex: string = ethers.utils.hexlify(decoded.payload as string | Uint8Array);
      const aztecL2Key: string = decoded.aztecL2Key as string;
      let payloadUtf8: string | undefined; try { payloadUtf8 = ethers.utils.toUtf8String(stripTrailingNulls(payloadHex)); } catch {}
      out.push({ vmHash, sequence, payloadHex, payloadUtf8, aztecL2Key });
    } catch {}
  }
  return out;
}
function decodeInboxEnqueuedFromLogs(logs: readonly any[]): InboxEnqueuedDecoded[] {
  const out: InboxEnqueuedDecoded[] = [];
  for (const l of logs) {
    if (!l || typeof l !== "object") continue;
    const addr = (l.address || "").toLowerCase(); if (addr !== PORTAL_ADDRESS.toLowerCase()) continue;
    const t0: string = Array.isArray(l.topics) && l.topics[0] ? String(l.topics[0]) : ""; if (t0.toLowerCase() !== topicEnq.toLowerCase()) continue;
    try {
      const decoded = portalIface.decodeEventLog("InboxEnqueued", l.data, l.topics) as any;
      out.push({ vmHash: decoded.vmHash as string, sequence: (decoded.sequence as ethers.BigNumber).toString(), contentFr: decoded.contentFr as string, key: decoded.key as string, leafIndex: (decoded.leafIndex as ethers.BigNumber).toString(), secretHash: decoded.secretHash as string });
    } catch {}
  }
  return out;
}
function resolveAztecCliCwd(): string | undefined { if (!AZTEC_ARTIFACT) return undefined; const abs = path.resolve(AZTEC_ARTIFACT); let cwd = path.dirname(abs); const base = path.basename(cwd).toLowerCase(); if (base === "target" || "artifacts") cwd = path.dirname(cwd); return cwd; }
async function runAztecWallet(args: string[]) {
  const spawnOpts: any = { stdio: ["ignore", "pipe", "pipe"] as any[] };
  const cliCwd = resolveAztecCliCwd();
  if (cliCwd) { if (fs.existsSync(cliCwd)) { log("[aztec] using cwd for artifact resolution:", cliCwd); spawnOpts.cwd = cliCwd; } else { warn("[aztec] resolved cwd not found:", cliCwd); } }
  await new Promise<void>((resolve, reject) => {
    const p = spawn(AZTEC_WALLET_BIN, args, spawnOpts);
    p.stdout.on("data", (d) => process.stdout.write(`${TS()} [aztec-cli] ${d}`));
    p.stderr.on("data", (d) => process.stderr.write(`${TS()} [aztec-cli] ${d}`));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`aztec-wallet exited ${code}`))));
  });
}
async function aztecConsume(contentFr: string, leafIndex: string | bigint, secretFrHex: string) {
  if (!AZTEC_AUTO_CONSUME) { log("[aztec] auto-consume disabled"); return; }
  if (!AZTEC_CONTRACT) { warn("[aztec] AZTEC_CONTRACT not set; skip"); return; }
  const argsBase = ["send","consume_from_inbox","-ca",AZTEC_CONTRACT,"--args",contentFr,leafIndex.toString(),secretFrHex,"--node-url",AZTEC_NODE_URL,"--from",AZTEC_WALLET_FROM,"--payment",AZTEC_PAYMENT];
  for (let i = 0; i < CONSUME_RETRY_MAX; i++) {
    try { log("[aztec] spawn", AZTEC_WALLET_BIN, argsBase.join(" ")); await runAztecWallet(argsBase); log("[aztec] consume_from_inbox success", { leafIndex: leafIndex.toString() }); return; }
    catch (e: any) {
      const msg = String(e?.message || e);
      if (i < CONSUME_RETRY_MAX - 1 && /nonexistent L1-to-L2 message/i.test(msg)) { log("[aztec] wait membership (retry)", i + 1, "/", CONSUME_RETRY_MAX); await new Promise((r) => setTimeout(r, CONSUME_RETRY_MS)); continue; }
      warn("[aztec] consume_from_inbox failed", msg);
      if (i < CONSUME_RETRY_MAX - 1) { await new Promise((r) => setTimeout(r, CONSUME_RETRY_MS)); continue; }
      return;
    }
  }
}
async function reportAztecFromReceipt(rcpt: ethers.providers.TransactionReceipt, secretFrHex: string) {
  let decodedV = decodeVaaConsumedFromLogs(rcpt.logs || []);
  if (decodedV.length === 0) { try { const events = await portal.queryFilter(portal.filters.VaaConsumed(), rcpt.blockNumber, rcpt.blockNumber); decodedV = decodeVaaConsumedFromLogs(events as any); } catch (e) { warn("[aztec] queryFilter VaaConsumed failed", String(e)); } }
  for (const ev of decodedV) {
    const size = (ev.payloadHex.length - 2) / 2; const ok = ev.aztecL2Key.toLowerCase() !== ZERO32;
    log("[aztec] VaaConsumed", { seq: ev.sequence, vmHash: ev.vmHash, aztecL2Key: ev.aztecL2Key, ok });
    log("[aztec] payload", { len: size, hex: ev.payloadHex, utf8: ev.payloadUtf8 ?? "<non-utf8 | padded>" });
  }
  let decodedE = decodeInboxEnqueuedFromLogs(rcpt.logs || []);
  if (decodedE.length === 0) { try { const events = await portal.queryFilter(portal.filters.InboxEnqueued(), rcpt.blockNumber, rcpt.blockNumber); decodedE = decodeInboxEnqueuedFromLogs(events as any); } catch (e) { warn("[aztec] queryFilter InboxEnqueued failed", String(e)); } }
  for (const ev of decodedE) {
    log("[aztec] InboxEnqueued", { seq: ev.sequence, vmHash: ev.vmHash, contentFr: ev.contentFr, key: ev.key, leafIndex: ev.leafIndex, secretHash: ev.secretHash });
    try { await aztecConsume(ev.contentFr, ev.leafIndex, secretFrHex); } catch { /* non-blocking */ }
  }
}

/* preflight */
function toTopic32FromNumber(n: number | bigint): string { const hex = typeof n === "bigint" ? "0x" + n.toString(16) : ethers.utils.hexlify(n); return ethers.utils.hexZeroPad(hex, 32); }
async function wasSequenceConsumed(seq: number): Promise<boolean> {
  const seqTopic = toTopic32FromNumber(seq);
  let fromBlock = PORTAL_FROM_BLOCK; if (!fromBlock) { const latest = await evmProvider.getBlockNumber(); fromBlock = Math.max(0, latest - 250_000); }
  const filter = { address: PORTAL_ADDRESS, topics: [topicVaa, null, seqTopic], fromBlock, toBlock: "latest" as const };
  try { const logs = await evmProvider.getLogs(filter); return logs.length > 0; } catch (e) { warn("[preflight] getLogs failed; will not skip", String(e)); return false; }
}

/* EVM submit + report */
async function submitConsumeTx(vaa: Buffer, seq: number, vmHashHint?: string) {
  const vmHashForSeed = vmHashHint && vmHashHint.startsWith("0x") ? vmHashHint : "0x" + "00".repeat(32);
  const secretFrHex = deriveSecretPreimage(seq, vmHashForSeed);
  const secretHash = await computeSecretHashFromAztecJS(secretFrHex);
  log("[evm] submit consumeWithSecret(bytes,bytes32) len", vaa.length, "from", evmWallet.address);
  const tx = await portal.consumeWithSecret(vaa, secretHash, { gasLimit: 1_000_000 });
  log("[evm] sent", tx.hash);
  const rcpt = await tx.wait();
  log("[evm] mined", rcpt?.hash);
  await reportAztecFromReceipt(rcpt as ethers.providers.TransactionReceipt, secretFrHex);
  return { rcpt: rcpt as ethers.providers.TransactionReceipt, secretFrHex };
}

/* Solana scan */
const conn = new Connection(SOLANA_RPC_URL, { commitment: "finalized" });
function extractSequences(logs: string[] | null | undefined): number[] { if (!logs) return []; const out = new Set<number>(); for (const line of logs) { const m = /Sequence:\s*(\d+)/.exec(line); if (m) out.add(Number(m[1])); } return [...out].sort((a, b) => a - b); }
async function txSequences(sig: string): Promise<number[]> {
  try {
    const tx: VersionedTransactionResponse | null = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    if (!tx) { warn("[sol] tx null", sig); return []; }
    if (tx.meta?.err) { warn("[sol] tx err", sig, tx.meta.err); return []; }
    const seqs = extractSequences(tx.meta?.logMessages); log("[sol] seqs", sig, seqs); return seqs;
  } catch (e) { warn("[sol] getTransaction fail", sig, String(e)); return []; }
}
async function recentProgramSigs(limit: number): Promise<ConfirmedSignatureInfo[]> {
  try { const sigs = await conn.getSignaturesForAddress(SOLANA_PROGRAM_ID, { limit }); log("[sol] recent sigs", sigs.length); return [...sigs].reverse(); }
  catch (e) { warn("[sol] getSignaturesForAddress fail", String(e)); return []; }
}

/* drain job */
let draining = false;
export async function runDrain() {
  log("boot", `chain=${VAA_CHAIN}`, `emitter=0x${VAA_EMITTER_HEX}`, `portal=${PORTAL_ADDRESS}`, `solRpc=${SOLANA_RPC_URL}`, `program=${SOLANA_PROGRAM_ID.toBase58()}`, AZTEC_ARTIFACT ? `[artifact=${AZTEC_ARTIFACT}]` : "");
  try { const bh = await conn.getLatestBlockhash(); log("[sol] rpc ok slot", bh.lastValidBlockHeight); } catch (e) { warn("[sol] rpc failed", String(e)); }
  const state = readState(); let expected = state.lastProcessed + 1; const pending = new Set<number>(); const seen = new Set<string>();

  async function backfill() {
    log("[bf] start", { limit: BOOTSTRAP_LIMIT, expected });
    try {
      const sigs = await recentProgramSigs(BOOTSTRAP_LIMIT);
      for (const it of sigs) {
        if (seen.has(it.signature)) continue; seen.add(it.signature);
        const seqs = await txSequences(it.signature);
        for (const s of seqs) { if (s >= expected) { pending.add(s); log("[bf] enqueue seq", s); } }
      }
      log("[bf] done pending", pending.size);
    } catch (e) { warn("[bf] fail", String(e)); }
  }

  async function drain() {
    if (draining) { log("[drain] skip (already running)"); return; }
    draining = true;
    try {
      for (;;) {
        if (!pending.has(expected)) { log("[drain] idle expected", expected, "pending", [...pending].sort((a, b) => a - b)); break; }
        if (await wasSequenceConsumed(expected)) { log("[preflight] seq already consumed on-chain; fast-forward", expected); pending.delete(expected); state.lastProcessed = expected; writeState(state); expected += 1; continue; }
        let vaa: Buffer | undefined;
        for (let i = 0; i < FETCH_VAA_RETRY_MAX; i++) { try { log("[drain] fetchVaa try", i + 1, "seq", expected); vaa = await fetchVaa(VAA_CHAIN, VAA_EMITTER_HEX, expected); break; } catch (e) { log("[drain] wait vaa seq", expected, String(e)); await new Promise((r) => setTimeout(r, FETCH_VAA_RETRY_MS)); } }
        if (!vaa) { warn("[drain] give up seq", expected); break; }
        try { await submitConsumeTx(vaa, expected); } catch (e) { warn("[evm] consumeWithSecret failed", String(e)); break; }
        pending.delete(expected); state.lastProcessed = expected; writeState(state); log("[drain] processed", expected); expected += 1;
      }
    } finally { draining = false; }
  }

  await backfill(); await drain();
  setInterval(async () => {
    try {
      log("[poll] tick expected", expected);
      const sigs = await recentProgramSigs(64);
      for (const it of sigs) {
        if (seen.has(it.signature)) continue; seen.add(it.signature);
        const seqs = await txSequences(it.signature);
        for (const s of seqs) { if (s >= expected) { pending.add(s); log("[poll] enqueue seq", s, "from", it.signature); } }
      }
      await drain();
      if (seen.size > 1000) { const arr = Array.from(seen); seen.clear(); for (const x of arr.slice(-500)) seen.add(x); log("[poll] prune seen to", seen.size); }
    } catch (e) { warn("poll:", String(e)); }
  }, POLL_MS);
  log("running...");
}

/* receipt job */
function evmAddressToEmitter32(address: string): string { const a = ethers.utils.getAddress(address); const bytes = ethers.utils.arrayify(a); if (bytes.length !== 20) throw new Error("bad evm addr"); const padded = new Uint8Array(32); padded.set(bytes, 12); return ethers.utils.hexlify(padded); }
const EVM_EMITTER_32 = evmAddressToEmitter32(PORTAL_ADDRESS).replace(/^0x/i, "").toLowerCase();
function deriveCfgPda(programId: PublicKey): PublicKey { const [pda] = PublicKey.findProgramAddressSync([Buffer.from("cfg")], programId); return pda; }
function deriveReceiptPda(programId: PublicKey, emitter32: Uint8Array, origSeq: bigint): PublicKey { const seqBe = Buffer.alloc(8); seqBe.writeBigUInt64BE(origSeq); const [pda] = PublicKey.findProgramAddressSync([Buffer.from("receipt"), Buffer.from(emitter32), seqBe], programId); return pda; }
function buildRecordReceiptFromVaaIxData(emitter32Hex: string, origSeq: bigint): Buffer { const discHex = ethers.utils.sha256(ethers.utils.toUtf8Bytes("global:record_receipt_from_vaa")).slice(2); const disc = Buffer.from(discHex, "hex").subarray(0, 8); const emitter = Buffer.from(emitter32Hex.replace(/^0x/i, ""), "hex"); if (emitter.length !== 32) throw new Error("emitter32 bad length"); const seqLe = Buffer.alloc(8); seqLe.writeBigUInt64LE(origSeq); return Buffer.concat([disc, emitter, seqLe]); }
function buildRecordReceiptDirectIxData(emitter32Hex: string, origSeq: bigint): Buffer { const discHex = ethers.utils.sha256(ethers.utils.toUtf8Bytes("global:record_receipt_direct")).slice(2); const disc = Buffer.from(discHex, "hex").subarray(0, 8); const emitter = Buffer.from(emitter32Hex.replace(/^0x/i, ""), "hex"); if (emitter.length !== 32) throw new Error("emitter32 bad length"); const seqLe = Buffer.alloc(8); seqLe.writeBigUInt64LE(origSeq); return Buffer.concat([disc, emitter, seqLe]); }
function derivePostedVaaPda(wormholeProgramId: PublicKey, vaaHash: Uint8Array): PublicKey { const [pda] = PublicKey.findProgramAddressSync([Buffer.from("PostedVAA"), Buffer.from(vaaHash)], wormholeProgramId); return pda; }
function loadSolanaPayer(): Keypair { const file = SOLANA_PAYER_KEYPAIR; const raw = fs.readFileSync(file, "utf8"); let arr: number[] | undefined; try { arr = JSON.parse(raw); } catch { throw new Error(`SOLANA_PAYER_KEYPAIR must be a JSON array of secret key: ${file}`); } if (!Array.isArray(arr)) throw new Error("bad keypair json"); return Keypair.fromSecretKey(Uint8Array.from(arr)); }
async function isReceiptRecordedOnSolana(origSeq: bigint): Promise<boolean> { const emitter32 = Buffer.from(EVM_EMITTER_32, "hex"); const rPda = deriveReceiptPda(SOLANA_PROGRAM_ID, emitter32, origSeq); const info = await conn.getAccountInfo(rPda, { commitment: "finalized" }); return !!info; }
async function getEvmWormholeMessageFee(): Promise<ethers.BigNumber> { const whAddr: string = await portal.wormhole(); const wh = new ethers.Contract(whAddr, ["function messageFee() view returns (uint256)"], evmWallet); const fee: ethers.BigNumber = await (wh as any).messageFee(); return fee; }
async function publishReceiptOnEvm(ev: InboxEnqueuedDecoded): Promise<number> {
  const fee = await getEvmWormholeMessageFee(); const origEmitterChain = Number(VAA_CHAIN); const origEmitter = "0x" + VAA_EMITTER_HEX;
  log("[evm] publishReceipt", { origEmitterChain, origEmitter, origSequence: ev.sequence, contentFr: ev.contentFr, key: ev.key, leafIndex: ev.leafIndex, secretHash: ev.secretHash, resultHash: RECEIPT_RESULT_HASH, consistency: RECEIPT_CONSISTENCY });
  const tx = await portal.publishReceipt(origEmitterChain, origEmitter, ev.sequence, ev.contentFr, ev.key, ev.leafIndex, ev.secretHash, RECEIPT_RESULT_HASH, RECEIPT_CONSISTENCY, { value: fee, gasLimit: 1_000_000 });
  log("[evm] publishReceipt sent", tx.hash); const rcpt = await tx.wait(); log("[evm] publishReceipt mined", rcpt?.hash);
  const logs = (rcpt?.logs || []).filter((l: any) => String(l.address).toLowerCase() === PORTAL_ADDRESS.toLowerCase());
  for (const l of logs) { const t0 = Array.isArray(l.topics) && l.topics[0] ? String(l.topics[0]) : ""; if (t0.toLowerCase() === topicReceipt.toLowerCase()) { const decoded = portalIface.decodeEventLog("ReceiptPublished", l.data, l.topics) as any; const seq: ethers.BigNumber = decoded.sequence as ethers.BigNumber; log("[evm] ReceiptPublished", { sequence: seq.toString() }); return Number(seq.toString()); } }
  throw new Error("ReceiptPublished event not found");
}
async function postReceiptVaaToSolana_viaSdk(vaa: Buffer, payer: Keypair, wormholeProgramId: PublicKey): Promise<PublicKey> {
  const sdk: any = await import("@certusone/wormhole-sdk"); const { postVaaSolanaWithRetry, parseVaa } = sdk;
  await postVaaSolanaWithRetry(conn, { publicKey: payer.publicKey, signTransaction: async (tx: Transaction) => { tx.partialSign(payer); return tx; }, signAllTransactions: async (txs: Transaction[]) => { txs.forEach((t: Transaction) => t.partialSign(payer)); return txs; } }, wormholeProgramId.toBase58(), payer.publicKey.toBase58(), vaa, 5, "finalized");
  const parsed = parseVaa(vaa); const pda = derivePostedVaaPda(wormholeProgramId, parsed.hash); log("[sol] PostedVAA PDA", pda.toBase58()); return pda;
}
async function recordReceiptFromVaaOnSolana(postedVaa: PublicKey, wormholeProgramId: PublicKey, origSeq: bigint, payer: Keypair) {
  const cfgPda = deriveCfgPda(SOLANA_PROGRAM_ID); const emitter32 = Buffer.from(EVM_EMITTER_32, "hex"); const receiptPda = deriveReceiptPda(SOLANA_PROGRAM_ID, emitter32, origSeq);
  const ixData = buildRecordReceiptFromVaaIxData("0x" + EVM_EMITTER_32, origSeq);
  const keys = [
    { pubkey: cfgPda, isSigner: false, isWritable: true },
    { pubkey: postedVaa, isSigner: false, isWritable: false },
    { pubkey: wormholeProgramId, isSigner: false, isWritable: false },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const ix = new TransactionInstruction({ programId: SOLANA_PROGRAM_ID, keys, data: ixData });
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "finalized" });
  log("[sol] record_receipt_from_vaa sent", sig, { receiptPda: receiptPda.toBase58() });
}
async function recordReceiptDirectOnSolana(origSeq: bigint, payer: Keypair) {
  const cfgPda = deriveCfgPda(SOLANA_PROGRAM_ID); const emitter32 = Buffer.from(EVM_EMITTER_32, "hex"); const receiptPda = deriveReceiptPda(SOLANA_PROGRAM_ID, emitter32, origSeq);
  const ixData = buildRecordReceiptDirectIxData("0x" + EVM_EMITTER_32, origSeq);
  const keys = [
    { pubkey: cfgPda, isSigner: false, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const ix = new TransactionInstruction({ programId: SOLANA_PROGRAM_ID, keys, data: ixData });
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "finalized" });
  log("[sol] record_receipt_direct sent", sig, { receiptPda: receiptPda.toBase58() });
}
async function scanInboxEnqueued(fromBlock: number, toBlock: number): Promise<{ ev: InboxEnqueuedDecoded; blockNumber: number }[]> {
  const filter = { address: PORTAL_ADDRESS, topics: [topicEnq], fromBlock, toBlock };
  const logs = await evmProvider.getLogs(filter);
  const out: { ev: InboxEnqueuedDecoded; blockNumber: number }[] = [];
  for (const l of logs) { const dec = decodeInboxEnqueuedFromLogs([l]); for (const e of dec) out.push({ ev: e, blockNumber: Number((l as any).blockNumber) }); }
  return out.sort((a, b) => a.blockNumber - b.blockNumber);
}

/* receipt-state */
const RECEIPT_STATE_FILE = path.join(process.env.HOME || ".", ".zkcb", "receipt-state.json");
type ReceiptState = { lastEvmBlock: number };
function readReceiptState(currentEvmBlock: number): ReceiptState {
  try { const s = JSON.parse(fs.readFileSync(RECEIPT_STATE_FILE, "utf8")); log("[receipt-state] loaded", RECEIPT_STATE_FILE, s); if (typeof s.lastEvmBlock !== "number") throw new Error("bad receipt-state"); return s; }
  catch { const fallback = Math.max(0, currentEvmBlock - 50_000); const s = { lastEvmBlock: Number(opt("RECEIPT_FROM_BLOCK", String(fallback))) }; log("[receipt-state] init", RECEIPT_STATE_FILE, s); return s; }
}
function writeReceiptState(s: ReceiptState) { fs.mkdirSync(path.dirname(RECEIPT_STATE_FILE), { recursive: true }); fs.writeFileSync(RECEIPT_STATE_FILE, JSON.stringify(s, null, 2)); log("[receipt-state] saved", s); }

export async function runReceipt() {
  log("boot(receipt)", `portal=${PORTAL_ADDRESS}`, `emitter(sol)=0x${VAA_EMITTER_HEX}`, `emitter(evm32)=0x${EVM_EMITTER_32}`, `mode=${RECEIPT_MODE}`, `solRpc=${SOLANA_RPC_URL}`);
  const latestBlk = await evmProvider.getBlockNumber(); const rstate = readReceiptState(latestBlk); let fromBlock = rstate.lastEvmBlock; const payer = loadSolanaPayer();

  setInterval(async () => {
    try {
      const cur = await evmProvider.getBlockNumber(); if (cur < fromBlock) fromBlock = cur;
      const events = await scanInboxEnqueued(fromBlock + 1, cur);
      if (events.length === 0) { log("[receipt] no new InboxEnqueued", { fromBlock, cur }); return; }
      for (const { ev, blockNumber } of events) {
        const origSeqB = BigInt(ev.sequence);
        if (await isReceiptRecordedOnSolana(origSeqB)) { log("[receipt] already recorded on Solana; skip", ev.sequence); fromBlock = Math.max(fromBlock, blockNumber); continue; }
        if (RECEIPT_MODE === "direct") {
          try { await recordReceiptDirectOnSolana(origSeqB, payer); }
          catch (e) { warn("[receipt/direct] record_receipt_direct failed", String(e)); fromBlock = Math.max(fromBlock, blockNumber); continue; }
        } else {
          let wormholeProgramId: PublicKey;
          try { wormholeProgramId = new PublicKey(req("WORMHOLE_SOLANA_PROGRAM_ID")); }
          catch (e) { warn("[receipt/wormhole] missing WORMHOLE_SOLANA_PROGRAM_ID", String(e)); fromBlock = Math.max(fromBlock, blockNumber); continue; }
          let receiptEvmSeq: number | undefined;
          try { receiptEvmSeq = await publishReceiptOnEvm(ev); }
          catch (e) { warn("[receipt/wormhole] publishReceipt failed", String(e)); fromBlock = Math.max(fromBlock, blockNumber); continue; }
          let receiptVaa: Buffer | undefined;
          for (let i = 0; i < FETCH_VAA_RETRY_MAX; i++) {
            try { log("[receipt/wormhole] fetchVaa try", i + 1, { chain: RECEIPT_CHAIN, emitter: EVM_EMITTER_32, seq: receiptEvmSeq }); receiptVaa = await fetchVaa(RECEIPT_CHAIN, EVM_EMITTER_32, receiptEvmSeq!); break; }
            catch (e) { log("[receipt/wormhole] wait signed VAA", String(e)); await new Promise((r) => setTimeout(r, FETCH_VAA_RETRY_MS)); }
          }
          if (!receiptVaa) { warn("[receipt/wormhole] give up waiting signed receipt VAA for origSeq", ev.sequence); fromBlock = Math.max(fromBlock, blockNumber); continue; }
          let postedVaaPda: PublicKey | undefined;
          try { postedVaaPda = await postReceiptVaaToSolana_viaSdk(receiptVaa, payer, wormholeProgramId); }
          catch (e) { warn("[receipt/wormhole] postVAA to Solana failed", String(e)); fromBlock = Math.max(fromBlock, blockNumber); continue; }
          try { await recordReceiptFromVaaOnSolana(postedVaaPda, wormholeProgramId, origSeqB, payer); }
          catch (e) { warn("[receipt/wormhole] record_receipt_from_vaa failed", String(e)); fromBlock = Math.max(fromBlock, blockNumber); continue; }
        }
        fromBlock = Math.max(fromBlock, blockNumber); rstate.lastEvmBlock = fromBlock; writeReceiptState(rstate); log("[receipt] done origSeq", ev.sequence, "evmBlock", fromBlock);
      }
      if (fromBlock < cur) { fromBlock = cur; rstate.lastEvmBlock = fromBlock; writeReceiptState(rstate); }
    } catch (e) { warn("[receipt] loop error", String(e)); }
  }, POLL_MS);
  log("running(receipt)...");
}

/* job dispatcher */
function getJobArg(): "drain" | "receipt" { const i = process.argv.indexOf("--job"); if (i >= 0 && process.argv[i + 1]) { const v = String(process.argv[i + 1]).trim().toLowerCase(); if (v === "receipt") return "receipt"; return "drain"; } return "drain"; }
if (require.main === module) { const job = getJobArg(); (async () => { if (job === "receipt") { await runReceipt(); } else { await runDrain(); } })().catch((e) => { console.error(TS(), e); process.exit(1); }); }

/* compatibility export */
export { runDrain as runRelayer };
