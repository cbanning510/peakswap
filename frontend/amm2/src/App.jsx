import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import AMM_ABI   from './contracts/AMM.json';
import TOKEN_ABI from './contracts/Token.json';

const AMM_ADDRESS   = import.meta.env.VITE_AMM_ADDRESS;
const MUSD_ADDRESS  = import.meta.env.VITE_MUSD_ADDRESS;
const MDAPP_ADDRESS = import.meta.env.VITE_MDAPP_ADDRESS;
const SEPOLIA_CHAIN_ID = 11155111;

const shorten = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

const fmt = (bigVal, maxDec = 4) => {
  try {
    const n = parseFloat(ethers.formatUnits(bigVal, 18));
    if (n === 0) return '0.00';
    if (n > 0 && n < 0.0001) return '< 0.0001';
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: maxDec });
  } catch { return '0.00'; }
};

export default function App() {
  // ── Wallet ───────────────────────────────────────────────────────────────
  const [signer,  setSigner]  = useState(null);
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(null);

  // ── Contracts ────────────────────────────────────────────────────────────
  const [amm,   setAmm]   = useState(null);
  const [musd,  setMusd]  = useState(null);
  const [mdapp, setMdapp] = useState(null);

  // ── On-chain state ────────────────────────────────────────────────────────
  const [musdBal,    setMusdBal]    = useState(0n);
  const [mdappBal,   setMdappBal]   = useState(0n);
  const [userShares, setUserShares] = useState(0n);
  const [reserve1,   setReserve1]   = useState(0n);
  const [reserve2,   setReserve2]   = useState(0n);
  const [totalShares, setTotalShares] = useState(0n);

  // ── Swap form ─────────────────────────────────────────────────────────────
  const [isToken1In, setIsToken1In] = useState(true);
  const [swapInput,  setSwapInput]  = useState('');
  const [swapQuote,  setSwapQuote]  = useState('');
  const [swapBusy,   setSwapBusy]   = useState(false);

  // ── Liquidity form ────────────────────────────────────────────────────────
  const [liq1,      setLiq1]      = useState('');
  const [liq2,      setLiq2]      = useState('');
  const [removeAmt, setRemoveAmt] = useState('');
  const [liqBusy,   setLiqBusy]   = useState(false);

  // ── Faucet ────────────────────────────────────────────────────────────────
  const [faucetBusy, setFaucetBusy] = useState(false);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const notify = useCallback((msg, type = 'info') => {
    clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  const isConnected  = Boolean(account);
  const isCorrectNet = chainId === SEPOLIA_CHAIN_ID;

  // ── Load chain data ───────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!amm || !musd || !mdapp || !account) return;
    try {
      const [r1, r2, ts, sh, mb, db] = await Promise.all([
        amm.reserve1(),
        amm.reserve2(),
        amm.totalShares(),
        amm.shares(account),
        musd.balanceOf(account),
        mdapp.balanceOf(account),
      ]);
      setReserve1(r1); setReserve2(r2); setTotalShares(ts);
      setUserShares(sh); setMusdBal(mb); setMdappBal(db);
    } catch (e) { console.error('loadData:', e); }
  }, [amm, musd, mdapp, account]);

  // Rebuild contracts when signer changes
  useEffect(() => {
    if (!signer) { setAmm(null); setMusd(null); setMdapp(null); return; }
    setAmm(new ethers.Contract(AMM_ADDRESS, AMM_ABI, signer));
    setMusd(new ethers.Contract(MUSD_ADDRESS, TOKEN_ABI, signer));
    setMdapp(new ethers.Contract(MDAPP_ADDRESS, TOKEN_ABI, signer));
  }, [signer]);

  // Reload whenever contracts or account change
  useEffect(() => { loadData(); }, [loadData]);

  // ── Wallet connection ─────────────────────────────────────────────────────
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

  // Listen for MetaMask account / chain changes
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

  // ── Swap quote (debounced) ────────────────────────────────────────────────
  useEffect(() => {
    if (!amm || !swapInput || isNaN(swapInput) || parseFloat(swapInput) <= 0) {
      setSwapQuote(''); return;
    }
    const timer = setTimeout(async () => {
      try {
        const tokenIn = isToken1In ? MUSD_ADDRESS : MDAPP_ADDRESS;
        const out = await amm.getAmountOut(tokenIn, ethers.parseUnits(swapInput, 18));
        setSwapQuote(ethers.formatUnits(out, 18));
      } catch { setSwapQuote(''); }
    }, 300);
    return () => clearTimeout(timer);
  }, [amm, swapInput, isToken1In]);

  // ── Faucet ────────────────────────────────────────────────────────────────
  const handleFaucet = async () => {
    setFaucetBusy(true);
    let musdOk = false, mdappOk = false;
    try { await (await musd.faucet()).wait();  musdOk  = true; } catch {}
    try { await (await mdapp.faucet()).wait(); mdappOk = true; } catch {}
    await loadData();
    if      (musdOk && mdappOk) notify('Received 1,000 mUSD and 1,000 mDAPP!', 'success');
    else if (musdOk)            notify('Received 1,000 mUSD. mDAPP is on cooldown.', 'info');
    else if (mdappOk)           notify('Received 1,000 mDAPP. mUSD is on cooldown.', 'info');
    else                        notify('Both tokens are on cooldown. Try again in 24 hours.', 'error');
    setFaucetBusy(false);
  };

  // ── Swap ──────────────────────────────────────────────────────────────────
  const handleSwap = async () => {
    if (!swapInput || parseFloat(swapInput) <= 0) return;
    setSwapBusy(true);
    try {
      const tokenIn  = isToken1In ? MUSD_ADDRESS : MDAPP_ADDRESS;
      const contract = isToken1In ? musd : mdapp;
      const amountIn = ethers.parseUnits(swapInput, 18);
      await (await contract.approve(AMM_ADDRESS, amountIn)).wait();
      await (await amm.swap(tokenIn, amountIn)).wait();
      await loadData();
      setSwapInput(''); setSwapQuote('');
      notify('Swap complete!', 'success');
    } catch (e) { notify(e.reason || e.message || 'Swap failed', 'error'); }
    finally { setSwapBusy(false); }
  };

  // ── Liquidity: auto-calculate mDAPP from mUSD + current ratio ────────────
  const handleLiq1Change = (val) => {
    setLiq1(val);
    if (reserve1 > 0n && reserve2 > 0n && val && !isNaN(val) && parseFloat(val) > 0) {
      try {
        const a2 = (ethers.parseUnits(val, 18) * reserve2) / reserve1;
        setLiq2(parseFloat(ethers.formatUnits(a2, 18)).toFixed(6));
      } catch { setLiq2(''); }
    } else if (!val) { setLiq2(''); }
  };

  const handleAddLiquidity = async () => {
    if (!liq1 || !liq2) return;
    setLiqBusy(true);
    try {
      const a1 = ethers.parseUnits(liq1, 18);
      // Recompute a2 from BigInt to avoid float precision issues
      const a2 = reserve1 > 0n
        ? (a1 * reserve2) / reserve1
        : ethers.parseUnits(liq2, 18);
      await (await musd.approve(AMM_ADDRESS, a1)).wait();
      await (await mdapp.approve(AMM_ADDRESS, a2)).wait();
      await (await amm.addLiquidity(a1, a2)).wait();
      await loadData();
      setLiq1(''); setLiq2('');
      notify('Liquidity added!', 'success');
    } catch (e) { notify(e.reason || e.message || 'Add liquidity failed', 'error'); }
    finally { setLiqBusy(false); }
  };

  const handleRemoveLiquidity = async () => {
    if (!removeAmt || parseFloat(removeAmt) <= 0) return;
    setLiqBusy(true);
    try {
      await (await amm.removeLiquidity(ethers.parseUnits(removeAmt, 18))).wait();
      await loadData();
      setRemoveAmt('');
      notify('Liquidity removed!', 'success');
    } catch (e) { notify(e.reason || e.message || 'Remove liquidity failed', 'error'); }
    finally { setLiqBusy(false); }
  };

  const fromToken = isToken1In ? 'mUSD' : 'mDAPP';
  const toToken   = isToken1In ? 'mDAPP' : 'mUSD';
  const anyBusy   = swapBusy || liqBusy || faucetBusy;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* Header */}
      <header className="header">
        <div className="header-logo">
          <span className="logo-glyph">◈</span>
          <span className="logo-name">Conduit Exchange Beta</span>
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

      {/* Toast */}
      {toast && (
        <div className={`toast toast-${toast.type}`} onClick={() => setToast(null)}>
          {toast.msg}
        </div>
      )}

      {/* Not connected */}
      {!isConnected ? (
        <div className="centered">
          <div className="splash">
            <div className="splash-glyph">◈</div>
            <h2>Welcome to Conduit Exchange Beta</h2>
            <p>Swap tokens and provide liquidity on Sepolia testnet.</p>
            <button className="btn btn-primary btn-lg" onClick={connectWallet}>Connect Wallet</button>
          </div>
        </div>

      /* Wrong network */
      ) : !isCorrectNet ? (
        <div className="centered">
          <div className="splash">
            <h2>Wrong Network</h2>
            <p>Please switch to Sepolia testnet to continue.</p>
            <button className="btn btn-warn btn-lg" onClick={switchToSepolia}>Switch to Sepolia</button>
          </div>
        </div>

      /* Main UI */
      ) : (
        <main className="main">

          {/* Balances */}
          <section className="card">
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
              <div className="bal-item">
                <span className="bal-label">Pool Shares</span>
                <span className="bal-value">{fmt(userShares)}</span>
              </div>
            </div>
          </section>

          {/* Swap + Liquidity */}
          <div className="panels">

            {/* Swap */}
            <section className="card">
              <h2 className="card-title">Swap</h2>

              <div className="field">
                <label className="label">From</label>
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
                onClick={() => { setIsToken1In(v => !v); setSwapInput(''); setSwapQuote(''); }}
                disabled={anyBusy}
                title="Flip direction"
              >
                ⇅
              </button>

              <div className="field">
                <label className="label">To (estimated)</label>
                <div className="input-row">
                  <span className="chip">{toToken}</span>
                  <div className="input input-display">
                    {swapQuote
                      ? parseFloat(swapQuote).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
                      : <span className="placeholder">—</span>}
                  </div>
                </div>
              </div>

              <button
                className="btn btn-primary btn-full"
                onClick={handleSwap}
                disabled={anyBusy || !swapInput || parseFloat(swapInput) <= 0}
              >
                {swapBusy ? 'Swapping…' : `Swap ${fromToken} → ${toToken}`}
              </button>
            </section>

            {/* Liquidity */}
            <section className="card">
              <h2 className="card-title">Liquidity</h2>

              {/* Pool stats */}
              <div className="pool-stats">
                <div className="stat">
                  <span className="stat-label">mUSD Reserve</span>
                  <span className="stat-value">{fmt(reserve1)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">mDAPP Reserve</span>
                  <span className="stat-value">{fmt(reserve2)}</span>
                </div>
                <div className="stat stat-full">
                  <span className="stat-label">Total Pool Shares</span>
                  <span className="stat-value">{fmt(totalShares)}</span>
                </div>
              </div>

              <p className="section-div">Add Liquidity</p>

              <div className="field">
                <label className="label">mUSD Amount</label>
                <div className="input-row">
                  <span className="chip">mUSD</span>
                  <input
                    className="input"
                    type="number"
                    placeholder="0.00"
                    min="0"
                    value={liq1}
                    onChange={e => handleLiq1Change(e.target.value)}
                    disabled={anyBusy}
                  />
                </div>
              </div>

              <div className="field">
                <label className="label">
                  mDAPP Amount
                  {reserve1 > 0n && <span className="label-hint"> · auto-calculated from ratio</span>}
                </label>
                <div className="input-row">
                  <span className="chip">mDAPP</span>
                  <input
                    className={`input${reserve1 > 0n ? ' input-readonly' : ''}`}
                    type="number"
                    placeholder="0.00"
                    min="0"
                    value={liq2}
                    readOnly={reserve1 > 0n}
                    onChange={e => reserve1 === 0n && setLiq2(e.target.value)}
                    disabled={anyBusy}
                  />
                </div>
              </div>

              <button
                className="btn btn-primary btn-full"
                onClick={handleAddLiquidity}
                disabled={anyBusy || !liq1 || !liq2}
              >
                {liqBusy ? 'Processing…' : 'Add Liquidity'}
              </button>

              <p className="section-div">Remove Liquidity</p>

              <div className="field">
                <label className="label">
                  Shares to Burn
                  <span className="label-hint"> · you have {fmt(userShares, 2)}</span>
                </label>
                <input
                  className="input"
                  type="number"
                  placeholder="0.00"
                  min="0"
                  value={removeAmt}
                  onChange={e => setRemoveAmt(e.target.value)}
                  disabled={anyBusy}
                />
              </div>

              <button
                className="btn btn-danger btn-full"
                onClick={handleRemoveLiquidity}
                disabled={anyBusy || !removeAmt || parseFloat(removeAmt) <= 0}
              >
                {liqBusy ? 'Processing…' : 'Remove Liquidity'}
              </button>
            </section>
          </div>
        </main>
      )}

      <footer className="footer">
        Conduit Exchange Beta · Sepolia Testnet · Powered by Peakswap
      </footer>
    </div>
  );
}
