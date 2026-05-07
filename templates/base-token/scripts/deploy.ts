import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

// Base (chain 8453) only
const CHAIN_ID = 8453;
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

if (!DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY env var required");

// Token config — edit these
const TOKEN_NAME    = "{{PROJECT_NAME}} Token";
const TOKEN_SYMBOL  = "TKN"; // change this
const INITIAL_SUPPLY = ethers.parseUnits("100000000", 18); // 100M tokens

async function deploy() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  const network = await provider.getNetwork();

  if (network.chainId !== BigInt(CHAIN_ID)) {
    throw new Error(`Wrong network. Expected Base (${CHAIN_ID}), got chain ${network.chainId}`);
  }

  const wallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY!, provider);
  console.log(`Deploying from: ${wallet.address}`);
  console.log(`Network: Base mainnet (chain ${CHAIN_ID})\n`);

  // Load compiled artifact
  const artifactPath = path.join(process.cwd(), "out", "Token.sol", "{{PROJECT_NAME}}Token.json");
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found at ${artifactPath}. Run: forge build`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);

  console.log("Deploying token...");
  const contract = await factory.deploy(TOKEN_NAME, TOKEN_SYMBOL, wallet.address, INITIAL_SUPPLY);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`\nToken deployed to: ${address}`);
  console.log(`Verify on Basescan: https://basescan.org/address/${address}`);
  console.log(`\nVerify with Foundry:`);
  console.log(`forge verify-contract ${address} contracts/Token.sol:{{PROJECT_NAME}}Token --chain-id ${CHAIN_ID} --watch`);
}

deploy().catch((err) => { console.error(err); process.exit(1); });
