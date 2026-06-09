/**
 * mintEngine.js — Blockchain logic only
 * Handles: ABI fetching, mint function detection,
 * price detection, arg building, simulation, tx execution
 */

'use strict';

const ETHERSCAN_API_KEY = "YOUR_API_KEY"; // ← replace with your key from etherscan.io

/* ══════════════════════════════════════
   ABI FETCHING
   Direct → CORS proxy fallbacks
══════════════════════════════════════ */
export async function fetchABI(address) {
  const url = `https://api.etherscan.io/api?module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;

  const sources = [
    url,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ];

  for (const src of sources) {
    try {
      const res = await fetch(src);
      const data = await res.json();
      if (data.status === "1" && data.result) {
        return JSON.parse(data.result);
      }
    } catch(e) {}
  }

  throw new Error("ABI not found — contract may not be verified on Etherscan");
}

/* ══════════════════════════════════════
   MINT FUNCTION DETECTION
   Filters payable functions, ranks by priority
══════════════════════════════════════ */
function rankFunctions(funcs) {
  const priority = ["mint", "public", "buy", "claim", "purchase", "free"];
  return funcs.sort((a, b) => {
    const aScore = priority.findIndex(p => a.name.toLowerCase().includes(p));
    const bScore = priority.findIndex(p => b.name.toLowerCase().includes(p));
    return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
  });
}

export function findMintFunctions(abi) {
  const funcs = abi.filter(fn =>
    fn.type === "function" &&
    (fn.stateMutability === "payable" || fn.stateMutability === "nonpayable") &&
    /mint|buy|claim|purchase|free/i.test(fn.name)
  );
  return rankFunctions(funcs);
}

/* ══════════════════════════════════════
   PRICE DETECTION
   Tries common price getter names
══════════════════════════════════════ */
export async function detectPrice(contractAddress, provider) {
  const abi = [
    "function publicSalePrice() view returns (uint256)",
    "function mintPrice() view returns (uint256)",
    "function price() view returns (uint256)",
    "function cost() view returns (uint256)",
    "function getPrice() view returns (uint256)",
    "function publicPrice() view returns (uint256)",
    "function salePrice() view returns (uint256)",
    "function tokenPrice() view returns (uint256)",
    "function PRICE() view returns (uint256)",
    "function MINT_PRICE() view returns (uint256)",
    "function currentPrice() view returns (uint256)",
    "function getMintPrice() view returns (uint256)",
    "function pricePerToken() view returns (uint256)",
    "function mintCost() view returns (uint256)",
    "function presalePrice() view returns (uint256)"
  ];
  const contract = new ethers.Contract(contractAddress, abi, provider);
  const methods = [
    "publicSalePrice", "mintPrice", "price", "cost",
    "getPrice", "publicPrice", "salePrice", "tokenPrice",
    "PRICE", "MINT_PRICE", "currentPrice", "getMintPrice",
    "pricePerToken", "mintCost", "presalePrice"
  ];
  for (const m of methods) {
    try {
      const p = await contract[m]();
      if (p && p.toString() !== "0") {
        return ethers.utils.formatEther(p); // returns string e.g. "0.0800"
      }
    } catch(e) {}
  }
  return null; // not detected
}

/* ══════════════════════════════════════
   BUILD ARGS
   Constructs calldata args from ABI input types
   Supports optional merkleProof (bytes32[]) injection
══════════════════════════════════════ */
export function buildArgs(fn, qty, addr, options = {}) {
  if (!fn.inputs || fn.inputs.length === 0) return [];
  const merkleProof = options.merkleProof || [];
  return fn.inputs.map(inp => {
    const t = inp.type;
    if (t === "bytes32[]") return merkleProof; // whitelist / merkle proof
    if (t.includes("uint")) return qty;
    if (t === "address")   return addr;
    if (t === "bool")      return true;
    if (t === "bytes")     return "0x";
    return qty;
  });
}

/* ══════════════════════════════════════
   MERKLE / WHITELIST DETECTION
   True if the function expects a bytes32[] proof arg
══════════════════════════════════════ */
export function hasMerkleProof(fn) {
  return !!(fn && fn.inputs && fn.inputs.some(inp => inp.type === "bytes32[]"));
}

/* ══════════════════════════════════════
   SHARED HELPERS
   sleep · fee computation (turbo) · retry · receipt enrichment
══════════════════════════════════════ */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isUserRejection(err) {
  return err && (err.code === 4001 ||
    /reject(ed)? by user|user rejected|user denied/i.test(err.message || ""));
}

/* Compute EIP-1559 fee overrides.
   Turbo mode: maxFeePerGas = live baseFee * 2 + tip (read via getFeeData). */
export async function computeFeeOverrides(provider, options = {}, log = () => {}) {
  const { maxGas = 50, tip = 2, turbo = false } = options;
  const tipWei = ethers.utils.parseUnits(String(tip), "gwei");

  if (turbo && provider) {
    try {
      const feeData = await provider.getFeeData();
      const baseFee = feeData.lastBaseFeePerGas || feeData.gasPrice;
      if (baseFee) {
        const maxFeePerGas = baseFee.mul(2).add(tipWei);
        log("⚡ Turbo: baseFee " + ethers.utils.formatUnits(baseFee, "gwei") +
            " gwei → maxFee " + ethers.utils.formatUnits(maxFeePerGas, "gwei") + " gwei");
        return { maxFeePerGas, maxPriorityFeePerGas: tipWei };
      }
      log("Turbo: baseFee unavailable — falling back to manual gas", "warn");
    } catch (e) {
      log("Turbo: getFeeData failed (" + (e.message || e) + ") — manual gas", "warn");
    }
  }

  return {
    maxFeePerGas: ethers.utils.parseUnits(String(maxGas), "gwei"),
    maxPriorityFeePerGas: tipWei
  };
}

/* Run taskFn, retrying up to maxRetries on failure with exponential
   backoff (1s, 2s, 4s …). User rejections are never retried. */
export async function withRetry(taskFn, log = () => {}, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await taskFn(attempt);
    } catch (err) {
      if (isUserRejection(err)) throw err;
      lastErr = err;
      if (attempt === maxRetries) break;
      const delay = 1000 * Math.pow(2, attempt); // 1000, 2000, 4000…
      const reason = (err.reason || err.message || String(err)).slice(0, 120);
      log("Retry " + (attempt + 1) + "/" + maxRetries + " in " +
          (delay / 1000) + "s — reason: " + reason, "warn");
      await sleep(delay);
    }
  }
  throw lastErr;
}

/* Parse receipt logs for ERC-721 Transfer events and return minted tokenIds.
   ERC-721 Transfer has 4 topics (sig, from, to, tokenId); ERC-20 has 3. */
// Computed lazily on first use — `ethers` is loaded async from a CDN, so we must
// not touch it at module-import time (that would crash this ES module before the UI wires up).
let _TRANSFER_TOPIC = null;
export function parseMintedTokenIds(receipt, ownerAddr) {
  const TRANSFER_TOPIC = _TRANSFER_TOPIC || (_TRANSFER_TOPIC = ethers.utils.id("Transfer(address,address,uint256)"));
  const ids = [];
  if (!receipt || !receipt.logs) return ids;
  const owner = ownerAddr ? ownerAddr.toLowerCase() : null;
  for (const lg of receipt.logs) {
    if (!lg.topics || lg.topics.length !== 4 || lg.topics[0] !== TRANSFER_TOPIC) continue;
    const to = ("0x" + lg.topics[2].slice(26)).toLowerCase();
    if (owner && to !== owner) continue; // only tokens minted to this wallet
    try {
      ids.push(ethers.BigNumber.from(lg.topics[3]).toString());
    } catch (e) {}
  }
  return ids;
}

/* ══════════════════════════════════════
   EXECUTE MINT — main entry point
   Route 1: ABI-aware + simulation
   Route 2: Brute-force signatures fallback
══════════════════════════════════════ */
export async function executeMint(contractAddr, signer, qty, log, options = {}) {
  const {
    maxGas      = 50,
    tip         = 2,
    manualPrice = null,
    turbo       = false,   // mempool speed mode: baseFee*2 + tip
    maxRetries  = 3,       // tx-failure retries with exponential backoff
    merkleProof = null     // optional bytes32[] whitelist proof
  } = options;

  /* ── NETWORK CHECK — must be Ethereum Mainnet (chainId 1) ── */
  try {
    const network = await signer.provider.getNetwork();
    if (network.chainId !== 1) {
      throw new Error(
        `Wrong network: connected to "${network.name}" (chain ${network.chainId}). ` +
        `Switch MetaMask to Ethereum Mainnet and try again.`
      );
    }
    log("Network: Ethereum Mainnet ✓");
  } catch(e) {
    if (e.message.includes("Wrong network")) throw e;
    log("Could not verify network — proceeding with caution", "warn");
  }

  const addr = await signer.getAddress();

  /* ── Route 1: ABI-aware ── */
  try {
    log("Fetching ABI…");
    const abi      = await fetchABI(contractAddr);
    const contract = new ethers.Contract(contractAddr, abi, signer);
    const mintFns  = findMintFunctions(abi);

    if (mintFns.length === 0) throw new Error("No mint function found in ABI");
    log(`Found ${mintFns.length} mint function(s)`);

    // Price — use manual override if provided, otherwise detect from contract
    let unitPrice;
    if (manualPrice !== null && manualPrice > 0) {
      unitPrice = ethers.utils.parseEther(String(manualPrice));
      log("Price (manual): " + manualPrice + " ETH");
    } else {
      const detected = await detectPrice(contractAddr, signer.provider);
      unitPrice = detected ? ethers.utils.parseEther(detected) : ethers.utils.parseEther("0");
      log("Price (detected): " + ethers.utils.formatEther(unitPrice) + " ETH");
    }

    for (const fn of mintFns) {
      try {
        log("Trying: " + fn.name + "()");
        if (hasMerkleProof(fn)) {
          if (merkleProof && merkleProof.length)
            log("Merkle proof input detected — using provided proof (" + merkleProof.length + " elements)");
          else
            log("Merkle proof input detected but none provided — passing empty array", "warn");
        }
        const args  = buildArgs(fn, qty, addr, { merkleProof });
        let   value = unitPrice.mul(qty);

        // Simulate first
        try {
          await contract.callStatic[fn.name](...args, { value });
          log("Simulation passed ✓");
        } catch(simErr) {
          // Retry as free mint (no value)
          try {
            await contract.callStatic[fn.name](...args);
            value = ethers.constants.Zero;
            log("Simulation passed (free mint) ✓");
          } catch(e) {
            log("Simulation failed — skipping " + fn.name);
            continue;
          }
        }

        // Estimate gas with 20% buffer
        let gasLimit = 300000;
        try {
          const est = await contract.estimateGas[fn.name](...args, { value });
          gasLimit = Math.ceil(est.toNumber() * 1.2);
          log("Gas estimated: " + gasLimit);
        } catch(e) {
          log("Gas estimation failed — using 300k fallback", "warn");
        }

        return await withRetry(async () => {
          const fee = await computeFeeOverrides(signer.provider, options, log);
          const tx  = await contract[fn.name](...args, { value, ...fee, gasLimit });

          log("TX sent: " + tx.hash);
          const receipt = await tx.wait();
          if (receipt.status === 0) throw new Error("Transaction reverted on-chain");

          const tokenIds = parseMintedTokenIds(receipt, addr);
          const gasUsed  = receipt.gasUsed?.toString() || '?';
          const block    = receipt.blockNumber || '?';
          log("✅ Mint confirmed! Block " + block + " · Gas used: " + gasUsed +
              (tokenIds.length ? " · tokenIds: " + tokenIds.join(", ") : ""));
          return { success: true, hash: tx.hash, block, gasUsed, tokenIds };
        }, log, maxRetries);

      } catch(err) {
        if (err.code === 4001) throw new Error("Rejected by user");
        log("Failed: " + fn.name + " — " + (err.reason || err.message).slice(0, 80));
      }
    }

    throw new Error("All ABI functions failed");

  } catch(abiErr) {
    if (abiErr.message === "Rejected by user") throw abiErr;
    log("ABI route failed: " + abiErr.message);
    log("Trying brute-force signatures…");
  }

  /* ── Route 2: Brute-force ── */
  const SIGS = [
    "mint(uint256)", "mint()",
    "publicMint(uint256)", "publicMint()",
    "buy(uint256)", "buy()",
    "claim(uint256)", "claim()",
    "purchase(uint256)",
    "freeMint(uint256)", "freeMint()"
  ];

  const bruteValue = manualPrice
    ? ethers.utils.parseEther(String(manualPrice * qty))
    : ethers.utils.parseEther("0");

  for (const sig of SIGS) {
    try {
      log("Trying: " + sig);
      const iface  = new ethers.utils.Interface(["function " + sig]);
      const fnName = sig.split("(")[0];
      const data   = sig.includes("uint256")
        ? iface.encodeFunctionData(fnName, [qty])
        : iface.encodeFunctionData(fnName);

      // Estimate gas with 20% buffer
      let gasLimit = 300000;
      try {
        const est = await signer.estimateGas({ to: contractAddr, value: bruteValue, data });
        gasLimit = Math.ceil(est.toNumber() * 1.2);
        log("Gas estimated: " + gasLimit);
      } catch(e) {}

      return await withRetry(async () => {
        const fee = await computeFeeOverrides(signer.provider, options, log);
        const tx  = await signer.sendTransaction({
          to: contractAddr,
          value: bruteValue,
          data,
          ...fee,
          gasLimit
        });

        log("TX sent: " + tx.hash);
        const receipt = await tx.wait();
        if (receipt.status === 0) throw new Error("Transaction reverted on-chain");

        const tokenIds = parseMintedTokenIds(receipt, addr);
        const gasUsed  = receipt.gasUsed?.toString() || '?';
        const block    = receipt.blockNumber || '?';
        log("✅ Mint confirmed! Block " + block + " · Gas used: " + gasUsed +
            (tokenIds.length ? " · tokenIds: " + tokenIds.join(", ") : ""));
        return { success: true, hash: tx.hash, block, gasUsed, tokenIds };
      }, log, maxRetries);

    } catch(err) {
      if (err.code === 4001) throw new Error("Rejected by user");
      log("Failed: " + sig);
    }
  }

  throw new Error("All mint attempts failed");
}

/* ══════════════════════════════════════
   PRIVATE KEY SIGNER
   Creates a signer from a raw private key
   WARNING: Never share your private key
══════════════════════════════════════ */
export function createPrivateKeySigner(privateKey, rpcUrl = 'https://ethereum.publicnode.com') {
  if (!privateKey || privateKey.trim() === '') throw new Error('Private key is empty');
  const pk = privateKey.trim().startsWith('0x') ? privateKey.trim() : '0x' + privateKey.trim();
  if (pk.length !== 66) throw new Error('Invalid private key length');
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  return wallet;
}

export async function getPrivateKeyAddress(privateKey) {
  const signer = createPrivateKeySigner(privateKey);
  return await signer.getAddress();
}

/* ══════════════════════════════════════
   MULTI-WALLET MINT
   Accepts an array of private keys (strings) or signer objects.
   Executes a mint from each wallet in parallel (Promise.allSettled)
   and returns one result object per wallet.
══════════════════════════════════════ */
export async function mintFromWallets(contractAddr, signers, qty, log, options = {}) {
  if (!Array.isArray(signers) || signers.length === 0)
    throw new Error("signers must be a non-empty array of private keys or signers");

  log("Minting from " + signers.length + " wallet(s) in parallel…");

  const settled = await Promise.allSettled(signers.map(async (entry, i) => {
    let signer, addr;
    try {
      signer = typeof entry === "string"
        ? createPrivateKeySigner(entry, options.rpcUrl)
        : entry;
      addr = await signer.getAddress();
    } catch (e) {
      return { index: i, wallet: null, success: false, error: "Invalid wallet: " + e.message };
    }

    const tag  = "[wallet " + (i + 1) + " " + addr.slice(0, 6) + "…" + addr.slice(-4) + "] ";
    const wlog = (m, lvl) => log(tag + m, lvl);

    try {
      const result = await executeMint(contractAddr, signer, qty, wlog, options);
      return { index: i, wallet: addr, ...result };
    } catch (e) {
      return { index: i, wallet: addr, success: false, error: e.message };
    }
  }));

  const results = settled.map((s, i) => s.status === "fulfilled"
    ? s.value
    : { index: i, wallet: null, success: false, error: s.reason?.message || String(s.reason) });

  const ok = results.filter(r => r.success).length;
  log("Multi-wallet complete: " + ok + "/" + results.length + " succeeded");
  return results;
}

/* ══════════════════════════════════════
   BATCH MINT
   Splits totalQty into sequential txs of perTxQty each, with a
   configurable delay (options.delayMs, default 1000) between txs.
   Returns one result object per batch tx.
══════════════════════════════════════ */
export async function batchMint(contractAddr, signer, totalQty, perTxQty, log, options = {}) {
  const { delayMs = 1000 } = options;
  if (totalQty <= 0 || perTxQty <= 0)
    throw new Error("totalQty and perTxQty must be positive numbers");

  const txCount = Math.ceil(totalQty / perTxQty);
  log("Batch mint: " + totalQty + " total across " + txCount + " tx (" +
      perTxQty + "/tx · " + delayMs + "ms delay)");

  const results = [];
  let remaining = totalQty;

  for (let i = 0; i < txCount; i++) {
    const thisQty = Math.min(perTxQty, remaining);
    remaining -= thisQty;
    log("Batch " + (i + 1) + "/" + txCount + " — minting " + thisQty);

    try {
      const result = await executeMint(contractAddr, signer, thisQty, log, options);
      results.push({ batch: i + 1, qty: thisQty, ...result });
    } catch (e) {
      results.push({ batch: i + 1, qty: thisQty, success: false, error: e.message });
      if (isUserRejection(e)) {
        log("User rejected — stopping batch", "warn");
        break;
      }
    }

    if (i < txCount - 1 && delayMs > 0) {
      log("Waiting " + delayMs + "ms before next tx…");
      await sleep(delayMs);
    }
  }

  const ok = results.filter(r => r.success).length;
  log("Batch complete: " + ok + "/" + results.length + " tx succeeded");
  return results;
}
