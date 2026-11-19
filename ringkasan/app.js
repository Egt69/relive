/* RELIVE — network snapshot (separate view, same live data) */
(() => {
  'use strict';

  const API = 'https://rpc.retium.org/api';
  const MONEY = 'https://api.retium.money/api/summary';
  const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
  const NFT_METHODS = new Set(['mint', 'batch_mint', 'batch_mint_base', 'drop_mint', 'drop_mint_pick', 'transfer', 'batch_transfer', 'burn', 'batch_burn', 'reveal', 'init_drop']);

  const TYPES = [
    { key: 'transfer', label: 'Transfers', color: '#c8f169' },
    { key: 'contract_call', label: 'Contract calls', color: '#54d6c6' },
    { key: 'stake', label: 'Stake', color: '#f5d66b' },
    { key: 'unstake', label: 'Unstake', color: '#f08fc0' },
    { key: 'contract_deploy', label: 'Deploys', color: '#ff7a1a' },
    { key: 'safehouse', label: 'Safehouse', color: '#6cb8ff' },
    { key: 'validator', label: 'Validators', color: '#a78bfa' },
    { key: 'api_key', label: 'API keys', color: '#9aa8b0' },
    { key: 'multisig', label: 'Multisig', color: '#7dd3fc' }
  ];

  const state = {
    stats: null, tick: null, safehouse: null, summary: null,
    histogram: null, transactions: [], range: '7d',
    collections: [], nftBusy: false, lastSync: 0, lastTick: null
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = (v) => (v === null || v === undefined || v === '' ? '—' : (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : String(v)));
  const pct = (a, b) => (b > 0 ? ((Number(a) / Number(b)) * 100).toFixed(1) : '0.0');
  const short = (v, h = 8, t = 5) => { const s = String(v || ''); return s.length > h + t + 3 ? `${s.slice(0, h)}…${s.slice(-t)}` : s; };
  const timeAgo = (ts) => {
    const s = Math.floor((Date.now() - Number(ts) * 1000) / 1000);
    if (!Number.isFinite(s)) return '—';
    if (s < 60) return `${Math.max(0, s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const atomic = (value, decimals = 18, digits = 2) => {
    const raw = String(value || '').trim();
    if (!/^\d+$/.test(raw)) return '—';
    const big = BigInt(raw), base = 10n ** BigInt(decimals);
    const whole = (big / base).toLocaleString('en-US');
    const frac = big % base;
    const part = frac > 0n ? `.${frac.toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '')}` : '';
    return whole + (part === '.' ? '' : part);
  };
  const amount = (value, digits = 2) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '0';
    if (n > 0 && n < 0.01) return '<0.01';
    return n.toLocaleString('en-US', { maximumFractionDigits: digits });
  };

  async function api(path, timeout = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(API + path, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  async function money() {
    const res = await fetch(MONEY, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function markSync() {
    state.lastSync = Date.now();
    $('#sync-time').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
    updateAge();
  }
  function updateAge() {
    const el = $('#sync-age');
    if (!el || !state.lastSync) return;
    const s = Math.floor((Date.now() - state.lastSync) / 1000);
    el.textContent = s < 2 ? '· just now' : `· ${s}s ago`;
  }

  /* ---------------- core ---------------- */
  async function loadCore() {
    const [stats, tick, safehouse, summary, histogram, tx] = await Promise.allSettled([
      api('/stats'), api('/tick/current'), api('/safehouse'), money(),
      api(`/transactions/histogram?range=${state.range}&tz=${-new Date().getTimezoneOffset()}`),
      api('/transactions?limit=24&offset=0')
    ]);
    if (stats.status === 'fulfilled') state.stats = stats.value;
    if (tick.status === 'fulfilled') state.tick = tick.value;
    if (safehouse.status === 'fulfilled') state.safehouse = safehouse.value;
    if (summary.status === 'fulfilled') state.summary = summary.value;
    if (histogram.status === 'fulfilled') state.histogram = histogram.value;
    if (tx.status === 'fulfilled') state.transactions = Array.isArray(tx.value?.transactions) ? tx.value.transactions : [];

    renderAll();
    markSync();
  }

  async function loadTick() {
    try {
      const data = await api('/tick/current', 8000);
      const previous = state.tick ? Number(state.tick.tick) : null;
      state.tick = data;
      renderPulse();
      if (previous !== null && Number(data.tick) > previous) {
        const el = $('#tick-value');
        el.style.color = 'var(--lime)';
        setTimeout(() => { el.style.color = ''; }, 700);
      }
      markSync();
    } catch { /* keep last value */ }
  }

  function renderAll() {
    renderPulse();
    renderStats();
    renderComposition();
    renderHistogram();
    renderValidators();
    renderWallets();
    renderEconomy();
    renderSignals();
  }

  function renderPulse() {
    const tick = state.tick;
    if (!tick) return;
    $('#tick-value').textContent = `#${int(tick.tick)}`;
    $('#tick-meta').textContent = `${int(tick.total_blocks)} blocks in mesh`;
  }

  function renderStats() {
    const stats = state.stats;
    if (!stats) return;
    const tx = stats.totals?.transactions || {};
    const total = Number(tx.total) || 0;
    $('#s-total').textContent = int(total);
    $('#s-total-note').textContent = `${int(stats.blocks_finalized)} blocks finalized`;
    $('#s-transfer').textContent = int(tx.transfer);
    $('#s-transfer-note').textContent = `${pct(tx.transfer, total)}% of all actions`;
    const calls = Number(tx.contract_call) || 0, deploys = Number(tx.contract_deploy) || 0;
    $('#s-contracts').textContent = int(calls + deploys);
    $('#s-contracts-note').textContent = `${int(calls)} calls · ${int(deploys)} deploys`;
    const wallets = stats.totals?.wallets ?? stats.wallets ?? null;
    $('#s-wallets').textContent = int(wallets);
    $('#s-wallets-note').textContent = `${int((stats.wallet_windows || []).find((w) => Number(w.hours) === 24)?.new_wallets)} new in 24h`;
    $('#s-blocks').textContent = int(stats.blocks_finalized);
    $('#s-blocks-note').textContent = `${int(state.tick?.open_blocks)} open blocks`;
  }

  function renderComposition() {
    const tx = state.stats?.totals?.transactions || {};
    const total = Number(tx.total) || 0;
    $('#composition-total').textContent = `${int(total)} actions`;
    const rows = TYPES.map((t) => ({ ...t, value: Number(tx[t.key]) || 0 }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    if (!rows.length) return;
    let acc = 0;
    const stops = rows.map((item) => {
      const share = total ? (item.value / total) * 100 : 0;
      const start = acc;
      acc += share;
      return `${item.color} ${start.toFixed(3)}% ${acc.toFixed(3)}%`;
    });
    $('#donut').style.background = `conic-gradient(${stops.join(',')})`;
    $('#donut-main').textContent = `${pct(rows[0].value, total)}%`;
    $('#legend').innerHTML = rows.map((item) => `<div class="legend-row">
      <i style="background:${item.color}"></i><span>${esc(item.label)}</span>
      <b>${int(item.value)}</b><small>${pct(item.value, total)}%</small>
    </div>`).join('');
  }

  function renderHistogram() {
    const data = state.histogram;
    if (!data || !Array.isArray(data.buckets)) return;
    const buckets = data.buckets;
    const max = Math.max(...buckets.map((b) => Number(b.count) || 0), 1);
    const labelEvery = Math.ceil(buckets.length / 7);
    $('#bars').innerHTML = buckets.map((b, i) => {
      const height = Math.max(3, ((Number(b.count) || 0) / max) * 100);
      const date = new Date(Number(b.start_ts) * 1000);
      const label = state.range === '1d'
        ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
        : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<div class="bar-col"><i style="height:${height}%"></i>${i % labelEvery === 0 ? `<span>${esc(label)}</span>` : '<span></span>'}</div>`;
    }).join('');
    $('#momentum-sub').textContent = state.range === '1d' ? 'Rolling 24 hours' : state.range === '7d' ? 'Rolling 7 days' : 'Rolling 30 days';
    $('#bar-total').textContent = `${int(data.total)} in range`;
    $('#bar-peak').textContent = `peak ${int(max)} / bucket`;
  }

  function renderValidators() {
    const nodes = state.stats?.nodes || {};
    const parts = [nodes.keepers, nodes.suits, nodes.workers];
    const online = parts.reduce((sum, n) => sum + (Number(n?.online) || 0), 0);
    const all = parts.reduce((sum, n) => sum + (Number(n?.total) || 0), 0);
    const share = all ? (online / all) * 100 : 0;
    $('#gauge').style.background = `conic-gradient(var(--lime) 0 ${share.toFixed(2)}%, var(--line) ${share.toFixed(2)}% 100%)`;
    $('#gauge-value').textContent = `${Math.round(share)}%`;
    const chip = $('#node-chip');
    chip.textContent = all ? `${online}/${all} online` : '—';
    chip.classList.toggle('ok', all > 0 && online === all);
    const cells = [
      ['Keepers', nodes.keepers], ['Suits', nodes.suits], ['Workers', nodes.workers], ['RPC nodes', nodes.rpc]
    ].map(([label, node]) => {
      const on = node?.online !== undefined ? (Number(node.online) || 0) : (node?.total !== undefined ? (Number(node.total) || 0) : 0);
      const total = Number(node?.total) || 0;
      return `<div class="node-cell"><span>${esc(label)}</span><b>${int(on)}${total ? `<small style="font-size:11px;color:var(--muted-2)"> / ${int(total)}</small>` : ''}</b>
        <div class="node-track"><i style="width:${total ? (on / total) * 100 : 100}%"></i></div></div>`;
    });
    $('#nodes').innerHTML = cells.join('');
  }

  function renderWallets() {
    const windows = state.stats?.wallet_windows || [];
    const max = Math.max(...windows.map((w) => Number(w.active_wallets) || 0), 1);
    $('#wallet-chip').textContent = `${int(windows.length)} windows`;
    $('#windows').innerHTML = windows.map((w) => {
      const hours = Number(w.hours);
      const label = hours === 24 ? '24h' : hours === 168 ? '7d' : hours === 720 ? '30d' : `${hours}h`;
      return `<div class="window-row"><span>${label}</span>
        <div class="window-track"><i style="width:${((Number(w.active_wallets) || 0) / max) * 100}%"></i></div>
        <span class="window-meta"><b>${int(w.active_wallets)}</b> active · ${int(w.new_wallets)} new</span></div>`;
    }).join('');
    const tx = state.stats?.totals?.transactions || {};
    const stake = Number(tx.stake) || 0, unstake = Number(tx.unstake) || 0;
    const sum = stake + unstake;
    $('#stake-count').textContent = int(stake);
    $('#unstake-count').textContent = int(unstake);
    $('#stake-bar').style.width = `${sum ? (stake / sum) * 100 : 50}%`;
    $('#stake-note').textContent = `${pct(sum, tx.total)} of ledger is staking activity · net ${stake >= unstake ? '+' : ''}${int(stake - unstake)}`;
  }

  function renderEconomy() {
    const summary = state.summary, safe = state.safehouse, fees = state.stats?.totals?.fees || {};
    $('#rtd-supply').textContent = summary ? `${atomic(summary.supply_atomic)} RTD` : '—';
    $('#customers').textContent = summary ? int(summary.customers) : '—';
    $('#backing').textContent = safe ? `${amount(safe.backing * 100, 2)}%` : '—';
    $('#gas-collected').textContent = `${amount(fees.collected_rtm, 0)} RTM`;
    const chip = $('#backing-chip');
    chip.textContent = summary?.backed ? 'BACKED' : 'CHECK BACKING';
    chip.classList.toggle('ok', Boolean(summary?.backed));
    $('#gas-burned').textContent = `${amount(fees.burned_rtm, 2)} RTM burned`;
    const parts = [
      ['Workers', Number(fees.workers_rtm) || 0, 'var(--teal)'],
      ['Foundation', Number(fees.foundation_rtm) || 0, 'var(--lime)'],
      ['Keepers', Number(fees.keepers_rtm) || 0, 'var(--blue)'],
      ['Suits', Number(fees.suits_rtm) || 0, 'var(--violet)'],
      ['Treasury', Number(fees.treasury_rtm) || 0, 'var(--orange)'],
      ['Burned', Number(fees.burned_rtm) || 0, 'var(--pink)']
    ];
    const total = parts.reduce((s, p) => s + p[1], 0) || 1;
    $('#gas-stack').innerHTML = parts.map(([, value, color]) => `<i style="width:${(value / total) * 100}%;background:${color}"></i>`).join('');
    $('#gas-legend').innerHTML = parts.map(([label, value, color]) => `<span><i style="background:${color}"></i>${esc(label)} ${pct(value, total)}%</span>`).join('');
  }

  function actionLabel(raw) {
    const key = String(raw || '').toLowerCase();
    if (key === 'call') return 'Contract call';
    if (key === 'transfer') return 'Transfer';
    if (key.startsWith('safehouse')) return `Safehouse ${key.replace('safehouse_', '')}`.trim();
    if (key === 'deploy') return 'Contract deploy';
    return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Action';
  }

  function renderSignals() {
    const list = state.transactions.slice(0, 7);
    $('#signal-count').textContent = `${int(list.length)} shown`;
    $('#signals').innerHTML = list.map((tx) => `<div class="signal-row">
      <i></i>
      <span><b>${esc(actionLabel(tx.action))}</b><small>${esc(short(tx.sender, 10, 6))} → ${esc(short(tx.recipient, 10, 6))}</small></span>
      <span>${amount(tx.amount_rtm, 2)} RTM<br /><b>${esc(timeAgo(tx.timestamp))}</b></span>
    </div>`).join('');
  }

  /* ---------------- NFT layer ---------------- */
  const metaCache = new Map();

  function ipfsPath(uri) {
    const v = String(uri || '').trim();
    if (v.startsWith('ipfs://ipfs/')) return v.slice(11);
    if (v.startsWith('ipfs://')) return v.slice(7);
    if (v.startsWith('/ipfs/')) return v.slice(6);
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+)$/i.test(v)) return v;
    return null;
  }
  function candidates(uri) {
    const path = ipfsPath(uri);
    if (path) return [...GATEWAYS.map((g) => g + path), `https://images.weserv.nl/?url=${encodeURIComponent(`ipfs.filebase.io/ipfs/${path}`)}&w=480&h=480&fit=cover&output=webp&q=80`];
    return /^https?:\/\//.test(String(uri)) ? [String(uri)] : [];
  }
  function imageFallbacks(root) {
    $$('img', root).forEach((img) => {
      if (img.dataset.fallback) return;
      const original = img.src;
      img.dataset.fallback = '1';
      img.onerror = () => {
        if (img.dataset.retried) return;
        img.dataset.retried = '1';
        img.src = original.includes('ipfs.filebase.io')
          ? original.replace('ipfs.filebase.io', 'gateway.pinata.cloud')
          : original.replace('gateway.pinata.cloud', 'ipfs.filebase.io');
      };
    });
  }

  async function jsonUri(uri) {
    const path = ipfsPath(uri);
    const value = String(uri || '').trim();
    const urls = path ? GATEWAYS.map((g) => g + path) : (/^https?:\/\//.test(value) ? [value] : []);
    for (const url of urls) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 9000);
        try {
          const res = await fetch(url, { signal: ctrl.signal, cache: 'force-cache' });
          if (res.ok) return await res.json();
        } finally { clearTimeout(timer); }
      } catch { /* next */ }
    }
    return null;
  }
  async function tokenMeta(contract, token) {
    const key = `${contract}:${token}`;
    if (metaCache.has(key)) return metaCache.get(key);
    const promise = (async () => {
      try {
        const query = await api(`/contract/${contract}/query?method=token_uri&args=${encodeURIComponent(token)}`, 10000);
        let uri = query?.output;
        if (typeof uri === 'string') { try { const parsed = JSON.parse(uri); uri = typeof parsed === 'string' ? parsed : parsed; } catch { /* plain */ } }
        const meta = (uri && typeof uri === 'object') ? uri : (typeof uri === 'string' && uri.trim() ? await jsonUri(uri) : null);
        if (!meta) return null;
        const image = meta.image || meta.image_url || '';
        return { name: String(meta.name || ''), image: candidates(image)[0] || '' };
      } catch { return null; }
    })();
    metaCache.set(key, promise);
    return promise;
  }

  async function discover() {
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
    const ids = Array.from(found).slice(0, 10);
    const valid = [];
    for (let i = 0; i < ids.length; i += 4) {
      const batch = ids.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map((id) => api(`/contract/${id}`)));
      results.forEach((res, idx) => {
        const type = String(res.value?.rcp_metadata?.rcp_type || '').toUpperCase();
        if (res.status === 'fulfilled' && type.includes('NFT')) valid.push(batch[idx]);
      });
    }
    state.collections = valid.slice(0, 8);
    await loadCollections();
  }

  async function loadCollections() {
    if (state.nftBusy) return;
    state.nftBusy = true;
    try {
      const items = await Promise.all(state.collections.map(async (id) => {
        const [meta, supplyRes, eventsRes] = await Promise.allSettled([
          api(`/contract/${id}`),
          api(`/contract/${id}/query?method=total_supply&args=`),
          api(`/contract/${id}/events`)
        ]);
        const events = eventsRes.value?.events || [];
        const supply = Number(supplyRes.value?.output) || 0;
        const mint = events.find((e) => e.event_type === 'Transfer' && String(e.data || '').includes('"from":"0x0"'));
        let token = null;
        try { token = mint ? JSON.parse(mint.data).id : null; } catch { /* none */ }
        const metaInfo = token ? await tokenMeta(id, token) : null;
        return {
          id,
          name: `Collection ${short(id, 6, 4)}`,
          supply,
          events,
          cover: metaInfo?.image || '',
          token
        };
      }));
      state.collections = items;
      renderCollections();
      const total = items.reduce((s, item) => s + item.supply, 0);
      $('#s-nft').textContent = int(total);
      $('#s-nft-note').textContent = `across ${items.length} discovered contracts`;
      $('#nft-count').textContent = `${items.length} discovered`;
    } finally { state.nftBusy = false; }
  }

  function renderCollections() {
    const host = $('#collection-grid');
    if (!state.collections.length) {
      host.innerHTML = '<p class="hint" style="grid-column:1/-1">No NFT contracts found in recent activity. Press “Scan chain” to try again.</p>';
      return;
    }
    host.innerHTML = state.collections.map((item) => {
      const count = (type) => item.events.filter((e) => String(e.event_type || '').toLowerCase().includes(type)).length;
      const cover = item.cover
        ? `<img src="${esc(item.cover)}" alt="" loading="lazy" />`
        : '<span class="placeholder">NFT</span>';
      return `<article class="collection">${cover}
        <div><h3>${esc(item.name)}</h3><span class="cid">${esc(item.id)}</span>
          <div class="counts"><span>SUPPLY <b>${int(item.supply)}</b></span><span>MINTS <b>${int(count('mint')) + count('drop')}</b></span><span>TRANSFERS <b>${int(count('transfer'))}</b></span></div>
        </div></article>`;
    }).join('');
    imageFallbacks(host);
  }

  function latestHolder() {
    for (const item of state.collections) {
      const events = [...(item.events || [])].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
      for (const event of events) {
        let data = {};
        try { data = JSON.parse(event.data || '{}'); } catch { /* skip */ }
        if (typeof data.to === 'string' && /^rete[a-z0-9]+$/i.test(data.to)) return data.to;
      }
    }
    return null;
  }

  async function loadGallery(address) {
    const host = $('#gallery');
    host.innerHTML = '<p class="hint">Loading artwork…</p>';
    try {
      const data = await api(`/wallet/${encodeURIComponent(address)}/nfts?limit=12&offset=0`);
      const nfts = Array.isArray(data?.nfts) ? data.nfts : [];
      if (!nfts.length) { host.innerHTML = '<p class="hint">This wallet holds no NFTs right now.</p>'; return; }
      const items = await Promise.all(nfts.slice(0, 12).map(async (nft) => {
        const meta = await tokenMeta(String(nft.contract_id).toLowerCase(), nft.token_id);
        return { id: nft.token_id, contract: nft.contract_id, ...meta };
      }));
      host.innerHTML = items.map((item) => `<article class="art">
        ${item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy" />` : `<div class="fallback">#${esc(item.id)}</div>`}
        <div><b>${esc(item.name || `NFT #${item.id}`)}</b><small>${esc(short(item.contract, 8, 5))}</small></div>
      </article>`).join('');
      imageFallbacks(host);
    } catch (err) {
      host.innerHTML = `<p class="hint">Could not load this wallet: ${esc(err.message)}</p>`;
    }
  }

  /* ---------------- wiring ---------------- */
  $('#ranges').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-range]');
    if (!button) return;
    state.range = button.dataset.range;
    $$('#ranges button').forEach((el) => el.classList.toggle('on', el === button));
    api(`/transactions/histogram?range=${state.range}&tz=${-new Date().getTimezoneOffset()}`)
      .then((data) => { state.histogram = data; renderHistogram(); })
      .catch(() => {});
  });

  $('#scan-nft').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Scanning…';
    try { await discover(); } finally { button.disabled = false; button.textContent = 'Scan chain'; }
  });

  $('#load-holder').addEventListener('click', () => {
    const address = latestHolder();
    if (!address) { $('#gallery').innerHTML = '<p class="hint">No NFT holder found yet. Scan the chain first.</p>'; return; }
    loadGallery(address);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { loadTick(); loadCore(); }
  });

  loadCore();
  discover();
  setInterval(() => { if (document.visibilityState === 'visible') loadTick(); }, 3000);
  setInterval(() => { if (document.visibilityState === 'visible') loadCore(); }, 10000);
  setInterval(updateAge, 1000);
})();
