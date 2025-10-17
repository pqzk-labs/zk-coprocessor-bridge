// CLI entry that runs the relayer and posts a Wormhole message on Solana.

import "dotenv/config";
import { Command } from "commander";
import { runRelayer } from "./relayer";
import { sendOnce } from "./send";

const program = new Command();
program.name("zkcb").description("ZK Coprocessor Bridge CLI").version("0.1.0");

program
  .command("relayer")
  .description("Follow Solana → fetch VAA → Portal.consume (daemon)")
  .action(async () => { await runRelayer(); });

program
  .command("send")
  .description("Post a Wormhole message on Solana (devnet)")
  .option("--payload <str>", "utf8 payload", "hello aztec!")
  .action(async (o) => { await sendOnce(String(o.payload)); });

program.parseAsync().catch((e) => { console.error(e); process.exit(1); });
