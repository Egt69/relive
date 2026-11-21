/* ============================================================
   Retium Live — data layer & UI
   Reads only public endpoints:
     https://rpc.retium.org/api/*
     https://api.retium.money/api/summary
   ============================================================ */
(() => {
  'use strict';

  document.documentElement.classList.add('js');

  /* ---------------- constants ---------------- */

  const API = 'https://rpc.retium.org/api';
  const MONEY = 'https://api.retium.money/api/summary';
  const NFT_CALL_METHODS = new Set([
    'mint', 'batch_mint', 'batch_mint_base', 'drop_mint', 'drop_mint_pick',
    'transfer', 'batch_transfer', 'burn', 'batch_burn', 'reveal', 'init_drop'
  ]);
  const STORE_COLLECTIONS = 'retium-live.collections.v1';
  const STORE_NAMES = 'retium-live.names.v1';
  const STORE_RANGE = 'retium-live.range.v1';
  const STORE_META = 'retium-live.nftmeta.v1';
  const META_TTL = 7 * 24 * 60 * 60 * 1000;

  // Public IPFS gateways. The first one that answers wins.
  const IPFS_GATEWAYS = [
    'https://ipfs.filebase.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://ipfs.io/ipfs/'
  ];

  const TYPE_META = [
    { key: 'transfer', label: 'Transfers', color: '#4ade80' },
    { key: 'contract_call', label: 'Contract calls', color: '#60a5fa' },
    { key: 'contract_deploy', label: 'Contract deploys', color: '#c084fc' },
    { key: 'stake', label: 'Stake', color: '#facc15' },
    { key: 'unstake', label: 'Unstake', color: '#fb923c' },
    { key: 'safehouse', label: 'Safehouse', color: '#38bdf8' },
    { key: 'validator', label: 'Validator registry', color: '#f472b6' },
    { key: 'api_key', label: 'API key ops', color: '#94a3b8' },
    { key: 'multisig', label: 'Multisig', color: '#a78bfa' },
    { key: 'other', label: 'Other', color: '#64748b' }
  ];

  const ACTION_LABEL = {
    transfer: 'Transfer',
    contract_call: 'Contract call',
    contract_deploy: 'Deploy',
    stake: 'Stake',
    unstake: 'Unstake',
    safehouse: 'Safehouse',
    validator: 'Validator',
    api_key: 'API key',
    multisig: 'Multisig',
    other: 'Other'
  };

  // Transaction and stats endpoints use slightly different action names.
  function actionInfo(raw) {
    const key = String(raw || '').toLowerCase();
    if (key === 'transfer') return { label: 'Transfer', cls: 'transfer' };
    if (key === 'call' || key === 'contract_call' || key === 'contractcall') {
      return { label: 'Contract call', cls: 'contract_call' };
    }
    if (key === 'deploy' || key === 'deployment' || key.startsWith('contract_deploy')) {
      return { label: 'Contract deploy', cls: 'contract_deploy' };
    }
    if (key.startsWith('safehouse')) {
      const suffix = key.replace(/^safehouse_?/, '').replace(/_/g, ' ').trim();
      return { label: suffix ? `Safehouse ${suffix}` : 'Safehouse', cls: 'safehouse' };
    }
    if (key === 'stake' || key === 'unstake') {
      return { label: key.charAt(0).toUpperCase() + key.slice(1), cls: key };
    }
    if (ACTION_LABEL[key]) return { label: ACTION_LABEL[key], cls: key };
    const pretty = key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).trim();
    return { label: pretty || 'Action', cls: 'other' };
  }

  const state = {
    stats: null,
    tick: null,
    safehouse: null,
    summary: null,
    histogram: null,
    range: readStore(STORE_RANGE) || '7d',
    rpcMs: null,
    transactions: [],
    txFilter: 'all',
    blocks: [],
    collections: loadCollections(),
    names: loadNames(),
    nft: null,
    searchToken: 0,
    prevKpi: {},
    lastSync: null,
    lastTickAt: null,
    lastTopTx: null,
    seenTx: new Set()
  };

  let coreBusy = false;
  let feedBusy = false;
  let nftBusy = false;
  let tickBusy = false;
  let coreRetry = null;
  let feedRetry = null;
  let tickRetry = null;

  /* ---------------- tiny helpers ---------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const num = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
  };

  const fmtAmount = (value, maxFrac = 6) => {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (n === 0) return '0';
    if (n > 0 && n < 0.000001) return '<0.000001';
    return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
  };

  const fmtAtomic = (value, decimals = 18, maxFrac = 2) => {
    if (value === null || value === undefined || value === '') return '—';
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) return fmtAmount(raw, maxFrac);
    const big = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = big / base;
    const frac = big % base;
    let out = whole.toLocaleString('en-US');
    if (frac > 0n && maxFrac > 0) {
      const fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
      if (fracStr) out += `.${fracStr}`;
    }
    return out;
  };

  const short = (value, head = 10, tail = 6) => {
    const s = String(value == null ? '' : value);
    if (s.length <= head + tail + 3) return s;
    return `${s.slice(0, head)}…${s.slice(-tail)}`;
  };

  const toMs = (ts) => {
    const n = Number(ts);
    if (!Number.isFinite(n)) return 0;
    return n > 1e12 ? n : n * 1000;
  };

  const timeAgo = (ts) => {
    const ms = toMs(ts);
    if (!ms) return '—';
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 31) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    return `${mo}mo ago`;
  };

  const dateLabel = (seconds, range) => {
    const d = new Date(Number(seconds) * 1000);
    if (range === '1d') {
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const pct = (part, whole) => {
    const p = Number(part);
    const w = Number(whole);
    if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return '0%';
    return `${((p / w) * 100).toFixed(1)}%`;
  };

  const setText = (sel, value) => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (el && el.textContent !== String(value)) el.textContent = value;
  };

  function readStore(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  }

  function loadCollections() {
    let list = [];
    try {
      const raw = JSON.parse(readStore(STORE_COLLECTIONS) || '[]');
      if (Array.isArray(raw)) list = raw.filter((id) => /^[0-9a-f]{64}$/i.test(String(id)));
    } catch { list = []; }
    const normalized = list.map((id) => String(id).toLowerCase());
    return Array.from(new Set(normalized)).slice(0, 12);
  }

  function saveCollections() {
    writeStore(STORE_COLLECTIONS, JSON.stringify(state.collections));
  }

  function loadNames() {
    try {
      const raw = JSON.parse(readStore(STORE_NAMES) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  }

  function saveNames() {
    writeStore(STORE_NAMES, JSON.stringify(state.names));
  }

  function collectionName(id) {
    return state.names[id] || `Collection ${short(id, 6, 4)}`;
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function setApiError(message) {
    let host = $('#api-error');
    if (!host) {
      host = document.createElement('div');
      host.id = 'api-error';
      host.className = 'wrap';
      const alert = document.createElement('div');
      alert.className = 'alert';
      host.appendChild(alert);
      const main = $('main');
      main.insertBefore(host, $('#activity'));
    }
    if (message) {
      host.hidden = false;
      host.firstElementChild.textContent = message;
    } else {
      host.hidden = true;
    }
  }

  /* ---------------- network ---------------- */

  async function api(path, { timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(API + path, {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        const message = (data && typeof data === 'object' && (data.error || data.message)) || `HTTP ${res.status}`;
        const error = new Error(message);
        error.status = res.status;
        error.data = data;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function timed(promise) {
    const t0 = performance.now();
    const data = await promise;
    return { data, ms: Math.round(performance.now() - t0) };
  }

  async function getMoney() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(MONEY, {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- core loading ---------------- */

  async function loadCore({ silent = false } = {}) {
    if (coreBusy) return;
    coreBusy = true;
    const btn = $('#refresh-btn');
    if (btn) btn.classList.add('is-loading');
    const tz = -new Date().getTimezoneOffset();
    const requestedRange = state.range;

    const results = await Promise.allSettled([
      api('/stats'),
      timed(api('/tick/current')),
      api(`/transactions/histogram?range=${requestedRange}&tz=${tz}`),
      api('/safehouse'),
      getMoney()
    ]);

    const errors = [];

    if (results[0].status === 'fulfilled') {
      state.stats = results[0].value;
      try { renderStats(); } catch (err) { console.error(err); errors.push(err); }
      try { renderStaking(); } catch (err) { console.error(err); }
    } else {
      errors.push(results[0].reason);
    }

    if (results[1].status === 'fulfilled') {
      state.tick = results[1].value.data;
      state.rpcMs = results[1].value.ms;
      try { renderTick(); } catch (err) { console.error(err); errors.push(err); }
    } else {
      errors.push(results[1].reason);
    }

    if (results[2].status === 'fulfilled') {
      if (state.range === requestedRange) {
        state.histogram = results[2].value;
        try { renderHistogram(); } catch (err) { console.error(err); errors.push(err); }
      }
    } else {
      errors.push(results[2].reason);
    }

    if (results[3].status === 'fulfilled') {
      state.safehouse = results[3].value;
      try { renderEconomy(); buildMarquee(); } catch (err) { console.error(err); }
    }

    if (results[4].status === 'fulfilled') {
      state.summary = results[4].value;
      try { renderEconomy(); buildMarquee(); } catch (err) { console.error(err); }
    }

    if (state.stats || state.tick) {
      setApiError('');
      markSync();
    } else if (errors.length) {
      setApiError('Could not reach the Retium public API. Check your connection, an ad-blocker, or try again in a moment.');
      toast('Retium API unreachable', true);
      const grid = $('#kpi-grid');
      if (grid) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Stats could not be loaded. <button class="chip" type="button" data-retry="core">Retry</button></div>`;
      }
      if (!coreRetry) {
        coreRetry = setTimeout(() => {
          coreRetry = null;
          loadCore({ silent: true });
        }, 5000);
      }
    }

    if (errors.length && !silent && (state.stats || state.tick)) {
      toast('Some panels could not refresh — showing the last known values', true);
    }

    coreBusy = false;
    if (btn) btn.classList.remove('is-loading');
  }

  async function loadHistogram() {
    const requestedRange = state.range;
    try {
      const data = await api(`/transactions/histogram?range=${requestedRange}&tz=${-new Date().getTimezoneOffset()}`);
      if (state.range !== requestedRange) return;
      state.histogram = data;
      renderHistogram();
    } catch (err) {
      console.warn('histogram', err);
      toast('Could not load the transaction chart', true);
    }
  }

  /* ---------------- realtime tick ---------------- */

  function markSync() {
    state.lastSync = Date.now();
    setText('#last-sync', new Date(state.lastSync).toLocaleTimeString('en-US', { hour12: false }));
    updateSyncAge();
  }

  function updateSyncAge() {
    const el = $('#sync-age');
    if (!el) return;
    if (!state.lastSync) { el.textContent = ''; return; }
    const seconds = Math.max(0, Math.floor((Date.now() - state.lastSync) / 1000));
    el.textContent = seconds < 2 ? '· just now' : `· ${seconds}s ago`;
    el.classList.toggle('stale', seconds > 20);
  }

  function flashTick() {
    const el = $('#hero-tick');
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  async function loadTick() {
    if (tickBusy) return;
    tickBusy = true;
    try {
      const result = await timed(api('/tick/current', { timeout: 8000 }));
      const previous = state.tick ? Number(state.tick.tick) : null;
      state.tick = result.data;
      state.rpcMs = result.ms;
      renderTick();
      if (previous !== null && Number(result.data?.tick) > previous) flashTick();
      markSync();
    } catch (err) {
      console.warn('tick', err);
      if (!tickRetry) {
        tickRetry = setTimeout(() => {
          tickRetry = null;
          loadTick();
        }, 8000);
      }
    } finally {
      tickBusy = false;
    }
  }

  /* ---------------- hero ---------------- */

  function walletCount(stats) {
    if (!stats) return null;
    if (stats.wallets !== undefined && stats.wallets !== null) return Number(stats.wallets) || 0;
    const windows = Array.isArray(stats.wallet_windows) ? stats.wallet_windows : [];
    const monthly = windows.find((w) => Number(w.hours) === 720);
    return monthly ? Number(monthly.new_wallets) || 0 : null;
  }

  function renderTick() {
    const tick = state.tick;
    if (!tick) return;
    const stats = state.stats;

    setText('#hero-tick', `#${num(tick.tick)}`);
    setText('#hero-tick-sub', `${num(tick.total_blocks)} blocks in mesh · ${num(tick.open_blocks)} open`);
    setText('#hero-rpc', state.rpcMs === null ? '—' : `${num(state.rpcMs)} ms`);
    setText('#hero-rpc-sub', state.rpcMs !== null && state.rpcMs < 400 ? 'rpc.retium.org · healthy' : 'rpc.retium.org');

    if (stats) {
      const wallets = walletCount(stats);
      setText('#hero-blocks', num(stats.blocks_finalized));
      setText('#hero-blocks-sub', `${num(stats.totals?.transactions?.total)} actions${wallets === null ? '' : ` · ${num(wallets)} wallets`}`);
      setText('#hero-total', num(stats.totals?.transactions?.total));
      setText('#hero-total-sub', `${num(stats.totals?.transactions?.transfer)} transfers · ${num(stats.totals?.transactions?.contract_deploy)} deploys`);
    }

    if (stats) buildMarquee();
  }

  function buildMarquee() {
    const stats = state.stats;
    if (!stats) return;
    const tx = stats.totals?.transactions || {};
    const items = [
      ['Tick', `#${num(state.tick?.tick)}`],
      ['Blocks finalized', num(stats.blocks_finalized)],
      ['Transactions', num(tx.total)],
      ['Transfers', num(tx.transfer)],
      ['Contract calls', num(tx.contract_call)],
      ['Contract deploys', num(tx.contract_deploy)],
      ['Stake', num(tx.stake)],
      ['Unstake', num(tx.unstake)],
      ['Wallets', num(walletCount(stats))],
      ['NFT supply indexed', state.nft ? num(state.nft.supply) : '—'],
      ['RTD supply', state.summary ? fmtAtomic(state.summary.supply_atomic, 18, 2) : '—'],
      ['RPC', state.rpcMs === null ? '—' : `${num(state.rpcMs)} ms`]
    ];
    const chunk = items
      .map(([label, value]) => `<span>${esc(label)} <b>${esc(value)}</b></span><i></i>`)
      .join('');
    const track = $('#marquee');
    if (track) track.innerHTML = chunk + chunk;
  }

  /* ---------------- stats ---------------- */

  function kpiMarkup(cards, className = 'kpi') {
    return cards.map((card) => {
      const prev = state.prevKpi[card.label];
      const changed = prev !== undefined && prev !== card.value;
      state.prevKpi[card.label] = card.value;
      return `<article class="${className}" style="--accent:${card.color}">
        <div class="kpi-label"><i aria-hidden="true"></i>${esc(card.label)}</div>
        <div class="kpi-value${changed ? ' flash' : ''}">${esc(card.display ?? num(card.value))}</div>
        <div class="kpi-sub">${card.subHtml ?? esc(card.sub || '')}</div>
      </article>`;
    }).join('');
  }

  function renderStats() {
    const stats = state.stats;
    if (!stats) return;
    const tx = stats.totals?.transactions || {};
    const fees = stats.totals?.fees || {};
    const windows = Array.isArray(stats.wallet_windows) ? stats.wallet_windows : [];
    const total = Number(tx.total) || 0;

    const share = (value) => {
      const n = Number(value) || 0;
      if (!total) return '—';
      return `${((n / total) * 100).toFixed(1)}% of all actions`;
    };

    const new24 = windows.find((w) => Number(w.hours) === 24)?.new_wallets ?? '—';
    const wallets = walletCount(stats);

    const cards = [
      { label: 'Total transactions', value: total, sub: 'all-time ledger actions', color: '#4ade80' },
      { label: 'Transfers', value: tx.transfer || 0, sub: share(tx.transfer), color: '#86efac' },
      { label: 'Contract calls', value: tx.contract_call || 0, sub: share(tx.contract_call), color: '#60a5fa' },
      { label: 'Contract deploys', value: tx.contract_deploy || 0, sub: share(tx.contract_deploy), color: '#c084fc' },
      { label: 'Stake', value: tx.stake || 0, sub: share(tx.stake), color: '#facc15' },
      { label: 'Unstake', value: tx.unstake || 0, sub: share(tx.unstake), color: '#fb923c' },
      { label: 'Wallets', value: wallets ?? 0, sub: `${num(new24)} new in the last 24h`, color: '#34d399' },
      { label: 'Blocks finalized', value: stats.blocks_finalized || 0, sub: `${num(fees.blocks_paid)} blocks paid fees`, color: '#22d3ee' },
      { label: 'Validator registry', value: tx.validator || 0, sub: 'validator registry actions', color: '#f472b6' },
      { label: 'Safehouse ops', value: tx.safehouse || 0, sub: 'RTD mint / redeem / lock', color: '#38bdf8' },
      { label: 'API key ops', value: tx.api_key || 0, sub: 'developer key activity', color: '#94a3b8' },
      { label: 'Multisig', value: tx.multisig || 0, sub: `${num(tx.other)} other actions`, color: '#a78bfa' }
    ];

    $('#kpi-grid').innerHTML = kpiMarkup(cards);

    renderTypes(tx);
    renderNetwork(stats, windows);
    renderFees(fees);
    renderTick();
    buildMarquee();
  }

  function renderTypes(tx) {
    const rows = TYPE_META.map((meta) => ({
      ...meta,
      value: Number(tx[meta.key]) || 0
    }));
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const max = Math.max(...rows.map((row) => row.value), 1);

    setText('#type-total', `${num(total)} total`);

    const stack = $('#type-stack');
    if (stack) {
      stack.innerHTML = total
        ? rows.filter((row) => row.value > 0).map((row) =>
          `<span style="width:${(row.value / total) * 100}%;background:${row.color}" title="${esc(row.label)}: ${num(row.value)}"></span>`
        ).join('')
        : '<span style="width:100%;background:#1f2937"></span>';
    }

    const list = $('#type-list');
    if (list) {
      const sorted = [...rows].sort((a, b) => b.value - a.value);
      list.innerHTML = sorted.map((row) => `<li class="type-row">
        <span class="type-name"><i style="background:${row.color}" aria-hidden="true"></i>${esc(row.label)}</span>
        <span class="type-track"><span class="type-fill" style="width:${(row.value / max) * 100}%;background:${row.color}"></span></span>
        <span class="type-count">${num(row.value)}</span>
        <span class="type-share">${total ? ((row.value / total) * 100).toFixed(1) : '0.0'}%</span>
      </li>`).join('');
    }
  }

  function nodeCard(role, online, total, sub) {
    const safeTotal = Number(total) || 0;
    const safeOnline = Number(online) || 0;
    const width = safeTotal ? Math.min(100, (safeOnline / safeTotal) * 100) : 0;
    return `<div class="node-card">
      <div class="node-top">
        <span class="node-role">${esc(role)}</span>
        <span class="node-val"><b>${num(safeOnline)}</b>/${num(safeTotal)}</span>
      </div>
      <div class="node-bar"><i style="width:${width}%"></i></div>
      <div class="node-sub">${esc(sub)}</div>
    </div>`;
  }

  function renderNetwork(stats, windows) {
    const nodes = stats.nodes || {};
    const keepers = nodes.keepers || { online: 0, total: 0 };
    const suits = nodes.suits || { online: 0, total: 0 };
    const workers = nodes.workers || { online: 0, total: 0 };
    const rpc = nodes.rpc || { total: 0 };

    const online = Number(keepers.online || 0) + Number(suits.online || 0) + Number(workers.online || 0);
    const all = Number(keepers.total || 0) + Number(suits.total || 0) + Number(workers.total || 0);
    const pill = $('#node-summary');
    if (pill) {
      pill.textContent = all ? `${online}/${all} online` : '—';
      pill.classList.toggle('warn', all > 0 && online < all);
      pill.classList.toggle('ok', all > 0 && online === all);
    }

    const grid = $('#node-grid');
    if (grid) {
      grid.innerHTML = [
        nodeCard('Keepers', keepers.online, keepers.total, 'consensus'),
        nodeCard('Suits', suits.online, suits.total, 'finality'),
        nodeCard('Workers', workers.online, workers.total, 'execution'),
        nodeCard('RPC nodes', rpc.total, rpc.total, 'public endpoints')
      ].join('');
    }

    const maxActive = Math.max(...windows.map((w) => Number(w.active_wallets) || 0), 1);
    const maxNew = Math.max(...windows.map((w) => Number(w.new_wallets) || 0), 1);
    const host = $('#wallet-windows');
    if (host) {
      host.innerHTML = windows.map((w) => {
        const hours = Number(w.hours) || 0;
        const label = hours === 24 ? '24h' : hours === 168 ? '7d' : hours === 720 ? '30d' : `${hours}h`;
        return `<div class="window-row">
          <span class="window-label">${label}</span>
          <span class="window-bars">
            <span class="window-bar active" title="${num(w.active_wallets)} active wallets"><i style="width:${(Number(w.active_wallets) || 0) / maxActive * 100}%"></i></span>
            <span class="window-bar new" title="${num(w.new_wallets)} new wallets"><i style="width:${(Number(w.new_wallets) || 0) / maxNew * 100}%"></i></span>
          </span>
          <span class="window-meta"><b>${num(w.active_wallets)}</b> active<br /><b>${num(w.new_wallets)}</b> new</span>
        </div>`;
      }).join('');
    }

    const chips = $('#ledger-chips');
    if (chips) {
      const tx = stats.totals?.transactions || {};
      const items = [];
      if (stats.transactions_rejected !== undefined) items.push(`<span><b>Rejected</b> ${num(stats.transactions_rejected)}</span>`);
      if (stats.transactions_voided !== undefined) items.push(`<span><b>Voided</b> ${num(stats.transactions_voided)}</span>`);
      items.push(`<span><b>Types tracked</b> ${num(TYPE_META.length)}</span>`);
      items.push(`<span><b>API key ops</b> ${num(tx.api_key)}</span>`);
      items.push(`<span><b>RPC nodes</b> ${num(rpc.total)}</span>`);
      chips.innerHTML = items.join('');
    }
  }

  function renderFees(fees) {
    const collected = Number(fees.collected_rtm) || 0;
    const rows = [
      ['Workers', Number(fees.workers_rtm) || 0, '#4ade80'],
      ['Foundation', Number(fees.foundation_rtm) || 0, '#34d399'],
      ['Keepers', Number(fees.keepers_rtm) || 0, '#22d3ee'],
      ['Suits', Number(fees.suits_rtm) || 0, '#60a5fa'],
      ['Treasury', Number(fees.treasury_rtm) || 0, '#c084fc'],
      ['Burned', Number(fees.burned_rtm) || 0, '#fb923c']
    ];

    setText('#fees-blocks', `${num(fees.blocks_paid)} blocks paid`);

    const grid = $('#fee-grid');
    if (grid) {
      const cards = [
        ['Collected', fees.collected_rtm, 'RTM'],
        ['Burned', fees.burned_rtm, 'RTM'],
        ['Burned', fees.burned_rusd, 'RUSD'],
        ['Workers', fees.workers_rtm, 'RTM'],
        ['Foundation', fees.foundation_rtm, 'RTM'],
        ['Treasury', fees.treasury_rtm, 'RTM'],
        ['Suits', fees.suits_rtm, 'RTM'],
        ['Keepers', fees.keepers_rtm, 'RTM']
      ];
      grid.innerHTML = cards.map(([label, value, unit]) =>
        `<div class="fee-card"><span>${esc(label)}</span><strong>${esc(fmtAmount(value, 2))}<small>${esc(unit)}</small></strong></div>`
      ).join('');
    }

    const bars = $('#fee-bars');
    if (bars) {
      bars.innerHTML = rows.map(([label, value, color]) => {
        const width = collected ? Math.min(100, (value / collected) * 100) : 0;
        return `<div class="fee-bar-row">
          <span>${esc(label)}</span>
          <span class="type-track"><span class="type-fill" style="width:${width}%;background:${color}"></span></span>
          <b>${esc(fmtAmount(value, 2))} RTM</b>
        </div>`;
      }).join('');
    }
  }

  /* ---------------- chart ---------------- */

  function renderHistogram() {
    const data = state.histogram;
    const svg = $('#hist-chart');
    if (!data || !Array.isArray(data.buckets) || !svg) return;

    const buckets = data.buckets;
    if (!buckets.length) return;
    const range = data.range || state.range;
    const total = Number(data.total) || 0;
    const counts = buckets.map((b) => Number(b.count) || 0);
    const max = Math.max(...counts, 1);
    const peakIndex = counts.indexOf(Math.max(...counts));

    const caption = range === '1d' ? 'Rolling 24 hours' : range === '7d' ? 'Rolling 7 days' : 'Rolling 30 days';
    setText('#hist-caption', caption);
    setText('#hist-total', num(total));
    setText('#hist-avg', num(Math.round(total / Math.max(buckets.length, 1))));
    setText('#hist-peak', `${num(counts[peakIndex] || 0)}`);

    // Make one SVG unit equal one CSS pixel so labels stay readable at every width.
    const cssWidth = Math.round(svg.clientWidth || svg.getBoundingClientRect().width || 1000);
    const W = Math.max(300, cssWidth);
    const H = W < 560 ? 236 : 280;
    const padL = W < 560 ? 42 : 54;
    const padR = 10;
    const padT = 18;
    const padB = W < 560 ? 32 : 38;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const slot = plotW / buckets.length;
    const barW = Math.max(2, Math.min(W < 560 ? 28 : 60, slot * 0.7));

    let grid = '';
    for (let i = 0; i <= 3; i += 1) {
      const y = padT + (plotH / 3) * i;
      const value = Math.round(max - (max / 3) * i);
      grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="rgba(74,222,128,0.09)" stroke-dasharray="3 5" />`;
      grid += `<text x="${padL - 10}" y="${(y + 3).toFixed(1)}" text-anchor="end">${num(value)}</text>`;
    }

    const step = Math.max(1, Math.ceil(buckets.length / 6));
    let labels = '';
    let bars = '';
    buckets.forEach((bucket, i) => {
      const count = counts[i];
      const h = max ? (count / max) * plotH : 0;
      const x = padL + slot * i + (slot - barW) / 2;
      const y = padT + plotH - h;
      const label = dateLabel(bucket.start_ts, range);
      const isPeak = i === peakIndex && count > 0;
      bars += `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 0.8).toFixed(1)}" rx="${Math.min(3, barW / 3).toFixed(1)}" fill="${isPeak ? 'url(#barPeak)' : 'url(#barGrad)'}" data-label="${esc(label)}" data-count="${count}"><title>${esc(label)} — ${num(count)} transactions</title></rect>`;
      if (i % step === 0 || i === buckets.length - 1) {
        labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle">${esc(label)}</text>`;
      }
    });

    svg.innerHTML = `<defs>
      <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4ade80" /><stop offset="100%" stop-color="#14532d" />
      </linearGradient>
      <linearGradient id="barPeak" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#bef264" /><stop offset="100%" stop-color="#15803d" />
      </linearGradient>
    </defs>
    ${grid}${bars}${labels}`;

    attachChartTips();
  }

  function attachChartTips() {
    const wrap = $('.chart-wrap');
    const tip = $('#chart-tip');
    if (!wrap || !tip) return;

    $$('#hist-chart .bar').forEach((bar) => {
      bar.addEventListener('mouseenter', () => {
        const rect = bar.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        tip.innerHTML = `<b>${esc(bar.dataset.count)} transactions</b><small>${esc(bar.dataset.label)}</small>`;
        tip.style.left = `${rect.left - wrapRect.left + rect.width / 2}px`;
        tip.style.top = `${rect.top - wrapRect.top}px`;
        tip.hidden = false;
      });
      bar.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  /* ---------------- NFT ---------------- */

  function parseNftEvent(event, collectionId, name) {
    let payload = {};
    try { payload = JSON.parse(event.data || '{}'); } catch { payload = {}; }
    const rawType = String(payload.type || event.event_type || '').toLowerCase();
    let kind = 'other';
    if (rawType === 'transfer') {
      const from = String(payload.from || '').toLowerCase();
      const to = String(payload.to || '').toLowerCase();
      if (!from || from === '0x0') kind = 'mint';
      else if (!to || to === '0x0') kind = 'burn';
      else kind = 'transfer';
    } else if (rawType.includes('mint')) {
      kind = 'mint';
    } else if (rawType.includes('burn')) {
      kind = 'burn';
    }
    return {
      kind,
      type: payload.type || event.event_type || 'Event',
      tokenId: payload.id ?? payload.token_id ?? payload.tokenId ?? null,
      from: payload.from ?? null,
      to: payload.to ?? null,
      ts: event.timestamp,
      txId: event.tx_id,
      collection: collectionId,
      collectionName: name
    };
  }

  async function loadCollection(id) {
    const [metaR, supplyR, eventsR] = await Promise.allSettled([
      api(`/contract/${id}`),
      api(`/contract/${id}/query?method=total_supply&args=`),
      api(`/contract/${id}/events`)
    ]);

    const meta = metaR.status === 'fulfilled' ? metaR.value : null;
    let supply = null;
    if (supplyR.status === 'fulfilled' && supplyR.value && supplyR.value.ok) {
      const parsed = Number(supplyR.value.output);
      if (Number.isFinite(parsed)) supply = parsed;
    }

    let events = [];
    if (eventsR.status === 'fulfilled' && eventsR.value && Array.isArray(eventsR.value.events)) {
      events = eventsR.value.events;
    }

    if (meta && meta.rcp_metadata) {
      const type = String(meta.rcp_metadata.rcp_type || '').toUpperCase();
      if (type.includes('NFT')) {
        // The collection name is only exposed per wallet; keep the id as fallback.
      }
    }

    const name = collectionName(id);
    const parsedEvents = events.map((event) => parseNftEvent(event, id, name));
    const counts = parsedEvents.reduce((acc, event) => {
      acc.total += 1;
      if (event.kind === 'mint') acc.mints += 1;
      else if (event.kind === 'burn') acc.burns += 1;
      else if (event.kind === 'transfer') acc.transfers += 1;
      return acc;
    }, { total: 0, mints: 0, transfers: 0, burns: 0 });

    const minted = parsedEvents.find((event) => event.kind === 'mint' && event.tokenId !== null);
    const coverToken = minted ? Number(minted.tokenId) : (supply ? 1 : null);

    return {
      id,
      name,
      type: meta?.rcp_metadata?.rcp_type || 'Contract',
      status: meta?.status || 'unknown',
      deployer: meta?.deployer || null,
      tick: meta?.deployed_at_tick ?? null,
      supply,
      coverToken,
      counts,
      events: parsedEvents,
      ok: Boolean(meta)
    };
  }

  /* ---------------- NFT artwork (IPFS metadata) ---------------- */

  const metaCache = new Map();
  const metaInflight = new Map();
  let metaDisk = null;

  function metaStore() {
    if (metaDisk) return metaDisk;
    try {
      const raw = JSON.parse(readStore(STORE_META) || '{}');
      metaDisk = raw && typeof raw === 'object' ? raw : {};
    } catch { metaDisk = {}; }
    return metaDisk;
  }

  function cacheMeta(key, value) {
    metaCache.set(key, value);
    const store = metaStore();
    store[key] = { t: Date.now(), v: value };
    const keys = Object.keys(store);
    if (keys.length > 160) {
      keys.slice(0, keys.length - 160).forEach((old) => delete store[old]);
    }
    try { writeStore(STORE_META, JSON.stringify(store)); } catch { /* quota */ }
  }

  function cachedMeta(key) {
    if (metaCache.has(key)) return metaCache.get(key);
    const hit = metaStore()[key];
    if (hit && Date.now() - Number(hit.t || 0) < META_TTL && hit.v) {
      metaCache.set(key, hit.v);
      return hit.v;
    }
    return null;
  }

  function ipfsPath(uri) {
    const value = String(uri || '').trim();
    if (!value) return null;
    if (value.startsWith('ipfs://ipfs/')) return value.slice(11);
    if (value.startsWith('ipfs://')) return value.slice(7);
    if (value.startsWith('/ipfs/')) return value.slice(6);
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+)$/i.test(value)) return value;
    return null;
  }

  function uriCandidates(uri) {
    const value = String(uri || '').trim();
    if (!value) return [];
    const path = ipfsPath(value);
    if (path) return IPFS_GATEWAYS.map((gateway) => gateway + path.replace(/^\/+/, ''));
    if (/^https?:\/\//i.test(value)) return [value];
    return [];
  }

  // Thumbnails go through a fast image proxy when the source is IPFS, so large
  // artwork files never block the page. Direct URLs are used as-is.
  function thumbnailCandidates(uri) {
    const urls = uriCandidates(uri);
    const out = [];
    urls.forEach((url) => {
      const path = ipfsPath(uri);
      if (path && url.includes('ipfs.filebase.io')) {
        out.push(`https://images.weserv.nl/?url=${encodeURIComponent(`ipfs.filebase.io/ipfs/${path}`)}&w=480&h=480&fit=cover&output=webp&q=80`);
      }
      out.push(url);
    });
    return out;
  }

  async function fetchJsonUri(uri) {
    const value = String(uri || '').trim();
    if (value.startsWith('data:application/json')) {
      const comma = value.indexOf(',');
      const head = value.slice(0, comma);
      const body = value.slice(comma + 1);
      return JSON.parse(head.includes('base64') ? atob(body) : decodeURIComponent(body));
    }
    const urls = uriCandidates(value);
    if (!urls.length) throw new Error('Unsupported metadata URI');
    let lastError = null;
    for (const url of urls) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          cache: 'force-cache',
          headers: { Accept: 'application/json' }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('Metadata fetch failed');
  }

  function normalizeImage(value) {
    const image = String(value || '').trim();
    if (!image) return '';
    if (image.startsWith('ipfs://') || image.startsWith('/ipfs/') || /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(image)) {
      const urls = uriCandidates(image);
      return urls[0] || '';
    }
    return image;
  }

  async function getNftMeta(contractId, tokenId) {
    const key = `${contractId}:${tokenId}`;
    const cached = cachedMeta(key);
    if (cached) return cached;
    if (metaInflight.has(key)) return metaInflight.get(key);

    const promise = (async () => {
      const query = await api(
        `/contract/${contractId}/query?method=token_uri&args=${encodeURIComponent(tokenId)}`,
        { timeout: 10000 }
      );
      let uri = query?.output;
      if (typeof uri === 'string') {
        try {
          const parsed = JSON.parse(uri);
          uri = (parsed && typeof parsed === 'object') ? parsed : String(parsed);
        } catch { /* plain URI */ }
      }

      let meta = null;
      if (uri && typeof uri === 'object') meta = uri;
      else if (typeof uri === 'string' && uri.trim()) meta = await fetchJsonUri(uri);
      if (!meta || typeof meta !== 'object') throw new Error('No metadata');

      const record = {
        name: typeof meta.name === 'string' ? meta.name : '',
        description: typeof meta.description === 'string' ? meta.description : '',
        image: normalizeImage(meta.image || meta.image_url || meta.imageUrl || ''),
        attributes: Array.isArray(meta.attributes) ? meta.attributes.slice(0, 12) : []
      };
      if (record.image || record.name) cacheMeta(key, record);
      return record;
    })().finally(() => metaInflight.delete(key));

    metaInflight.set(key, promise);
    return promise;
  }

  let artActive = 0;
  const artQueue = [];

  function pumpArt() {
    while (artActive < 4 && artQueue.length) {
      const el = artQueue.shift();
      if (!el || !el.isConnected || el.dataset.nftState === 'ready' || el.dataset.nftState === 'loading') continue;
      artActive += 1;
      loadNftArt(el).finally(() => {
        artActive -= 1;
        pumpArt();
      });
    }
  }

  function queueNftArt(root = document, { eager = true } = {}) {
    const targets = $$('[data-nft-contract][data-nft-token]', root);
    targets.forEach((el) => {
      if (el.dataset.nftState) return;
      el.dataset.nftState = 'queued';
      if (eager) {
        artQueue.push(el);
        pumpArt();
      } else if ('IntersectionObserver' in window) {
        if (!queueNftArt.observer) {
          queueNftArt.observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              queueNftArt.observer.unobserve(entry.target);
              artQueue.push(entry.target);
              pumpArt();
            });
          }, { rootMargin: '300px' });
        }
        queueNftArt.observer.observe(el);
      } else {
        artQueue.push(el);
        pumpArt();
      }
    });
  }

  async function loadNftArt(el) {
    const contractId = el.dataset.nftContract;
    const tokenId = el.dataset.nftToken;
    if (!contractId || tokenId === undefined || tokenId === '') return;
    el.dataset.nftState = 'loading';
    try {
      const meta = await getNftMeta(contractId, tokenId);
      const image = el.querySelector('img');
      const nameEl = el.closest('.nft-card')?.querySelector('[data-nft-name]');
      if (nameEl && meta.name) {
        nameEl.textContent = meta.name;
        nameEl.title = meta.name;
      }
      const candidates = thumbnailCandidates(meta.image);
      if (!image || !candidates.length) throw new Error('No image');
      let index = 0;
      image.onload = () => {
        el.dataset.nftState = 'ready';
        el.classList.add('has-art');
        image.classList.add('is-loaded');
      };
      image.onerror = () => {
        if (index < candidates.length) image.src = candidates[index++];
        else el.dataset.nftState = 'error';
      };
      image.alt = meta.name ? `${meta.name} — NFT #${tokenId}` : `NFT #${tokenId}`;
      image.hidden = false;
      image.src = candidates[index++];
    } catch (err) {
      el.dataset.nftState = 'error';
    }
  }


  async function loadNFT({ silent = false } = {}) {
    if (nftBusy) return;
    nftBusy = true;
    try {
      const results = await Promise.all(state.collections.map((id) => loadCollection(id)));
      const readable = results.filter((item) => item.ok || item.events.length || item.supply !== null);
      const allEvents = readable.flatMap((item) => item.events)
        .sort((a, b) => toMs(b.ts) - toMs(a.ts));

      state.nft = {
        collections: results,
        events: allEvents,
        supply: readable.reduce((sum, item) => sum + (Number(item.supply) || 0), 0),
        mints: readable.reduce((sum, item) => sum + item.counts.mints, 0),
        transfers: readable.reduce((sum, item) => sum + item.counts.transfers, 0),
        burns: readable.reduce((sum, item) => sum + item.counts.burns, 0)
      };

      renderNFT();
      buildMarquee();
      if (!silent) toast('NFT index refreshed');
    } catch (err) {
      console.error('NFT index', err);
      if (!silent) toast('Could not index NFT collections', true);
    } finally {
      nftBusy = false;
    }
  }

  function renderNFT() {
    const nft = state.nft;
    const kpiHost = $('#nft-kpis');
    if (!nft) return;

    if (kpiHost) {
      const cards = [
        { label: 'Collections tracked', value: state.collections.length, sub: 'stored in your browser', color: '#34d399' },
        { label: 'NFT supply', value: nft.supply, sub: 'across tracked contracts', color: '#86efac' },
        { label: 'Mint events', value: nft.mints, sub: `${num(nft.burns)} burn events`, color: '#60a5fa' },
        { label: 'Transfer events', value: nft.transfers, sub: `${num(nft.events.length)} events indexed`, color: '#c084fc' }
      ];
      kpiHost.innerHTML = kpiMarkup(cards, 'nft-kpi');
    }

    setText('#nft-collection-count', `${num(nft.collections.length)} tracked`);
    setText('#nft-event-count', `${num(nft.events.length)} events`);
    setText('#nft-events-sub', `Mints, transfers and burns across ${num(nft.collections.length)} contract${nft.collections.length === 1 ? '' : 's'}`);

    const list = $('#nft-collections');
    if (list) {
      if (!nft.collections.length) {
        list.innerHTML = `<div class="empty-state empty-state-actions">No collections tracked yet.<br />Scan recent chain activity to discover NFT contracts, or paste a contract id below.<br /><button class="btn btn-primary btn-sm" type="button" data-discover>Scan chain for NFTs</button></div>`;
      } else {
        list.innerHTML = nft.collections.map((item) => `<div class="collection-row">
          <div class="collection-cover"${item.coverToken !== null && item.coverToken !== undefined ? ` data-nft-contract="${esc(item.id)}" data-nft-token="${esc(item.coverToken)}"` : ''}>
            <span class="nft-fallback">RCP</span>
            <img hidden alt="" loading="lazy" decoding="async" />
          </div>
          <div class="collection-info">
            <div class="collection-name">${esc(item.ok ? item.name : 'Unavailable contract')} <span class="tag">RCP</span></div>
            <span class="collection-id" title="${esc(item.id)}">${copyable(item.id, item.id)}</span>
            <div class="collection-stats">
              <span>Supply <b>${item.supply === null ? '—' : num(item.supply)}</b></span>
              <span>Mints <b>${num(item.counts.mints)}</b></span>
              <span>Transfers <b>${num(item.counts.transfers)}</b></span>
              <span>Burns <b>${num(item.counts.burns)}</b></span>
            </div>
          </div>
          <div class="collection-actions">
            <button class="icon-btn" type="button" data-search="${esc(item.id)}" title="Open contract in explorer">↗</button>
            <button class="icon-btn danger" type="button" data-remove-collection="${esc(item.id)}" title="Stop tracking this collection">×</button>
          </div>
        </div>`).join('');
        queueNftArt(list, { eager: true });
      }
    }

    const body = $('#nft-events-body');
    if (body) {
      const events = nft.events.slice(0, 14);
      if (!events.length) {
        body.innerHTML = '<tr><td colspan="6" class="empty-cell">No NFT events found for the tracked contracts.</td></tr>';
      } else {
        body.innerHTML = events.map((event) => `<tr>
          <td><span class="ev-chip ${event.kind}">${event.kind === 'mint' ? 'Mint' : event.kind === 'burn' ? 'Burn' : event.kind === 'transfer' ? 'Transfer' : esc(event.type)}</span></td>
          <td class="amount"><span class="nft-token">${event.tokenId === null ? '' : `<span class="nft-mini" data-nft-contract="${esc(event.collection)}" data-nft-token="${esc(event.tokenId)}"><img hidden alt="" loading="lazy" decoding="async" /></span>`}${event.tokenId === null ? '—' : `#${esc(event.tokenId)}`}</span></td>
          <td class="addr" title="${esc(event.from || '')}">${event.from ? copyable(event.from, short(event.from, 8, 6)) : '—'}</td>
          <td class="addr" title="${esc(event.to || '')}">${event.to ? copyable(event.to, short(event.to, 8, 6)) : '—'}</td>
          <td class="addr hide-sm" title="${esc(event.collection)}">${copyable(event.collection, event.collectionName || short(event.collection, 8, 6))}</td>
          <td class="addr" title="${esc(new Date(toMs(event.ts)).toISOString())}">${esc(timeAgo(event.ts))}</td>
        </tr>`).join('');
        queueNftArt(body, { eager: true });
      }
    }
  }

  async function addCollection(id) {
    const normalized = String(id || '').trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      toast('That is not a valid 64-hex contract id', true);
      return false;
    }
    if (state.collections.includes(normalized)) {
      toast('That collection is already tracked');
      return false;
    }
    let meta;
    try {
      meta = await api(`/contract/${normalized}`);
    } catch (err) {
      toast(`Contract not found: ${err.message}`, true);
      return false;
    }
    if (!meta || !meta.contract_id) {
      toast('Contract not found', true);
      return false;
    }
    state.collections = [normalized, ...state.collections].slice(0, 12);
    saveCollections();
    toast('Collection added to the live NFT index');
    await loadNFT({ silent: true });
    return true;
  }

  const GENERIC_COLLECTION_NAMES = new Set(['', 'nft', 'nfts', 'token', 'tokens', 'collection', 'rcp collection']);

  async function loadWalletGallery(address, { auto = false } = {}) {
    const addr = String(address || '').trim();
    const host = $('#wallet-nft-result');
    const pill = $('#nft-wallet-count');
    if (!addr || !host) return;
    if (!/^rete[a-z0-9]+$/i.test(addr) || addr.length < 40) {
      host.innerHTML = '<div class="empty-state">That does not look like a Retium wallet address. It should start with “rete”.</div>';
      if (pill) pill.textContent = '—';
      return;
    }

    host.innerHTML = '<div class="empty-state">Loading NFT gallery…</div>';
    if (pill) pill.textContent = 'loading…';

    try {
      const data = await api(`/wallet/${encodeURIComponent(addr)}/nfts?limit=60&offset=0`);
      const nfts = Array.isArray(data?.nfts) ? data.nfts : [];
      const total = Number(data?.total_count) || nfts.length;

      let collectionsChanged = false;
      let namesChanged = false;
      nfts.forEach((nft) => {
        const key = String(nft.contract_id || '').toLowerCase();
        if (!key) return;
        if (!state.collections.includes(key) && state.collections.length < 12) {
          state.collections.push(key);
          collectionsChanged = true;
        }
        const label = String(nft.collection || '').trim();
        if (label && !GENERIC_COLLECTION_NAMES.has(label.toLowerCase()) && state.names[key] !== label) {
          state.names[key] = label;
          namesChanged = true;
        }
      });
      if (namesChanged) saveNames();
      if (collectionsChanged) {
        saveCollections();
        setTimeout(() => loadNFT({ silent: true }), 250);
      }

      if (pill) pill.textContent = `${num(total)} NFT${total === 1 ? '' : 's'}`;
      if (!nfts.length) {
        host.innerHTML = '<div class="empty-state">This wallet holds no NFTs — or the wallet has never touched an NFT contract.</div>';
        return;
      }

      host.innerHTML = nfts.map((nft) => {
        const contract = String(nft.contract_id || '').toLowerCase();
        const id = String(nft.token_id ?? '?');
        const name = contract ? collectionName(contract) : (nft.collection || 'NFT');
        return `<article class="nft-card"${contract ? ` data-nft-contract="${esc(contract)}" data-nft-token="${esc(nft.token_id ?? '')}"` : ''}>
          <div class="nft-thumb">
            <span class="nft-fallback">#${esc(id)}</span>
            <img hidden alt="" loading="lazy" decoding="async" />
          </div>
          <div class="nft-meta">
            <span class="nft-name" data-nft-name>#${esc(id)}</span>
            <span class="nft-collection" title="${esc(name)}">${esc(name)}</span>
            <span class="nft-contract" title="${esc(contract)}">token #${esc(id)} · ${copyable(contract, short(contract, 6, 4))}</span>
          </div>
        </article>`;
      }).join('') + (total > nfts.length
        ? `<div class="empty-state">Showing ${num(nfts.length)} of ${num(total)} NFTs.</div>`
        : '');

      // Load art for the first cards immediately, lazy-load the rest when scrolled into view.
      queueNftArt(host, { eager: nfts.length <= 12 });

      if (state.nft) renderNFT();
      if (auto && !nfts.length) {
        host.innerHTML = '<div class="empty-state">The seeded wallet holds no NFTs right now. Try another wallet address.</div>';
      }
    } catch (err) {
      const message = err.status === 400 || err.status === 404
        ? 'No NFT data for this wallet.'
        : `Could not load NFTs: ${err.message}`;
      host.innerHTML = `<div class="empty-state">${esc(message)}</div>`;
      if (pill) pill.textContent = '—';
    }
  }

  /* Discover NFT contracts from recent on-chain activity — no hardcoded seeds. */
  async function discoverNftCollections({ silent = false } = {}) {
    const candidates = new Set();
    for (let page = 0; page < 3 && candidates.size < 16; page += 1) {
      const res = await api(`/transactions?limit=100&offset=${page * 100}`);
      const list = Array.isArray(res?.transactions) ? res.transactions : [];
      if (!list.length) break;
      list.forEach((tx) => {
        const call = tx.call;
        const method = String(call?.method || '').toLowerCase();
        const contract = String(call?.contract || '').toLowerCase();
        if (contract && NFT_CALL_METHODS.has(method)) candidates.add(contract);
      });
    }

    const ids = Array.from(candidates).slice(0, 12);
    const found = [];
    for (let i = 0; i < ids.length; i += 4) {
      const batch = ids.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map((id) => api(`/contract/${id}`)));
      results.forEach((result, index) => {
        const meta = result.status === 'fulfilled' ? result.value : null;
        const type = String(meta?.rcp_metadata?.rcp_type || '').toUpperCase();
        if (type.includes('NFT') && !state.collections.includes(batch[index])) found.push(batch[index]);
      });
    }

    state.collections = Array.from(new Set([...found, ...state.collections])).slice(0, 12);
    saveCollections();
    if (!silent) toast(found.length ? `Discovered ${found.length} NFT collection${found.length === 1 ? '' : 's'}` : 'No NFT contracts found in recent activity');
    return found;
  }

  async function ensureNftIndex() {
    if (!state.collections.length) {
      await discoverNftCollections({ silent: true });
    }
    await loadNFT({ silent: true });
  }

  function latestHolderAddress() {
    const collections = state.nft?.collections || [];
    for (const collection of collections) {
      const holders = (collection.events || [])
        .filter((event) => event.to && /^rete[a-z0-9]+$/i.test(event.to))
        .sort((a, b) => toMs(b.ts) - toMs(a.ts));
      if (holders.length) return holders[0].to;
    }
    return collections.find((item) => item.ok)?.deployer || null;
  }

  /* ---------------- staking ---------------- */

  function renderStaking() {
    const stats = state.stats;
    if (!stats) return;
    const tx = stats.totals?.transactions || {};
    const stake = Number(tx.stake) || 0;
    const unstake = Number(tx.unstake) || 0;
    const total = Number(tx.total) || 0;
    const sum = stake + unstake;
    const net = stake - unstake;
    const nodes = stats.nodes || {};

    setText('#stake-count', num(stake));
    setText('#unstake-count', num(unstake));
    setText('#validator-count', num(tx.validator));
    setText('#stake-share', `${pct(stake, total)} of all transactions`);
    setText('#unstake-share', `${pct(unstake, total)} of all transactions`);
    setText('#stake-net', `${net > 0 ? '+' : ''}${num(net)}`);
    setText('#stake-legend', `${num(stake)} ops`);
    setText('#unstake-legend', `${num(unstake)} ops`);

    const bar = $('#stake-bar');
    if (bar) bar.style.width = `${sum ? (stake / sum) * 100 : 50}%`;

    const nodeGrid = $('#staking-nodes');
    if (nodeGrid) {
      nodeGrid.innerHTML = [
        nodeCard('Keepers', nodes.keepers?.online, nodes.keepers?.total, 'consensus'),
        nodeCard('Suits', nodes.suits?.online, nodes.suits?.total, 'finality'),
        nodeCard('Workers', nodes.workers?.online, nodes.workers?.total, 'execution'),
        nodeCard('RPC', nodes.rpc?.total, nodes.rpc?.total, 'public endpoints')
      ].join('');
    }

    const online = Number(nodes.keepers?.online || 0) + Number(nodes.suits?.online || 0) + Number(nodes.workers?.online || 0);
    const all = Number(nodes.keepers?.total || 0) + Number(nodes.suits?.total || 0) + Number(nodes.workers?.total || 0);
    const summary = $('#validator-summary');
    if (summary) {
      summary.textContent = all ? `${online}/${all} nodes online` : '—';
      summary.classList.toggle('warn', all > 0 && online < all);
    }

    const facts = $('#staking-facts');
    if (facts) {
      const participation = total ? ((sum / total) * 100).toFixed(1) : '0.0';
      facts.innerHTML = [
        ['Staking activity', `${num(sum)} ops`, ''],
        ['Share of ledger', `${participation}%`, 'green'],
        ['Net direction', `${net > 0 ? '+' : ''}${num(net)}`, net >= 0 ? 'green' : 'orange'],
        ['Validator registry', `${num(tx.validator)} ops`, ''],
        ['Node operators', `${num(online)} online`, 'green'],
        ['Stake / unstake ratio', unstake ? `${(stake / unstake).toFixed(2)}×` : '—', '']
      ].map(([label, value, cls]) =>
        `<div class="fact"><span>${esc(label)}</span><strong class="${cls}">${esc(value)}</strong></div>`
      ).join('');
    }
  }

  /* ---------------- economy ---------------- */

  function renderEconomy() {
    const safehouse = state.safehouse;
    const summary = state.summary;

    if (safehouse) {
      const total = Number(safehouse.total_supply_atomic) / 1e18;
      const inventory = Number(safehouse.inventory_atomic) / 1e18;
      const burned = Number(safehouse.burned_atomic) / 1e18;
      const circulating = Math.max(0, total - inventory - burned);

      setText('#rtm-circulating', `${fmtAmount(circulating, 2)} RTM`);
      setText('#rtm-status', 'Fixed supply');

      const bar = $('#rtm-inventory-bar');
      if (bar) bar.style.width = `${total ? Math.min(100, (inventory / total) * 100) : 0}%`;

      const rows = $('#rtm-rows');
      if (rows) {
        rows.innerHTML = [
          ['Total supply', `${fmtAmount(total, 0)} RTM`],
          ['Safehouse inventory', `${fmtAmount(inventory, 2)} RTM`],
          ['Burned', `${fmtAmount(burned, 2)} RTM`],
          ['Circulating', `${fmtAmount(circulating, 2)} RTM`],
          ['Inventory share', total ? `${((inventory / total) * 100).toFixed(2)}%` : '—']
        ].map(([label, value]) =>
          `<li class="stat-row"><span>${esc(label)}</span><b>${esc(value)}</b></li>`
        ).join('');
      }
    }

    if (summary) {
      const supply = Number(summary.supply_atomic) / 1e18;
      const reserve = (Number(summary.bank_cents) + Number(summary.stable_cents)) / 100;
      const ratio = supply ? (reserve / supply) * 100 : null;

      setText('#rtd-supply', `${fmtAmount(supply, 2)} RTD`);
      setText('#rtd-status', summary.backed === false ? 'Unbacked' : 'Fully backed');
      const status = $('#rtd-status');
      if (status) {
        status.classList.toggle('ok', summary.backed !== false);
        status.classList.toggle('warn', summary.backed === false);
      }

      const meter = $('#rtd-backing-bar');
      if (meter) meter.style.width = `${ratio === null ? 0 : Math.min(100, ratio)}%`;

      const rows = $('#rtd-rows');
      if (rows) {
        rows.innerHTML = [
          ['Bank reserve', `$${fmtAmount(Number(summary.bank_cents) / 100, 2)}`],
          ['Stable reserve', `$${fmtAmount(Number(summary.stable_cents) / 100, 2)}`],
          ['Total reserve', `$${fmtAmount(reserve, 2)}`],
          ['Collateral ratio', ratio === null ? '—' : `${ratio.toFixed(2)}%`],
          ['Customers', num(summary.customers)]
        ].map(([label, value], index) =>
          `<li class="stat-row"><span>${esc(label)}</span><b class="${index === 3 ? 'green' : ''}">${esc(value)}</b></li>`
        ).join('');
      }
    }

    const facts = $('#economy-facts');
    if (facts && (safehouse || summary)) {
      const items = [];
      if (safehouse) {
        items.push(['Safehouse balance', `${fmtAmount(Number(safehouse.inventory_rtm || 0), 2)} RTM`]);
        items.push(['RTM burned', `${fmtAmount(Number(safehouse.burned_rtm || 0), 2)} RTM`]);
        items.push(['RTD locked', `${fmtAmount(Number(safehouse.locked_rusd || 0), 2)} RTD`]);
        items.push(['Safehouse wallet', short(safehouse.safehouse || '—', 12, 8), safehouse.safehouse]);
      }
      if (summary) {
        items.push(['Bridged away', `${fmtAtomic(summary.bridged_away_atomic, 18, 2)} RTD`]);
        items.push(['Expected supply', `${fmtAtomic(summary.expected_supply_atomic, 18, 2)} RTD`]);
        items.push(['Books match', summary.books_match ? 'Yes' : 'No']);
        items.push(['Backed', summary.backed ? 'Yes' : 'No']);
        items.push(['Issuer wallet', short(summary.issuer_wallet || '—', 12, 8), summary.issuer_wallet]);
        items.push(['Last error', summary.last_error ? String(summary.last_error) : 'None']);
      }
      facts.innerHTML = items.map(([label, value, address]) =>
        `<div class="fact"><span>${esc(label)}</span><strong>${address ? copyable(address, value) : esc(value)}</strong></div>`
      ).join('');
    }
  }

  /* ---------------- explorer ---------------- */

  function kv(label, value, opts = {}) {
    const content = opts.html !== undefined ? opts.html : `<b>${esc(value)}</b>`;
    return `<div class="kv"><span>${esc(label)}</span>${content}</div>`;
  }

  function copyButton(text) {
    return `<button class="pill" type="button" data-copy="${esc(text)}" title="Copy to clipboard">Copy</button>`;
  }

  function copyable(value, display = value) {
    const raw = String(value ?? '');
    if (!raw || raw === '—') return esc(display ?? '—');
    return `<i class="copyable" role="button" tabindex="0" data-copy="${esc(raw)}" title="Copy ${esc(raw)}">${esc(display ?? raw)}</i>`;
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      try {
        const field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        const ok = document.execCommand('copy');
        field.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function resultShell(kind, title, body, copyValue) {
    return `<div class="result-card">
      <div class="result-head">
        <span class="result-kind">${esc(kind)}</span>
        <span class="result-title" title="${esc(title)}">${esc(title)}</span>
        ${copyValue ? copyButton(copyValue) : ''}
      </div>
      <div class="result-body">${body}</div>
    </div>`;
  }

  function loadingShell(label) {
    return `<div class="result-card"><div class="result-body"><div class="empty-state">${esc(label)}</div></div></div>`;
  }

  function errorShell(message) {
    return `<div class="result-card"><div class="result-body"><div class="empty-state">${esc(message)}</div></div></div>`;
  }

  async function openWallet(address, token) {
    const results = await Promise.allSettled([
      api(`/wallet/${encodeURIComponent(address)}`),
      api(`/wallet/${encodeURIComponent(address)}/tokens`),
      api(`/wallet/${encodeURIComponent(address)}/nfts?limit=12&offset=0`),
      api(`/wallet/${encodeURIComponent(address)}/transactions?limit=6&offset=0`)
    ]);

    if (results[0].status !== 'fulfilled') {
      throw new Error(results[0].reason?.message || 'Wallet not found');
    }
    if (token !== state.searchToken) return;

    const wallet = results[0].value || {};
    const tokens = results[1].status === 'fulfilled' ? (results[1].value?.tokens || []) : [];
    const nfts = results[2].status === 'fulfilled' ? results[2].value : null;
    const txs = results[3].status === 'fulfilled' ? (results[3].value || []) : [];

    const kvRows = [
      kv('Balance', `${fmtAmount(wallet.balance_rtm, 6)} RTM`),
      kv('Spendable', `${fmtAmount(wallet.spendable, 6)} RTM`),
      kv('PIE stake', `${fmtAmount(wallet.balance_pie, 2)} PIE`),
      kv('Nonce', num(wallet.nonce)),
      kv('NFTs', nfts ? num(nfts.total_count) : '0'),
      kv('Multisig', wallet.multisig ? 'Active' : 'None')
    ].join('');

    const tokenHtml = tokens.length
      ? `<div class="token-chips">${tokens.slice(0, 14).map((t) =>
        `<span class="token-chip">${esc(t.symbol || 'TOKEN')} <b>${esc(fmtAtomic(t.balance, Number(t.decimals) || 18, 3))}</b></span>`
      ).join('')}${tokens.length > 14 ? `<span class="token-chip">+${num(tokens.length - 14)} more</span>` : ''}</div>`
      : '<div class="empty-state">No RCP tokens held by this wallet.</div>';

    const nftHtml = nfts && Array.isArray(nfts.nfts) && nfts.nfts.length
      ? `<div class="token-chips">${nfts.nfts.slice(0, 8).map((n) =>
        `<button class="chip" type="button" data-search="${esc(n.contract_id)}">${esc(n.collection || 'NFT')} #${esc(n.token_id)}</button>`
      ).join('')}${Number(nfts.total_count) > 8 ? `<span class="token-chip">+${num(Number(nfts.total_count) - 8)} more</span>` : ''}</div>`
      : '<div class="empty-state">No NFTs held by this wallet.</div>';

    const txHtml = Array.isArray(txs) && txs.length
      ? `<div class="mini-list">${txs.map((tx) => {
        const info = actionInfo(tx.action);
        return `<button class="mini-item" type="button" data-search="${esc(tx.tx_id)}" style="text-align:left;cursor:pointer">
          <span class="action" data-action="${esc(info.cls)}">${esc(info.label)}</span>
          <b>${esc(fmtAmount(tx.amount_rtm, 4))} RTM</b>
          <span class="spacer">${esc(timeAgo(tx.timestamp))}</span>
          <span>${copyable(tx.tx_id, short(tx.tx_id, 12, 6))}</span>
        </button>`;
      }).join('')}</div>`
      : '<div class="empty-state">No transactions returned for this wallet.</div>';

    const body = `<div class="kv-grid">${kvRows}</div>
      <div class="result-section"><h4>Tokens</h4>${tokenHtml}</div>
      <div class="result-section"><h4>NFTs</h4>${nftHtml}</div>
      <div class="result-section"><h4>Recent transactions</h4>${txHtml}</div>`;

    $('#explorer-result').innerHTML = resultShell('Wallet', address, body, address);
  }

  async function openContract(contractId, token) {
    const meta = await api(`/contract/${encodeURIComponent(contractId)}`);
    if (token !== state.searchToken) return;

    const metaInfo = meta?.rcp_metadata || {};
    let supply = null;
    if (Array.isArray(metaInfo.capabilities) && metaInfo.capabilities.includes('total_supply')) {
      try {
        const res = await api(`/contract/${encodeURIComponent(contractId)}/query?method=total_supply&args=`);
        if (res && res.ok) supply = res.output;
      } catch { /* not all contracts expose a supply */ }
    }
    if (token !== state.searchToken) return;

    let events = [];
    try {
      const res = await api(`/contract/${encodeURIComponent(contractId)}/events`);
      events = Array.isArray(res?.events) ? res.events : [];
    } catch { /* events can be unavailable */ }

    const kvRows = [
      kv('Type', metaInfo.rcp_type || 'Contract'),
      kv('Status', meta.status || 'unknown'),
      meta.deployer ? kv('Deployer', '', { html: copyable(meta.deployer, short(meta.deployer, 14, 8)) }) : kv('Deployer', '—'),
      kv('Deployed at tick', num(meta.deployed_at_tick)),
      kv('Storage keys', num(meta.storage_keys_count)),
      supply !== null ? kv('Total supply', num(supply)) : '',
      kv('Version', metaInfo.version || '—'),
      meta.code_hash ? kv('Code hash', '', { html: copyable(meta.code_hash, short(meta.code_hash, 14, 8)) }) : kv('Code hash', '—')
    ].join('');

    const caps = Array.isArray(metaInfo.capabilities) && metaInfo.capabilities.length
      ? `<div class="token-chips">${metaInfo.capabilities.slice(0, 16).map((cap) =>
        `<span class="token-chip">${esc(cap)}</span>`
      ).join('')}</div>`
      : '<div class="empty-state">No RCP capabilities advertised.</div>';

    const eventHtml = events.length
      ? `<div class="mini-list">${events.slice(0, 8).map((event) => {
        const parsed = parseNftEvent(event, contractId, collectionName(contractId));
        return `<div class="mini-item">
          <span class="ev-chip ${parsed.kind}">${esc(parsed.type)}</span>
          <span>${parsed.tokenId !== null ? `#${esc(parsed.tokenId)}` : ''}</span>
          <span class="spacer">${esc(timeAgo(event.timestamp))}</span>
          <button class="chip" type="button" data-search="${esc(event.tx_id)}" title="Open transaction">${copyable(event.tx_id, short(event.tx_id, 10, 6))}</button>
        </div>`;
      }).join('')}</div>`
      : '<div class="empty-state">No events indexed for this contract.</div>';

    const body = `<div class="kv-grid">${kvRows}</div>
      <div class="result-section"><h4>Capabilities</h4>${caps}</div>
      <div class="result-section"><h4>Recent events</h4>${eventHtml}</div>`;

    $('#explorer-result').innerHTML = resultShell('Contract', contractId, body, contractId);
  }

  async function openTransaction(txId, token) {
    const tx = await api(`/transaction/${encodeURIComponent(txId)}`);
    if (token !== state.searchToken) return;
    const gas = tx.gas_breakdown || {};

    const kvRows = [
      kv('Action', actionInfo(tx.action).label || '—'),
      kv('Status', tx.status || tx.finality || '—'),
      kv('Amount', `${fmtAmount(tx.amount_rtm, 8)} RTM`),
      kv('Fee', gas.gas_used_rtm ? `${fmtAmount(gas.gas_used_rtm, 8)} RTM` : '—'),
      tx.sender ? kv('Sender', '', { html: copyable(tx.sender, short(tx.sender, 16, 8)) }) : kv('Sender', '—'),
      tx.recipient ? kv('Recipient', '', { html: copyable(tx.recipient, short(tx.recipient, 16, 8)) }) : kv('Recipient', '—'),
      kv('Block', num(tx.block_id)),
      kv('Tick', num(tx.tick)),
      kv('Nonce', num(tx.nonce)),
      kv('Time', tx.timestamp ? new Date(toMs(tx.timestamp)).toLocaleString() : '—')
    ].join('');

    const gasRows = gas.fee_currency || gas.base_fee_rtm ? `<div class="kv-grid">
      ${kv('Base fee', `${fmtAmount(gas.base_fee_rtm, 8)} RTM`)}
      ${kv('Burned', `${fmtAmount(gas.burned_rtm, 8)} RTM`)}
      ${kv('Workers', `${fmtAmount(gas.workers_total_rtm, 8)} RTM`)}
      ${kv('Suits', `${fmtAmount(gas.suits_total_rtm, 8)} RTM`)}
      ${kv('Treasury', `${fmtAmount(gas.treasury_rtm, 8)} RTM`)}
      ${kv('Currency', gas.fee_currency || 'RTM')}
    </div>` : '<div class="empty-state">No fee breakdown returned for this transaction.</div>';

    const paid = tx.validators_paid || {};
    const paidHtml = `<div class="token-chips">
      <span class="token-chip">Suits <b>${num((paid.suits || []).length)}</b></span>
      <span class="token-chip">Workers <b>${num((paid.workers || []).length)}</b></span>
    </div>`;

    const body = `<div class="kv-grid">${kvRows}</div>
      <div class="result-section"><h4>Gas breakdown</h4>${gasRows}</div>
      <div class="result-section"><h4>Validators paid</h4>${paidHtml}</div>
      <div class="result-section"><button class="chip" type="button" data-search="${esc(tx.block_id)}">Open block ${esc(tx.block_id)} ↗</button></div>`;

    $('#explorer-result').innerHTML = resultShell('Transaction', tx.tx_id || txId, body, tx.tx_id || txId);
  }

  async function openBlock(blockId, token) {
    const block = await api(`/block/${encodeURIComponent(blockId)}`);
    if (token !== state.searchToken) return;

    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    const kvRows = [
      kv('Status', block.status || '—'),
      kv('Type', block.block_type || '—'),
      kv('Tick', num(block.tick)),
      kv('Transactions', num(block.tx_count ?? txs.length)),
      kv('Total gas', `${fmtAmount(block.total_gas_rtm, 8)} RTM`),
      kv('Timestamp', block.timestamp ? new Date(toMs(block.timestamp)).toLocaleString() : '—'),
      kv('Parents', (block.parents || []).length ? String(block.parents.length) : '0'),
      kv('Validator proofs', num(block.validator_proofs_count))
    ].join('');

    const txHtml = txs.length
      ? `<div class="mini-list">${txs.slice(0, 10).map((tx) => `<button class="mini-item" type="button" data-search="${esc(tx.tx_id)}" style="text-align:left;cursor:pointer">
          <span class="action" data-action="transfer">TX</span>
          <b>${esc(fmtAmount(tx.amount_rtm, 4))} RTM</b>
          <span>${copyable(tx.sender, short(tx.sender, 8, 5))} → ${copyable(tx.recipient, short(tx.recipient, 8, 5))}</span>
          <span class="spacer">${esc(timeAgo(tx.timestamp))}</span>
        </button>`).join('')}</div>`
      : '<div class="empty-state">This block carries no transactions.</div>';

    const body = `<div class="kv-grid">${kvRows}</div>
      <div class="result-section"><h4>Transactions in block</h4>${txHtml}</div>`;

    $('#explorer-result').innerHTML = resultShell('Block', String(blockId), body, String(blockId));
  }

  async function runSearch(rawQuery) {
    const query = String(rawQuery || '').trim();
    if (!query) return;

    state.searchToken += 1;
    const token = state.searchToken;
    const host = $('#explorer-result');
    host.innerHTML = loadingShell(`Looking up ${query}…`);

    try {
      if (/^tx_/i.test(query)) {
        await openTransaction(query, token);
      } else if (/^rete/i.test(query)) {
        await openWallet(query, token);
      } else if (/^\d+$/.test(query)) {
        await openBlock(query, token);
      } else if (/^[0-9a-f]{64}$/i.test(query)) {
        await openContract(query, token);
      } else if (/^[0-9a-f]{40}$/i.test(query)) {
        const lookup = await api(`/lookup/${query}`);
        if (token !== state.searchToken) return;
        if (lookup?.tx_id) {
          await openTransaction(lookup.tx_id, token);
        } else {
          host.innerHTML = resultShell('Lookup', query, `<div class="kv-grid">${kv('Kind', lookup?.kind || 'unknown')}${kv('Value', lookup?.value || query)}</div>`, query);
        }
      } else {
        const lookup = await api(`/lookup/${encodeURIComponent(query)}`);
        if (token !== state.searchToken) return;
        if (lookup?.tx_id) {
          await openTransaction(lookup.tx_id, token);
        } else if (lookup?.block_id) {
          await openBlock(lookup.block_id, token);
        } else {
          host.innerHTML = errorShell('No wallet, transaction, block or contract matches that query.');
        }
      }
    } catch (err) {
      if (token !== state.searchToken) return;
      const message = err.status === 404
        ? 'Nothing on Retium matches that query.'
        : err.status === 400
          ? `That query is not valid: ${err.message}`
          : `Lookup failed: ${err.message}`;
      host.innerHTML = errorShell(message);
    }
  }

  /* ---------------- feeds ---------------- */

  async function loadFeeds({ silent = false } = {}) {
    if (feedBusy) return;
    feedBusy = true;
    try {
      const [txRes, blockRes] = await Promise.allSettled([
        api('/transactions?limit=60&offset=0'),
        api('/mesh?page=1&limit=8')
      ]);

      if (txRes.status === 'fulfilled' && txRes.value) {
        state.transactions = Array.isArray(txRes.value.transactions) ? txRes.value.transactions : [];
        renderTransactions();
        const pill = $('#feed-status');
        if (pill) {
          pill.textContent = `${num(txRes.value.total_count)} total`;
          pill.classList.add('ok');
          pill.classList.remove('warn');
        }
      } else {
        const body = $('#tx-body');
        if (body) {
          body.innerHTML = `<tr><td colspan="7" class="empty-cell">Could not load transactions. <button class="chip" type="button" data-retry="feeds">Retry</button></td></tr>`;
        }
        const pill = $('#feed-status');
        if (pill) { pill.textContent = 'retry'; pill.classList.remove('ok'); pill.classList.add('warn'); }
        if (!silent) toast('Could not load transactions', true);
      }

      if (blockRes.status === 'fulfilled' && blockRes.value) {
        state.blocks = Array.isArray(blockRes.value.blocks) ? blockRes.value.blocks : [];
        renderBlocks(blockRes.value.total_blocks);
        const pill = $('#block-status');
        if (pill) { pill.classList.add('ok'); pill.classList.remove('warn'); }
      } else {
        const host = $('#block-list');
        if (host) {
          host.innerHTML = `<div class="empty-state">Could not load blocks. <button class="chip" type="button" data-retry="feeds">Retry</button></div>`;
        }
        const pill = $('#block-status');
        if (pill) { pill.textContent = 'retry'; pill.classList.remove('ok'); pill.classList.add('warn'); }
      }

      if ((txRes.status !== 'fulfilled' || blockRes.status !== 'fulfilled') && !feedRetry) {
        feedRetry = setTimeout(() => {
          feedRetry = null;
          loadFeeds({ silent: true });
        }, 4000);
      }
    } finally {
      feedBusy = false;
    }
  }

  function renderTransactions() {
    const body = $('#tx-body');
    if (!body) return;
    if (!state.transactions.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty-cell">Loading transactions…</td></tr>';
      return;
    }
    const filter = state.txFilter;
    const list = (filter === 'all'
      ? state.transactions
      : state.transactions.filter((tx) => actionInfo(tx.action).cls === filter)
    ).slice(0, 20);

    setText('#feed-sub', `Showing ${num(list.length)} of ${num(state.transactions.length)} newest actions`);

    if (!list.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty-cell">No matching transactions in the latest batch.</td></tr>`;
      return;
    }

    body.innerHTML = list.map((tx) => {
      const info = actionInfo(tx.action);
      const isNew = state.lastTopTx !== null && !state.seenTx.has(tx.tx_id);
      return `<tr class="${isNew ? 'is-new' : ''}" data-search="${esc(tx.tx_id)}" title="Open ${esc(tx.tx_id)} in the explorer" style="cursor:pointer">
      <td><span class="action" data-action="${esc(info.cls)}">${esc(info.label)}</span></td>
      <td class="amount">${esc(fmtAmount(tx.amount_rtm, 4))}${tx.amount_rtm && Number(tx.amount_rtm) !== 0 ? '<small>RTM</small>' : ''}</td>
      <td class="addr" title="${esc(tx.sender || '')}">${tx.sender ? copyable(tx.sender, short(tx.sender, 9, 6)) : '—'}</td>
      <td class="addr" title="${esc(tx.recipient || '')}">${tx.recipient ? copyable(tx.recipient, short(tx.recipient, 9, 6)) : '—'}</td>
      <td class="addr hide-sm">${num(tx.tick)}</td>
      <td class="addr" title="${esc(tx.timestamp_readable || '')}">${esc(timeAgo(tx.timestamp))}</td>
      <td class="addr hide-sm" title="${esc(tx.tx_id || '')}">${tx.tx_id ? copyable(tx.tx_id, short(tx.tx_id, 10, 4)) : '—'}</td>
    </tr>`;
    }).join('');

    list.forEach((tx) => state.seenTx.add(tx.tx_id));
    while (state.seenTx.size > 400) {
      state.seenTx.delete(state.seenTx.values().next().value);
    }
    state.lastTopTx = list[0]?.tx_id || state.lastTopTx;
  }

  function renderBlocks(totalBlocks) {
    const host = $('#block-list');
    if (!host) return;
    if (!state.blocks.length) {
      host.innerHTML = '<div class="empty-state">No blocks returned.</div>';
      return;
    }
    const seen = new Set();
    const unique = state.blocks.filter((block) => {
      if (seen.has(block.id)) return false;
      seen.add(block.id);
      return true;
    });
    host.innerHTML = unique.map((block) => `<button class="block-row" type="button" data-search="${esc(block.id)}" title="Open block ${esc(block.id)}">
      <span>
        <span class="block-id">${esc(block.id)}</span>
        <span class="block-meta">
          <span>tick <b>${num(block.tick)}</b></span>
          <span>${esc(block.status || '')}</span>
          <span>${esc(block.source || 'mesh')}</span>
        </span>
      </span>
      <span class="block-tx">${num(block.tx_count)} tx</span>
    </button>`).join('');

    const pill = $('#block-status');
    if (pill) pill.textContent = `${num(totalBlocks)} blocks`;
  }

  /* ---------------- chrome ---------------- */

  function initNavigation() {
    const nav = $('#nav');
    const menu = $('#menu-btn');
    const header = $('#site-header');

    menu?.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      menu.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    $$('.nav-link').forEach((link) => link.addEventListener('click', () => {
      nav.classList.remove('open');
      menu?.setAttribute('aria-expanded', 'false');
    }));

    const onScroll = () => {
      header?.classList.toggle('is-scrolled', window.scrollY > 10);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    const sectionLinks = new Map(
      $$('.nav-link').map((link) => [link.getAttribute('href')?.slice(1), link])
    );
    const sections = $$('main section[id]').filter((section) => sectionLinks.has(section.id));

    let ticking = false;
    const spy = () => {
      const offset = window.scrollY + 140;
      let current = sections[0]?.id;
      sections.forEach((section) => {
        if (section.offsetTop <= offset) current = section.id;
      });
      sectionLinks.forEach((link, id) => link.classList.toggle('is-active', id === current));
      ticking = false;
    };
    window.addEventListener('scroll', () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(spy);
      }
    }, { passive: true });
    spy();
  }

  function initReveal() {
    const items = $$('.reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('in'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -40px 0px' });
    items.forEach((el) => observer.observe(el));
  }

  function initRain() {
    const canvas = $('#rain');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const palette = ['#ff6a00', '#1f9b3a', '#8b97a8'];
    let width = 0;
    let height = 0;
    let nodes = [];
    let frame = 0;
    let active = true;
    let raf = null;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(20, Math.min(68, Math.floor((width * height) / 22000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28,
        r: Math.random() * 1.8 + 0.8,
        color: palette[Math.floor(Math.random() * palette.length)],
        alpha: Math.random() * 0.5 + 0.35
      }));
      ctx.clearRect(0, 0, width, height);
    };

    const draw = (time) => {
      if (!active) return;
      if (time - frame < 50) {
        raf = requestAnimationFrame(draw);
        return;
      }
      frame = time;
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < -20) node.x = width + 20;
        if (node.x > width + 20) node.x = -20;
        if (node.y < -20) node.y = height + 20;
        if (node.y > height + 20) node.y = -20;
      }
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 130) {
            ctx.strokeStyle = `rgba(255,106,0,${((1 - dist / 130) * 0.22).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      nodes.forEach((node) => {
        ctx.globalAlpha = node.alpha;
        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, node.alpha + 0.3);
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
      raf = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);

    if (!reduce) {
      if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !active) {
              active = true;
              raf = requestAnimationFrame(draw);
            } else if (!entry.isIntersecting) {
              active = false;
              if (raf) cancelAnimationFrame(raf);
            }
          });
        }, { threshold: 0 });
        observer.observe(canvas);
      }
      raf = requestAnimationFrame(draw);
    }
  }

  function bindEvents() {
    $('#refresh-btn')?.addEventListener('click', async () => {
      toast('Refreshing live data…');
      await Promise.all([loadCore(), loadFeeds({ silent: true }), loadNFT({ silent: true })]);
    });

    $('#range-buttons')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-range]');
      if (!button) return;
      state.range = button.dataset.range;
      writeStore(STORE_RANGE, state.range);
      $$('#range-buttons button').forEach((el) => el.classList.toggle('is-active', el === button));
      loadHistogram();
    });

    $('#feed-filters')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-filter]');
      if (!button) return;
      state.txFilter = button.dataset.filter;
      $$('#feed-filters button').forEach((el) => el.classList.toggle('is-active', el === button));
      renderTransactions();
    });

    $('#search-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = $('#search-input').value.trim();
      runSearch(value);
    });

    $('#add-collection-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = $('#collection-input');
      const hint = $('#collection-hint');
      const ok = await addCollection(input.value);
      if (ok) {
        input.value = '';
        if (hint) {
          hint.textContent = 'Collection tracked. Its supply and events are now part of the live NFT index.';
          hint.classList.remove('error');
        }
      } else if (hint) {
        hint.textContent = 'Could not track that contract. Use a 64-hex contract id from an NFT collection.';
        hint.classList.add('error');
      }
    });

    $('#wallet-nft-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      loadWalletGallery($('#wallet-nft-input').value);
    });

    $('#try-tx')?.addEventListener('click', async () => {
      let id = state.transactions[0]?.tx_id;
      if (!id) {
        try {
          const res = await api('/transactions?limit=1&offset=0');
          id = res?.transactions?.[0]?.tx_id;
        } catch { /* ignore */ }
      }
      if (id) {
        $('#search-input').value = id;
        runSearch(id);
      } else {
        toast('No transaction available yet', true);
      }
    });

    $('#try-block')?.addEventListener('click', () => {
      const id = state.blocks[0]?.id || state.tick?.tick;
      if (id) {
        $('#search-input').value = id;
        runSearch(String(id));
      } else {
        toast('No block loaded yet', true);
      }
    });

    $('#try-wallet')?.addEventListener('click', () => {
      const addr = state.transactions[0]?.sender;
      if (addr) {
        $('#search-input').value = addr;
        runSearch(addr);
      } else {
        toast('No wallet loaded yet', true);
      }
    });

    $('#try-nft')?.addEventListener('click', () => {
      const id = state.collections[0];
      if (!id) {
        toast('Scan the chain or track an NFT contract first', true);
        return;
      }
      $('#search-input').value = id;
      runSearch(id);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const el = event.target.closest?.('.copyable[data-copy]');
      if (!el) return;
      event.preventDefault();
      el.click();
    });

    document.addEventListener('click', async (event) => {
      const discover = event.target.closest('[data-discover]');
      if (discover) {
        discover.disabled = true;
        try {
          const found = await discoverNftCollections({ silent: true });
          await loadNFT({ silent: true });
          toast(found.length ? `Discovered ${found.length} NFT collection${found.length === 1 ? '' : 's'}` : 'No NFT contracts found in recent activity');
        } finally {
          discover.disabled = false;
        }
        return;
      }

      const holder = event.target.closest('[data-load-holder]');
      if (holder) {
        const address = latestHolderAddress();
        if (!address) {
          toast('No NFT holder found yet', true);
          return;
        }
        const input = $('#wallet-nft-input');
        if (input) input.value = address;
        loadWalletGallery(address);
        return;
      }

      const retry = event.target.closest('[data-retry]');
      if (retry) {
        const scope = retry.getAttribute('data-retry');
        retry.disabled = true;
        if (scope === 'core') loadCore();
        else if (scope === 'feeds') loadFeeds();
        else if (scope === 'nft') loadNFT();
        else loadCore();
        return;
      }

      const copy = event.target.closest('[data-copy]');
      if (copy) {
        event.preventDefault();
        const value = copy.getAttribute('data-copy');
        const ok = await copyText(value);
        toast(ok ? `Copied ${short(value, 10, 6)}` : 'Could not copy — select the text manually', !ok);
        return;
      }

      const remove = event.target.closest('[data-remove-collection]');
      if (remove) {
        const id = remove.getAttribute('data-remove-collection');
        state.collections = state.collections.filter((item) => item !== id);
        saveCollections();
        loadNFT({ silent: true });
        toast('Collection removed');
        return;
      }

      const search = event.target.closest('[data-search]');
      if (search) {
        const value = search.getAttribute('data-search');
        if (value) {
          const input = $('#search-input');
          if (input) input.value = value;
          runSearch(value);
          const explorer = $('#explorer');
          if (explorer) explorer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  }

  function startTimers() {
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.histogram) renderHistogram();
      }, 200);
    });

    // Realtime clock: tick + RPC latency every 3 seconds.
    setInterval(() => {
      if (document.visibilityState === 'visible') loadTick();
    }, 3000);

    // Live transaction + block feeds every 4 seconds.
    setInterval(() => {
      if (document.visibilityState === 'visible') loadFeeds({ silent: true });
    }, 4000);

    // Heavier aggregate panels every 10 seconds.
    setInterval(() => {
      if (document.visibilityState === 'visible') loadCore({ silent: true });
    }, 10000);

    // NFT index every 60 seconds (metadata is cached separately).
    setInterval(() => {
      if (document.visibilityState === 'visible') loadNFT({ silent: true });
    }, 60000);

    setInterval(updateSyncAge, 1000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      loadTick();
      loadFeeds({ silent: true });
      updateSyncAge();
    });
  }

  function init() {
    const year = $('#year');
    if (year) year.textContent = new Date().getFullYear();

    $$('#range-buttons button').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.range === state.range);
    });

    initNavigation();
    initReveal();
    initRain();
    bindEvents();
    setText('#nft-wallet-count', 'ready');

    // Render synchronous placeholders, then hydrate from the API.
    renderTick();
    loadCore();
    loadFeeds();
    ensureNftIndex();
    startTimers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
