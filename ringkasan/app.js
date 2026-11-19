/* RELIVE — Network Brief
   Same public API as the explorer, editorial one-page layout. */
(() => {
  'use strict';

  const API = 'https://rpc.retium.org/api';
  const MONEY = 'https://api.retium.money/api/summary';
  const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
  const NFT_METHODS = new Set([
    'mint', 'batch_mint', 'batch_mint_base', 'drop_mint', 'drop_mint_pick',
    'transfer', 'batch_transfer', 'burn', 'batch_burn', 'reveal', 'init_drop'
  ]);

  const TYPES = [
    { key: 'transfer', label: 'Transfers', color: '#ff7a1a' },
    { key: 'contract_call', label: 'Contract calls', color: '#5b8def' },
    { key: 'stake', label: 'Stake', color: '#3ecf6f' },
    { key: 'unstake', label: 'Unstake', color: '#b07cf7' },
    { key: 'contract_deploy', label: 'Deploys', color: '#e0b341' },
    { key: 'safehouse', label: 'Safehouse', color: '#38bdf8' },
    { key: 'validator', label: 'Validators', color: '#2e9e4f' },
    { key: 'api_key', label: 'API keys', color: '#6e7781' },
    { key: 'multisig', label: 'Multisig', color: '#94a3b8' }
  ];

  const ACTION_COLORS = {
    transfer: '#ff7a1a',
    call: '#5b8def',
    contract_call: '#5b8def',
    deploy: '#e0b341',
    contract_deploy: '#e0b341',
    stake: '#3ecf6f',
    unstake: '#b07cf7',
    safehouse: '#38bdf8',
    validator: '#2e9e4f',
    multisig: '#94a3b8'
  };

  const state = {
    stats: null,
    tick: null,
    safehouse: null,
    summary: null,
    histogram: null,
    transactions: [],
    range: '7d',
    collections: [],
    nftBusy: false,
    nftTotal: null,
    lastSync: 0,
    latency: null
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US'));
  const pct = (a, b) => (Number(b) > 0 ? ((Number(a) / Number(b)) * 100).toFixed(1) : '0.0');
  const short = (v, h = 9, t = 6) => {
    const s = String(v || '');
    return s.length > h + t + 3 ? `${s.slice(0, h)}…${s.slice(-t)}` : s;
  };
  const amount = (value, digits = 2) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '0';
    if (n > 0 && n < 0.01) return '<0.01';
    return n.toLocaleString('en-US', { maximumFractionDigits: digits });
  };
  const atomic = (value, decimals = 18, digits = 2) => {
    const raw = String(value || '').trim();
    if (!/^\d+$/.test(raw)) return '—';
    const big = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = (big / base).toLocaleString('en-US');
    const frac = big % base;
    if (frac === 0n) return whole;
    const part = frac.toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '');
    return part ? `${whole}.${part}` : whole;
  };
  const timeAgo = (ts) => {
    const raw = Number(ts);
    const seconds = Math.floor((Date.now() - (raw > 1e12 ? raw : raw * 1000)) / 1000);
    if (!Number.isFinite(seconds)) return '—';
    if (seconds < 5) return 'now';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  };

  async function api(path, timeout = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(API + path, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function moneySummary() {
    const res = await fetch(MONEY, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /* ---------------- sync clock ---------------- */
  function markSync() {
    state.lastSync = Date.now();
    const clock = new Date().toLocaleTimeString('en-US', { hour12: false });
    $('#sync-time').textContent = clock;
    const last = $('#last-sync');
    if (last) last.textContent = clock;
    updateAge();
  }

  function updateAge() {
    const el = $('#sync-age');
    if (!el || !state.lastSync) return;
    const seconds = Math.floor((Date.now() - state.lastSync) / 1000);
    el.textContent = seconds < 2 ? ' · just now' : ` · ${seconds}s ago`;
    if (seconds > 45) el.style.color = '#f0a15a';
    else el.style.color = '';
    const clock = $('#last-sync');
    if (clock) clock.textContent = new Date(state.lastSync).toLocaleTimeString('en-US', { hour12: false });
  }

  /* ---------------- loaders ---------------- */
  async function loadCore() {
    const tz = -new Date().getTimezoneOffset();
    let latency = null;
    const timedTick = (async () => {
      const started = performance.now();
      const data = await api('/tick/current');
      latency = performance.now() - started;
      return data;
    })();

    const [stats, tick, safehouse, summary, histogram, tx] = await Promise.allSettled([
      api('/stats'),
      timedTick,
      api('/safehouse'),
      moneySummary(),
      api(`/transactions/histogram?range=${state.range}&tz=${tz}`),
      api('/transactions?limit=30&offset=0')
    ]);

    if (stats.status === 'fulfilled') state.stats = stats.value;
    if (tick.status === 'fulfilled') state.tick = tick.value;
    if (safehouse.status === 'fulfilled') state.safehouse = safehouse.value;
    if (summary.status === 'fulfilled') state.summary = summary.value;
    if (histogram.status === 'fulfilled') state.histogram = histogram.value;
    if (tx.status === 'fulfilled') state.transactions = Array.isArray(tx.value?.transactions) ? tx.value.transactions : [];

    state.latency = latency === null ? state.latency : Math.round(latency);
    $('#readout-state').textContent = stats.status === 'fulfilled' ? 'live' : 'partial';
    $('#readout-state').classList.toggle('ok', stats.status === 'fulfilled');

    renderAll();
    markSync();
  }

  async function loadTick() {
    const started = performance.now();
    try {
      const data = await api('/tick/current', 8000);
      const previous = state.tick ? Number(state.tick.tick) : null;
      state.tick = data;
      state.latency = Math.round(performance.now() - started);
      renderReadout();
      if (previous !== null && Number(data.tick) > previous) flashTick();
      markSync();
    } catch {
      /* keep the last good value */
    }
  }

  function flashTick() {
    const el = $('#ro-tick');
    if (!el) return;
    el.classList.add('is-fresh');
    setTimeout(() => el.classList.remove('is-fresh'), 900);
  }

  function renderAll() {
    renderReadout();
    renderStrip();
    renderComposition();
    renderChart();
    renderValidators();
    renderWallets();
    renderStaking();
    renderEconomy();
    renderWire();
    renderTape();
  }

  /* ---------------- hero readout ---------------- */
  function renderReadout() {
    const tick = state.tick;
    if (tick) {
      $('#ro-tick').textContent = `#${int(tick.tick)}`;
      $('#ro-blocks').textContent = int(state.stats?.blocks_finalized ?? tick.total_blocks);
      $('#ro-open').textContent = int(tick.open_blocks);
    }
    if (state.latency !== null) $('#ro-rpc').textContent = `${int(state.latency)} ms`;
  }

  /* ---------------- totals strip ---------------- */
  function renderStrip() {
    const stats = state.stats;
    if (!stats) return;
    const tx = stats.totals?.transactions || {};
    const total = Number(tx.total) || 0;
    const calls = Number(tx.contract_call) || 0;
    const deploys = Number(tx.contract_deploy) || 0;
    const windows = stats.wallet_windows || [];
    const new24 = windows.find((w) => Number(w.hours) === 24)?.new_wallets;

    $('#s-total').textContent = int(total);
    $('#s-total-note').textContent = 'since genesis';
    $('#s-transfer').textContent = int(tx.transfer);
    $('#s-transfer-note').textContent = `${pct(tx.transfer, total)}% of all actions`;
    $('#s-contracts').textContent = int(calls + deploys);
    $('#s-contracts-note').textContent = `${int(calls)} calls · ${int(deploys)} deploys`;
    $('#s-wallets').textContent = int(stats.totals?.wallets ?? stats.wallets);
    $('#s-wallets-note').textContent = `${int(new24)} new in 24h`;
    $('#s-blocks').textContent = int(stats.blocks_finalized);
    $('#s-blocks-note').textContent = `${int(state.tick?.open_blocks)} open now`;
    $('#s-nft').textContent = state.nftTotal === null ? '—' : int(state.nftTotal);
  }

  /* ---------------- composition ---------------- */
  function renderComposition() {
    const tx = state.stats?.totals?.transactions || {};
    const total = Number(tx.total) || 0;
    const rows = TYPES.map((t) => ({ ...t, value: Number(tx[t.key]) || 0 })).filter((r) => r.value > 0);

    if (!rows.length) return;
    $('#composition-total').textContent = `${int(total)} actions`;

    let cursor = 0;
    const stops = rows.map((row) => {
      const share = total ? (row.value / total) * 100 : 0;
      const from = cursor;
      cursor += share;
      return `${row.color} ${from.toFixed(3)}% ${cursor.toFixed(3)}%`;
    });
    $('#donut').style.background = `conic-gradient(${stops.join(', ')})`;

    const lead = rows[0];
    $('#donut-main').textContent = `${pct(lead.value, total)}%`;
    $('#donut-sub').textContent = lead.label.toLowerCase();

    $('#legend').innerHTML = rows.slice(0, 6).map((row) => `<div class="type-row">
      <span class="type-name"><i style="background:${row.color}"></i>${esc(row.label)}</span>
      <span class="type-track"><i class="type-fill" style="width:${pct(row.value, rows[0].value)}%;background:${row.color}"></i></span>
      <span class="type-count">${int(row.value)}</span>
    </div>`).join('');
  }

  /* ---------------- chart ---------------- */
  function renderChart() {
    const data = state.histogram;
    if (!data || !Array.isArray(data.buckets) || !data.buckets.length) return;

    const W = 600;
    const H = 190;
    const top = 14;
    const bottom = 16;
    const counts = data.buckets.map((b) => Number(b.count) || 0);
    const max = Math.max(...counts, 1);
    const n = counts.length;
    const step = n > 1 ? (W - 10) / (n - 1) : 0;
    const x = (i) => 5 + i * step;
    const y = (c) => H - bottom - (c / max) * (H - top - bottom);

    const points = counts.map((c, i) => [x(i), y(c)]);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${line} L${x(n - 1).toFixed(1)},${H - bottom} L${x(0).toFixed(1)},${H - bottom} Z`;

    $('#chart-line').setAttribute('d', line);
    $('#chart-area').setAttribute('d', area);

    $('#chart-grid').innerHTML = [0.25, 0.5, 0.75, 1].map((t) => {
      const gy = (H - bottom - t * (H - top - bottom)).toFixed(1);
      return `<line class="grid-line" x1="0" x2="${W}" y1="${gy}" y2="${gy}" />`;
    }).join('');

    const labelCount = Math.min(window.innerWidth < 620 ? 4 : 7, n);
    const stride = Math.max(1, Math.ceil(n / labelCount));
    const indices = [];
    for (let i = 0; i < n; i += stride) indices.push(i);
    if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);

    $('#chart-x').innerHTML = indices.map((i) => {
      const date = new Date(Number(data.buckets[i].start_ts) * 1000);
      const text = state.range === '1d'
        ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
        : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const left = Math.min(96, Math.max(4, (x(i) / W) * 100));
      return `<span style="left:${left}%">${esc(text)}</span>`;
    }).join('');

    $('#momentum-sub').textContent = state.range === '1d'
      ? 'Rolling 24 hours'
      : state.range === '7d' ? 'Rolling 7 days' : 'Rolling 30 days';
    $('#chart-total').textContent = `${int(data.total)} actions in range`;
    $('#chart-peak').textContent = `peak ${int(max)} per bucket`;
  }

  /* ---------------- validators ---------------- */
  function renderValidators() {
    const nodes = state.stats?.nodes || {};
    const rows = [
      ['Keepers', nodes.keepers?.online, nodes.keepers?.total, 'signing'],
      ['Suits', nodes.suits?.online, nodes.suits?.total, 'consensus'],
      ['Workers', nodes.workers?.online, nodes.workers?.total, 'execution'],
      ['RPC', nodes.rpc?.total, nodes.rpc?.total, 'endpoints']
    ];

    const online = rows.reduce((sum, [, on]) => sum + (Number(on) || 0), 0);
    const all = rows.reduce((sum, [, , total]) => sum + (Number(total) || 0), 0);
    const share = all ? (online / all) * 100 : 0;

    $('#health-value').textContent = `${Math.round(share)}%`;
    $('#health-bar').style.width = `${share}%`;

    const chip = $('#node-chip');
    chip.textContent = all ? `${int(online)}/${int(all)} online` : '—';
    chip.classList.toggle('ok', all > 0 && online === all);

    $('#nodes').innerHTML = rows.map(([role, on, total, sub]) => {
      const safeTotal = Number(total) || 0;
      const safeOn = Number(on) || 0;
      const width = safeTotal ? Math.min(100, (safeOn / safeTotal) * 100) : 0;
      return `<div class="node-card">
        <div class="node-top"><span class="node-role">${esc(role)}</span><span class="node-val"><b>${int(safeOn)}</b>/${int(safeTotal)}</span></div>
        <div class="node-bar"><i style="width:${width}%"></i></div>
        <div class="node-sub">${esc(sub)}</div>
      </div>`;
    }).join('');
  }

  /* ---------------- wallets ---------------- */
  function renderWallets() {
    const windows = state.stats?.wallet_windows || [];
    if (!windows.length) return;

    const max = Math.max(...windows.map((w) => Number(w.active_wallets) || 0), 1);
    $('#wallet-chip').textContent = `${int(windows.length)} windows`;

    $('#windows').innerHTML = windows.map((w) => {
      const hours = Number(w.hours);
      const label = hours === 24 ? '24h' : hours === 168 ? '7d' : hours === 720 ? '30d' : `${hours}h`;
      const active = Number(w.active_wallets) || 0;
      const fresh = Number(w.new_wallets) || 0;
      const freshMax = Math.max(...windows.map((x) => Number(x.new_wallets) || 0), 1);
      return `<div class="window-row">
        <span class="window-label">${label}</span>
        <div class="window-bars">
          <div class="window-bar active"><i style="width:${(active / max) * 100}%"></i></div>
          <div class="window-bar new"><i style="width:${(fresh / freshMax) * 100}%"></i></div>
        </div>
        <span class="window-meta"><b>${int(active)}</b> active<br /><b>${int(fresh)}</b> new</span>
      </div>`;
    }).join('');
  }

  /* ---------------- staking ---------------- */
  function renderStaking() {
    const tx = state.stats?.totals?.transactions || {};
    const stake = Number(tx.stake) || 0;
    const unstake = Number(tx.unstake) || 0;
    const sum = stake + unstake;
    const net = stake - unstake;

    $('#stake-count').textContent = int(stake);
    $('#unstake-count').textContent = int(unstake);
    $('#stake-bar').style.width = `${sum ? (stake / sum) * 100 : 50}%`;
    $('#stake-share').textContent = `${pct(stake, sum)}%`;
    $('#unstake-share').textContent = `${pct(unstake, sum)}%`;

    const chip = $('#stake-chip');
    chip.textContent = `${net >= 0 ? '+' : ''}${int(net)} net`;
    chip.classList.toggle('ok', net >= 0);

    $('#stake-note').textContent = `${pct(sum, tx.total)}% of all ledger actions are staking activity. ${net >= 0 ? 'More commitments than exits' : 'More exits than commitments'} on record.`;
  }

  /* ---------------- economy ---------------- */
  function renderEconomy() {
    const summary = state.summary;
    const safe = state.safehouse;
    const fees = state.stats?.totals?.fees || {};

    const supply = summary ? Number(atomic(summary.supply_atomic).replace(/,/g, '')) : NaN;
    const compact = (n) => {
      if (!Number.isFinite(n)) return null;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
      return n.toFixed(2);
    };
    const supplyEl = $('#rtd-supply');
    if (Number.isFinite(supply)) {
      supplyEl.textContent = `${compact(supply)} RTD`;
      supplyEl.title = `${atomic(summary.supply_atomic)} RTD`;
    } else {
      supplyEl.textContent = '—';
      supplyEl.removeAttribute('title');
    }
    $('#customers').textContent = summary ? int(summary.customers) : '—';
    $('#backing').textContent = safe ? `${amount(Number(safe.backing) * 100, 2)}%` : '—';
    $('#gas-collected').textContent = `${amount(fees.collected_rtm, 0)} RTM`;

    const chip = $('#backing-chip');
    const backed = Boolean(summary?.backed);
    chip.textContent = backed ? 'fully backed' : 'check backing';
    chip.classList.toggle('ok', backed);

    $('#gas-burned').textContent = `${amount(fees.burned_rtm, 2)} RTM burned`;

    const rows = [
      ['Workers', Number(fees.workers_rtm) || 0, '#ff7a1a'],
      ['Foundation', Number(fees.foundation_rtm) || 0, '#ffb066'],
      ['Keepers', Number(fees.keepers_rtm) || 0, '#5b8def'],
      ['Suits', Number(fees.suits_rtm) || 0, '#3ecf6f'],
      ['Treasury', Number(fees.treasury_rtm) || 0, '#b07cf7'],
      ['Burned', Number(fees.burned_rtm) || 0, '#e0b341']
    ];
    const total = rows.reduce((sum, [, value]) => sum + value, 0) || 1;

    $('#gas-bars').innerHTML = rows.map(([label, value, color]) => `<div class="fee-bar-row">
      <span>${esc(label)}</span>
      <span class="type-track"><i class="type-fill" style="width:${(value / total) * 100}%;background:${color}"></i></span>
      <b>${amount(value, value < 10 ? 2 : 0)} RTM</b>
    </div>`).join('');
  }

  /* ---------------- wire + tape ---------------- */
  function actionLabel(raw) {
    const key = String(raw || '').toLowerCase();
    if (key === 'call' || key === 'contract_call') return 'Contract call';
    if (key === 'transfer') return 'Transfer';
    if (key === 'deploy' || key === 'contract_deploy') return 'Contract deploy';
    if (key === 'stake') return 'Stake';
    if (key === 'unstake') return 'Unstake';
    if (key === 'validator') return 'Validator';
    if (key.startsWith('safehouse')) return `Safehouse ${key.replace('safehouse_', '')}`.trim();
    return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Action';
  }

  function actionColor(raw) {
    const key = String(raw || '').toLowerCase();
    if (key.startsWith('safehouse')) return ACTION_COLORS.safehouse;
    return ACTION_COLORS[key] || '#6e7781';
  }

  function renderWire() {
    const list = state.transactions.slice(0, 9);
    const host = $('#wire');
    if (!list.length) {
      host.innerHTML = '<div class="empty-state">No transactions returned yet.</div>';
      return;
    }
    $('#wire-state').textContent = `${int(state.transactions.length)} loaded`;
    host.innerHTML = list.map((tx) => {
      const color = actionColor(tx.action);
      const value = Number(tx.amount_rtm) > 0
        ? `${amount(tx.amount_rtm, 3)} <b>RTM</b>`
        : '<span style="color:#4a545f">0 RTM</span>';
      return `<div class="wire-row">
        <i style="background:${color}"></i>
        <div class="wire-main">
          <b>${esc(actionLabel(tx.action))}</b>
          <span>${esc(short(tx.sender, 10, 6))} → ${esc(short(tx.recipient, 10, 6))}</span>
        </div>
        <div class="wire-value">${value}<small>${esc(timeAgo(tx.timestamp))} ago</small></div>
      </div>`;
    }).join('');
  }

  function renderTape() {
    const host = $('#tape');
    const list = state.transactions.slice(0, 12);
    if (!list.length) {
      host.innerHTML = '<span class="tape-empty">Waiting for the next actions…</span>';
      return;
    }
    host.innerHTML = list.map((tx) => `<span class="tape-item">
      <i style="background:${actionColor(tx.action)}"></i>
      <b>${esc(actionLabel(tx.action))}</b>
      ${Number(tx.amount_rtm) > 0 ? `${esc(amount(tx.amount_rtm, 2))} RTM` : 'no value'}
      <em>${esc(timeAgo(tx.timestamp))}</em>
    </span>`).join('');
  }

  /* ---------------- NFT layer ---------------- */
  const metaCache = new Map();

  function ipfsPath(uri) {
    const value = String(uri || '').trim();
    if (value.startsWith('ipfs://ipfs/')) return value.slice(11);
    if (value.startsWith('ipfs://')) return value.slice(7);
    if (value.startsWith('/ipfs/')) return value.slice(6);
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+)$/i.test(value)) return value;
    return null;
  }

  function candidates(uri) {
    const path = ipfsPath(uri);
    if (path) return [`https://images.weserv.nl/?url=${encodeURIComponent(`ipfs.filebase.io/ipfs/${path}`)}&w=480&h=480&fit=cover&output=webp&q=80`, ...GATEWAYS.map((g) => g + path)];
    const value = String(uri || '').trim();
    return /^https?:\/\//.test(value) ? [value] : [];
  }

  async function jsonUri(uri) {
    const path = ipfsPath(uri);
    const value = String(uri || '').trim();
    const urls = path ? GATEWAYS.map((g) => g + path) : (/^https?:\/\//.test(value) ? [value] : []);
    for (const url of urls) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'force-cache' });
        if (res.ok) return await res.json();
      } catch {
        /* try the next gateway */
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  async function tokenMeta(contract, token) {
    const key = `${contract}:${token}`;
    if (metaCache.has(key)) return metaCache.get(key);
    const promise = (async () => {
      try {
        const query = await api(`/contract/${contract}/query?method=token_uri&args=${encodeURIComponent(token)}`, 10000);
        const raw = unwrapUri(query?.output);
        if (!raw) return null;
        const meta = typeof raw === 'object' ? raw : await jsonUri(raw);
        if (!meta || typeof meta !== 'object') return null;
        const image = meta.image || meta.image_url || meta.imageUri || '';
        return { name: String(meta.name || ''), image: candidates(image)[0] || '' };
      } catch {
        return null;
      }
    })();
    metaCache.set(key, promise);
    return promise;
  }

  function safeParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }

  function unwrapUri(raw) {
    let value = String(raw ?? '').trim();
    if (!value) return '';
    if (value.startsWith('"')) {
      const parsed = safeParse(value);
      if (typeof parsed === 'string') value = parsed.trim();
    } else if (value.startsWith('{')) {
      const parsed = safeParse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    return value;
  }

  async function discoverCollections() {
    showNftSkeleton();
    const found = new Set();
    for (let page = 0; page < 3; page += 1) {
      const data = await api(`/transactions?limit=100&offset=${page * 100}`);
      const list = Array.isArray(data?.transactions) ? data.transactions : [];
      if (!list.length) break;
      list.forEach((tx) => {
        const method = String(tx.call?.method || '').toLowerCase();
        const contract = String(tx.call?.contract || '').toLowerCase();
        if (contract && NFT_METHODS.has(method)) found.add(contract);
      });
    }

    const ids = Array.from(found).slice(0, 12);
    const valid = [];
    for (let i = 0; i < ids.length; i += 4) {
      const batch = ids.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map((id) => api(`/contract/${id}`)));
      results.forEach((res, idx) => {
        const type = String(res.value?.rcp_metadata?.rcp_type || '').toUpperCase();
        if (res.status === 'fulfilled' && type.includes('NFT')) valid.push(batch[idx]);
      });
    }

    state.collections = valid.slice(0, 8).map((id) => ({ id, supply: 0, cover: '', name: '', token: null, events: [] }));
    await loadCollections();
  }

  function showNftSkeleton() {
    $('#collection-grid').innerHTML = Array.from({ length: 4 }, () => '<div class="collection-row skeleton" aria-hidden="true"></div>').join('');
    $('#nft-count').textContent = 'scanning…';
  }

  async function loadCollections() {
    if (state.nftBusy) return;
    state.nftBusy = true;
    try {
      const items = await Promise.all(state.collections.map(async (entry) => {
        const [supplyRes, eventsRes] = await Promise.allSettled([
          api(`/contract/${entry.id}/query?method=total_supply&args=`),
          api(`/contract/${entry.id}/events`)
        ]);
        const events = eventsRes.value?.events || [];
        const supply = Number(supplyRes.value?.output) || 0;

        let token = null;
        const mintEvent = events.find((e) => {
          const raw = String(e.data || '');
          return raw.includes('"from":"0x0"') || String(e.event_type || '').toLowerCase() === 'mint';
        });
        if (mintEvent) {
          const parsed = safeParse(mintEvent.data);
          token = parsed?.id ?? parsed?.token_id ?? null;
        }

        return {
          id: entry.id,
          name: `Collection ${short(entry.id, 6, 4)}`,
          supply,
          events,
          token,
          cover: ''
        };
      }));

      state.collections = items;
      state.nftTotal = items.reduce((sum, item) => sum + Math.max(Number(item.supply) || 0, countMints(item.events)), 0);

      renderCollections();
      $('#s-nft').textContent = int(state.nftTotal);
      $('#s-nft-note').textContent = `across ${items.length} discovered contracts`;
      $('#nft-count').textContent = `${items.length} discovered`;
      $('#gallery-sub').textContent = 'Pick a holder from the latest NFT activity';

      items.forEach((item) => hydrateCollection(item.id));
    } finally {
      state.nftBusy = false;
    }
  }

  function countMints(events) {
    return (events || []).filter((e) => {
      const raw = String(e.data || '');
      return raw.includes('"from":"0x0"') || String(e.event_type || '').toLowerCase() === 'mint';
    }).length;
  }

  async function hydrateCollection(id) {
    const item = state.collections.find((entry) => entry.id === id);
    if (!item || item.token === null || item.cover) return;
    const meta = await tokenMeta(id, item.token);
    if (!meta) return;
    const derived = meta.name ? meta.name.replace(/\s*#?\d+\s*$/, '').trim() : '';
    if (derived.length > 2) item.name = derived;
    item.cover = meta.image || '';

    const row = document.querySelector(`.collection-row[data-collection="${id}"]`);
    if (!row) return;
    const nameEl = row.querySelector('.cname');
    if (nameEl && item.name) nameEl.textContent = item.name;
    const img = row.querySelector('.collection-cover img');
    if (img && item.cover) img.src = item.cover;
  }

  function renderCollections() {
    const host = $('#collection-grid');
    if (!state.collections.length) {
      host.innerHTML = '<div class="empty-state">No NFT contracts in the latest activity. Press “Scan chain” to look again.</div>';
      return;
    }

    host.innerHTML = state.collections.map((item) => {
      const events = item.events || [];
      const transfers = events.filter((e) => String(e.event_type || '').toLowerCase().includes('transfer')).length;
      const burns = events.filter((e) => String(e.event_type || '').toLowerCase().includes('burn')).length;
      const cover = item.cover
        ? `<img src="${esc(item.cover)}" alt="" decoding="async" />`
        : '<img alt="" decoding="async" />';
      return `<div class="collection-row" data-collection="${esc(item.id)}">
        <div class="collection-cover">
          <span class="nft-fallback">NFT</span>
          ${cover}
        </div>
        <div class="collection-info">
          <div class="collection-name"><span class="cname">${esc(item.name)}</span> <span class="tag">NFT</span></div>
          <span class="collection-id">${esc(short(item.id, 14, 8))}</span>
          <div class="collection-stats">
            <span>Supply <b>${int(item.supply)}</b></span>
            <span>Mints <b>${int(countMints(events))}</b></span>
            <span>Xfers <b>${int(transfers)}</b></span>
            <span>Burns <b>${int(burns)}</b></span>
          </div>
        </div>
      </div>`;
    }).join('');
    imageFallbacks(host);
  }

  function latestHolder() {
    for (const item of state.collections) {
      const events = [...(item.events || [])].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
      for (const event of events) {
        const data = safeParse(event.data) || {};
        const to = data.to || data.recipient;
        if (typeof to === 'string' && /^rete[a-z0-9]+$/i.test(to)) return to;
      }
    }
    return null;
  }

  async function loadGallery(address) {
    const host = $('#gallery');
    host.innerHTML = '<div class="empty-state">Loading artwork…</div>';
    try {
      const data = await api(`/wallet/${encodeURIComponent(address)}/nfts?limit=12&offset=0`);
      const nfts = Array.isArray(data?.nfts) ? data.nfts : [];
      if (!nfts.length) {
        host.innerHTML = '<div class="empty-state">This wallet holds no NFTs right now.</div>';
        return;
      }

      $('#gallery-sub').textContent = `${nfts.length} pieces · ${short(address, 10, 6)}`;

      const cards = nfts.slice(0, 12);
      host.innerHTML = cards.map((nft, i) => `<article class="nft-card">
        <div class="nft-thumb">
          <span class="nft-fallback">#${esc(nft.token_id)}</span>
          <img alt="" decoding="async" data-slot="${i}" />
        </div>
        <div class="nft-meta">
          <b class="nft-name" data-name="${i}">Token #${esc(nft.token_id)}</b>
          <span class="nft-contract">${esc(short(nft.contract_id, 10, 6))}</span>
        </div>
      </article>`).join('');
      imageFallbacks(host);

      await Promise.all(cards.map(async (nft, i) => {
        const meta = await tokenMeta(String(nft.contract_id).toLowerCase(), nft.token_id);
        if (!meta) return;
        const img = host.querySelector(`img[data-slot="${i}"]`);
        const name = host.querySelector(`[data-name="${i}"]`);
        if (name && meta.name) name.textContent = meta.name;
        if (img && meta.image) img.src = meta.image;
      }));
    } catch (err) {
      host.innerHTML = `<div class="empty-state">Could not load this wallet: ${esc(err.message)}</div>`;
    }
  }

  function imageFallbacks(root) {
    $$('img', root).forEach((img) => {
      const markLoaded = () => {
        img.classList.add('is-loaded');
        const card = img.closest('.nft-card');
        if (card) card.classList.add('has-art');
        const avatar = img.closest('.tool-avatar');
        if (avatar) avatar.classList.add('has-art');
      };
      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', () => {
        if (img.dataset.retried) return;
        img.dataset.retried = '1';
        img.src = img.src.includes('ipfs.filebase.io')
          ? img.src.replace('ipfs.filebase.io', 'gateway.pinata.cloud')
          : img.src.replace('gateway.pinata.cloud', 'ipfs.filebase.io');
      }, { once: true });
      if (img.complete && img.naturalWidth > 0) markLoaded();
    });
  }

  /* ---------------- tools: shared helpers ---------------- */
  const DEX = '59bf79b965fc9ae4f6854ca766027d0275e76bc56f060a377ec49106baf54f61';
  const poolCache = { at: 0, map: null, list: [] };
  const symbolCache = new Map();

  const isContractId = (v) => /^[0-9a-f]{64}$/i.test(String(v || '').trim());
  const isWalletId = (v) => /^rete[a-z0-9]{20,}$/i.test(String(v || '').trim());

  function parseJson(value) {
    if (typeof value !== 'string') return value ?? null;
    try { return JSON.parse(value); } catch { return null; }
  }

  function traitsOf(meta) {
    const traits = meta?.rcp_metadata?.traits || [];
    const symbol = String(traits.find((t) => t.startsWith('symbol:')) || '').slice(7).trim();
    const rawDecimals = String(traits.find((t) => t.startsWith('decimals:')) || '').slice(9);
    const decimals = /^\d{1,2}$/.test(rawDecimals) ? Number(rawDecimals) : 18;
    return {
      traits,
      symbol: /^[A-Za-z0-9._-]{1,16}$/.test(symbol) ? symbol : null,
      decimals
    };
  }

  function bigToNumber(raw, decimals = 18) {
    try {
      const big = BigInt(String(raw));
      const base = 10n ** BigInt(decimals);
      return Number(big / base) + Number(big % base) / Number(base);
    } catch {
      return NaN;
    }
  }

  function fmtAmount(raw, decimals = 18, digits = 2) {
    const n = bigToNumber(raw, decimals);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '0';
    if (n < 0.000001) return '<0.000001';
    return n.toLocaleString('en-US', { maximumFractionDigits: digits });
  }

  async function contractQuery(contract, method, args = '') {
    try {
      const res = await api(`/contract/${contract}/query?method=${encodeURIComponent(method)}&args=${encodeURIComponent(args)}`, 12000);
      if (res?.ok === false) return null;
      return res?.output ?? null;
    } catch {
      return null;
    }
  }

  async function tokenBasics(id) {
    const key = String(id).toLowerCase();
    if (symbolCache.has(key)) return symbolCache.get(key);
    const promise = (async () => {
      const meta = await api(`/contract/${key}`, 12000).catch(() => null);
      const info = traitsOf(meta);
      return {
        id: key,
        symbol: info.symbol,
        decimals: info.decimals,
        type: meta?.rcp_metadata?.rcp_type || 'Token',
        ok: Boolean(meta?.rcp_metadata)
      };
    })();
    symbolCache.set(key, promise);
    return promise;
  }

  async function loadPools(force = false) {
    if (!force && poolCache.map && Date.now() - poolCache.at < 90000) return poolCache;
    const [v1, v2] = await Promise.allSettled([
      contractQuery(DEX, 'list_pools'),
      contractQuery(DEX, 'list_v2')
    ]);
    const map = new Map();
    (parseJson(v1.value)?.pools || []).forEach((pool) => {
      const id = String(pool?.token_b || '').toLowerCase();
      if (id) map.set(id, { ...pool, kind: 'v1' });
    });
    (parseJson(v2.value)?.pools || []).forEach((pool) => {
      const id = String(pool?.token || '').toLowerCase();
      if (id && !map.has(id)) map.set(id, { ...pool, kind: 'v2' });
    });
    poolCache.at = Date.now();
    poolCache.map = map;
    poolCache.list = [...map.values()];
    return poolCache;
  }

  function poolPrice(pool, decimals = 18) {
    const rtm = bigToNumber(pool?.reserve_rtm, 18);
    const token = bigToNumber(pool?.reserve_token, decimals);
    if (!Number.isFinite(rtm) || !Number.isFinite(token) || token <= 0) return NaN;
    return rtm / token;
  }

  async function renderPools() {
    const host = $('#pool-list');
    const pools = [...(poolCache.list || [])].sort((a, b) => Number(b.reserve_rtm || 0) - Number(a.reserve_rtm || 0));
    $('#pool-count').textContent = pools.length ? `${int(pools.length)} pools · DexCore` : '—';
    if (!pools.length) {
      host.innerHTML = '<div class="empty-state">DexCore returned no pools right now.</div>';
      return;
    }

    const top = pools.slice(0, 8);
    host.innerHTML = top.map((pool) => {
      const id = String(pool.token_b || pool.token || '');
      return `<button type="button" class="pool-row" data-pool="${esc(id)}">
        <span><b data-sym="${esc(id)}">${esc(short(id, 8, 4))}</b><small>${esc(short(id, 14, 8))}</small></span>
        <span class="pool-col" data-price="${esc(id)}">—<span>RTM / token</span></span>
        <span class="pool-col" data-liq="${esc(id)}">${esc(fmtAmount(pool.reserve_rtm, 18, 0))}<span>RTM liq</span></span>
      </button>`;
    }).join('');

    await Promise.all(top.map(async (pool) => {
      const id = String(pool.token_b || pool.token || '');
      const info = await tokenBasics(id);
      const row = host.querySelector(`[data-pool="${id}"]`);
      if (!row) return;
      if (info.symbol) {
        const sym = row.querySelector(`[data-sym="${id}"]`);
        if (sym) sym.textContent = info.symbol;
      }
      const price = poolPrice(pool, info.decimals);
      if (Number.isFinite(price)) {
        const el = row.querySelector(`[data-price="${id}"]`);
        if (el && el.firstChild) el.firstChild.textContent = amount(price, 6);
      }
    }));
  }

  /* ---------------- tools: wallet NFTs ---------------- */
  async function openWallet(address) {
    const host = $('#wallet-result');
    const wallet = String(address || '').trim();
    if (!isWalletId(wallet)) {
      host.innerHTML = '<div class="empty-state">That does not look like a Retium wallet (expected <code>rete…</code>).</div>';
      return;
    }

    host.innerHTML = '<div class="empty-state">Reading this wallet’s NFT index…</div>';

    const data = await api(`/wallet/${encodeURIComponent(wallet)}/nfts?limit=48&offset=0`).catch(() => null);
    if (!data) {
      host.innerHTML = '<div class="empty-state">Could not read that wallet right now.</div>';
      return;
    }

    const nfts = Array.isArray(data.nfts) ? data.nfts : [];
    if (!nfts.length) {
      host.innerHTML = `<div class="empty-state">No NFTs found for ${esc(short(wallet, 12, 6))}.</div>`;
      return;
    }

    const groups = new Map();
    nfts.forEach((nft) => {
      const id = String(nft.contract_id).toLowerCase();
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(nft.token_id);
    });

    const chips = [...groups.entries()].map(([id, tokens]) =>
      `<span data-col-chip="${esc(id)}">Collection ${esc(short(id, 6, 4))} · <b>${int(tokens.length)}</b></span>`
    ).join('');

    host.innerHTML = `
      <div class="tool-head">
        <div>
          <div class="tool-title">${int(data.total_count ?? nfts.length)} pieces · ${int(groups.size)} collections</div>
          <div class="tool-id">${esc(wallet)}</div>
        </div>
      </div>
      <div class="ledger-chips" style="margin-top:14px">${chips}</div>
      <div class="nft-gallery" style="margin-top:16px">${nfts.map((nft, i) => `<article class="nft-card">
        <div class="nft-thumb"><span class="nft-fallback">#${esc(nft.token_id)}</span><img alt="" decoding="async" data-wallet-img="${i}" /></div>
        <div class="nft-meta">
          <b class="nft-name" data-wallet-name="${i}">Token #${esc(nft.token_id)}</b>
          <span class="nft-contract">${esc(short(nft.contract_id, 10, 6))}</span>
        </div>
      </article>`).join('')}</div>`;

    imageFallbacks(host);

    await Promise.all([...groups.entries()].map(async ([id, tokens]) => {
      const meta = await tokenMeta(id, tokens[0]);
      const derived = meta?.name ? meta.name.replace(/\s*#?\d+\s*$/, '').trim() : '';
      const chip = host.querySelector(`[data-col-chip="${id}"]`);
      if (chip && derived && !/^\d+$/.test(derived)) chip.innerHTML = `${esc(derived)} · <b>${int(tokens.length)}</b>`;
    }));

    await Promise.all(nfts.map(async (nft, i) => {
      const meta = await tokenMeta(String(nft.contract_id).toLowerCase(), nft.token_id);
      if (!meta) return;
      const name = host.querySelector(`[data-wallet-name="${i}"]`);
      const img = host.querySelector(`[data-wallet-img="${i}"]`);
      if (name && meta.name && !/^\d+$/.test(meta.name.trim())) name.textContent = meta.name;
      if (img && meta.image) img.src = meta.image;
    }));
  }

  /* ---------------- tools: contract check ---------------- */
  async function checkContract(id) {
    const host = $('#contract-result');
    const clean = String(id || '').trim().toLowerCase();
    if (!isContractId(clean)) {
      host.innerHTML = '<div class="empty-state">Enter the full 64-hex contract id.</div>';
      return;
    }

    host.innerHTML = '<div class="empty-state">Reading contract…</div>';

    const meta = await api(`/contract/${clean}`, 12000).catch(() => null);
    if (!meta?.rcp_metadata) {
      host.innerHTML = '<div class="empty-state">No RCP contract found for that id.</div>';
      return;
    }

    const rcp = meta.rcp_metadata;
    const traits = rcp.traits || [];
    const caps = rcp.capabilities || [];
    const isNft = caps.includes('token_uri') || caps.includes('owner_of') || /NFT/i.test(String(rcp.rcp_type || ''));
    const isFungible = traits.includes('fungible');

    const [supplyRaw, eventsRes] = isNft
      ? await Promise.all([
        contractQuery(clean, 'total_supply'),
        api(`/contract/${clean}/events`, 15000).catch(() => null)
      ])
      : [null, null];

    const events = eventsRes?.events || [];
    const count = (label) => events.filter((e) => String(e.event_type || '').toLowerCase() === label).length;
    const mints = count('mint') + events.filter((e) => String(e.data || '').includes('"from":"0x0"')).length;
    const transfers = count('transfer');
    const burns = count('burn');

    let cover = '';
    let derived = '';
    if (isNft) {
      const mintEvent = events.find((e) => String(e.data || '').includes('"from":"0x0"'));
      const tokenId = mintEvent ? (parseJson(mintEvent.data)?.id ?? parseJson(mintEvent.data)?.token_id) : null;
      if (tokenId !== null && tokenId !== undefined) {
        const tm = await tokenMeta(clean, tokenId);
        cover = tm?.image || '';
        derived = tm?.name ? tm.name.replace(/\s*#?\d+\s*$/, '').trim() : '';
      }
    }

    const name = derived || `${rcp.rcp_type || 'Contract'} ${short(clean, 6, 4)}`;
    const recent = events.slice(0, 6);
    const deployer = meta.deployer ? short(meta.deployer, 10, 6) : '—';
    const kindLabel = isNft ? 'NFT' : isFungible ? 'fungible token' : 'contract';
    const typeLabel = String(rcp.rcp_type || '').toLowerCase() === kindLabel.toLowerCase().replace(' token', '')
      ? `${kindLabel} · ${rcp.version || '—'}`
      : `${rcp.rcp_type || 'Contract'} · ${kindLabel} · ${rcp.version || '—'}`;

    host.innerHTML = `
      <div class="tool-head">
        <div class="tool-avatar"><span>${isNft ? 'NFT' : isFungible ? 'FT' : 'RCP'}</span>${cover ? `<img alt="" decoding="async" data-contract-art src="${esc(cover)}" />` : ''}</div>
        <div>
          <div class="tool-title">${esc(name)}</div>
          <div class="tool-type">${esc(typeLabel)}</div>
          <div class="tool-id">${esc(clean)}</div>
        </div>
        ${isFungible ? `<button type="button" class="btn btn-ghost btn-sm" data-open-token="${esc(clean)}" style="margin-left:auto">Open token page</button>` : ''}
      </div>
      <div class="fee-grid tool-section">
        <div class="fee-card"><span>${isNft ? 'NFT supply' : 'Status'}</span><strong>${isNft ? esc(fmtAmount(supplyRaw, 0, 0)) : esc(meta.status || 'deployed')}</strong></div>
        <div class="fee-card"><span>Mints (last 100)</span><strong>${isNft ? int(mints) : '—'}</strong></div>
        <div class="fee-card"><span>Transfers (last 100)</span><strong>${isNft ? int(transfers) : '—'}</strong></div>
        <div class="fee-card"><span>Burns (last 100)</span><strong>${isNft ? int(burns) : '—'}</strong></div>
        <div class="fee-card"><span>Deployed at tick</span><strong>${esc(meta.deployed_at_tick ?? '—')}</strong></div>
        <div class="fee-card"><span>Capabilities</span><strong>${int(caps.length)}</strong></div>
      </div>
      <p class="tool-note">Deployer <b>${esc(deployer)}</b> · traits: ${esc(traits.join(', ') || 'none')}</p>
      ${isNft && !cover ? '<p class="tool-note warn">No artwork resolved yet — this contract may not expose <code>token_uri</code> metadata.</p>' : ''}
      ${isFungible ? '' : isNft ? '' : '<p class="tool-note warn">This looks like a non-NFT contract. Use the Token tab for fungible tokens.</p>'}
      ${recent.length ? `<div class="tool-section">
        <div class="mini-title">Recent events</div>
        ${recent.map((event) => {
          const type = String(event.event_type || 'event').toLowerCase();
          const isMint = type.includes('transfer') && String(event.data || '').includes('"from":"0x0"');
          const label = isMint ? 'mint' : type;
          const cls = label.includes('mint') ? 'mint' : label.includes('burn') ? 'burn' : label.includes('transfer') ? 'transfer' : '';
          const when = timeAgo(event.timestamp);
          return `<div class="event-row">
            <span class="ev-badge ${cls}">${esc(label)}</span>
            <span class="ev-text">${esc(eventSummary(event))}</span>
            <span class="ev-time">${esc(when === 'now' ? 'just now' : `${when} ago`)}</span>
          </div>`;
        }).join('')}
      </div>` : ''}`;

    imageFallbacks(host);
  }

  /* ---------------- tools: token page ---------------- */
  async function openToken(id) {
    const host = $('#token-result');
    const clean = String(id || '').trim().toLowerCase();
    if (!isContractId(clean)) {
      host.innerHTML = '<div class="empty-state">Enter the full 64-hex token contract id.</div>';
      return;
    }

    host.innerHTML = '<div class="empty-state">Reading token, supply and pools…</div>';

    const [meta, statusRaw, nameRaw, pools] = await Promise.all([
      api(`/contract/${clean}`, 12000).catch(() => null),
      contractQuery(clean, 'status'),
      contractQuery(clean, 'name'),
      loadPools()
    ]);

    if (!meta?.rcp_metadata) {
      host.innerHTML = '<div class="empty-state">No RCP contract found for that id.</div>';
      return;
    }

    const info = traitsOf(meta);
    const rcp = meta.rcp_metadata;
    const isFungible = info.traits.includes('fungible');

    let supplyRaw = parseJson(statusRaw)?.total_supply ?? null;
    if (!supplyRaw) supplyRaw = await contractQuery(clean, 'total_supply');
    const nameOutput = parseJson(nameRaw);
    const name = typeof nameOutput === 'string' && nameOutput.trim() ? nameOutput.trim() : '';

    const pool = pools.map.get(clean) || null;
    const price = pool ? poolPrice(pool, info.decimals) : NaN;
    const rtmLiquidity = pool ? bigToNumber(pool.reserve_rtm, 18) : NaN;
    const tokenReserve = pool ? bigToNumber(pool.reserve_token, info.decimals) : NaN;

    host.innerHTML = `
      <div class="tool-head">
        <div class="tool-avatar"><span>${esc((info.symbol || 'TOK').slice(0, 4))}</span></div>
        <div>
          <div class="token-sym">${esc(info.symbol || short(clean, 8, 4))}</div>
          <div class="tool-title" style="font-size:14px;margin-top:4px">${esc(name || rcp.rcp_type || 'Token')}</div>
          <div class="tool-type">${esc(rcp.rcp_type || 'Token')} · ${isFungible ? 'fungible' : 'no fungible trait'} · ${info.decimals} decimals · ${esc(rcp.version || '—')}</div>
          <div class="tool-id">${esc(clean)}</div>
        </div>
        <span class="pill ${pool ? 'ok' : ''}" style="margin-left:auto">${pool ? `${pool.kind.toUpperCase()} pool` : 'no pool'}</span>
      </div>
      <div class="fee-grid tool-section">
        <div class="fee-card"><span>Total supply</span><strong>${esc(fmtAmount(supplyRaw, info.decimals, 2))} ${esc(info.symbol || '')}</strong></div>
        <div class="fee-card"><span>Price</span><strong>${Number.isFinite(price) ? `${amount(price, 6)} RTM` : '—'}</strong></div>
        <div class="fee-card"><span>Liquidity</span><strong>${Number.isFinite(rtmLiquidity) ? `${amount(rtmLiquidity, 2)} RTM` : '—'}</strong></div>
        <div class="fee-card"><span>Token reserve</span><strong>${Number.isFinite(tokenReserve) ? `${amount(tokenReserve, 2)} ${esc(info.symbol || '')}` : '—'}</strong></div>
        <div class="fee-card"><span>LP supply</span><strong>${pool?.lp_supply ? fmtAmount(pool.lp_supply, 18, 2) : '—'}</strong></div>
        <div class="fee-card"><span>Pool type</span><strong>${pool ? pool.kind.toUpperCase() : 'none'}</strong></div>
      </div>
      ${pool ? '' : '<p class="tool-note warn">No RTM pool on DexCore for this token, so price and liquidity cannot be derived on-chain.</p>'}
      ${isFungible ? '' : '<p class="tool-note warn">This contract has no <code>fungible</code> trait — it may still hold a supply, but it is not a standard token.</p>'}
      ${pool && Number.isFinite(rtmLiquidity) ? `<p class="tool-note">Pool value is ${amount(rtmLiquidity * 2, 2)} RTM counting both sides, at a spot price of ${amount(price, 6)} RTM per ${esc(info.symbol || 'token')}. Prices move with every swap.</p>` : ''}`;
  }


  function eventSummary(event) {
    const data = parseJson(event.data) || {};
    const tokenId = data.id ?? data.token_id;
    const from = typeof data.from === 'string' ? data.from : '';
    const to = typeof data.to === 'string' ? data.to : '';
    const parts = [];
    if (tokenId !== undefined && tokenId !== null && tokenId !== '') parts.push(`#${tokenId}`);
    if (to) parts.push(`${from && from !== '0x0' ? short(from, 8, 4) : 'mint'} → ${short(to, 8, 4)}`);
    else if (from) parts.push(short(from, 8, 4));
    if (!parts.length) return String(event.data || '').replace(/[{}"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    return parts.join(' · ');
  }

  /* ---------------- tools wiring ---------------- */
  const toolTabs = $('#tool-tabs');
  const panes = $$('.tool-pane');
  let poolsRequested = false;

  function selectTool(name) {
    if (!toolTabs) return;
    $$('button[data-tool]', toolTabs).forEach((btn) => {
      const active = btn.dataset.tool === name;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    panes.forEach((pane) => { pane.hidden = pane.dataset.pane !== name; });

    if (name === 'token' && !poolsRequested) {
      poolsRequested = true;
      $('#pool-list').innerHTML = '<div class="empty-state">Loading DexCore pools…</div>';
      loadPools()
        .then(renderPools)
        .catch(() => {
          $('#pool-count').textContent = '—';
          $('#pool-list').innerHTML = '<div class="empty-state">Could not reach DexCore right now.</div>';
        });
    }

    const input = name === 'wallet' ? $('#wallet-input') : name === 'contract' ? $('#contract-input') : $('#token-input');
    if (input) input.focus({ preventScroll: true });
  }

  if (toolTabs) {
    toolTabs.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-tool]');
      if (btn) selectTool(btn.dataset.tool);
    });

    $$('.tool-pane').forEach((pane) => {
      pane.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.target;
        if (!form.matches('form')) return;
        if (form.id === 'wallet-form') {
          const value = $('#wallet-input').value.trim();
          $('#wallet-hint').textContent = 'Reading the public NFT index for this wallet…';
          openWallet(value).finally(() => {
            $('#wallet-hint').textContent = 'Any Retium wallet. Collections, counts and artwork are read from the public NFT index.';
          });
        } else if (form.id === 'contract-form') {
          checkContract($('#contract-input').value);
        } else if (form.id === 'token-form') {
          openToken($('#token-input').value);
        }
      });
    });

    $('#tools').addEventListener('click', (event) => {
      const poolRow = event.target.closest('.pool-row[data-pool]');
      if (poolRow) {
        selectTool('token');
        $('#token-input').value = poolRow.dataset.pool;
        openToken(poolRow.dataset.pool);
        return;
      }
      const openTokenBtn = event.target.closest('[data-open-token]');
      if (openTokenBtn) {
        selectTool('token');
        $('#token-input').value = openTokenBtn.dataset.openToken;
        openToken(openTokenBtn.dataset.openToken);
      }
    });
  }

  $('#ranges').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-range]');
    if (!button) return;
    state.range = button.dataset.range;
    $$('#ranges button').forEach((el) => el.classList.toggle('is-active', el === button));
    const tz = -new Date().getTimezoneOffset();
    api(`/transactions/histogram?range=${state.range}&tz=${tz}`)
      .then((data) => { state.histogram = data; renderChart(); })
      .catch(() => {});
  });

  $('#scan-nft').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Scanning…';
    try {
      await discoverCollections();
    } catch {
      $('#collection-grid').innerHTML = '<div class="empty-state">Scan failed. Try again in a moment.</div>';
      $('#nft-count').textContent = '—';
    } finally {
      button.disabled = false;
      button.textContent = 'Scan chain';
    }
  });

  $('#load-holder').addEventListener('click', () => {
    const address = latestHolder();
    if (!address) {
      $('#gallery').innerHTML = '<div class="empty-state">No NFT holder found yet — scan the chain first.</div>';
      return;
    }
    loadGallery(address);
  });

  $('#refresh-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.classList.add('is-loading');
    try { await loadCore(); } finally { button.classList.remove('is-loading'); }
  });

  const header = $('#site-header');
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const menuBtn = $('#menu-btn');
  const nav = $('#nav');
  menuBtn.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      nav.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadTick();
      loadCore();
    }
  });

  $('#year').textContent = new Date().getFullYear();
  loadCore();
  discoverCollections().catch(() => {
    $('#collection-grid').innerHTML = '<div class="empty-state">Could not scan the chain right now. Press “Scan chain” to retry.</div>';
    $('#nft-count').textContent = '—';
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') loadTick();
  }, 3000);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadCore();
  }, 10000);
  setInterval(updateAge, 1000);
})();
