// Compile SettlementEvidenceRegistry and (optionally) deploy it to Ethereum SEPOLIA testnet.
//
//   node contracts/deploy.mjs                                   compile + dry run, nothing sent
//   PRIVATE_KEY=0x... CONFIRM_TESTNET=yes node contracts/deploy.mjs --send
//   ... --forwarder 0x...                                       production KeystoneForwarder
//
// Default forwarder: the Sepolia MockKeystoneForwarder used by `cre workflow simulate --broadcast`.
// The key is read from PRIVATE_KEY only and never printed. Refuses any chain id other than 11155111.
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const solc = createRequire(import.meta.url)("solc");
const RPC = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111n;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SEND = argv.includes("--send");
const MOCK_FORWARDER = "0x15fC6ae953E024d975e77382eEeC56A9101f9F88";
const forwarder = ethers.getAddress(arg("--forwarder", MOCK_FORWARDER));
if (SEND && process.env.CONFIRM_TESTNET !== "yes") { console.error("Refusing: --send needs CONFIRM_TESTNET=yes"); process.exit(2); }

const NAME = "SettlementEvidenceRegistry";
export function compile() {
  const source = readFileSync(path.join(HERE, `${NAME}.sol`), "utf8");
  const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { [`${NAME}.sol`]: { content: source } }, settings })));
  const err = (out.errors || []).find((e) => e.severity === "error");
  if (err) throw new Error(err.formattedMessage);
  const c = out.contracts[`${NAME}.sol`][NAME];
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}`, solc: solc.version() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = compile();
  mkdirSync(path.join(HERE, "build"), { recursive: true });
  writeFileSync(path.join(HERE, "build", `${NAME}.json`), JSON.stringify(built, null, 1) + "\n");
  console.log(`compiled with solc ${built.solc}, ${(built.bytecode.length - 2) / 2} bytes; forwarder ${forwarder}`);
  if (!SEND) { console.log("DRY RUN. Set PRIVATE_KEY and CONFIRM_TESTNET=yes and add --send to deploy on Sepolia."); process.exit(0); }
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: ethers.Network.from(CHAIN_ID) });
  if (BigInt(await provider.send("eth_chainId", [])) !== CHAIN_ID) throw new Error("RPC is not Sepolia (11155111)");
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const factory = new ethers.ContractFactory(built.abi, built.bytecode, wallet);
  const c = await factory.deploy(forwarder);
  const r = await c.deploymentTransaction().wait();
  console.log(`deployed ${NAME} at ${await c.getAddress()} (tx ${r.hash}, block ${r.blockNumber})`);
  console.log(`set write.receiverAddress in settlement-evidence/config.staging.json to ${await c.getAddress()}`);
}
