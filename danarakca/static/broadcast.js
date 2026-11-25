// Danarakca Public Broadcast & Presentation Screen Logic
// Hyperstudio Dark Editorial Edition

const LIVE_CHANNEL = 'danarakca_live_fafc19b30c66';
let broadcastEventSource = null;
let sseActive = false;
let sseErrors = 0;
let gameState = null;
let currentTab = 'top10';
let chartTopPlayers = null;
let chartAssetIndexes = null;
let broadcastPollTimeout = null;
let lastRenderedCardId = null;
let lastRecentCardsHash = '';
let lastLeaderboardHash = '';
let lastChartsHash = '';
let cachedQrUrl = null;
let cachedQrHtml = null;
let lastQrTrigger = null;

const ASSET_META = [
  ['sukuk', 'Sukuk'],
  ['saham', 'Saham'],
  ['rdpu', 'Rdpu'],
  ['emas', 'Emas'],
  ['campuran', 'Campuran']
];

function setElementText(id, val) {
  const el = document.getElementById(id);
  if (el && el.innerText !== val) {
    el.innerText = val;
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setBroadcastError(msg) {
  const banner = document.getElementById('broadcastSyncError');
  const text = document.getElementById('broadcastSyncErrorText');
  if (!banner) return;
  if (msg) {
    if (text) text.innerText = msg;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// Currency & Percentage Formatters
function formatRupiah(num) {
  if (num === null || num === undefined) return 'Rp 0';
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

function formatJuta(num) {
  if (num === null || num === undefined) return 'Rp 0';
  const jt = num / 1000000;
  return 'Rp ' + jt.toFixed(1).replace('.', ',') + ' Jt';
}

function formatPercent(num, withSign = true) {
  if (num === null || num === undefined) return '0%';
  const pct = (num * 100).toFixed(1).replace('.', ',');
  if (withSign && num > 0) return '+' + pct + '%';
  return pct + '%';
}

// Chart.js Initialization
function initCharts() {
  if (typeof Chart !== 'function') {
    const topEmpty = document.getElementById('chartTopEmpty');
    if (topEmpty) {
      topEmpty.classList.remove('hidden');
      topEmpty.innerText = 'Grafik tidak tersedia (pustaka grafik gagal dimuat).';
    }
    const assetEmpty = document.getElementById('chartAssetEmpty');
    if (assetEmpty) assetEmpty.classList.remove('hidden');
    return;
  }

  const chartOptionsBase = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        position: 'top',
        labels: {
          color: '#c1c1c1',
          font: { family: 'Inter', size: 12 },
          boxWidth: 14,
          boxHeight: 14
        }
      },
      tooltip: {
        backgroundColor: '#101010',
        borderColor: '#212121',
        borderWidth: 1,
        titleColor: '#f3f3f3',
        bodyColor: '#c1c1c1',
        titleFont: { family: 'Inter', size: 12 },
        bodyFont: { family: 'JetBrains Mono', size: 12 }
      }
    },
    scales: {
      x: {
        grid: { color: '#212121' },
        ticks: { color: '#9c9c9c', font: { family: 'JetBrains Mono', size: 11 } }
      },
      y: {
        grid: { color: '#212121' },
        ticks: { color: '#9c9c9c', font: { family: 'JetBrains Mono', size: 11 } }
      }
    }
  };

  const canvasTop = document.getElementById('chartTopPlayers');
  if (canvasTop) {
    const ctxTop = canvasTop.getContext('2d');
    chartTopPlayers = new Chart(ctxTop, {
      type: 'line',
      data: {
        labels: ['Awal'],
        datasets: []
      },
      options: {
        ...chartOptionsBase,
        scales: {
          ...chartOptionsBase.scales,
          y: {
            ...chartOptionsBase.scales.y,
            ticks: {
              ...chartOptionsBase.scales.y.ticks,
              callback: (val) => (val / 1000000).toFixed(0) + ' Jt'
            }
          }
        }
      }
    });
  }

  const canvasAssets = document.getElementById('chartAssetIndexes');
  if (canvasAssets) {
    const ctxAssets = canvasAssets.getContext('2d');
    chartAssetIndexes = new Chart(ctxAssets, {
      type: 'line',
      data: {
        labels: ['Awal'],
        datasets: [
          { label: 'Sukuk/SBN', data: [100], borderColor: '#8fb3d9', backgroundColor: '#8fb3d9', tension: 0.2, borderWidth: 2.5, pointRadius: 3 },
          { label: 'Saham', data: [100], borderColor: '#d98f8f', backgroundColor: '#d98f8f', tension: 0.2, borderWidth: 2.5, pointRadius: 3 },
          { label: 'Pasar Uang', data: [100], borderColor: '#8fd9a8', backgroundColor: '#8fd9a8', tension: 0.2, borderWidth: 2.5, pointRadius: 3 },
          { label: 'Emas', data: [100], borderColor: '#d9c38f', backgroundColor: '#d9c38f', tension: 0.2, borderWidth: 2.5, pointRadius: 3 },
          { label: 'Campuran', data: [100], borderColor: '#b38fd9', backgroundColor: '#b38fd9', tension: 0.2, borderWidth: 2.5, pointRadius: 3 }
        ]
      },
      options: chartOptionsBase
    });
  }
}

// Realtime Stream via SSE with Error Handling & Auto Fallback
let localBus = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    localBus = new BroadcastChannel('danarakca_live_bus');
    localBus.onmessage = (e) => {
      if (e.data && e.data.state) {
        applyIncomingState(e.data.state, Boolean(e.data.force));
      } else if (e.data && e.data.event) {
        handleBroadcastLiveEvent(e.data, Date.now() / 1000);
      }
    };
  }
} catch (e) {}

const BROADCAST_RETRY_EVENTS = new Set(['CARD_DRAWN', 'STAGE_ADVANCED', 'GAME_RESET']);

// Treat external SSE events strictly as wake-up triggers to fetch authoritative server state
function handleBroadcastLiveEvent(msg, sentAtSec) {
  if (!msg || !msg.event) return;
  if (sentAtSec && (Date.now() / 1000 - sentAtSec) > 60) return;

  if (msg.event === 'GAME_RESET') {
    lastRenderedCardId = null;
    lastRecentCardsHash = '';
    lastLeaderboardHash = '';
    lastChartsHash = '';
  }
  const minRound = Number(msg.current_round || msg.round) || 0;
  const minVersion = Number(msg.state_version) || 0;
  fetchState({
    urgent: true,
    minRound,
    minVersion,
    bust: !minRound && !minVersion,
    forceApply: msg.event === 'GAME_RESET',
    retryOnBehind: BROADCAST_RETRY_EVENTS.has(msg.event),
    retryCount: 0,
  });
}

let lastBroadcastSseAttemptAt = 0;

function initRealtimeStream() {
  const channel = (gameState && gameState.live_channel) || LIVE_CHANNEL;
  if (broadcastEventSource && broadcastEventSource.readyState !== EventSource.CLOSED) return;
  if (broadcastEventSource) {
    try { broadcastEventSource.close(); } catch (e) {}
  }
  sseActive = false;
  sseErrors = 0;
  lastBroadcastSseAttemptAt = Date.now();

  try {
    broadcastEventSource = new EventSource(`https://ntfy.sh/${channel}/sse?since=now`);
    broadcastEventSource.onopen = () => {
      sseActive = true;
      sseErrors = 0;
      setElementText('syncStatusText', 'Tersinkronisasi');
    };
    broadcastEventSource.onmessage = (e) => {
      try {
        const raw = JSON.parse(e.data);
        if (raw.event !== 'message' || !raw.message) return;
        const msg = typeof raw.message === 'string' ? JSON.parse(raw.message) : raw.message;
        handleBroadcastLiveEvent(msg, raw.time);
      } catch (err) {
        fetchState({ urgent: true, bust: true });
      }
    };
    broadcastEventSource.onerror = () => {
      sseErrors++;
      sseActive = false;
      if (broadcastEventSource && (broadcastEventSource.readyState === EventSource.CLOSED || sseErrors >= 2)) {
        try { broadcastEventSource.close(); } catch (e) {}
        broadcastEventSource = null;
      }
      setElementText('syncStatusText', 'Polling Aktif');
    };
  } catch (err) {
    sseActive = false;
    broadcastEventSource = null;
  }
}

// State Synchronization
function applyIncomingState(newState, force = false) {
  if (!newState) return;
  if (gameState) {
    const curSess = gameState.session_id || 0;
    const newSess = newState.session_id || 0;
    const curVer = gameState.state_version || 0;
    const newVer = newState.state_version || 0;

    if (newSess < curSess) return;

    if (!force && newSess === curSess) {
      const curRound = gameState.current_round || 0;
      const newRound = newState.current_round || 0;
      const curTotalP = gameState.total_participants || 0;
      const newTotalP = newState.total_participants || 0;
      const curEpoch = gameState.roster_epoch || 0;
      const newEpoch = newState.roster_epoch || 0;

      if (newEpoch < curEpoch) return;
      if (newEpoch === curEpoch && newRound < curRound) return;
      if (newEpoch === curEpoch && newRound === curRound && newTotalP < curTotalP) return;

      if ((!newState.leaderboard_top10 || newState.leaderboard_top10.length === 0) && (gameState.leaderboard_top10 && gameState.leaderboard_top10.length > 0)) {
        newState.leaderboard_top10 = gameState.leaderboard_top10;
      }
      if ((!newState.investor_tangguh_top5 || newState.investor_tangguh_top5.length === 0) && (gameState.investor_tangguh_top5 && gameState.investor_tangguh_top5.length > 0)) {
        newState.investor_tangguh_top5 = gameState.investor_tangguh_top5;
      }
      if (newEpoch === curEpoch && newVer < curVer && newRound <= curRound && newTotalP <= curTotalP) return;
    }
  }

  gameState = newState;
  setBroadcastError(null);
  setElementText('syncStatusText', sseActive ? 'Tersinkronisasi' : 'Polling Aktif');
  renderBroadcast();
}

let fetchInFlight = false;
let broadcastFetchSeq = 0;
let latestBroadcastSeq = 0;
let broadcastRetryTimeout = null;

async function fetchState(arg = false) {
  const opts = typeof arg === 'object' && arg !== null
    ? arg
    : { urgent: Boolean(arg), bust: Boolean(arg) };
  if (fetchInFlight && !opts.urgent) return;
  if (broadcastRetryTimeout && opts.urgent) {
    clearTimeout(broadcastRetryTimeout);
    broadcastRetryTimeout = null;
  }

  const retryBtn = opts.retryBtn || null;
  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.dataset.prevText = retryBtn.innerText;
    retryBtn.innerText = 'Mencoba...';
  }
  const mySeq = ++broadcastFetchSeq;
  fetchInFlight = true;
  try {
    const qs = new URLSearchParams();
    if (opts.bust) qs.set('bust', '1');
    if (opts.minRound) qs.set('min_round', String(opts.minRound));
    if (opts.minVersion) qs.set('min_version', String(opts.minVersion));
    const query = qs.toString();
    const url = query ? `/api/state?${query}` : '/api/state';
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json();
    if (mySeq < latestBroadcastSeq) return;
    latestBroadcastSeq = mySeq;

    if (!res.ok || !json.success || !json.data) {
      setBroadcastError(json.error || 'Gagal memuat data simulasi dari server.');
      return;
    }

    applyIncomingState(json.data, Boolean(opts.forceApply));
    if (opts.urgent) scheduleBroadcastPoll();

    const retryCount = Number(opts.retryCount) || 0;
    const stillBehind = (opts.minRound > 0 && (json.data.current_round || 0) < opts.minRound)
      || (opts.minVersion > 0 && (json.data.state_version || 0) < opts.minVersion);
    if (opts.retryOnBehind && stillBehind && retryCount < 2) {
      broadcastRetryTimeout = setTimeout(() => {
        fetchState({ ...opts, retryBtn: null, urgent: true, bust: true, retryCount: retryCount + 1 });
      }, retryCount === 0 ? 300 : 600);
    }
  } catch (err) {
    if (mySeq < latestBroadcastSeq) return;
    setElementText('syncStatusText', 'Menghubungkan...');
    setBroadcastError('Koneksi ke server simulasi terputus. Mencoba menyambung kembali...');
  } finally {
    if (retryBtn) {
      retryBtn.disabled = false;
      retryBtn.innerText = retryBtn.dataset.prevText || 'Coba Lagi';
    }
    if (mySeq >= broadcastFetchSeq) {
      fetchInFlight = false;
    }
  }
}

function scheduleBroadcastPoll() {
  if (broadcastPollTimeout) clearTimeout(broadcastPollTimeout);
  const baseInterval = sseActive ? 3000 : 1000;
  const jitter = Math.floor(Math.random() * 350);

  broadcastPollTimeout = setTimeout(async () => {
    if (!document.hidden) {
      if ((!broadcastEventSource || broadcastEventSource.readyState === EventSource.CLOSED) && (Date.now() - lastBroadcastSseAttemptAt) > 15000) {
        initRealtimeStream();
      }
      await fetchState();
    }
    scheduleBroadcastPoll();
  }, baseInterval + jitter);
}

// Render Functions
function renderBroadcast() {
  if (!gameState) return;

  const round = gameState.current_round || 0;
  const totalRounds = gameState.total_rounds || 30;

  setElementText('badgeRound', `${round} / ${totalRounds}`);
  setElementText('badgeRoundMobile', `${round}/${totalRounds}`);

  if (round === 0) {
    setElementText('badgeSimTime', 'Tahun 1 · Awal');
  } else {
    const year = Math.ceil(round / 4);
    const qtr = ((round - 1) % 4) + 1;
    setElementText('badgeSimTime', `Tahun ${year} · Q${qtr}`);
  }

  const stageStr = `${gameState.current_stage || 1} / ${gameState.total_stages || 3}`;
  setElementText('badgeStage', stageStr);
  setElementText('badgeStageMobile', stageStr);
  const partStr = `${gameState.total_participants || 0}`;
  setElementText('badgeParticipants', partStr);
  setElementText('badgeParticipantsMobile', partStr);

  const top1 = (gameState.leaderboard_top10 || [])[0];
  const peakStr = top1 ? formatJuta(top1.current_value) : 'Rp 100,0 Jt';
  setElementText('badgeHighestWealth', peakStr);
  setElementText('badgeHighestWealthMobile', peakStr);

  // Active Scenario Card
  const lastCard = gameState.last_drawn_card;
  const placeholder = document.getElementById('cardPlaceholder');
  const cardContent = document.getElementById('cardContent');
  setElementText('cardPlaceholderTitle', 'Sesi Simulasi Siap Dimulai');
  setElementText('cardPlaceholderDesc', 'Pendaftaran peserta dibuka. Skenario pasar kuartal pertama akan ditampilkan saat putaran dimulai.');

  if (lastCard && lastCard.card) {
    if (placeholder) placeholder.classList.add('hidden');
    if (cardContent) {
      cardContent.classList.remove('hidden');
      cardContent.classList.add('flex');
    }

    const c = lastCard.card;
    const cardId = `${lastCard.round}-${c.id}`;

    if (cardContent && cardId !== lastRenderedCardId) {
      lastRenderedCardId = cardId;
      cardContent.classList.remove('card-zoom');
      void cardContent.offsetWidth;
      cardContent.classList.add('card-zoom');
    }

    setElementText('cardRoundTag', `PUTARAN ${lastCard.round} · ${c.id}`);
    setElementText('cardCategoryTag', c.category);
    setElementText('cardTitle', c.title);
    setElementText('cardNarration', c.narration);
    setElementText('cardExplanation', c.explanation);

    const inputStatusText = document.getElementById('inputStatusText');
    const inputStatusDot = document.getElementById('inputStatusDot');
    const badgeInputStatus = document.getElementById('badgeInputStatus');

    if (inputStatusText && inputStatusDot && badgeInputStatus) {
      const isOpen = Boolean(gameState.stage_input_open);
      const targetText = isOpen ? 'Alokasi Terbuka' : 'Alokasi Ditutup';
      if (inputStatusText.innerText !== targetText) {
        inputStatusText.innerText = targetText;
        inputStatusDot.className = `w-1.5 h-1.5 rounded-full ${isOpen ? 'bg-pulse' : 'bg-smoke'}`;
        badgeInputStatus.className = isOpen
          ? 'inline-flex items-center gap-1.5 px-3 py-1 rounded-tag font-mono text-xs bg-pulse/10 border border-pulse/30 text-pulse'
          : 'inline-flex items-center gap-1.5 px-3 py-1 rounded-tag font-mono text-xs bg-obsidian hairline text-smoke';
      }
    }

    const ret = lastCard.returns || {};
    const assets = (gameState.config && gameState.config.assets) || [];
    for (const [id, domKey] of ASSET_META) {
      const baseRet = assets.find(a => a.id === id)?.base_return || 0;
      setImpactUI(domKey, ret[id], baseRet, c[`return_${id}`]);
    }
  } else {
    if (placeholder) placeholder.classList.remove('hidden');
    if (cardContent) {
      cardContent.classList.add('hidden');
      cardContent.classList.remove('flex');
    }
  }

  renderRecentCards();
  renderLeaderboard();
  updateCharts();
}

function setImpactUI(assetKey, totalReturn, baseReturn, cardEffect) {
  const el = document.getElementById(`impact${assetKey}`);
  const sub = document.getElementById(`impact${assetKey}Sub`);
  if (!el || !sub) return;

  el.innerText = formatPercent(totalReturn);
  const colorClass = totalReturn > 0 ? 'text-pulse' : (totalReturn < 0 ? 'text-loss' : 'text-ash');
  el.className = `text-heading-xs tabular font-mono ${colorClass}`;
  sub.innerText = `Dasar ${formatPercent(baseReturn)} · Efek ${formatPercent(cardEffect)}`;
}

function renderRecentCards() {
  const container = document.getElementById('recentCardsList');
  if (!container) return;

  const recent = (gameState.recent_cards || []).slice(0, 3);
  const hash = recent.map(c => `${c.round}-${c.card_id}`).join('|');
  if (hash === lastRecentCardsHash) return;
  lastRecentCardsHash = hash;

  if (recent.length === 0) {
    container.innerHTML = '<div class="text-caption text-smoke italic py-1 col-span-full">Belum ada riwayat kartu sebelumnya.</div>';
    return;
  }

  container.innerHTML = recent.map(c => `
    <div class="flex items-center justify-between p-2.5 rounded-card bg-obsidian hairline text-caption">
      <div class="flex items-center gap-2 overflow-hidden">
        <span class="font-mono text-ash text-[10px] border border-graphite px-1.5 py-0.5 rounded-tag shrink-0">
          Q${Number(c.round) || 0}
        </span>
        <span class="text-chalk truncate text-xs">${escapeHtml(c.card?.title)}</span>
      </div>
      <span class="meta text-[10px] text-smoke shrink-0 ml-1">${escapeHtml(c.card?.category)}</span>
    </div>
  `).join('');
}

function handleTabKeydown(e, current) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const target = (e.key === 'Home' || (e.key !== 'End' && current !== 'top10')) ? 'top10' : 'tangguh';
  switchLbTab(target);
  const btn = document.getElementById(target === 'top10' ? 'btnTabTop10' : 'btnTabTangguh');
  if (btn) btn.focus();
}

function switchLbTab(tab) {
  if (currentTab === tab) return;
  currentTab = tab;
  lastLeaderboardHash = '';
  const isTop10 = tab === 'top10';
  const btn10 = document.getElementById('btnTabTop10');
  const btnT = document.getElementById('btnTabTangguh');
  const title = document.getElementById('lbTabTitle');
  const sub = document.getElementById('lbTabSub');
  const activeCls = 'min-h-[44px] px-3 py-1 rounded-card bg-chalk text-obsidian transition-colors cursor-pointer focus-visible:relative focus-visible:z-10';
  const idleCls = 'min-h-[44px] px-3 py-1 rounded-card text-smoke hover:text-chalk transition-colors cursor-pointer focus-visible:relative focus-visible:z-10';

  if (btn10) {
    btn10.className = isTop10 ? activeCls : idleCls;
    btn10.setAttribute('aria-selected', isTop10 ? 'true' : 'false');
  }
  if (btnT) {
    btnT.className = isTop10 ? idleCls : activeCls;
    btnT.setAttribute('aria-selected', isTop10 ? 'false' : 'true');
  }
  if (title) title.innerText = isTop10 ? 'Papan Peringkat' : 'Investor Tangguh';
  if (sub) sub.innerText = isTop10 ? '10 Portofolio Terbesar' : 'Disiplin Risiko Terbaik';
  renderLeaderboard();
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboardTbody');
  if (!tbody || !gameState) return;

  let list = currentTab === 'top10' ? (gameState.leaderboard_top10 || []) : (gameState.investor_tangguh_top5 || []);

  if (currentTab === 'tangguh' && list.length === 0 && (gameState.leaderboard_top10 || []).length > 0) {
    list = gameState.leaderboard_top10;
  }

  const hash = `${currentTab}:${gameState.session_id}:${gameState.current_round}:${list.map(p => `${p.code}-${p.current_value}-${p.current_rank}-${p.prev_rank}-${p.max_drawdown}`).join('|')}`;
  if (hash === lastLeaderboardHash) return;
  lastLeaderboardHash = hash;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-12 text-smoke italic font-sans">
          Menunggu peserta mendaftar...
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list.map((p, idx) => {
    if (!p) return '';
    const rankNum = idx + 1;

    const prevRank = p.prev_rank != null ? p.prev_rank : rankNum;
    const currRank = p.current_rank != null ? p.current_rank : rankNum;
    const delta = prevRank - currRank;
    let deltaHtml = '<span class="text-smoke" aria-label="Tidak berubah">–</span>';
    if (delta > 0) {
      deltaHtml = `<span class="text-pulse font-mono">↑${delta}</span>`;
    } else if (delta < 0) {
      deltaHtml = `<span class="text-loss font-mono">↓${Math.abs(delta)}</span>`;
    }

    const initial = (gameState.config && gameState.config.initial_capital) || 100000000;
    const currentVal = p.current_value != null ? p.current_value : initial;
    const returnPct = ((currentVal / initial - 1) * 100).toFixed(1).replace('.', ',');
    const returnSign = (currentVal >= initial ? '+' : '') + returnPct + '%';
    const returnColor = currentVal >= initial ? 'text-pulse' : 'text-loss';
    const mdd = p.max_drawdown != null ? p.max_drawdown : 0.0;
    const mddPct = (mdd * 100).toFixed(1).replace('.', ',') + '%';

    return `
      <tr class="hover:bg-graphite/40 transition-colors">
        <td class="py-2.5 px-1 text-center font-mono text-ash">${rankNum}</td>
        <td class="py-2.5 px-1 text-center">${deltaHtml}</td>
        <td class="py-2.5 px-2">
          <div class="text-chalk truncate max-w-[140px] sm:max-w-none">${escapeHtml(p.name || 'Peserta')}</div>
        </td>
        <td class="py-2.5 px-2 text-right font-mono text-chalk">${formatRupiah(currentVal)}</td>
        <td class="py-2.5 px-1 text-right font-mono ${returnColor}">${returnSign}</td>
        <td class="py-2.5 px-1 text-right font-mono text-smoke">${mddPct}</td>
      </tr>
    `;
  }).join('');
}

function updateCharts() {
  if (!gameState || !chartTopPlayers || !chartAssetIndexes) return;

  const currentRound = gameState.current_round || 0;
  const top5 = (gameState.leaderboard_top10 || []).slice(0, 5);
  const emptyOverlay = document.getElementById('chartTopEmpty');
  if (emptyOverlay) {
    if (currentRound > 0 && top5.length > 0) {
      emptyOverlay.classList.add('hidden');
    } else {
      emptyOverlay.classList.remove('hidden');
      emptyOverlay.innerText = top5.length === 0
        ? 'Menunggu peserta mendaftar...'
        : 'Menunggu putaran pertama dimulai...';
    }
  }

  const chartHash = `${gameState.session_id}:${currentRound}:${top5.map(p => `${p.code}-${p.current_value}`).join('|')}:${(gameState.asset_history?.sukuk || []).length}`;
  if (chartHash === lastChartsHash) return;
  lastChartsHash = chartHash;

  const labels = ['Awal'];
  for (let r = 1; r <= currentRound; r++) {
    labels.push(`K${r}`);
  }

  const lineColors = ['#f3f3f3', '#8fb3d9', '#8fd9a8', '#d9c38f', '#b38fd9'];

  const playerDatasets = top5.map((p, idx) => ({
    label: p.name || `P${idx + 1}`,
    data: (p.history && Array.isArray(p.history)) ? p.history.map(h => (h && h.value != null ? h.value : 100000000)) : [],
    borderColor: lineColors[idx % lineColors.length],
    backgroundColor: lineColors[idx % lineColors.length],
    tension: 0.2,
    borderWidth: 2.5,
    pointRadius: 3
  }));

  chartTopPlayers.data.labels = labels;
  chartTopPlayers.data.datasets = playerDatasets;
  chartTopPlayers.update('none');

  chartAssetIndexes.data.labels = labels;
  if (gameState.asset_history) {
    ASSET_META.forEach(([id], idx) => {
      chartAssetIndexes.data.datasets[idx].data = gameState.asset_history[id] || [100];
    });
  }
  chartAssetIndexes.update('none');
}

// Fullscreen Toggle
const FS_EXPAND_PATH = 'M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4';
const FS_COMPRESS_PATH = 'M5 9h4V5M19 9h-4V5M5 15h4v4M19 15h-4v4';

function updateFullscreenIcon() {
  const isFs = !!document.fullscreenElement;
  const btn = document.getElementById('btnFullscreen');
  if (btn) {
    const label = isFs ? 'Keluar Layar Penuh' : 'Layar Penuh';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  const svg = document.getElementById('fullscreenIconSvg');
  if (!svg) return;
  const path = svg.querySelector('path');
  if (!path) return;
  path.setAttribute('d', isFs ? FS_COMPRESS_PATH : FS_EXPAND_PATH);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else if (document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

document.addEventListener('fullscreenchange', updateFullscreenIcon);

// QR Code Modal
function showQRModal() {
  lastQrTrigger = document.activeElement;
  const modal = document.getElementById('qrModal');
  const container = document.getElementById('qrCodeContainer');
  const urlText = document.getElementById('qrUrlText');
  if (!modal) return;

  const joinUrl = window.location.origin + '/player.html';
  if (urlText && urlText.innerText !== joinUrl) {
    urlText.innerText = joinUrl;
  }

  if (container) {
    if (cachedQrUrl === joinUrl && cachedQrHtml) {
      container.innerHTML = cachedQrHtml;
    } else {
      const renderFallbackLink = () => {
        container.textContent = '';
        const link = document.createElement('a');
        link.href = joinUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'text-obsidian underline text-xs font-mono';
        link.textContent = 'Buka Tautan';
        container.appendChild(link);
      };
      try {
        if (typeof qrcode === 'function') {
          const qr = qrcode(0, 'M');
          qr.addData(joinUrl);
          qr.make();
          cachedQrHtml = qr.createImgTag(6, 12);
          cachedQrUrl = joinUrl;
          container.innerHTML = cachedQrHtml;
        } else {
          renderFallbackLink();
        }
      } catch (e) {
        renderFallbackLink();
      }
    }
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const closeBtn = document.getElementById('btnCloseQrModal');
  if (closeBtn) closeBtn.focus();
}

function hideQRModal() {
  const modal = document.getElementById('qrModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  if (lastQrTrigger && typeof lastQrTrigger.focus === 'function') {
    lastQrTrigger.focus();
    lastQrTrigger = null;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideQRModal();
    return;
  }
  if (e.key === 'Tab') {
    const modal = document.getElementById('qrModal');
    if (!modal || modal.classList.contains('hidden')) return;
    const focusables = modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

document.addEventListener('click', (e) => {
  const modal = document.getElementById('qrModal');
  if (modal && e.target === modal) {
    hideQRModal();
  }
});

// Lifecycle Setup
window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  fetchState();
  initRealtimeStream();
  scheduleBroadcastPoll();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (!broadcastEventSource || broadcastEventSource.readyState === EventSource.CLOSED) initRealtimeStream();
      fetchState({ urgent: true, bust: true });
      scheduleBroadcastPoll();
    }
  });
});
