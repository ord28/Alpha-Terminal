/**
 * app.js - UI logic only
 * Handles: wallet, prices, URL parsing, collection fetching,
 * task queue, sniper, theme toggle
 */

'use strict';

const OPENSEA_API_KEY = '5ba47a8af05f4082a613832c2dc30bcc';
const OPENSEA_HEADERS = { 'Accept': 'application/json', 'x-api-key': OPENSEA_API_KEY };

import {
  executeMint, detectPrice, createPrivateKeySigner, getPrivateKeyAddress,
  fetchABI, findMintFunctions
} from './mintEngine.js?v=20260605';
// NOTE: mintEngine.js does not export batchMint(); per the "treat as import / do not
// modify" constraint, the batch loop below is orchestrated in app.js on top of the
// real executeMint() export (one signed tx per call).

const $ = id => document.getElementById(id);

const S = {
  provider: null, signer: null, addr: null,
  ethPrice: 0, gasPrice: 0,
  tasks: [], mode: 'manual', pending: null,
  pkMode: false  // true when using private key instead of MetaMask
};

const COL = {
  contract: null, name: '', price: 0, floor: 0,
  supply: 0, minted: 0, slug: '', platform: '',
  phases: [], soldOut: false
};

let _prevEth = 0;

async function loadPrices() {
  try {
    const c = JSON.parse(localStorage.getItem('mb_p') || '{}');
    if (c.eth) _setEth(c.eth);
  } catch(e) {}
  try {
    const r = await Promise.race([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'),
      new Promise((_, rej) => setTimeout(rej, 5000))
    ]);
    const d = await r.json();
    _setEth(d.ethereum.usd);
    localStorage.setItem('mb_p', JSON.stringify({ eth: d.ethereum.usd }));
  } catch(e) {
    try {
      const r = await fetch('https://api.coincap.io/v2/assets/ethereum');
      const d = await r.json();
      _setEth(parseFloat(d.data.priceUsd));
    } catch(e2) {}
  }
}

function _setEth(p) {
  const el = $('ethP');
  if (!el || !p) return;
  const up = p > _prevEth;
  el.textContent = '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (_prevEth && p !== _prevEth) {
    el.className = 'tb-v ' + (up ? 'up' : 'down');
    setTimeout(() => el.className = 'tb-v', 700);
  }
  _prevEth = p;
  S.ethPrice = p;
}

async function loadGas() {
  const rpcs = [
    'https://ethereum.publicnode.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com'
  ];

  for (const url of rpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 })
      });
      const d = await r.json();
      if (d.result) {
        const g = parseInt(d.result, 16) / 1e9;
        S.gasPrice = g;
        $('gasP').textContent = g >= 10 ? Math.round(g) : g.toFixed(1).replace(/\.0$/, '');
        return;
      }
    } catch(e) {}
  }
  $('gasP').textContent = '--';
}

function log(msg, t = '') {
  const d = document.createElement('div');
  d.className = 'le ' + t;
  d.innerHTML = '<span class="ts">[' + new Date().toLocaleTimeString('en-US', { hour12: false }) + ']</span>' + msg;
  const l = $('botLog');
  l.insertBefore(d, l.firstChild);
  while (l.children.length > 80) l.removeChild(l.lastChild);
}

function setStatus(msg, t = '') {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg ' + t;
}

window.connectWallet = async function({ forcePicker = false } = {}) {
  if (!window.ethereum) { alert('Install MetaMask'); return; }
  try {
    if (forcePicker && window.ethereum.request) {
      try {
        await window.ethereum.request({
          method: 'wallet_requestPermissions',
          params: [{ eth_accounts: {} }]
        });
      } catch(e) {
        if (e.code === 4001) throw e;
      }
    }

    S.provider = new ethers.providers.Web3Provider(window.ethereum);
    await S.provider.send('eth_requestAccounts', []);
    S.signer = S.provider.getSigner();
    S.addr = await S.signer.getAddress();
    setWalletConnected(S.addr);
    if ($('mAddr')) $('mAddr').value = S.addr;
    log('Connected: ' + S.addr, 'ok');
    setStatus('Wallet connected.', 'ok');
  } catch(e) {
    log('Wallet error: ' + (e.message || e), 'err');
    setStatus(e.code === 4001 ? 'Wallet connection cancelled.' : 'Wallet connection failed.', 'err');
  }
};

function setWalletConnected(addr) {
  const btn = $('walletBtn');
  if (!btn) return;
  btn.textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
  btn.classList.add('connected');
  btn.disabled = false;
  btn.title = 'Click to choose a different MetaMask account';
  btn.onclick = () => window.connectWallet({ forcePicker: true });
  if ($('disconnectBtn')) $('disconnectBtn').hidden = false;
}

window.disconnectWallet = async function() {
  try {
    await window.ethereum?.request?.({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }]
    });
  } catch(e) {}

  S.provider = null;
  S.signer = null;
  S.addr = null;
  const btn = $('walletBtn');
  if (btn) {
    btn.textContent = 'Connect Wallet';
    btn.classList.remove('connected');
    btn.disabled = false;
    btn.title = '';
    btn.onclick = () => window.connectWallet();
  }
  if ($('disconnectBtn')) $('disconnectBtn').hidden = true;
  if ($('mAddr')) $('mAddr').value = '';
  setStatus('Wallet disconnected. Click Connect Wallet to choose an account.', 'ok');
  log('Wallet disconnected', 'info');
};

if (window.ethereum) {
  window.ethereum.on?.('accountsChanged', accounts => {
    if (accounts?.length) {
      S.addr = accounts[0];
      S.provider = new ethers.providers.Web3Provider(window.ethereum);
      S.signer = S.provider.getSigner();
      setWalletConnected(S.addr);
      if ($('mAddr')) $('mAddr').value = S.addr;
      log('Wallet switched: ' + S.addr, 'info');
    } else {
      window.disconnectWallet();
    }
  });
}

async function ensureSignerMatches(addr) {
  if (!S.signer) {
    await window.connectWallet();
  }
  if (!S.signer) return false;

  const signerAddr = (await S.signer.getAddress()).toLowerCase();
  if (addr && addr.toLowerCase() !== signerAddr) {
    setStatus('MetaMask is connected to a different account. Click the connected wallet button to switch accounts.', 'err');
    log('Wallet mismatch: field has ' + addr + ', MetaMask has ' + signerAddr, 'warn');
    return false;
  }
  if ($('mAddr')) $('mAddr').value = await S.signer.getAddress();
  return true;
}

function parseUrl(raw) {
  raw = raw.trim();
  raw = raw.replace(/\/(overview|items|activity|offers|analytics|traits|holders|mint)(\?.*)?$/, '');
  if (raw.match(/^0x[a-fA-F0-9]{40}$/)) return { type: 'contract', value: raw, platform: 'direct' };

  const maps = [
    [/opensea\.io\/collection\/([^/?#\s]+)/, 'opensea', 'slug'],
    [/opensea\.io\/assets\/ethereum\/(0x[a-fA-F0-9]{40})/, 'opensea', 'contract'],
    [/zora\.co\/collect\/(?:zora|eth):(0x[a-fA-F0-9]{40})/, 'zora', 'contract'],
    [/mint\.fun\/(0x[a-fA-F0-9]{40})/, 'mintfun', 'contract'],
    [/foundation\.app\/@[^/]+\/([^/?#\s]+)/, 'foundation', 'slug'],
    [/app\.manifold\.xyz\/c\/([^/?#\s]+)/, 'manifold', 'slug'],
    [/manifold\.gallery\/collection\/([^/?#\s]+)/, 'manifold', 'slug'],
    [/nft\.coinbase\.com\/collection\/ethereum\/(0x[a-fA-F0-9]{40})/, 'coinbase', 'contract'],
    [/rarible\.com\/collection\/(0x[a-fA-F0-9]{40})/, 'rarible', 'contract'],
  ];

  for (const [re, platform, type] of maps) {
    const m = raw.match(re);
    if (m) return { type, value: m[1], platform };
  }

  if (raw.length > 5 && !raw.includes(' ')) return { type: 'slug', value: raw, platform: 'opensea' };
  return null;
}

$('fetchBtn').addEventListener('click', fetchCollection);
$('urlIn').addEventListener('keydown', e => { if (e.key === 'Enter') fetchCollection(); });

async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallback(url, { headers = {}, parse = 'json', timeoutMs = 6500, direct = true } = {}) {
  const proxies = [
    ...(direct ? [''] : []),
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url='
  ];
  let lastError = null;
  for (const p of proxies) {
    try {
      const r = await fetchWithTimeout(p ? p + encodeURIComponent(url) : url, Object.keys(headers).length ? { headers } : {}, timeoutMs);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return parse === 'text' ? await r.text() : await r.json();
    } catch(e) {
      lastError = e;
    }
  }
  throw new Error(lastError?.name === 'AbortError' ? 'request timed out' : (lastError?.message || 'Failed to fetch'));
}

/* ── Reservoir — primary source, has images + supply + floor ── */
async function resolveReservoirSlug(slug) {
  for (const ver of ['v7', 'v6']) {
    try {
      const url = 'https://api.reservoir.tools/collections/' + ver + '?slug=' + encodeURIComponent(slug);
      const d = await fetchWithFallback(url, { timeoutMs: 6000 });
      const col = d.collections?.[0];
      if (!col) continue;
      const rawName = (col.name || 'Collection').replace(/\s+\d+\.?\d*\s*(ETH|eth|Ξ)/g, '').trim();
      return {
        contract:   col.primaryContract || col.contract || null,
        name:       rawName || 'Collection',
        image:      col.image || '',
        banner:     col.bannerImageUrl || col.banner || col.image || '',
        floor:      col.floorAsk?.price?.amount?.native || col.floorAsk?.price?.amount?.decimal || 0,
        supply:     parseInt(col.tokenCount) || 0,
        minted:     parseInt(col.mintedCount) || 0,
        twitterUrl: col.twitterUsername ? 'https://x.com/' + col.twitterUsername : '',
        osUrl:      'https://opensea.io/collection/' + slug,
        source:     'Reservoir'
      };
    } catch(e) {}
  }
  return null;
}

/* ── OpenSea API — secondary, fetches stats for accurate supply ── */
async function resolveOpenSeaSlug(slug) {
  // 1. Try Reservoir first — best images + supply data
  try {
    setStatus('Fetching collection data...');
    const res = await resolveReservoirSlug(slug);
    if (res?.contract) {
      log('Resolved via Reservoir', 'ok');
      return res;
    }
  } catch(e) {
    log('Reservoir failed: ' + e.message, 'warn');
  }

  // 2. OpenSea API with CORS proxies
  try {
    setStatus('Trying OpenSea API...');
    const d = await fetchWithFallback('https://api.opensea.io/api/v2/collections/' + slug, { timeoutMs: 6000, headers: OPENSEA_HEADERS });
    if (d?.contracts?.length || d?.name) {
      const collectionId = d.collection || slug;
      let floor = 0, minted = 0;
      // Fetch stats for real supply numbers
      try {
        const sd = await fetchWithFallback('https://api.opensea.io/api/v2/collections/' + collectionId + '/stats', { headers: OPENSEA_HEADERS, timeoutMs: 5000 });
        if (sd?.total) { floor = sd.total.floor_price || 0; minted = sd.total.count || 0; }
      } catch(e) {}
      const rawName = (d.name || 'Collection').replace(/\s+\d+\.?\d*\s*(ETH|eth|Ξ)/g, '').trim();
      return {
        contract:   d.contracts?.[0]?.address || null,
        name:       rawName || 'Collection',
        image:      d.image_url || '',
        banner:     d.banner_image_url || d.image_url || '',
        twitterUrl: d.twitter_username ? 'https://x.com/' + d.twitter_username : '',
        osUrl:      'https://opensea.io/collection/' + collectionId,
        supply:     d.total_supply ? parseInt(d.total_supply) : 0,
        minted:     minted,
        floor:      floor,
        source:     'OpenSea'
      };
    }
  } catch(e) {
    log('OpenSea API failed: ' + e.message, 'warn');
  }

  // 3. Jina page mirror — last resort, contract only, no images
  try {
    setStatus('Scanning page mirror...');
    const page = await fetchWithFallback('https://r.jina.ai/https://opensea.io/collection/' + slug, {
      parse: 'text', timeoutMs: 9000, direct: true
    });
    const match = [...(page.matchAll(/0x[a-fA-F0-9]{40}/g))];
    const contract = match[0]?.[0] || null;
    if (contract) {
      const title = page.match(/^Title:\s*(.+)$/m)?.[1]?.replace(/ - Collection \| OpenSea$/, '').replace(/\s+\d+\.?\d*\s*(ETH|eth|Ξ)/g, '').trim() || 'Collection';
      log('Contract found via page mirror — no images available', 'warn');
      return {
        contract, name: title, image: '', banner: '', twitterUrl: '',
        osUrl: 'https://opensea.io/collection/' + slug,
        supply: 0, minted: 0, floor: 0, source: 'page mirror'
      };
    }
  } catch(e) {
    log('Page mirror failed: ' + e.message, 'warn');
  }

  return null;
}

async function fetchCollection() {
  const raw = $('urlIn').value.trim();
  if (!raw) { setStatus('Paste a mint link or contract.', 'err'); return; }

  const parsed = parseUrl(raw);
  if (!parsed) { setStatus('Invalid link - try pasting the 0x address directly.', 'err'); return; }

  setStatus('Resolving ETH collection...');
  log('Resolving: ' + parsed.value);
  $('colCard').classList.remove('show');
  if ($('mPrc')) $('mPrc').value = '';
  stopRefresh();

  let contract = null, name = 'Collection';
  let image = '', banner = '', twitterUrl = '', osUrl = '';
  let supply = 0, minted = 0, floor = 0;

  try {
    if (parsed.type === 'contract') contract = parsed.value;

    if (!contract && parsed.type === 'slug') {
      const d = await resolveOpenSeaSlug(parsed.value);
      if (d?.contract) {
        contract = d.contract;
        name = d.name || name;
        image = d.image || '';
        banner = d.banner || image;
        floor = d.floor || 0;
        supply = d.supply || 0;
        minted = d.minted || 0;
        twitterUrl = d.twitterUrl || '';
        osUrl = d.osUrl || 'https://opensea.io/collection/' + parsed.value;
        log('Resolved via ' + (d.source || 'OpenSea'), 'ok');
      }
    }

    if (!contract && parsed.type === 'slug') {
      try {
        const d = await resolveReservoirSlug(parsed.value);
        if (d?.contract) {
          contract = d.contract;
          name = d.name || name;
          image = d.image || '';
          banner = d.banner || image;
          floor = d.floor || 0;
          supply = d.supply || 0;
          minted = d.minted || 0;
          twitterUrl = d.twitterUrl || '';
          osUrl = d.osUrl || 'https://opensea.io/collection/' + parsed.value;
          log('Resolved via Reservoir fallback', 'ok');
        }
      } catch(e) { log('Reservoir fallback failed: ' + e.message, 'warn'); }
    }

    if (!contract?.match(/^0x[a-fA-F0-9]{40}$/)) {
      setStatus('Could not resolve this OpenSea collection automatically. Paste the 0x ETH contract address instead.', 'err');
      return;
    }

    // On-chain reads — only override API data if chain returns higher values
    const apiMinted = minted;
    const apiSupply = supply;
    try {
      const provider = window.ethereum
        ? new ethers.providers.Web3Provider(window.ethereum)
        : new ethers.providers.JsonRpcProvider('https://ethereum.publicnode.com');
      const abi = [
        'function name() view returns (string)',
        'function totalSupply() view returns (uint256)',
        'function maxSupply() view returns (uint256)',
      ];
      const con = new ethers.Contract(contract, abi, provider);
      try { const n = await con.name(); if (n && n.length > 0) name = n; } catch(e) {}
      try {
        const ts = (await con.totalSupply()).toNumber();
        // Only use on-chain value if it's credible (> 0 and close to API value)
        if (ts > 0) minted = ts;
      } catch(e) {}
      try {
        const ms = (await con.maxSupply()).toNumber();
        if (ms > 0) supply = ms;
      } catch(e) {}
    } catch(e) {}

    // If on-chain returned 0 but API had real data, trust the API
    if (minted === 0 && apiMinted > 0) minted = apiMinted;
    if (supply === 0 && apiSupply > 0) supply = apiSupply;

    COL.minted = minted > 0 ? minted : 0;
    COL.supply = supply > 0 ? supply : 0;
    COL.contract = contract;
    if ($('bpContract')) $('bpContract').value = contract;
    COL.name = name;
    COL.price = floor;
    COL.floor = floor;
    COL.slug = parsed.value;
    COL.platform = parsed.type === 'slug' ? 'opensea' : parsed.platform;

    renderColCard({ name, image, banner, contract, supply, minted, floor, twitterUrl, osUrl });
    setStatus('');

    // Fetch phases and detect price in parallel
    const [phases, detectedPrice] = await Promise.all([
      parsed.type === 'slug' ? fetchMintPhases(parsed.value).catch(() => []) : Promise.resolve([]),
      (async () => {
        try {
          const provider = window.ethereum
            ? new ethers.providers.Web3Provider(window.ethereum)
            : new ethers.providers.JsonRpcProvider('https://ethereum.publicnode.com');
          return await detectPrice(contract, provider);
        } catch(e) { return null; }
      })()
    ]);

    COL.phases = phases;

    // Price priority: phases → on-chain detected → free
    // floor price = secondary market, NEVER used as mint price
    const phasesResolved = Array.isArray(phases) && phases.length > 0;
    const phasePrice     = phasesResolved ? parseFloat(phases[0].price) || 0 : null;

    if (phasePrice > 0) {
      // Drops API returned a real price
      COL.price = phasePrice;
      if ($('mPrc') && !$('mPrc').value) $('mPrc').value = phasePrice.toFixed(4);
      log('Mint price: ' + phasePrice.toFixed(4) + ' ETH (from drops API)', 'ok');
    } else if (phasesResolved && phasePrice === 0) {
      // Drops API responded — price is 0 = confirmed FREE MINT
      COL.price = 0;
      if ($('mPrc')) $('mPrc').value = '';
  stopRefresh();
      log('Mint price: FREE (confirmed by drops API)', 'ok');
    } else if (detectedPrice && parseFloat(detectedPrice) > 0) {
      // On-chain getter found a price
      COL.price = parseFloat(detectedPrice);
      if ($('mPrc') && !$('mPrc').value) $('mPrc').value = parseFloat(detectedPrice).toFixed(4);
      log('Mint price: ' + detectedPrice + ' ETH (on-chain detected)', 'ok');
    } else {
      // No price found anywhere — assume free, let user override
      COL.price = 0;
      if ($('mPrc')) $('mPrc').value = '';
  stopRefresh();
      log('Mint price: FREE (no price getter — enter manually if paid)', 'ok');
    }

    // Render phases with full data
    renderPhases(phases, COL.supply, COL.minted, detectedPrice);

    // Sold out banner
    if (COL.soldOut) {
      setStatus('⚠️ This collection is SOLD OUT (' + minted.toLocaleString() + '/' + supply.toLocaleString() + ' minted)', 'warn');
      log('SOLD OUT: ' + name, 'warn');
    }

    // Start auto-refresh
    startRefresh();

    $('limitNote').classList.remove('show');
    if (COL.supply > 0) {
      $('limitNote').classList.add('show');
      const remaining = Math.max(0, COL.supply - COL.minted);
      $('limitText').textContent = COL.supply.toLocaleString() + ' total supply · ' + remaining.toLocaleString() + ' remaining';
    }
    log('Loaded: ' + name + ' (' + contract.slice(0, 10) + '...) via ' + COL.platform, 'ok');
  } catch(e) {
    setStatus('Error: ' + e.message, 'err');
    log(e.message, 'err');
  }
}


/* ══════════════════════════════════════
   FETCH MINT PHASES from OpenSea
══════════════════════════════════════ */
async function fetchMintPhases(slug) {
  // ── 1. OpenSea Drops API — correct endpoint: /api/v2/drops/{slug} ──
  try {
    const d = await fetchWithFallback(
      'https://api.opensea.io/api/v2/drops/' + slug,
      { timeoutMs: 7000, headers: OPENSEA_HEADERS }
    );
    // Response has d.stages[] each with { name, price, start_time, end_time, max_per_wallet }
    if (d?.stages?.length) {
      return d.stages.map(s => ({
        stage:          s.stage || s.name || 'public-sale',
        name:           s.name  || 'Public Sale',
        price:          s.price != null ? parseFloat(s.price) : 0,
        start_time:     s.start_time || null,
        end_time:       s.end_time   || null,
        max_per_wallet: s.max_per_wallet || null,
      }));
    }
  } catch(e) {}

  // ── 2. OpenSea mint_stages — price_per_token in wei ──
  try {
    const d = await fetchWithFallback(
      'https://api.opensea.io/api/v2/collections/' + slug + '/mint_stages',
      { timeoutMs: 6000, headers: OPENSEA_HEADERS }
    );
    if (d?.mint_stages?.length) {
      return d.mint_stages.map(s => {
        let price = 0;
        if (s.price_per_token && s.price_per_token !== '0') {
          try { price = parseFloat(ethers.utils.formatEther(s.price_per_token)); } catch(e2) {}
        } else if (s.price != null) {
          price = parseFloat(s.price);
        }
        return { ...s, price };
      });
    }
  } catch(e) {}

  // ── 3. Reservoir with mintStages ──
  try {
    const d = await fetchWithFallback(
      'https://api.reservoir.tools/collections/v7?slug=' + encodeURIComponent(slug) + '&includeMintStages=true',
      { timeoutMs: 5000 }
    );
    const col = d?.collections?.[0];
    if (col?.mintStages?.length) {
      return col.mintStages.map(s => ({
        stage: s.stage || 'public-sale',
        price: s.price?.amount?.native || 0,
        start_time: s.startTime ? new Date(s.startTime * 1000).toISOString() : null,
        end_time: s.endTime ? new Date(s.endTime * 1000).toISOString() : null,
        max_per_wallet: s.maxMintsPerWallet || null,
      }));
    }
    if (col?.saleConfig) {
      const cfg = col.saleConfig;
      return [{ stage: 'public-sale',
        price: col.floorAsk?.price?.amount?.native || 0,
        start_time: cfg.publicSaleStart ? new Date(cfg.publicSaleStart * 1000).toISOString() : null,
        end_time: cfg.publicSaleEnd ? new Date(cfg.publicSaleEnd * 1000).toISOString() : null,
        max_per_wallet: cfg.maxSalePurchasePerAddress || null }];
    }
  } catch(e) {}
  return [];
}

function fmtPhaseTime(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  const now = new Date();
  const diff = d - now;
  if (diff <= 0) return null; // already started
  const h = Math.floor(diff / 36e5);
  const m = Math.floor((diff % 36e5) / 6e4);
  if (h > 48) return 'Starts in ' + Math.floor(h/24) + 'd ' + (h%24) + 'h';
  if (h > 0)  return 'Starts in ' + h + 'h ' + m + 'm';
  return 'Starts in ' + m + 'm';
}

function renderPhases(phases, supply, minted, detectedPrice) {
  const soldOut = supply > 0 && minted >= supply;
  COL.soldOut = soldOut;

  // Disable mint button if sold out
  const mintBtn = $('mintBtn');
  if (mintBtn) {
    mintBtn.disabled = soldOut;
    mintBtn.title = soldOut ? 'This collection is sold out' : '';
  }

  if (!phases || phases.length === 0) {
    // Fallback single phase
    renderPhase(detectedPrice || COL.price, supply, soldOut);
    return;
  }

  const html = phases.map((ph, i) => {
    const price = ph.price != null ? parseFloat(ph.price) : (detectedPrice ? parseFloat(detectedPrice) : 0);
    const now = new Date();
    const start = ph.start_time ? new Date(ph.start_time) : null;
    const end   = ph.end_time   ? new Date(ph.end_time)   : null;
    const started = !start || start <= now;
    const ended   = end && end <= now;
    const isLive  = started && !ended;
    const isSoldOut = soldOut && isLive;

    const startTime = (!started && start) ? fmtPhaseTime(ph.start_time) : null;
    let timerClass = isSoldOut ? 'sold-out' : ended ? 'ended' : isLive ? 'live' : 'soon';
    let timerText  = isSoldOut ? 'SOLD OUT' : ended ? 'ENDED' : isLive ? 'LIVE' : startTime;

    const stageName = (ph.stage || ph.name || (i === 0 ? 'PUBLIC MINT' : 'PHASE ' + (i+1)))
      .replace(/-/g, ' ').toUpperCase();

    return '<div class="phase' + (i === 0 ? ' selected' : '') + '" onclick="selectPhase(this,' + price + ',' + (ph.start_time ? JSON.stringify(ph.start_time) : 'null') + ')">' +
      '<div class="phase-top">' +
        '<span class="phase-name">' + stageName + '</span>' +
        '<span class="phase-timer ' + timerClass + '">' + timerText + '</span>' +
      '</div>' +
      '<div class="phase-meta">' +
        '<span class="phase-pill eth">PRICE · ' + (price > 0 ? price.toFixed(4) + ' Ξ' : 'FREE') + '</span>' +
        '<span class="phase-pill">SUPPLY · ' + (supply > 0 ? supply.toLocaleString() : '—') + '</span>' +
        (ph.max_per_wallet ? '<span class="phase-pill">MAX ' + ph.max_per_wallet + '/WALLET</span>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  $('phaseList').innerHTML = html;
}

window.selectPhase = function(el, price, startTime) {
  document.querySelectorAll('.phase').forEach(p => p.classList.remove('selected'));
  el.classList.add('selected');
  // Update price and scheduled time from this phase
  COL.price = price;
  if (startTime) {
    const t = new Date(startTime);
    if ($('mTime')) $('mTime').value = t.toISOString().slice(0, 16);
    // Auto-switch to scheduled mode if phase hasn't started
    if (t > new Date()) {
      document.querySelectorAll('#modeBar .mode-tab').forEach(b => {
        b.classList.toggle('on', b.dataset.mode === 'scheduled');
      });
      S.mode = 'scheduled';
      $('schedRow').style.display = 'block';
      $('modeNote').textContent = 'Scheduled for phase start time';
      log('Phase start time set: ' + t.toLocaleString(), 'info');
    }
  }
};

function renderPhase(price, supply) {
  const p = price > 0 ? parseFloat(price) : 0;
  $('phaseList').innerHTML =
    '<div class="phase selected">' +
      '<div class="phase-top">' +
        '<span class="phase-name">' + (p === 0 ? 'FREE MINT' : 'PUBLIC MINT') + '</span>' +
        '<span class="phase-timer live">LIVE</span>' +
      '</div>' +
      '<div class="phase-meta">' +
        '<span class="phase-pill eth">PRICE · ' + (p > 0 ? p.toFixed(4) + ' Ξ' : 'FREE') + '</span>' +
        '<span class="phase-pill">SUPPLY · ' + (supply > 0 ? supply.toLocaleString() : '—') + '</span>' +
      '</div>' +
    '</div>';
}

function renderColCard({ name, image, banner, contract, supply, minted, floor, twitterUrl, osUrl }) {
  $('colName').textContent = name;
  $('colAddrText').textContent = contract.slice(0, 6) + '...' + contract.slice(-4).toUpperCase();
  $('colAddr').href = 'https://etherscan.io/address/' + contract;

  const bi = $('colBannerImg');
  if (banner) { bi.src = banner; bi.style.display = 'block'; }
  else { bi.removeAttribute('src'); bi.style.display = 'none'; }

  const initial = (name || '?').charAt(0);
  const thumbWrap = $('colThumbWrap');
  thumbWrap.innerHTML = image
    ? '<img src="' + image + '" class="col-thumb" alt=""/>'
    : '<div class="col-thumb-ph">' + initial + '</div>';
  const thumbImg = thumbWrap.querySelector('img');
  if (thumbImg) {
    thumbImg.onerror = () => {
      thumbWrap.innerHTML = '<div class="col-thumb-ph">' + initial + '</div>';
    };
  }

  const pct = supply > 0 ? Math.min(100, Math.round(minted / supply * 100)) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressLabel').textContent = pct + '% minted';
  $('progressVal').textContent = minted.toLocaleString() + (supply > 0 ? ' / ' + supply.toLocaleString() : '');

  const links = [];
  if (osUrl) links.push('<a class="col-link" href="' + osUrl + '" target="_blank" rel="noopener">OpenSea</a>');
  if (twitterUrl) links.push('<a class="col-link" href="' + twitterUrl + '" target="_blank" rel="noopener">X</a>');
  links.push('<a class="col-link" href="https://etherscan.io/address/' + contract + '" target="_blank" rel="noopener">Etherscan</a>');
  $('colLinks').innerHTML = links.join('');

  // Floor price display
  const floorEl = $('colFloor');
  if (floorEl) {
    if (floor > 0) {
      floorEl.textContent = 'Floor: ' + floor.toFixed(4) + ' Ξ';
      floorEl.style.display = 'inline-flex';
    } else {
      floorEl.style.display = 'none';
    }
  }

  // phases rendered separately after fetchMintPhases resolves
  $('colCard').classList.add('show');
}

document.querySelectorAll('#modeBar .mode-tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#modeBar .mode-tab').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  S.mode = b.dataset.mode;
  const notes = {
    manual: 'Opens wallet immediately - you sign to mint',
    scheduled: 'Fires at the scheduled time',
    sniper: 'Polls contract every 10s - fires the instant mint goes live'
  };
  $('modeNote').textContent = notes[S.mode];
  $('schedRow').style.display = S.mode === 'scheduled' ? 'block' : 'none';
}));

function getOptions() {
  const manualPrc = parseFloat($('mPrc')?.value);
  return {
    maxGas: parseInt($('mGas').value) || 50,
    tip: parseFloat($('mTip').value) || 2,
    manualPrice: (manualPrc > 0 ? manualPrc : null) || COL.price || null
  };
}

function buildTask(addr) {
  return {
    id: Date.now(),
    addr,
    contract: COL.contract,
    name: COL.name,
    qty: parseInt($('mQty').value) || 1,
    price: COL.price,
    options: getOptions(),
    mode: S.mode,
    time: S.mode === 'scheduled' ? new Date($('mTime').value) : null,
    status: 'ready'
  };
}

$('mintBtn').addEventListener('click', async () => {
  if (!COL.contract) { setStatus('Fetch a collection first.', 'err'); return; }
  const addr = $('mAddr').value.trim() || S.addr;
  if (!addr?.match(/^0x[a-fA-F0-9]{40}$/)) {
    $('mAddr').focus();
    setStatus('Enter your wallet address first.', 'err');
    return;
  }

  const task = buildTask(addr);
  if (S.mode === 'manual') {
    if (await ensureSignerMatches(addr)) {
      setStatus('Opening MetaMask for signature...');
      try {
        const result = await executeMint(task.contract, S.signer, task.qty, msg => log(msg, 'info'), task.options);
        if (result.success) {
          const link = '<a href="https://etherscan.io/tx/' + result.hash + '" target="_blank" rel="noopener">' + result.hash.slice(0,14) + '…</a>';
          setStatus('Mint confirmed ✅', 'ok');
          log('TX confirmed: ' + link + ' · Block ' + result.block, 'ok');
        }
      } catch(e) {
        setStatus('Error: ' + e.message, 'err');
        log(e.message, 'err');
      }
    } else {
      setStatus('Connect MetaMask to sign this mint.', 'err');
    }
  } else if (S.mode === 'scheduled') {
    task.status = 'waiting';
    S.tasks.unshift(task);
    renderTasks();
    log('[SCHED] Queued for ' + new Date(task.time).toLocaleTimeString(), 'ok');
  } else {
    task.status = 'watching';
    S.tasks.unshift(task);
    renderTasks();
    log('[SNIPER] Watching ' + COL.contract.slice(0, 12) + '...', 'ok');
  }
});

$('queueBtn').addEventListener('click', async () => {
  if (!COL.contract) { setStatus('Fetch a collection first.', 'err'); return; }
  const addr = $('mAddr').value.trim() || S.addr;
  if (!addr?.match(/^0x[a-fA-F0-9]{40}$/)) {
    $('mAddr').focus();
    setStatus('Enter your wallet address first.', 'err');
    return;
  }
  const task = buildTask(addr);
  if (S.signer && !(await ensureSignerMatches(addr))) return;
  task.status = 'waiting';
  S.tasks.unshift(task);
  renderTasks();
  log('Queued: ' + COL.name + ' x' + task.qty, 'ok');
});

function fmtCD(t) {
  const d = new Date(t) - new Date();
  if (d <= 0) return 'NOW';
  const h = Math.floor(d / 36e5), m = Math.floor((d / 6e4) % 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

function persistTasks() {
  try {
    localStorage.setItem('mb_tasks', JSON.stringify(S.tasks));
  } catch(e) {}
}

function renderTasks() {
  persistTasks();
  $('queueCnt').textContent = S.tasks.length + ' task' + (S.tasks.length !== 1 ? 's' : '');
  const el = $('taskList');
  if (!S.tasks.length) { $('queueSection').classList.remove('show'); return; }
  $('queueSection').classList.add('show');

  el.innerHTML = S.tasks.map(t =>
    '<div class="task-card ' + t.status + '">' +
      '<div class="tc-top">' +
        '<div class="tc-addr">' + (t.name || t.contract.slice(0, 12) + '...') + ' x' + t.qty + '</div>' +
        '<span class="tc-badge ' + t.status + '">' + t.status.toUpperCase() + '</span>' +
      '</div>' +
      '<div class="tc-meta">' +
        '<div class="tc-m"><span class="lk">Mode</span><span class="lv">' + t.mode.toUpperCase() + '</span></div>' +
        '<div class="tc-m"><span class="lk">Price</span><span class="lv">' + (t.price > 0 ? t.price.toFixed(4) + ' ETH' : 'FREE') + '</span></div>' +
        '<div class="tc-m"><span class="lk">Gas</span><span class="lv">' + t.options.maxGas + '</span></div>' +
        '<div class="tc-m"><span class="lk">' + (t.mode === 'scheduled' ? 'Fires In' : 'State') + '</span><span class="lv hi">' + (t.time ? fmtCD(t.time) : t.mode === 'sniper' ? 'WATCHING' : 'NOW') + '</span></div>' +
      '</div>' +
      '<div class="tc-acts">' +
        '<button class="tc-btn fire" data-id="' + t.id + '" data-a="fire">Fire</button>' +
        '<button class="tc-btn del" data-id="' + t.id + '" data-a="del">Remove</button>' +
      '</div>' +
    '</div>'
  ).join('');

  el.querySelectorAll('.tc-btn').forEach(b => b.addEventListener('click', async () => {
    const t = S.tasks.find(x => x.id == b.dataset.id);
    if (!t) return;
    if (b.dataset.a === 'fire') {
      t.status = 'ready';
      if (S.signer) {
        try { await executeMint(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options); }
        catch(e) { log(e.message, 'err'); }
      } else {
        openModal(t);
      }
    }
    if (b.dataset.a === 'del') {
      S.tasks = S.tasks.filter(x => x.id != b.dataset.id);
      renderTasks();
    }
  }));
}

function tickTasks() {
  S.tasks.forEach(async t => {
    if (t.mode === 'scheduled' && t.time && t.status === 'waiting' && new Date() >= t.time) {
      t.status = 'ready';
      log('SCHEDULED: ' + t.name, 'ok');
      if (S.signer) {
        try { await executeMint(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options); }
        catch(e) { log(e.message, 'err'); }
      } else { openModal(t); }
    }

    if (t.mode === 'sniper' && t.status === 'watching') {
      const now = Math.floor(Date.now() / 1000);
      if (!t._p || now - t._p >= 10) {
        t._p = now;
        try {
          const r = await fetch('https://ethereum.publicnode.com', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: t.contract, data: '0x1249c58b' }, 'latest'], id: 1 })
          });
          const d = await r.json();
          if (d.result !== undefined && !d.error) {
            t.status = 'ready';
            log('SNIPER HIT: ' + t.name + ' is LIVE', 'ok');
            if (S.signer) {
              try { await executeMint(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options); }
              catch(e) { log(e.message, 'err'); }
            } else { openModal(t); }
          }
        } catch(e) {}
        renderTasks();
      }
    }
  });
  renderTasks();
}

function openModal(task) {
  S.pending = task;
  const tot = task.price * task.qty;
  const vW = ethers.utils.parseEther(tot.toFixed(8)).toString();

  $('txPreview').innerHTML = [
    ['Collection', task.name || '-'],
    ['Contract', task.contract.slice(0, 14) + '...' + task.contract.slice(-4)],
    ['Qty / Value', task.qty + ' x ' + (task.price > 0 ? task.price.toFixed(4) : '0') + ' ETH = ' + tot.toFixed(4) + ' ETH' + (S.ethPrice ? ' (~$' + (tot * S.ethPrice).toFixed(2) + ')' : '')],
    ['Gas', task.options.maxGas + ' gwei max - ' + task.options.tip + ' gwei tip'],
  ].map(([k, v]) => '<div class="txr"><span class="txk">' + k + '</span><span class="txv">' + v + '</span></div>').join('');

  $('modalDesc').textContent = S.signer
    ? 'MetaMask connected - sign on-chain directly.'
    : 'Connect MetaMask or use a wallet deep-link below.';
  $('btnMM').style.display = S.signer ? 'block' : 'none';
  $('btnRainbow').href = 'https://rnbwapp.com/wc?uri=' + encodeURIComponent('ethereum:' + task.contract + '@1?value=' + vW);
  $('btnTrust').href = 'trust://send?address=' + task.contract + '&amount=' + tot + '&coin=60';
  $('overlay').classList.add('open');
}

window.signWithMM = async function() {
  const t = S.pending;
  if (!t) return;
  if (!(await ensureSignerMatches(t.addr))) return;
  $('overlay').classList.remove('open');
  setStatus('Minting...');
  try {
    const result = await executeMint(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options);
    setStatus(result.success ? 'Mint successful' : 'Done', 'ok');
    S.tasks = S.tasks.filter(x => x.id !== t.id);
    renderTasks();
  } catch(e) {
    setStatus('Error: ' + e.message, 'err');
    log(e.message, 'err');
  }
};

$('modalClose').onclick = () => $('overlay').classList.remove('open');
$('overlay').onclick = e => { if (e.target.id === 'overlay') $('overlay').classList.remove('open'); };

window.toggleTheme = function() {
  const isDark = document.documentElement.classList.toggle('dark');
  document.body.classList.toggle('dark', isDark);
  $('themeIcon').textContent = isDark ? '☽' : '○';
  localStorage.setItem('mb_theme', isDark ? 'dark' : 'light');
};

(function() {
  if (localStorage.getItem('mb_theme') === 'dark') {
    document.documentElement.classList.add('dark');
    document.body.classList.add('dark');
    const ic = document.getElementById('themeIcon');
    if (ic) ic.textContent = '☽';
  }
})();


/* ══════════════════════════════════════
   PRIVATE KEY MODE
══════════════════════════════════════ */
window.connectPrivateKey = async function() {
  const pkInput = $('pkInput');
  if (!pkInput) return;
  const pk = pkInput.value.trim();
  if (!pk) { setStatus('Enter a private key.', 'err'); return; }

  try {
    const wallet = createPrivateKeySigner(pk);
    S.signer = wallet;
    S.addr = await wallet.getAddress();
    S.pkMode = true;

    setStatus('Private key wallet connected.', 'ok');
    pkInput.value = ''; // clear immediately for security
    $('pkInput').placeholder = '✓ Key loaded — cleared for security';

    setWalletConnected(S.addr);
    if ($('mAddr')) $('mAddr').value = S.addr;
    log('PK wallet: ' + S.addr, 'ok');

    // Hide PK section
    const pkSection = $('pkSection');
    if (pkSection) pkSection.style.display = 'none';
  } catch(e) {
    setStatus('Invalid private key: ' + e.message, 'err');
    log(e.message, 'err');
  }
};

window.togglePKSection = function() {
  const s = $('pkSection');
  if (s) s.style.display = s.style.display === 'none' ? 'block' : 'none';
};


/* ══════════════════════════════════════
   BOT PANEL — multi-wallet batch minting
   Reuses mintEngine exports; never persists keys
══════════════════════════════════════ */
const BOT = {
  wallets: [],     // [{ signer, address, balance }]
  turbo: false,
  running: false
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function botProvider() {
  return window.ethereum
    ? new ethers.providers.Web3Provider(window.ethereum)
    : new ethers.providers.JsonRpcProvider('https://ethereum.publicnode.com');
}

/* ── Mint-log panel — color-coded, auto-scrolls to bottom ── */
function botLog(msg, t = '') {
  const el = $('bpLog');
  if (!el) return;
  const d = document.createElement('div');
  // executeMint() emits ('msg') and ('msg','warn'); other callers use success/error
  d.className = 'log-line ' + (t === 'ok' ? 'success' : t === 'err' ? 'error' : t);
  d.innerHTML = '<span class="log-ts">[' + new Date().toLocaleTimeString('en-US', { hour12: false }) + ']</span>' + msg;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight; // auto-scroll to newest entry
}

/* ── 1. MULTI-WALLET INPUT ── */
function parseWallets() {
  const lines = ($('bpWallets').value || '').split('\n').map(l => l.trim()).filter(Boolean);
  BOT.wallets = [];
  let invalid = 0;
  for (const line of lines) {
    try {
      const signer = createPrivateKeySigner(line);
      BOT.wallets.push({ signer, address: signer.address, balance: null });
    } catch(e) { invalid++; }
  }
  renderWalletList();
  botLog('Parsed ' + BOT.wallets.length + ' wallet(s)' + (invalid ? ' · ' + invalid + ' invalid skipped' : ''),
    invalid ? 'warn' : 'success');
}

function renderWalletList() {
  const cnt = $('bpWalletCount');
  if (cnt) cnt.textContent = BOT.wallets.length + ' wallet' + (BOT.wallets.length !== 1 ? 's' : '');
  const list = $('bpWalletList');
  if (!list) return;
  list.innerHTML = BOT.wallets.map((w, i) =>
    '<div class="wallet-list-item">' +
      '<span class="wallet-list-addr">' + (i + 1) + '. ' + w.address.slice(0, 8) + '…' + w.address.slice(-6) + '</span>' +
      '<span class="wallet-list-bal" id="bpBal' + i + '">' + (w.balance != null ? w.balance + ' Ξ' : '— Ξ') + '</span>' +
    '</div>'
  ).join('');
}

async function checkBalances() {
  if (!BOT.wallets.length) { botLog('Parse wallets first.', 'warn'); return; }
  botLog('Checking balances…');
  for (let i = 0; i < BOT.wallets.length; i++) {
    const w = BOT.wallets[i];
    try {
      const bal = await w.signer.getBalance();
      w.balance = parseFloat(ethers.utils.formatEther(bal)).toFixed(4);
      const el = $('bpBal' + i); if (el) el.textContent = w.balance + ' Ξ';
    } catch(e) {
      const el = $('bpBal' + i); if (el) el.textContent = 'err';
      botLog('Balance failed for ' + w.address.slice(0, 10) + '…', 'error');
    }
  }
  botLog('Balance check complete.', 'success');
}

/* ── 3. GAS CONTROLS ── */
function toggleTurbo() {
  BOT.turbo = !BOT.turbo;
  const t = $('bpTurbo');
  if (t) { t.classList.toggle('on', BOT.turbo); t.setAttribute('aria-checked', BOT.turbo ? 'true' : 'false'); }
  if ($('bpMaxGas')) $('bpMaxGas').disabled = BOT.turbo; // manual gas locked in turbo mode
  botLog('Turbo mode ' + (BOT.turbo ? 'ON — using live fee data' : 'OFF — manual gas'), 'success');
}

async function refreshLiveGas() {
  const el = $('bpLiveGas');
  if (!el) return;
  try {
    const fee = await botProvider().getFeeData();
    if (fee.gasPrice) el.value = parseFloat(ethers.utils.formatUnits(fee.gasPrice, 'gwei')).toFixed(2) + ' gwei';
  } catch(e) {}
}

// Build executeMint options — live fee data when Turbo is on, manual inputs otherwise
async function getBotOptions() {
  let maxGas = parseFloat($('bpMaxGas')?.value) || 50;
  let tip    = parseFloat($('bpTip')?.value)    || 2;
  if (BOT.turbo) {
    try {
      const fee = await botProvider().getFeeData();
      if (fee.maxFeePerGas)         maxGas = Math.ceil(parseFloat(ethers.utils.formatUnits(fee.maxFeePerGas, 'gwei')));
      if (fee.maxPriorityFeePerGas) tip    = parseFloat(parseFloat(ethers.utils.formatUnits(fee.maxPriorityFeePerGas, 'gwei')).toFixed(2));
      botLog('Turbo gas: max ' + maxGas + ' / tip ' + tip + ' gwei', 'success');
    } catch(e) { botLog('Live fee fetch failed — falling back to manual gas', 'warn'); }
  }
  const manualPrc = parseFloat($('mPrc')?.value);
  return {
    maxGas, tip,
    manualPrice: (manualPrc > 0 ? manualPrc : null) || COL.price || null
  };
}

/* ── 2. BATCH MINT — orchestrates executeMint per wallet ── */
async function batchMint() {
  if (BOT.running) { botLog('Batch already running.', 'warn'); return; }
  if (!BOT.wallets.length) { botLog('Parse wallets first.', 'error'); return; }

  const contract = ($('bpContract')?.value.trim() || COL.contract || '').trim();
  if (!contract.match(/^0x[a-fA-F0-9]{40}$/)) { botLog('Enter a valid contract address.', 'error'); return; }

  const total = Math.max(1, parseInt($('bpTotal')?.value) || 1); // per wallet
  const perTx = Math.max(1, parseInt($('bpPerTx')?.value) || 1);
  const delay = Math.max(0, parseInt($('bpDelay')?.value) || 0);
  const options = await getBotOptions();

  BOT.running = true;
  if ($('bpRunBtn')) $('bpRunBtn').disabled = true;
  if ($('bpSummary')) $('bpSummary').innerHTML = '';
  botLog('▶ Batch started — ' + BOT.wallets.length + ' wallet(s), ' + total + '/wallet, ' + perTx + '/tx, ' + delay + 'ms delay', 'success');

  const results = [];
  for (let wi = 0; wi < BOT.wallets.length; wi++) {
    const w = BOT.wallets[wi];
    botLog('Wallet ' + (wi + 1) + '/' + BOT.wallets.length + ': ' + w.address.slice(0, 10) + '…');
    let remaining = total;
    while (remaining > 0) {
      const qty = Math.min(perTx, remaining);
      try {
        const result = await executeMint(contract, w.signer, qty, botLog, options);
        if (result?.success) {
          const detail = await inspectReceipt(w, result.hash, options);
          results.push({ address: w.address, success: true, hash: result.hash, qty, ...detail });
          botLog('✅ ' + w.address.slice(0, 8) + '… minted ' + qty +
            (detail.tokenIds.length ? ' · #' + detail.tokenIds.join(', #') : ''), 'success');
        } else {
          results.push({ address: w.address, success: false, qty });
        }
      } catch(e) {
        results.push({ address: w.address, success: false, qty, error: e.message });
        botLog('❌ ' + w.address.slice(0, 8) + '… ' + (e.message || '').slice(0, 80), 'error');
      }
      remaining -= qty;
      if (remaining > 0 && delay) await sleep(delay);
    }
    if (wi < BOT.wallets.length - 1 && delay) await sleep(delay);
  }

  BOT.running = false;
  if ($('bpRunBtn')) $('bpRunBtn').disabled = false;
  renderSummary(results);
  botLog('■ Batch complete — ' + results.filter(r => r.success).length + '/' + results.length + ' tx succeeded.', 'success');
}

// Pull token IDs (ERC-721 Transfer logs) + total ETH spent from a confirmed tx
async function inspectReceipt(w, hash, options) {
  const out = { tokenIds: [], ethSpent: 0 };
  try {
    const provider = w.signer.provider;
    const [receipt, tx] = await Promise.all([
      provider.getTransactionReceipt(hash),
      provider.getTransaction(hash)
    ]);
    let spent = ethers.constants.Zero;
    if (tx?.value) spent = spent.add(tx.value);
    if (receipt?.gasUsed) {
      const gp = receipt.effectiveGasPrice || tx?.gasPrice || ethers.constants.Zero;
      spent = spent.add(receipt.gasUsed.mul(gp));
    }
    out.ethSpent = parseFloat(ethers.utils.formatEther(spent));

    const TRANSFER = ethers.utils.id('Transfer(address,address,uint256)');
    const me = w.address.toLowerCase();
    for (const lg of (receipt?.logs || [])) {
      // ERC-721 Transfer = 4 topics (indexed from, to, tokenId)
      if (lg.topics[0] === TRANSFER && lg.topics.length === 4) {
        const to = '0x' + lg.topics[2].slice(26);
        if (to.toLowerCase() === me) {
          try { out.tokenIds.push(ethers.BigNumber.from(lg.topics[3]).toString()); } catch(e) {}
        }
      }
    }
  } catch(e) {}
  return out;
}

/* ── 5. RESULT SUMMARY ── */
function renderSummary(results) {
  const box = $('bpSummary');
  if (!box) return;
  const ok       = results.filter(r => r.success);
  const fail     = results.filter(r => !r.success);
  const tokenIds = ok.flatMap(r => r.tokenIds || []);
  const totalEth = ok.reduce((s, r) => s + (r.ethSpent || 0), 0);

  const hashLinks = ok.map(r =>
    '<a class="etherscan-link" href="https://etherscan.io/tx/' + r.hash + '" target="_blank" rel="noopener">' +
      '<span class="es-hash">' + r.hash.slice(0, 12) + '…' + r.hash.slice(-6) + '</span></a>'
  ).join('');

  const tokenBadges = tokenIds.length
    ? tokenIds.slice(0, 60).map(id => '<span class="token-id-badge">' + id + '</span>').join(' ')
    : '<span style="color:var(--t2);font-size:11px;">none detected</span>';

  box.innerHTML =
    '<div class="result-summary-card">' +
      '<div class="rs-title">Batch Result</div>' +
      '<div class="rs-grid">' +
        '<div class="rs-stat"><span class="rs-k">Succeeded</span><span class="rs-v ok">' + ok.length + '</span></div>' +
        '<div class="rs-stat"><span class="rs-k">Failed</span><span class="rs-v ' + (fail.length ? 'err' : '') + '">' + fail.length + '</span></div>' +
        '<div class="rs-stat"><span class="rs-k">Total ETH</span><span class="rs-v">' + totalEth.toFixed(5) + '</span></div>' +
      '</div>' +
      '<div class="rs-title" style="margin-top:14px;">Token IDs (' + tokenIds.length + ')</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;">' + tokenBadges + '</div>' +
      '<div class="rs-title" style="margin-top:14px;">Transactions</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' +
        (hashLinks || '<span style="color:var(--t2);font-size:11px;">none</span>') +
      '</div>' +
    '</div>';
}

/* ── 6. CONTRACT INSPECTOR ── */
async function inspectContract() {
  const contract = ($('bpContract')?.value.trim() || COL.contract || '').trim();
  const box = $('bpInspector');
  if (!contract.match(/^0x[a-fA-F0-9]{40}$/)) { botLog('Enter a valid contract address to inspect.', 'error'); return; }
  if (box) box.innerHTML = '<div class="contract-inspector"><div class="ci-row"><span class="ci-k">Status</span><span class="ci-v">Inspecting…</span></div></div>';
  botLog('Inspecting ' + contract.slice(0, 10) + '…');
  try {
    const abi = await fetchABI(contract);
    const fns = findMintFunctions(abi);
    let price = null;
    try { price = await detectPrice(contract, botProvider()); } catch(e) {}

    const fnList = fns.slice(0, 6).map(f => f.name + '(' + (f.inputs || []).map(i => i.type).join(',') + ')');
    if (box) box.innerHTML =
      '<div class="contract-inspector">' +
        '<div class="ci-row"><span class="ci-k">ABI</span><span class="ci-v">verified ✓ · ' + abi.length + ' entries</span></div>' +
        '<div class="ci-row"><span class="ci-k">Mint Fns</span><span class="ci-v">' + (fnList.length ? fnList.join(', ') : 'none detected') + '</span></div>' +
        '<div class="ci-row"><span class="ci-k">Detected Price</span><span class="ci-v">' + (price ? price + ' ETH' : 'FREE / none') + '</span></div>' +
      '</div>';
    botLog('Inspector: ' + fns.length + ' mint fn(s), price ' + (price || 'free'), 'success');
  } catch(e) {
    if (box) box.innerHTML = '<div class="contract-inspector"><div class="ci-row"><span class="ci-k">Error</span><span class="ci-v" style="color:var(--err)">' + e.message + '</span></div></div>';
    botLog('Inspect failed: ' + e.message, 'error');
  }
}

/* ── Wire bot-panel controls (elements are static in index.html) ── */
$('bpParseBtn')?.addEventListener('click', parseWallets);
$('bpBalBtn')?.addEventListener('click', checkBalances);
$('bpRunBtn')?.addEventListener('click', batchMint);
$('bpInspectBtn')?.addEventListener('click', inspectContract);
$('bpTurbo')?.addEventListener('click', toggleTurbo);
$('bpClearLog')?.addEventListener('click', () => {
  const el = $('bpLog');
  if (el) el.innerHTML = '<div class="log-line"><span class="log-ts">[--:--]</span>Log cleared.</div>';
});


/* ══════════════════════════════════════
   AUTO-REFRESH — polls stats every 30s
   Updates minted count, progress bar, floor
══════════════════════════════════════ */
let _refreshTimer = null;

function startRefresh() {
  stopRefresh();
  _refreshTimer = setInterval(refreshStats, 15000);
  log('Auto-refresh: every 15s', 'info');
}

function stopRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

async function refreshStats() {
  if (!COL.contract && !COL.slug) return;
  try {
    const slug = COL.slug || '';
    let minted = COL.minted, floor = COL.floor || 0;

    // ── Fetch stats (minted count + floor) ──
    if (slug) {
      try {
        const sd = await fetchWithFallback(
          'https://api.opensea.io/api/v2/collections/' + slug + '/stats',
          { timeoutMs: 5000, headers: OPENSEA_HEADERS }
        );
        if (sd?.total) {
          minted = sd.total.count       || COL.minted;
          floor  = sd.total.floor_price || 0;
        }
      } catch(e) {}
    }

    // ── Re-read totalSupply from chain (most accurate) ──
    try {
      const provider = window.ethereum
        ? new ethers.providers.Web3Provider(window.ethereum)
        : new ethers.providers.JsonRpcProvider('https://ethereum.publicnode.com');
      const abi = ['function totalSupply() view returns (uint256)'];
      const con = new ethers.Contract(COL.contract, abi, provider);
      const ts = (await con.totalSupply()).toNumber();
      if (ts > 0) minted = ts;
    } catch(e) {}

    // ── Re-fetch phases to show active stage ──
    if (slug) {
      try {
        const phases = await fetchMintPhases(slug);
        if (phases?.length) {
          COL.phases = phases;
          renderPhases(phases, COL.supply, minted, null);
        }
      } catch(e) {}
    }

    // ── Update state ──
    COL.minted = minted;
    if (floor > 0) COL.floor = floor;

    // ── Update progress bar ──
    const supply = COL.supply;
    const pct = supply > 0 ? Math.min(100, Math.round(minted / supply * 100)) : 0;
    $('progressFill').style.width = pct + '%';
    $('progressLabel').textContent = pct + '% minted';
    $('progressVal').textContent = minted.toLocaleString() + (supply > 0 ? ' / ' + supply.toLocaleString() : '');

    // ── Update floor pill ──
    const floorEl = $('colFloor');
    if (floorEl) {
      if (floor > 0) {
        floorEl.textContent = 'Floor: ' + floor.toFixed(4) + ' Ξ';
        floorEl.style.display = 'inline-flex';
      } else {
        floorEl.style.display = 'none';
      }
    }

    // ── Update limit note ──
    if (supply > 0) {
      const remaining = Math.max(0, supply - minted);
      $('limitNote').classList.add('show');
      $('limitText').textContent = supply.toLocaleString() + ' total supply · ' + remaining.toLocaleString() + ' remaining';
    }

    // ── Sold out check ──
    if (supply > 0 && minted >= supply) {
      setStatus('⚠️ SOLD OUT — ' + supply.toLocaleString() + ' / ' + supply.toLocaleString() + ' minted', 'warn');
      stopRefresh();
    }

  } catch(e) {}
}

async function init() {
  // Restore persisted tasks
  try {
    const saved = JSON.parse(localStorage.getItem('mb_tasks') || '[]');
    if (Array.isArray(saved) && saved.length) {
      // Restore time objects
      S.tasks = saved.map(t => ({ ...t, time: t.time ? new Date(t.time) : null }));
      renderTasks();
      log('Restored ' + S.tasks.length + ' task(s) from previous session', 'info');
    }
  } catch(e) {}
  setInterval(tickTasks, 1000);
  setInterval(loadPrices, 30000);
  setInterval(loadGas, 30000);
  refreshLiveGas();
  setInterval(refreshLiveGas, 15000); // bot-panel live gas display
  const t = new Date(Date.now() + 3600e3);
  if ($('mTime')) $('mTime').value = t.toISOString().slice(0, 16);
  await Promise.all([loadPrices(), loadGas()]);
}

init();
