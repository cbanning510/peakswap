import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import AGGREGATOR_ABI from './contracts/Aggregator.json';
import TOKEN_ABI      from './contracts/Token.json';

// ── Contract addresses from .env ──────────────────────────────────────────────
const AGGREGATOR_ADDRESS = import.meta.env.VITE_AGGREGATOR_ADDRESS;
const AMM1_ADDRESS       = import.meta.env.VITE_AMM1_ADDRESS;
const AMM2_ADDRESS       = import.meta.env.VITE_AMM2_ADDRESS;
const MUSD_ADDRESS       = import.meta.env.VITE_MUSD_ADDRESS;
const MDAPP_ADDRESS      = import.meta.env.VITE_MDAPP_ADDRESS;
const SEPOLIA_CHAIN_ID   = 11155111;

// ── Helpers ───────────────────────────────────────────────────────────────────
const shorten = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

const fmt = (bigVal, maxDec = 4) => {
  try {
    const n = parseFloat(ethers.formatUnits(bigVal, 18));
    if (n === 0) return '0.00';
    if (n > 0 && n < 0.0001) return '< 0.0001';
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: maxDec });
  } catch { return '0.00'; }
};

// Map an on-chain AMM address to its friendly brand name
const resolveAMMName = (addr) => {
  if (!addr) return 'Unknown AMM';
  const lower = addr.toLowerCase();
  if (AMM1_ADDRESS && lower === AMM1_ADDRESS.toLowerCase()) return 'Conduit Alpha';
  if (AMM2_ADDRESS && lower === AMM2_ADDRESS.toLowerCase()) return 'Conduit Beta';
  return shorten(addr);
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function App() {

  // ── Wallet ──────────────────────────────────────────────────────────────────
  const [signer,  setSigner]  = useState(null);
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(null);

  // ── Contracts ────────────────────────────────────────────────────────────────
  const [aggregator, setAggregator] = useState(null);
  const [musd,       setMusd]       = useState(null);
  const [mdapp,      setMdapp]      = useState(null);

  // ── Balances ─────────────────────────────────────────────────────────────────
  const [musdBal,  setMusdBal]  = useState(0n);
  const [mdappBal, setMdappBal] = useState(0n);

  // ── Swap form ─────────────────────────────────────────────────────────────────
  const [isToken1In, setIsToken1In] = useState(true);
  const [swapInput,  setSwapInput]  = useState('');
  const [slippage,   setSlippage]   = useState('0.5');

  // ── Quotes ────────────────────────────────────────────────────────────────────
  const [quotes, setQuotes] = useState({
    amm1Out: 0n, amm2Out: 0n, ready: false, fetching: false,
  });

  // ── Last route ────────────────────────────────────────────────────────────────
  const [lastRoute, setLastRoute] = useState(null);
  // lastRoute: { fromToken, toToken, amountIn, amountOut, winnerName,
  //              loserOut (BigInt), diffAbs (BigInt), diffPct, time }

  // ── Busy / toast ──────────────────────────────────────────────────────────────
  const [swapBusy,   setSwapBusy]   = useState(false);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [toast,      setToast]      = useState(null);
  const toastTimer = useRef(null);

  const notify = useCallback((msg, type = 'info') => {
    clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const isConnected  = Boolean(account);
  const isCorrectNet = chainId === SEPOLIA_CHAIN_ID;
  const fromToken    = isToken1In ? 'mUSD'  : 'mDAPP';
  const toToken      = isToken1In ? 'mDAPP' : 'mUSD';

  // Mirrors the contract's `useAmm1 = quote1 >= quote2` logic so the displayed
  // winner always matches what the contract will choose.
  const amm1Wins      = quotes.ready && quotes.amm1Out >= quotes.amm2Out;
  const bestOut       = amm1Wins ? quotes.amm1Out  : quotes.amm2Out;
  const loserOut      = amm1Wins ? quotes.amm2Out  : quotes.amm1Out;
  const diffAbs       = bestOut - loserOut;
  const diffPct       = loserOut > 0n ? Number((diffAbs * 10000n) / loserOut) / 100 : 0;
  const winnerName    = amm1Wins ? 'Conduit Alpha' : 'Conduit Beta';
  const hasValidQuote = quotes.ready && bestOut > 0n;
  const anyBusy       = swapBusy || faucetBusy;

  // ── Load balances ─────────────────────────────────────────────────────────────
  const loadBalances = useCallback(async () => {
    if (!musd || !mdapp || !account) return;
    try {
      const [mb, db] = await Promise.all([
        musd.balanceOf(account),
        mdapp.balanceOf(account),
      ]);
      setMusdBal(mb);
      setMdappBal(db);
    } catch (e) { console.error('loadBalances:', e); }
  }, [musd, mdapp, account]);

  // ── Init contracts ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!signer) { setAggregator(null); setMusd(null); setMdapp(null); return; }
    setAggregator(new ethers.Contract(AGGREGATOR_ADDRESS, AGGREGATOR_ABI, signer));
    setMusd(new ethers.Contract(MUSD_ADDRESS,  TOKEN_ABI, signer));
    setMdapp(new ethers.Contract(MDAPP_ADDRESS, TOKEN_ABI, signer));
  }, [signer]);

  useEffect(() => { loadBalances(); }, [loadBalances]);

  // ── Wallet connection ─────────────────────────────────────────────────────────
  const connectWallet = async () => {
    if (!window.ethereum) { notify('MetaMask not detected. Please install it.', 'error'); return; }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const _signer = await provider.getSigner();
      const net = await provider.getNetwork();
      setSigner(_signer);
      setAccount(await _signer.getAddress());
      setChainId(Number(net.chainId));
    } catch (e) { notify(e.message || 'Connection failed', 'error'); }
  };

  const switchToSepolia = async () => {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xaa36a7' }],
      });
    } catch (e) { notify(e.message || 'Could not switch network', 'error'); }
  };

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccounts = (accs) => {
      if (!accs.length) { setAccount(''); setSigner(null); }
      else setAccount(accs[0]);
    };
    const onChain = (id) => setChainId(parseInt(id, 16));
    window.ethereum.on('accountsChanged', onAccounts);
    window.ethereum.on('chainChanged',    onChain);
    return () => {
      window.ethereum.removeListener('accountsChanged', onAccounts);
      window.ethereum.removeListener('chainChanged',    onChain);
    };
  }, []);

  // ── Quote fetching (debounced 350 ms) ─────────────────────────────────────────
  useEffect(() => {
    const val = parseFloat(swapInput);
    if (!aggregator || !swapInput || isNaN(val) || val <= 0) {
      setQuotes({ amm1Out: 0n, amm2Out: 0n, ready: false, fetching: false });
      return;
    }

    setQuotes(q => ({ ...q, fetching: true, ready: false }));

    const timer = setTimeout(async () => {
      try {
        const tokenIn = isToken1In ? MUSD_ADDRESS : MDAPP_ADDRESS;
        const [q1, q2] = await aggregator.getQuotes(tokenIn, ethers.parseUnits(swapInput, 18));
        setQuotes({ amm1Out: q1, amm2Out: q2, ready: true, fetching: false });
      } catch {
        setQuotes({ amm1Out: 0n, amm2Out: 0n, ready: false, fetching: false });
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [aggregator, swapInput, isToken1In]);

  // ── Faucet ────────────────────────────────────────────────────────────────────
  const handleFaucet = async () => {
    setFaucetBusy(true);
    let musdOk = false, mdappOk = false;
    try { await (await musd.faucet()).wait();  musdOk  = true; } catch {}
    try { await (await mdapp.faucet()).wait(); mdappOk = true; } catch {}
    await loadBalances();
    if      (musdOk && mdappOk) notify('Received 1,000 mUSD and 1,000 mDAPP!', 'success');
    else if (musdOk)            notify('Received 1,000 mUSD. mDAPP is on cooldown.', 'info');
    else if (mdappOk)           notify('Received 1,000 mDAPP. mUSD is on cooldown.', 'info');
    else                        notify('Both tokens on cooldown. Try again in 24 hours.', 'error');
    setFaucetBusy(false);
  };

  // ── Swap ──────────────────────────────────────────────────────────────────────
  const handleSwap = async () => {
    if (!hasValidQuote || !swapInput || parseFloat(swapInput) <= 0) return;
    setSwapBusy(true);

    // Snapshot quotes at submission time (they update live while user is typing)
    const snapshotAmm1Out = quotes.amm1Out;
    const snapshotAmm2Out = quotes.amm2Out;
    const snapshotAmm1Wins = snapshotAmm1Out >= snapshotAmm2Out;
    const snapshotBest  = snapshotAmm1Wins ? snapshotAmm1Out : snapshotAmm2Out;
    const snapshotLoser = snapshotAmm1Wins ? snapshotAmm2Out : snapshotAmm1Out;

    try {
      const tokenIn  = isToken1In ? MUSD_ADDRESS : MDAPP_ADDRESS;
      const contract = isToken1In ? musd : mdapp;
      const amountIn = ethers.parseUnits(swapInput, 18);

      // Apply slippage to best quote
      const slippagePct = Math.max(0, Math.min(50, parseFloat(slippage) || 0.5));
      const slippageBps = BigInt(Math.round(slippagePct * 100));
      const minAmountOut = snapshotBest * (10000n - slippageBps) / 10000n;

      // Approve then swap
      await (await contract.approve(AGGREGATOR_ADDRESS, amountIn)).wait();
      const tx = await aggregator.swap(tokenIn, amountIn, minAmountOut);
      const receipt = await tx.wait();

      // Parse the on-chain Swap event for the exact output and chosen AMM
      const iface = new ethers.Interface(AGGREGATOR_ABI);
      let routeInfo = null;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed?.name === 'Swap') {
            const chosenName = resolveAMMName(parsed.args.chosenAMM);
            const actualOut  = parsed.args.amountOut;
            const diffA      = snapshotBest - snapshotLoser;
            const diffP      = snapshotLoser > 0n
              ? Number((diffA * 10000n) / snapshotLoser) / 100
              : 0;
            routeInfo = {
              fromToken,
              toToken,
              amountIn: swapInput,
              amountOut: ethers.formatUnits(actualOut, 18),
              winnerName: chosenName,
              loserName: snapshotAmm1Wins ? 'Conduit Beta' : 'Conduit Alpha',
              diffAbs: diffA,
              diffPct: diffP,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            };
          }
        } catch {}
      }

      await loadBalances();
      setSwapInput('');
      setQuotes({ amm1Out: 0n, amm2Out: 0n, ready: false, fetching: false });
      if (routeInfo) {
        setLastRoute(routeInfo);
        notify(`Swapped via ${routeInfo.winnerName} — received ${parseFloat(routeInfo.amountOut).toFixed(4)} ${toToken}`, 'success');
      } else {
        notify('Swap complete!', 'success');
      }
    } catch (e) {
      notify(e.reason || e.message || 'Swap failed', 'error');
    } finally {
      setSwapBusy(false);
    }
  };

  // ── AMM config for quote cards ────────────────────────────────────────────────
  const ammCards = [
    { name: 'Conduit Alpha', out: quotes.amm1Out, isWinner: amm1Wins },
    { name: 'Conduit Beta',  out: quotes.amm2Out, isWinner: !amm1Wins },
  ];

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── Header ── */}
      <header className="header">
        <div className="header-logo">
          <span className="logo-mark">⬡</span>
          <div className="logo-text">
            <span className="logo-name">Peakswap</span>
            <span className="logo-tag">Best price. Every swap.</span>
          </div>
        </div>
        <div className="header-right">
          <span className="network-pill">◉ Sepolia</span>
          {!isConnected ? (
            <button className="btn btn-primary" onClick={connectWallet}>Connect Wallet</button>
          ) : !isCorrectNet ? (
            <button className="btn btn-warn" onClick={switchToSepolia}>Switch to Sepolia</button>
          ) : (
            <button className="btn btn-address">{shorten(account)}</button>
          )}
        </div>
      </header>

      {/* ── Toast ── */}
      {toast && (
        <div className={`toast toast-${toast.type}`} onClick={() => setToast(null)}>
          {toast.msg}
        </div>
      )}

      {/* ── Not connected ── */}
      {!isConnected ? (
        <div className="centered">
          <div className="splash">
            <div className="splash-mark">⬡</div>
            <h2>Welcome to Peakswap</h2>
            <p>Connect your wallet to access the best swap rates across multiple liquidity pools on Sepolia testnet.</p>
            <button className="btn btn-primary btn-lg" onClick={connectWallet}>Connect Wallet</button>
          </div>
        </div>

      /* ── Wrong network ── */
      ) : !isCorrectNet ? (
        <div className="centered">
          <div className="splash">
            <h2>Wrong Network</h2>
            <p>Peakswap runs on Sepolia testnet. Please switch your network to continue.</p>
            <button className="btn btn-warn btn-lg" onClick={switchToSepolia}>Switch to Sepolia</button>
          </div>
        </div>

      /* ── Main UI ── */
      ) : (
        <main className="main">

          {/* Balances */}
          <section className="card bal-card">
            <div className="card-head">
              <h2 className="card-title">Your Balances</h2>
              <button className="btn btn-outline" onClick={handleFaucet} disabled={faucetBusy}>
                {faucetBusy ? 'Getting tokens…' : '⬇ Get Tokens'}
              </button>
            </div>
            <div className="bal-row">
              <div className="bal-item">
                <span className="bal-label">mUSD</span>
                <span className="bal-value">{fmt(musdBal)}</span>
              </div>
              <div className="bal-item">
                <span className="bal-label">mDAPP</span>
                <span className="bal-value">{fmt(mdappBal)}</span>
              </div>
            </div>
          </section>

          {/* Swap card */}
          <section className="swap-card">

            {/* Direction input */}
            <div className="field">
              <label className="label">You Pay</label>
              <div className="input-row">
                <span className="chip">{fromToken}</span>
                <input
                  className="input"
                  type="number"
                  placeholder="0.00"
                  min="0"
                  value={swapInput}
                  onChange={e => setSwapInput(e.target.value)}
                  disabled={anyBusy}
                />
              </div>
            </div>

            <button
              className="flip-btn"
              title="Flip direction"
              disabled={anyBusy}
              onClick={() => {
                setIsToken1In(v => !v);
                setSwapInput('');
                setQuotes({ amm1Out: 0n, amm2Out: 0n, ready: false, fetching: false });
              }}
            >⇅</button>

            <div className="field">
              <label className="label">You Receive</label>
              <div className="input-row">
                <span className="chip">{toToken}</span>
                <div className="input input-display">
                  {hasValidQuote
                    ? <>{fmt(bestOut, 6)} <span className="recv-token">{toToken}</span></>
                    : <span className="placeholder">—</span>}
                </div>
              </div>
            </div>

            {/* ── Quote comparison ── */}
            <div className="quotes-section">
              <div className="quotes-header">
                <span className="quotes-label">
                  {quotes.fetching ? '⟳ Fetching quotes…' : '◈ Live Quotes'}
                </span>
                {hasValidQuote && (
                  <span className="quotes-winner-pill">
                    Best: {winnerName}
                  </span>
                )}
              </div>

              {/* Empty state */}
              {!swapInput || parseFloat(swapInput) <= 0 ? (
                <div className="quotes-empty">
                  Enter an amount above to compare quotes from both liquidity pools
                </div>

              /* Loading skeletons */
              ) : quotes.fetching ? (
                <div className="quotes-grid">
                  <div className="quote-skeleton" />
                  <div className="quote-skeleton" />
                </div>

              /* Quote cards */
              ) : quotes.ready ? (
                <div className="quotes-grid">
                  {ammCards.map(({ name, out, isWinner }) => (
                    <div
                      key={name}
                      className={`quote-card ${isWinner ? 'quote-best' : 'quote-alt'}`}
                    >
                      <div className="quote-head">
                        <span className="quote-amm">{name}</span>
                        {isWinner && <span className="best-badge">✓ BEST</span>}
                      </div>

                      <div className="quote-amount-row">
                        <span className="quote-amount">{fmt(out, 6)}</span>
                        <span className="quote-unit">{toToken}</span>
                      </div>

                      {isWinner && diffAbs > 0n && (
                        <div className="quote-advantage">
                          +{fmt(diffAbs, 4)} more · +{diffPct.toFixed(2)}%
                        </div>
                      )}
                      {!isWinner && diffAbs > 0n && (
                        <div className="quote-disadvantage">
                          −{fmt(diffAbs, 4)} fewer tokens
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {/* ── Slippage ── */}
            <div className="slippage-row">
              <span className="slippage-label">Slippage Tolerance</span>
              <div className="slippage-controls">
                {['0.1', '0.5', '1.0'].map(v => (
                  <button
                    key={v}
                    className={`slippage-preset${slippage === v ? ' active' : ''}`}
                    onClick={() => setSlippage(v)}
                  >{v}%</button>
                ))}
                <div className="slippage-input-wrap">
                  <input
                    className="input slippage-input"
                    type="number"
                    min="0.01"
                    max="50"
                    step="0.1"
                    value={slippage}
                    onChange={e => setSlippage(e.target.value)}
                  />
                  <span className="slippage-pct">%</span>
                </div>
              </div>
            </div>

            {/* ── Swap button ── */}
            <button
              className="btn btn-swap btn-full"
              onClick={handleSwap}
              disabled={anyBusy || !hasValidQuote || !swapInput || parseFloat(swapInput) <= 0}
            >
              {swapBusy
                ? 'Routing swap…'
                : hasValidQuote
                  ? `Swap via ${winnerName} →`
                  : 'Enter amount to swap'}
            </button>
          </section>

          {/* ── Recent Route ── */}
          {lastRoute && (
            <section className="card route-card">
              <div className="route-header">
                <div className="route-title-row">
                  <span className="route-label">Last Route</span>
                  <span className="route-time">{lastRoute.time}</span>
                </div>
              </div>

              <div className="route-body">
                <div className="route-amounts">
                  <span className="route-from">
                    {parseFloat(lastRoute.amountIn).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    <span className="route-token"> {lastRoute.fromToken}</span>
                  </span>
                  <span className="route-arrow">→</span>
                  <span className="route-to">
                    {parseFloat(lastRoute.amountOut).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    <span className="route-token"> {lastRoute.toToken}</span>
                  </span>
                </div>

                <div className="route-meta">
                  <span className="route-via">
                    Routed via <strong>{lastRoute.winnerName}</strong>
                  </span>
                  {lastRoute.diffAbs > 0n && (
                    <span className="route-saved">
                      Saved {fmt(lastRoute.diffAbs, 4)} {lastRoute.toToken} vs {lastRoute.loserName} (+{lastRoute.diffPct.toFixed(2)}%)
                    </span>
                  )}
                </div>
              </div>
            </section>
          )}

        </main>
      )}

      <footer className="footer">
        Peakswap · Sepolia Testnet · Routing across Conduit Alpha &amp; Conduit Beta
      </footer>
    </div>
  );
}
