import { expect } from "chai";
import { network } from "hardhat";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MUSD_SUPPLY  = 1_000_000n * 10n ** 18n;
const MDAPP_SUPPLY = 1_000_000n * 10n ** 18n;

// AMM1 ratio: 1 mUSD : 2 mDAPP  (more mDAPP per mUSD → better rate for mUSD→mDAPP)
const AMM1_MUSD  = 10_000n * 10n ** 18n;
const AMM1_MDAPP = 20_000n * 10n ** 18n;

// AMM2 ratio: 1 mUSD : 1.5 mDAPP
const AMM2_MUSD  = 10_000n * 10n ** 18n;
const AMM2_MDAPP = 15_000n * 10n ** 18n;

// ---------------------------------------------------------------------------
// One isolated in-process chain per test suite.
// network.create() must be awaited at the file's top level (ESM top-level
// await is fine; await inside a plain describe() callback is not).
// ---------------------------------------------------------------------------

const { ethers: tokenEthers }       = await network.create();
const { ethers: ammEthers }         = await network.create();
const { ethers: aggregatorEthers }  = await network.create();

// ============================================================================
// Token
// ============================================================================

describe("Token", function () {
  it("deployer receives the full mUSD total supply", async function () {
    const [deployer] = await tokenEthers.getSigners();
    const Token = await tokenEthers.getContractFactory("Token");
    const musd = await Token.deploy("Mock USD", "mUSD", MUSD_SUPPLY);

    expect(await musd.totalSupply()).to.equal(MUSD_SUPPLY);
    expect(await musd.balanceOf(deployer.address)).to.equal(MUSD_SUPPLY);
  });

  it("deployer receives the full mDAPP total supply", async function () {
    const [deployer] = await tokenEthers.getSigners();
    const Token = await tokenEthers.getContractFactory("Token");
    const mdapp = await Token.deploy("Mock DAPP", "mDAPP", MDAPP_SUPPLY);

    expect(await mdapp.totalSupply()).to.equal(MDAPP_SUPPLY);
    expect(await mdapp.balanceOf(deployer.address)).to.equal(MDAPP_SUPPLY);
  });

  it("name and symbol are set correctly", async function () {
    const Token = await tokenEthers.getContractFactory("Token");
    const musd = await Token.deploy("Mock USD", "mUSD", MUSD_SUPPLY);

    expect(await musd.name()).to.equal("Mock USD");
    expect(await musd.symbol()).to.equal("mUSD");
  });
});

// ============================================================================
// AMM
// ============================================================================

describe("AMM", function () {
  // ── helpers ─────────────────────────────────────────────────────────────

  async function deployAMM() {
    const [deployer, user] = await ammEthers.getSigners();
    const Token = await ammEthers.getContractFactory("Token");
    const AMM   = await ammEthers.getContractFactory("AMM");

    const musd  = await Token.deploy("Mock USD",  "mUSD",  MUSD_SUPPLY);
    const mdapp = await Token.deploy("Mock DAPP", "mDAPP", MDAPP_SUPPLY);
    const amm   = await AMM.deploy(await musd.getAddress(), await mdapp.getAddress());

    // Fund user
    await musd.transfer(user.address,  100_000n * 10n ** 18n);
    await mdapp.transfer(user.address, 100_000n * 10n ** 18n);

    return { musd, mdapp, amm, deployer, user };
  }

  async function deployAMMWithLiquidity() {
    const ctx = await deployAMM();
    const { musd, mdapp, amm } = ctx;
    const ammAddr = await amm.getAddress();

    await musd.approve(ammAddr, AMM1_MUSD);
    await mdapp.approve(ammAddr, AMM1_MDAPP);
    await amm.addLiquidity(AMM1_MUSD, AMM1_MDAPP);

    return ctx;
  }

  // ── deployment ───────────────────────────────────────────────────────────

  it("stores correct token addresses after deploy", async function () {
    const { musd, mdapp, amm } = await deployAMM();

    expect(await amm.token1()).to.equal(await musd.getAddress());
    expect(await amm.token2()).to.equal(await mdapp.getAddress());
  });

  it("reverts when both token addresses are identical", async function () {
    const { musd } = await deployAMM();
    const AMM      = await ammEthers.getContractFactory("AMM");
    const musdAddr = await musd.getAddress();

    await expect(AMM.deploy(musdAddr, musdAddr)).to.be.revertedWith(
      "AMM: identical tokens",
    );
  });

  // ── addLiquidity ─────────────────────────────────────────────────────────

  it("addLiquidity: reserves update correctly after first deposit", async function () {
    const { musd, mdapp, amm } = await deployAMM();
    const ammAddr = await amm.getAddress();

    await musd.approve(ammAddr, AMM1_MUSD);
    await mdapp.approve(ammAddr, AMM1_MDAPP);
    await amm.addLiquidity(AMM1_MUSD, AMM1_MDAPP);

    expect(await amm.reserve1()).to.equal(AMM1_MUSD);
    expect(await amm.reserve2()).to.equal(AMM1_MDAPP);
  });

  it("addLiquidity: mints shares to the liquidity provider", async function () {
    const { musd, mdapp, amm, deployer } = await deployAMM();
    const ammAddr = await amm.getAddress();

    await musd.approve(ammAddr, AMM1_MUSD);
    await mdapp.approve(ammAddr, AMM1_MDAPP);
    await amm.addLiquidity(AMM1_MUSD, AMM1_MDAPP);

    const deployerShares = await amm.shares(deployer.address);
    expect(deployerShares).to.be.greaterThan(0n);
    expect(await amm.totalShares()).to.equal(deployerShares);
  });

  it("addLiquidity: emits AddLiquidity event", async function () {
    const { musd, mdapp, amm } = await deployAMM();
    const ammAddr = await amm.getAddress();

    await musd.approve(ammAddr, AMM1_MUSD);
    await mdapp.approve(ammAddr, AMM1_MDAPP);

    await expect(amm.addLiquidity(AMM1_MUSD, AMM1_MDAPP))
      .to.emit(amm, "AddLiquidity");
  });

  it("addLiquidity: reverts on second deposit if ratio does not match", async function () {
    const { musd, mdapp, amm, user } = await deployAMMWithLiquidity();
    const ammAddr = await amm.getAddress();

    const badMdapp = AMM1_MDAPP + 1n; // off by one → wrong ratio
    await musd.connect(user).approve(ammAddr, AMM1_MUSD);
    await mdapp.connect(user).approve(ammAddr, badMdapp);

    await expect(
      amm.connect(user).addLiquidity(AMM1_MUSD, badMdapp),
    ).to.be.revertedWith("AMM: amounts must match current ratio");
  });

  // ── removeLiquidity ──────────────────────────────────────────────────────

  it("removeLiquidity: returns tokens proportionally and burns shares", async function () {
    const { musd, mdapp, amm, deployer } = await deployAMMWithLiquidity();

    const sharesBefore = await amm.shares(deployer.address);
    const musdBefore   = await musd.balanceOf(deployer.address);
    const mdappBefore  = await mdapp.balanceOf(deployer.address);

    await amm.removeLiquidity(sharesBefore);

    expect(await amm.shares(deployer.address)).to.equal(0n);
    expect(await musd.balanceOf(deployer.address)).to.be.greaterThan(musdBefore);
    expect(await mdapp.balanceOf(deployer.address)).to.be.greaterThan(mdappBefore);
  });

  it("removeLiquidity: reverts if caller has no shares", async function () {
    const { amm, user } = await deployAMMWithLiquidity();

    await expect(amm.connect(user).removeLiquidity(1n)).to.be.revertedWith(
      "AMM: insufficient shares",
    );
  });

  // ── swap ─────────────────────────────────────────────────────────────────

  it("swap token1→token2: user receives mDAPP and reserves update", async function () {
    const { musd, mdapp, amm, user } = await deployAMMWithLiquidity();
    const ammAddr    = await amm.getAddress();
    const musdAddr   = await musd.getAddress();
    const swapAmount = 1_000n * 10n ** 18n;

    const mdappBefore    = await mdapp.balanceOf(user.address);
    const reserve1Before = await amm.reserve1();
    const reserve2Before = await amm.reserve2();

    await musd.connect(user).approve(ammAddr, swapAmount);
    await amm.connect(user).swap(musdAddr, swapAmount);

    expect(await mdapp.balanceOf(user.address)).to.be.greaterThan(mdappBefore);
    expect(await amm.reserve1()).to.equal(reserve1Before + swapAmount);
    expect(await amm.reserve2()).to.be.lessThan(reserve2Before);
  });

  it("swap token2→token1: user receives mUSD and reserves update", async function () {
    const { musd, mdapp, amm, user } = await deployAMMWithLiquidity();
    const ammAddr    = await amm.getAddress();
    const mdappAddr  = await mdapp.getAddress();
    const swapAmount = 1_000n * 10n ** 18n;

    const musdBefore     = await musd.balanceOf(user.address);
    const reserve1Before = await amm.reserve1();
    const reserve2Before = await amm.reserve2();

    await mdapp.connect(user).approve(ammAddr, swapAmount);
    await amm.connect(user).swap(mdappAddr, swapAmount);

    expect(await musd.balanceOf(user.address)).to.be.greaterThan(musdBefore);
    expect(await amm.reserve2()).to.equal(reserve2Before + swapAmount);
    expect(await amm.reserve1()).to.be.lessThan(reserve1Before);
  });

  it("swap: emits Swap event with correct tokenIn and amounts", async function () {
    const { musd, amm, user } = await deployAMMWithLiquidity();
    const ammAddr    = await amm.getAddress();
    const musdAddr   = await musd.getAddress();
    const swapAmount = 500n * 10n ** 18n;

    await musd.connect(user).approve(ammAddr, swapAmount);

    await expect(amm.connect(user).swap(musdAddr, swapAmount))
      .to.emit(amm, "Swap")
      .withArgs(user.address, musdAddr, swapAmount, (out: bigint) => out > 0n);
  });

  it("swap: reverts with an invalid token address", async function () {
    const { amm, user } = await deployAMMWithLiquidity();
    const dead = "0x000000000000000000000000000000000000dEaD";

    await expect(amm.connect(user).swap(dead, 1n * 10n ** 18n)).to.be.revertedWith(
      "AMM: invalid token",
    );
  });

  it("swap: reverts with zero amountIn", async function () {
    const { musd, amm, user } = await deployAMMWithLiquidity();
    const musdAddr = await musd.getAddress();

    await expect(amm.connect(user).swap(musdAddr, 0n)).to.be.revertedWith(
      "AMM: amountIn must be > 0",
    );
  });

  // ── getAmountOut ─────────────────────────────────────────────────────────

  it("getAmountOut: returns a non-zero quote when pool has liquidity", async function () {
    const { musd, amm } = await deployAMMWithLiquidity();
    const musdAddr = await musd.getAddress();

    const quote = await amm.getAmountOut(musdAddr, 1_000n * 10n ** 18n);
    expect(quote).to.be.greaterThan(0n);
  });
});

// ============================================================================
// Aggregator
// ============================================================================

describe("Aggregator", function () {
  // ── helpers ─────────────────────────────────────────────────────────────

  async function deployAll() {
    const [deployer, user] = await aggregatorEthers.getSigners();
    const Token      = await aggregatorEthers.getContractFactory("Token");
    const AMM        = await aggregatorEthers.getContractFactory("AMM");
    const Aggregator = await aggregatorEthers.getContractFactory("Aggregator");

    const musd  = await Token.deploy("Mock USD",  "mUSD",  MUSD_SUPPLY);
    const mdapp = await Token.deploy("Mock DAPP", "mDAPP", MDAPP_SUPPLY);

    const musdAddr  = await musd.getAddress();
    const mdappAddr = await mdapp.getAddress();

    // Two pools — same tokens, different ratios
    const amm1 = await AMM.deploy(musdAddr, mdappAddr);
    const amm2 = await AMM.deploy(musdAddr, mdappAddr);

    await musd.approve(await amm1.getAddress(), AMM1_MUSD);
    await mdapp.approve(await amm1.getAddress(), AMM1_MDAPP);
    await amm1.addLiquidity(AMM1_MUSD, AMM1_MDAPP);

    await musd.approve(await amm2.getAddress(), AMM2_MUSD);
    await mdapp.approve(await amm2.getAddress(), AMM2_MDAPP);
    await amm2.addLiquidity(AMM2_MUSD, AMM2_MDAPP);

    const aggregator = await Aggregator.deploy(
      await amm1.getAddress(),
      await amm2.getAddress(),
    );
    const aggregatorAddr = await aggregator.getAddress();

    // Fund user and pre-approve the Aggregator
    const userAmount = 10_000n * 10n ** 18n;
    await musd.transfer(user.address, userAmount);
    await mdapp.transfer(user.address, userAmount);
    await musd.connect(user).approve(aggregatorAddr, userAmount);
    await mdapp.connect(user).approve(aggregatorAddr, userAmount);

    return { musd, mdapp, amm1, amm2, aggregator, deployer, user };
  }

  // ── deployment ───────────────────────────────────────────────────────────

  it("stores both AMM addresses after deployment", async function () {
    const { amm1, amm2, aggregator } = await deployAll();

    expect(await aggregator.amm1()).to.equal(await amm1.getAddress());
    expect(await aggregator.amm2()).to.equal(await amm2.getAddress());
  });

  // ── getQuotes ────────────────────────────────────────────────────────────

  it("getQuotes: returns two non-zero quotes", async function () {
    const { musd, aggregator } = await deployAll();
    const musdAddr = await musd.getAddress();

    const [q1, q2] = await aggregator.getQuotes(musdAddr, 1_000n * 10n ** 18n);

    expect(q1).to.be.greaterThan(0n);
    expect(q2).to.be.greaterThan(0n);
  });

  it("getQuotes: AMM1 (1:2) quotes more mDAPP than AMM2 (1:1.5)", async function () {
    const { musd, aggregator } = await deployAll();
    const musdAddr = await musd.getAddress();

    const [q1, q2] = await aggregator.getQuotes(musdAddr, 1_000n * 10n ** 18n);

    expect(q1).to.be.greaterThan(q2);
  });

  // ── swap routing ─────────────────────────────────────────────────────────

  it("swap: routes to the better AMM and emits Swap event with correct AMM address", async function () {
    const { musd, mdapp, amm1, aggregator, user } = await deployAll();
    const musdAddr  = await musd.getAddress();
    const mdappAddr = await mdapp.getAddress();
    const swapAmount = 500n * 10n ** 18n;

    await expect(aggregator.connect(user).swap(musdAddr, swapAmount, 0n))
      .to.emit(aggregator, "Swap")
      .withArgs(
        user.address,
        musdAddr,
        mdappAddr,
        await amm1.getAddress(), // AMM1 offers better rate
        swapAmount,
        (out: bigint) => out > 0n,
      );
  });

  it("swap: user balance increases by the exact quoted amount", async function () {
    const { musd, mdapp, aggregator, user } = await deployAll();
    const musdAddr   = await musd.getAddress();
    const swapAmount = 200n * 10n ** 18n;

    const [bestQuote] = await aggregator.getQuotes(musdAddr, swapAmount);
    const mdappBefore = await mdapp.balanceOf(user.address);

    await aggregator.connect(user).swap(musdAddr, swapAmount, 0n);

    expect(await mdapp.balanceOf(user.address)).to.equal(mdappBefore + bestQuote);
  });

  // ── slippage protection ──────────────────────────────────────────────────

  it("swap: reverts when minAmountOut exceeds the best available quote", async function () {
    const { musd, aggregator, user } = await deployAll();
    const musdAddr   = await musd.getAddress();
    const swapAmount = 500n * 10n ** 18n;

    const [q1, q2]   = await aggregator.getQuotes(musdAddr, swapAmount);
    const impossibleMin = (q1 > q2 ? q1 : q2) + 1n;

    await expect(
      aggregator.connect(user).swap(musdAddr, swapAmount, impossibleMin),
    ).to.be.revertedWith("Aggregator: slippage exceeded");
  });

  it("swap: succeeds when minAmountOut equals the best quote exactly", async function () {
    const { musd, aggregator, user } = await deployAll();
    const musdAddr   = await musd.getAddress();
    const swapAmount = 500n * 10n ** 18n;

    const [q1, q2] = await aggregator.getQuotes(musdAddr, swapAmount);
    const exactMin  = q1 > q2 ? q1 : q2;

    // Simply awaiting the call — if it reverts the test will throw and fail
    await aggregator.connect(user).swap(musdAddr, swapAmount, exactMin);
  });
});
