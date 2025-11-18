import "dotenv/config";
import { Command } from "commander";
import { ethers } from "ethers";
import { spawn } from "child_process";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PORTAL = need("PORTAL_ADDRESS");
const PK = need("PRIVATE_KEY");
const AZTEC_CONTRACT = need("AZTEC_CONTRACT");
const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL || "http://127.0.0.1:8080";
const AZTEC_FROM = process.env.AZTEC_FROM || "accounts:test0";
const AZTEC_PAYMENT = process.env.AZTEC_PAYMENT || "method=fee_juice,feePayer=test0";
const AZTEC_WALLET_BIN = process.env.AZTEC_WALLET_BIN || "aztec-wallet";

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PK, provider);

const portalAbi = [
  "function setAztecEndpoints(address,bytes32,uint256)",
  "function devConsume(bytes,bytes32) returns (bytes32,uint64)",
  "event InboxEnqueued(bytes32 indexed,uint64 indexed,bytes32,bytes32,uint256,bytes32)"
];
const portal = new ethers.Contract(PORTAL, portalAbi, wallet);

function need(n: string) { const v = process.env[n]; if (!v) throw new Error(`Missing env ${n}`); return v.trim(); }
function hex32(n: bigint | string | number) { return ethers.utils.hexZeroPad("0x" + BigInt(n).toString(16), 32); }
async function computeSecret(secret?: string) {
  try {
    const { Fr, computeSecretHash }: any = await import("@aztec/aztec.js");
    const fr = secret ? Fr.fromString(secret) : Fr.random();
    const h = await computeSecretHash(fr);
    return { frHex: hex32(fr.toString()), hHex: hex32(h.toString()) };
  } catch {
    const frHex = secret ?? ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const hHex = hex32(BigInt(ethers.utils.keccak256(frHex)).toString());
    return { frHex, hHex };
  }
}
function runAztecWallet(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(AZTEC_WALLET_BIN, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`aztec-wallet exited ${c}`))));
  });
}

const cli = new Command();
cli.name("sandbox").version("0.1.0");

cli.command("configure")
  .requiredOption("--inbox <addr>")
  .requiredOption("--l2 <addr32>")
  .requiredOption("--rollup <n>")
  .action(async (o) => {
    const tx = await portal.setAztecEndpoints(String(o.inbox), String(o.l2), String(o.rollup));
    console.log(tx.hash);
    await tx.wait();
  });

cli.command("enqueue")
  .option("--payload <str>", "utf8", "hello aztec! (sandbox)")
  .option("--secret-fr <hex32>")
  .action(async (o) => {
    const bytes = ethers.utils.toUtf8Bytes(String(o.payload));
    const { frHex, hHex } = await computeSecret(o.secretFr);
    const tx = await portal.devConsume(bytes, hHex, { gasLimit: 1_000_000 });
    const rc = await tx.wait();

    const iface = new ethers.utils.Interface(portalAbi);
    let out: any;
    for (const l of rc.logs) {
      try {
        const ev = iface.parseLog(l);
        if (ev.name === "InboxEnqueued") {
          out = {
            contentFr: ev.args[2],
            leafIndex: ev.args[4].toString(),
            secretHash: ev.args[5],
            secretFr: frHex
          };
        }
      } catch {}
    }
    if (!out) throw new Error("InboxEnqueued not found");
    console.log(JSON.stringify(out, null, 2));
  });

cli.command("consume")
  .requiredOption("--content-fr <hex32>")
  .requiredOption("--leaf-index <n>")
  .requiredOption("--secret-fr <hex32>")
  .option("--retries <n>", "10")
  .option("--sleep-ms <n>", "3000")
  .action(async (o) => {
    const args = [
      "send", "consume_from_inbox",
      "-ca", AZTEC_CONTRACT,
      "--args", String(o.contentFr), String(o.leafIndex), String(o.secretFr),
      "--node-url", AZTEC_NODE_URL,
      "--from", AZTEC_FROM,
      "--payment", AZTEC_PAYMENT
    ];
    const max = Number(o.retries), ms = Number(o.sleepMs);
    for (let i = 0; i < max; i++) {
      try { await runAztecWallet(args); return; }
      catch (e: any) {
        if (/nonexistent L1-to-L2 message/i.test(String(e)) && i < max - 1) {
          await new Promise(r => setTimeout(r, ms)); continue;
        }
        throw e;
      }
    }
  });

cli.parseAsync().catch((e) => { console.error(e); process.exit(1); });
