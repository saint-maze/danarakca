// Danarakca — Public Broadcast & Presentation Screen Logic
// Hyperstudio Dark Editorial Edition

const LIVE_CHANNEL = 'danarakca_live_fafc19b30c66';
let broadcastEventSource = null;
let sseActive = false;
let sseErrors = 0;
let gameState = null;
let currentTab = 'top10'; // 'top10' or 'tangguh'
let chartTopPlayers = null;
let chartAssetIndexes = null;
let broadcastPollTimeout = null;
let lastRenderedCardId = null;

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

// Chart.js Initialization (Optimized for Projector Contrast and Distance)
function initCharts() {
  const chartOptionsBase = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        position: 'top',
        labels: {
          color: '#c1c1c1',
          font: { family: 'Inter', size: 12, weight: '500' },
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
function initRealtimeStream() {
  const channel = (gameState && gameState.live_channel) || LIVE_CHANNEL;
  if (broadcastEventSource) {
    try { broadcastEventSource.close(); } catch (e) {}
  }
  sseActive = false;
  sseErrors = 0;

  try {
    broadcastEventSource = new EventSource(`https://ntfy.sh/${channel}/sse?since=now`);
    broadcastEventSource.onopen = () => {
      sseActive = true;
      sseErrors = 0;
      const syncEl = document.getElementById('syncStatusText');
      if (syncEl) syncEl.innerText = 'Tersinkronisasi';
    };
    broadcastEventSource.onmessage = (e) => {
      try {
        const raw = JSON.parse(e.data);
        if (raw.event !== 'message' || !raw.message) return;
        fetchState();
      } catch (err) {}
    };
    broadcastEventSource.onerror = () => {
      sseErrors++;
      sseActive = false;
      // Close immediately if closed or 403 rate-limited on public SSE
      if (broadcastEventSource && (broadcastEventSource.readyState === EventSource.CLOSED || sseErrors >= 2)) {
        try { broadcastEventSource.close(); } catch (e) {}
        broadcastEventSource = null;
      }
      const syncEl = document.getElementById('syncStatusText');
      if (syncEl) syncEl.innerText = 'Polling Aktif';
    };
  } catch (err) {
    sseActive = false;
    broadcastEventSource = null;
  }
}

// State Synchronization
function applyIncomingState(newState) {
  if (!newState) return;
  if (gameState) {
    const curSess = gameState.session_id || 0;
    const newSess = newState.session_id || 0;
    const curVer = gameState.state_version || 0;
    const newVer = newState.state_version || 0;

    if (newSess < curSess) return;

    if (newSess === curSess) {
      // Prevent round rollback
      if ((newState.current_round || 0) < (gameState.current_round || 0)) {
        newState.current_round = gameState.current_round;
        newState.drawn_card_ids = gameState.drawn_card_ids || [];
        newState.last_drawn_card = gameState.last_drawn_card;
        newState.recent_cards = gameState.recent_cards || [];
      }
      // Preserve leaderboard if lagging empty response
      if ((!newState.leaderboard_top10 || newState.leaderboard_top10.length === 0) && (gameState.leaderboard_top10 && gameState.leaderboard_top10.length > 0)) {
        newState.leaderboard_top10 = gameState.leaderboard_top10;
      }
      if ((!newState.investor_tangguh_top5 || newState.investor_tangguh_top5.length === 0) && (gameState.investor_tangguh_top5 && gameState.investor_tangguh_top5.length > 0)) {
        newState.investor_tangguh_top5 = gameState.investor_tangguh_top5;
      }
      if (newVer < curVer) return;
    }
  }

  gameState = newState;
  renderBroadcast();
}

async function fetchState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    const json = await res.json();
    if (json.success && json.data) {
      applyIncomingState(json.data);
    }
  } catch (err) {
    const syncEl = document.getElementById('syncStatusText');
    if (syncEl) syncEl.innerText = 'Menghubungkan...';
  }
}

// Dynamic Jittered Polling Schedule
function scheduleBroadcastPoll() {
  if (broadcastPollTimeout) clearTimeout(broadcastPollTimeout);
  const baseInterval = sseActive ? 3500 : 1800;
  const jitter = Math.floor(Math.random() * 500);

  broadcastPollTimeout = setTimeout(async () => {
    if (!document.hidden) {
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

  // Header Badges
  const bRound = document.getElementById('badgeRound');
  if (bRound) bRound.innerText = `${round} / ${totalRounds}`;

  const bTime = document.getElementById('badgeSimTime');
  if (bTime) {
    if (round === 0) {
      bTime.innerText = 'Tahun 1 · Awal';
    } else {
      const year = Math.ceil(round / 4);
      const qtr = ((round - 1) % 4) + 1;
      bTime.innerText = `Tahun ${year} · Q${qtr}`;
    }
  }

  const bStage = document.getElementById('badgeStage');
  if (bStage) bStage.innerText = `${gameState.current_stage || 1} / ${gameState.total_stages || 3}`;

  const bPart = document.getElementById('badgeParticipants');
  if (bPart) bPart.innerText = `${gameState.total_participants || 0}`;

  const bWealth = document.getElementById('badgeHighestWealth');
  if (bWealth) {
    const top1 = (gameState.leaderboard_top10 || [])[0];
    bWealth.innerText = top1 ? formatJuta(top1.current_value) : 'Rp 100,0 Jt';
  }

  // Active Scenario Card
  const lastCard = gameState.last_drawn_card;
  const placeholder = document.getElementById('cardPlaceholder');
  const cardContent = document.getElementById('cardContent');

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

    const rTag = document.getElementById('cardRoundTag');
    if (rTag) rTag.innerText = `PUTARAN ${lastCard.round} · ${c.id}`;

    const catTag = document.getElementById('cardCategoryTag');
    if (catTag) catTag.innerText = c.category;

    const titleEl = document.getElementById('cardTitle');
    if (titleEl) titleEl.innerText = c.title;

    const narrEl = document.getElementById('cardNarration');
    if (narrEl) narrEl.innerText = c.narration;

    const expEl = document.getElementById('cardExplanation');
    if (expEl) expEl.innerText = c.explanation;

    // Allocation Input Status Badge
    const inputStatusText = document.getElementById('inputStatusText');
    const inputStatusDot = document.getElementById('inputStatusDot');
    const badgeInputStatus = document.getElementById('badgeInputStatus');

    if (inputStatusText && inputStatusDot && badgeInputStatus) {
      if (gameState.stage_input_open) {
        inputStatusText.innerText = 'Alokasi Terbuka';
        inputStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-pulse animate-pulse';
        badgeInputStatus.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-tag font-mono text-xs font-semibold bg-pulse/10 border border-pulse/30 text-pulse';
      } else {
        inputStatusText.innerText = 'Alokasi Ditutup';
        inputStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-smoke';
        badgeInputStatus.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-tag font-mono text-xs font-semibold bg-obsidian hairline text-smoke';
      }
    }

    // Impact Matrix
    const ret = lastCard.returns || {};
    const assets = (gameState.config && gameState.config.assets) || [];
    const baseSukuk = assets.find(a => a.id === 'sukuk')?.base_return || 0;
    const baseSaham = assets.find(a => a.id === 'saham')?.base_return || 0;
    const baseRdpu = assets.find(a => a.id === 'rdpu')?.base_return || 0;
    const baseEmas = assets.find(a => a.id === 'emas')?.base_return || 0;
    const baseCampuran = assets.find(a => a.id === 'campuran')?.base_return || 0;

    setImpactUI('Sukuk', ret.sukuk, baseSukuk, c.return_sukuk);
    setImpactUI('Saham', ret.saham, baseSaham, c.return_saham);
    setImpactUI('Rdpu', ret.rdpu, baseRdpu, c.return_rdpu);
    setImpactUI('Emas', ret.emas, baseEmas, c.return_emas);
    setImpactUI('Campuran', ret.campuran, baseCampuran, c.return_campuran);
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
  if (totalReturn > 0) {
    el.className = 'text-heading-xs tabular font-mono font-semibold text-pulse';
  } else if (totalReturn < 0) {
    el.className = 'text-heading-xs tabular font-mono font-semibold text-loss';
  } else {
    el.className = 'text-heading-xs tabular font-mono font-semibold text-ash';
  }

  sub.innerText = `Dasar ${formatPercent(baseReturn)} · Efek ${formatPercent(cardEffect)}`;
}

function renderRecentCards() {
  const container = document.getElementById('recentCardsList');
  if (!container) return;

  if (!gameState.recent_cards || gameState.recent_cards.length === 0) {
    container.innerHTML = '<div class="text-caption text-smoke italic py-1 col-span-3">Belum ada riwayat kartu sebelumnya.</div>';
    return;
  }

  const recent = gameState.recent_cards.slice(0, 3);
  container.innerHTML = recent.map(c => `
    <div class="flex items-center justify-between p-2.5 rounded-card bg-obsidian hairline text-caption">
      <div class="flex items-center gap-2 overflow-hidden">
        <span class="font-mono text-ash text-[10px] border border-graphite px-1.5 py-0.5 rounded-tag shrink-0">
          Q${c.round}
        </span>
        <span class="text-chalk truncate text-xs font-medium">${c.card.title}</span>
      </div>
      <span class="meta text-[10px] text-smoke shrink-0 ml-1">${c.card.category}</span>
    </div>
  `).join('');
}

function switchLbTab(tab) {
  currentTab = tab;
  const btn10 = document.getElementById('btnTabTop10');
  const btnT = document.getElementById('btnTabTangguh');
  const title = document.getElementById('lbTabTitle');
  const sub = document.getElementById('lbTabSub');

  if (tab === 'top10') {
    if (btn10) btn10.className = 'px-3 py-1 rounded-card bg-chalk text-obsidian font-semibold transition-colors';
    if (btnT) btnT.className = 'px-3 py-1 rounded-card text-smoke hover:text-chalk transition-colors';
    if (title) title.innerText = 'Papan Peringkat';
    if (sub) sub.innerText = '10 Portofolio Terbesar';
  } else {
    if (btnT) btnT.className = 'px-3 py-1 rounded-card bg-chalk text-obsidian font-semibold transition-colors';
    if (btn10) btn10.className = 'px-3 py-1 rounded-card text-smoke hover:text-chalk transition-colors';
    if (title) title.innerText = 'Investor Tangguh';
    if (sub) sub.innerText = 'Disiplin Risiko Terbaik';
  }
  renderLeaderboard();
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboardTbody');
  if (!tbody || !gameState) return;

  let list = currentTab === 'top10' ? (gameState.leaderboard_top10 || []) : (gameState.investor_tangguh_top5 || []);

  if (currentTab === 'tangguh' && list.length === 0 && (gameState.leaderboard_top10 || []).length > 0) {
    list = gameState.leaderboard_top10;
  }

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
    let deltaHtml = '<span class="text-smoke">–</span>';
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
        <td class="py-2.5 px-1 text-center font-mono text-ash font-medium">${rankNum}</td>
        <td class="py-2.5 px-1 text-center">${deltaHtml}</td>
        <td class="py-2.5 px-2">
          <div class="text-chalk truncate max-w-[140px] sm:max-w-none font-medium">${p.name || 'Peserta'}</div>
        </td>
        <td class="py-2.5 px-2 text-right font-mono text-chalk font-semibold">${formatRupiah(currentVal)}</td>
        <td class="py-2.5 px-1 text-right font-mono ${returnColor}">${returnSign}</td>
        <td class="py-2.5 px-1 text-right font-mono text-smoke">${mddPct}</td>
      </tr>
    `;
  }).join('');
}

function updateCharts() {
  if (!gameState || !chartTopPlayers || !chartAssetIndexes) return;

  const currentRound = gameState.current_round || 0;
  const labels = ['Awal'];
  for (let r = 1; r <= currentRound; r++) {
    labels.push(`K${r}`);
  }

  // Top 5 Portfolios
  const top5 = (gameState.leaderboard_top10 || []).slice(0, 5);
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

  // Asset Benchmark Indexes
  chartAssetIndexes.data.labels = labels;
  if (gameState.asset_history) {
    chartAssetIndexes.data.datasets[0].data = gameState.asset_history.sukuk || [100];
    chartAssetIndexes.data.datasets[1].data = gameState.asset_history.saham || [100];
    chartAssetIndexes.data.datasets[2].data = gameState.asset_history.rdpu || [100];
    chartAssetIndexes.data.datasets[3].data = gameState.asset_history.emas || [100];
    chartAssetIndexes.data.datasets[4].data = gameState.asset_history.campuran || [100];
  }
  chartAssetIndexes.update('none');
}

// Fullscreen Toggle
function toggleFullscreen() {
  const icon = document.getElementById('fullscreenIcon');
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    if (icon) icon.innerText = '⤓';
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    if (icon) icon.innerText = '⛶';
  }
}

document.addEventListener('fullscreenchange', () => {
  const icon = document.getElementById('fullscreenIcon');
  if (icon) {
    icon.innerText = document.fullscreenElement ? '⤓' : '⛶';
  }
});

// QR Code Modal
function showQRModal() {
  const modal = document.getElementById('qrModal');
  const container = document.getElementById('qrCodeContainer');
  const urlText = document.getElementById('qrUrlText');
  if (!modal) return;

  const joinUrl = window.location.origin + '/player.html';
  if (urlText) urlText.innerText = joinUrl;

  if (container) {
    try {
      if (typeof qrcode === 'function') {
        const qr = qrcode(0, 'M');
        qr.addData(joinUrl);
        qr.make();
        container.innerHTML = qr.createImgTag(6, 12);
      } else {
        container.innerHTML = `<a href="${joinUrl}" target="_blank" class="text-obsidian underline text-xs font-mono">Buka Tautan</a>`;
      }
    } catch (e) {
      container.innerHTML = `<a href="${joinUrl}" target="_blank" class="text-obsidian underline text-xs font-mono">Buka Tautan</a>`;
    }
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function hideQRModal() {
  const modal = document.getElementById('qrModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideQRModal();
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
      fetchState();
      scheduleBroadcastPoll();
    }
  });
});
