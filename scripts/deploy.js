/**
 * Peakswap deployment script
 * ──────────────────────────
 * Deploys the full Peakswap system to the target network in order:
 *   1. Token (mUSD)       — mock USD, used as the "stable" side of each pool
 *   2. Token (mDAPP)      — mock DAPP token
 *   3. AMM #1             — seeded 2:1 (mUSD:mDAPP), so mDAPP is cheap here
 *   4. AMM #2             — seeded 1:2 (mUSD:mDAPP), so mDAPP is expensive here
 *   5. Aggregator         — routes swaps to whichever AMM gives the better rate
 *
 * How to run:
 *   npx hardhat run scripts/deploy.js --network sepolia
 *
 * Prerequisites:
 *   - Copy .env.example to .env and fill in ALCHEMY_API_URL and PRIVATE_KEY
 *   - Make sure your wallet has enough Sepolia ETH for gas
 */

import "dotenv/config";
import { network } from "hardhat";

const TOTAL_SUPPLY = 1_000_000n * 10n ** 18n; // 1,000,000 tokens

// AMM #1 — 2:1 ratio (mUSD:mDAPP)
const AMM1_MUSD  = 100_000n * 10n ** 18n;
const AMM1_MDAPP =  50_000n * 10n ** 18n;

// AMM #2 — 1:2 ratio (mUSD:mDAPP), opposite of AMM #1 so prices differ
const AMM2_MUSD  =  50_000n * 10n ** 18n;
const AMM2_MDAPP = 100_000n * 10n ** 18n;

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("Deploying with account:", deployer.address);
  console.log("─".repeat(52));

  // ── 1. Tokens ─────────────────────────────────────────────────────────────

  const Token = await ethers.getContractFactory("Token");

  const musd = await Token.deploy("mock USD", "mUSD", TOTAL_SUPPLY);
  await musd.waitForDeployment();
  console.log("mUSD deployed to:        ", await musd.getAddress());

  const mdapp = await Token.deploy("mock DAPP", "mDAPP", TOTAL_SUPPLY);
  await mdapp.waitForDeployment();
  console.log("mDAPP deployed to:       ", await mdapp.getAddress());

  // ── 2. AMMs ───────────────────────────────────────────────────────────────

  const AMM = await ethers.getContractFactory("AMM");
  const musdAddr  = await musd.getAddress();
  const mdappAddr = await mdapp.getAddress();

  const amm1 = await AMM.deploy(musdAddr, mdappAddr);
  await amm1.waitForDeployment();
  console.log("AMM #1 deployed to:      ", await amm1.getAddress());

  const amm2 = await AMM.deploy(musdAddr, mdappAddr);
  await amm2.waitForDeployment();
  console.log("AMM #2 deployed to:      ", await amm2.getAddress());

  // ── 3. Aggregator ─────────────────────────────────────────────────────────

  const Aggregator = await ethers.getContractFactory("Aggregator");
  const aggregator = await Aggregator.deploy(
    await amm1.getAddress(),
    await amm2.getAddress(),
  );
  await aggregator.waitForDeployment();
  console.log("Aggregator deployed to:  ", await aggregator.getAddress());

  // ── 4. Seed AMM #1 (100,000 mUSD + 50,000 mDAPP → 2:1 ratio) ────────────

  console.log("\nSeeding AMM #1 (2:1 ratio)...");
  await (await musd.approve(await amm1.getAddress(), AMM1_MUSD)).wait();
  await (await mdapp.approve(await amm1.getAddress(), AMM1_MDAPP)).wait();
  await (await amm1.addLiquidity(AMM1_MUSD, AMM1_MDAPP)).wait();
  console.log("AMM #1 seeded ✓");

  // ── 5. Seed AMM #2 (50,000 mUSD + 100,000 mDAPP → 1:2 ratio) ────────────

  console.log("Seeding AMM #2 (1:2 ratio)...");
  await (await musd.approve(await amm2.getAddress(), AMM2_MUSD)).wait();
  await (await mdapp.approve(await amm2.getAddress(), AMM2_MDAPP)).wait();
  await (await amm2.addLiquidity(AMM2_MUSD, AMM2_MDAPP)).wait();
  console.log("AMM #2 seeded ✓");

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n" + "═".repeat(52));
  console.log("DEPLOYED CONTRACT ADDRESSES");
  console.log("═".repeat(52));
  console.log("MUSD_ADDRESS=       ", await musd.getAddress());
  console.log("MDAPP_ADDRESS=      ", await mdapp.getAddress());
  console.log("AMM1_ADDRESS=       ", await amm1.getAddress());
  console.log("AMM2_ADDRESS=       ", await amm2.getAddress());
  console.log("AGGREGATOR_ADDRESS= ", await aggregator.getAddress());
  console.log("═".repeat(52));
  console.log("Paste the above into your frontend .env files.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
