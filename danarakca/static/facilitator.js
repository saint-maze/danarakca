// Facilitator View Logic (Hyperstudio Dark Editorial Edition)

const LIVE_CHANNEL = 'danarakca_live_fafc19b30c66';
let facilitatorEventSource = null;
let localBus = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    localBus = new BroadcastChannel('danarakca_live_bus');
    localBus.onmessage = (e) => {
      if (e.data && e.data.state && !actionInFlight) {
        applyIncomingState(e.data.state, false);
      }
    };
  }
} catch (e) {}

function broadcastLivePush(eventType, payload = {}) {
  try {
    if (localBus) {
      localBus.postMessage({
        event: eventType,
        state: gameState,
        session_id: gameState ? gameState.session_id : 1,
        state_version: gameState ? gameState.state_version : 1,
        current_round: gameState ? gameState.current_round : 0,
        current_stage: gameState ? gameState.current_stage : 1,
        stage_input_open: gameState ? gameState.stage_input_open : false,
        ...payload
      });
    }
  } catch (e) {}
}

let facilitatorSseActive = false;
let facilitatorSseErrors = 0;

function initFacilitatorRealtimeStream() {
  const channel = (gameState && gameState.live_channel) || LIVE_CHANNEL;
  if (facilitatorEventSource) {
    try { facilitatorEventSource.close(); } catch (e) {}
  }
  facilitatorSseActive = false;
  facilitatorSseErrors = 0;

  try {
    facilitatorEventSource = new EventSource(`https://ntfy.sh/${channel}/sse?since=now`);
    facilitatorEventSource.onopen = () => {
      facilitatorSseActive = true;
      facilitatorSseErrors = 0;
    };
    facilitatorEventSource.onmessage = () => {
      fetchState();
    };
    facilitatorEventSource.onerror = () => {
      facilitatorSseErrors++;
      facilitatorSseActive = false;
      if (facilitatorEventSource && (facilitatorEventSource.readyState === EventSource.CLOSED || facilitatorSseErrors >= 2)) {
        try { facilitatorEventSource.close(); } catch (e) {}
        facilitatorEventSource = null;
      }
    };
  } catch (err) {
    facilitatorSseActive = false;
    facilitatorEventSource = null;
  }
}

let gameState = null;
let currentTab = 'top10';
let chartTopPlayers = null;
let chartAssetIndexes = null;
let lastRecentCardsHash = '';
let lastLeaderboardHash = '';
let lastChartsHash = '';
let cachedQrUrl = null;
let cachedQrHtml = null;
let lastModalTrigger = null;

const ASSET_META = [
  ['sukuk', 'Sukuk'],
  ['saham', 'Saham'],
  ['rdpu', 'Rdpu'],
  ['emas', 'Emas'],
  ['campuran', 'Campuran']
];

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function setSyncError(message) {
  const banner = document.getElementById('syncErrorBanner');
  const text = document.getElementById('syncErrorText');
  if (!banner) return;
  if (message) {
    if (text) text.innerText = message;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function setActionButtonsDisabled(disabled) {
  document.querySelectorAll('[data-action-btn="1"]').forEach(btn => {
    btn.disabled = disabled;
  });
  if (!disabled && gameState) {
    renderUI();
  }
}

// Chart.js initialization with DESIGN.md color tokens
function initCharts() {
  if (typeof Chart !== 'function') {
    const emptyTop = document.getElementById('chartTopEmpty');
    const emptyAsset = document.getElementById('chartAssetEmpty');
    if (emptyTop) {
      emptyTop.classList.remove('hidden');
      emptyTop.innerText = 'Grafik tidak tersedia saat pustaka grafik gagal dimuat.';
    }
    if (emptyAsset) emptyAsset.classList.remove('hidden');
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
          color: '#9c9c9c',
          font: { family: 'Inter', size: 11 },
          boxWidth: 10,
          boxHeight: 10
        }
      }
    },
    scales: {
      x: {
        grid: { color: '#212121' },
        ticks: { color: '#9c9c9c', font: { family: 'JetBrains Mono', size: 10 } }
      },
      y: {
        grid: { color: '#212121' },
        ticks: { color: '#9c9c9c', font: { family: 'JetBrains Mono', size: 10 } }
      }
    }
  };

  const ctxTop = document.getElementById('chartTopPlayers').getContext('2d');
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

  const ctxAssets = document.getElementById('chartAssetIndexes').getContext('2d');
  chartAssetIndexes = new Chart(ctxAssets, {
    type: 'line',
    data: {
      labels: ['Awal'],
      datasets: [
        { label: 'Sukuk/SBN', data: [100], borderColor: '#8fb3d9', backgroundColor: '#8fb3d9', tension: 0.2, borderWidth: 1.5, pointRadius: 2 },
        { label: 'Saham', data: [100], borderColor: '#d98f8f', backgroundColor: '#d98f8f', tension: 0.2, borderWidth: 1.5, pointRadius: 2 },
        { label: 'RD P. Uang', data: [100], borderColor: '#8fd9a8', backgroundColor: '#8fd9a8', tension: 0.2, borderWidth: 1.5, pointRadius: 2 },
        { label: 'Emas', data: [100], borderColor: '#d9c38f', backgroundColor: '#d9c38f', tension: 0.2, borderWidth: 1.5, pointRadius: 2 },
        { label: 'Campuran', data: [100], borderColor: '#b38fd9', backgroundColor: '#b38fd9', tension: 0.2, borderWidth: 1.5, pointRadius: 2 }
      ]
    },
    options: chartOptionsBase
  });
}

function getAdminToken() {
  return localStorage.getItem('danarakca_admin_token') || '';
}

function handleExpiredAdminSession(withToast = true) {
  localStorage.removeItem('danarakca_admin_token');
  if (withToast) showToast('Sesi fasilitator berakhir', 'error');
  window.location.href = 'admin-login.html?session_expired=1';
}

async function verifyAdminAuth() {
  const token = getAdminToken();
  if (!token) {
    window.location.href = 'admin-login.html';
    return false;
  }
  try {
    const res = await fetch('/api/admin/verify', {
      headers: { 'X-Admin-Token': token }
    });
    if (res.status === 401 || res.status === 403) {
      handleExpiredAdminSession(false);
      return false;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json.success || !json.authenticated) {
      handleExpiredAdminSession(false);
      return false;
    }
    setSyncError(null);
    return true;
  } catch (err) {
    console.error('Auth verification error:', err);
    setSyncError('Gagal memverifikasi sesi admin ke server. Periksa koneksi lalu klik Coba Lagi.');
    setActionButtonsDisabled(true);
    const badgeTime = document.getElementById('badgeSimTime');
    const phTitle = document.getElementById('cardPlaceholderTitle');
    const phDesc = document.getElementById('cardPlaceholderDesc');
    const tbody = document.getElementById('leaderboardTbody');
    if (badgeTime) badgeTime.innerText = 'Offline';
    if (phTitle) phTitle.innerText = 'Koneksi Server Terputus';
    if (phDesc) phDesc.innerText = 'Tidak dapat memverifikasi sesi admin. Klik Coba Lagi di banner atas setelah koneksi pulih.';
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center py-10 text-smoke italic">Data belum dapat dimuat.</td></tr>';
    return false;
  }
}

let facilitatorInitialized = false;
let retryInFlight = false;

async function retryFacilitatorInit() {
  if (retryInFlight) return;
  retryInFlight = true;
  try {
    setSyncError(null);
    if (!facilitatorInitialized) {
      const isAuthed = await verifyAdminAuth();
      if (!isAuthed) return;
      facilitatorInitialized = true;
      if (!chartTopPlayers || !chartAssetIndexes) initCharts();
      initFacilitatorRealtimeStream();
    }
    await fetchState();
    scheduleFacilitatorPoll();
  } finally {
    retryInFlight = false;
  }
}

function adminLogout() {
  showConfirmDialog({
    meta: 'Keamanan Sesi',
    title: 'Kunci Sesi Fasilitator',
    message: 'Apakah Anda ingin mengakhiri sesi pengelolaan dan kembali ke halaman login admin?',
    okText: 'Keluar Sesi'
  }).then(res => {
    if (res.confirmed) {
      localStorage.removeItem('danarakca_admin_token');
      window.location.href = 'admin-login.html';
    }
  });
}

// In-App Toast Notification
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  const borderCol = type === 'error' ? 'border-loss text-loss' : (type === 'success' ? 'border-pulse text-chalk' : 'border-graphite text-chalk');
  toast.className = `panel px-4 py-3 bg-carbon text-caption pointer-events-auto flex items-center gap-2.5 rounded-card card-in ${borderCol}`;
  const span = document.createElement('span');
  span.textContent = String(msg ?? '');
  toast.appendChild(span);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Modal Konfirmasi Operasional
let confirmResolver = null;

function showConfirmDialog({
  meta = 'Konfirmasi Operasional',
  title = 'Konfirmasi Tindakan',
  message = '',
  okText = 'Konfirmasi',
  isDanger = false,
  showCheckbox = false,
  checkboxLabel = 'Pertahankan data & alokasi peserta terdaftar'
} = {}) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    lastModalTrigger = document.activeElement;

    const metaEl = document.getElementById('confirmModalMeta');
    const titleEl = document.getElementById('confirmModalTitle');
    const messageEl = document.getElementById('confirmModalMessage');
    if (metaEl) metaEl.innerText = meta;
    if (titleEl) titleEl.innerText = title;
    if (messageEl) messageEl.innerText = message;

    const extraEl = document.getElementById('confirmModalExtra');
    const checkboxEl = document.getElementById('confirmModalCheckbox');
    const checkboxLabelEl = document.getElementById('confirmModalCheckboxLabel');
    if (showCheckbox && extraEl && checkboxEl) {
      extraEl.classList.remove('hidden');
      if (checkboxLabelEl) checkboxLabelEl.innerText = checkboxLabel;
      checkboxEl.checked = true;
    } else if (extraEl) {
      extraEl.classList.add('hidden');
    }

    const btnOk = document.getElementById('confirmModalBtnOk');
    const btnOkText = document.getElementById('confirmModalBtnOkText');
    if (btnOkText) btnOkText.innerText = okText;
    if (btnOk) {
      btnOk.className = isDanger ? 'btn-danger text-caption px-5' : 'btn-pill text-caption px-5';
      btnOk.onclick = () => {
        const checked = checkboxEl ? checkboxEl.checked : false;
        closeConfirmModal(true, checked);
      };
    }

    const modal = document.getElementById('modalConfirm');
    if (modal) {
      modal.classList.remove('hidden');
      const cancelBtn = document.getElementById('confirmModalBtnCancel');
      if (cancelBtn) cancelBtn.focus();
    }
  });
}

function closeConfirmModal(result = false, extraData = false) {
  const modal = document.getElementById('modalConfirm');
  if (modal) modal.classList.add('hidden');
  if (lastModalTrigger && typeof lastModalTrigger.focus === 'function') {
    lastModalTrigger.focus();
    lastModalTrigger = null;
  }
  if (confirmResolver) {
    const res = confirmResolver;
    confirmResolver = null;
    res({ confirmed: !!result, checkbox: !!extraData });
  }
}

let actionInFlight = false;

function buildClientSync() {
  if (!gameState) return null;
  return {
    session_id: gameState.session_id || 1,
    state_version: gameState.state_version || 1,
    roster_epoch: gameState.roster_epoch || 0,
    preserve_participants_on_reset: !!gameState.preserve_participants_on_reset,
    status: gameState.status,
    current_round: gameState.current_round,
    current_stage: gameState.current_stage,
    stage_input_open: gameState.stage_input_open,
    total_stages: gameState.total_stages,
    rounds_per_stage: gameState.rounds_per_stage,
    drawn_card_ids: gameState.drawn_card_ids || [],
    participants_sync: gameState.participants_sync || {},
    message: gameState.message || ''
  };
}

function mergeParticipantsSync(existingSync, incomingSync) {
  const merged = {};
  const addSource = (src) => {
    if (!src || typeof src !== 'object') return;
    for (const [code, p] of Object.entries(src)) {
      if (!p || typeof p !== 'object') continue;
      if (!merged[code]) {
        merged[code] = {
          code: p.code || code,
          name: p.name,
          joined_at: Number(p.joined_at || 0),
          allocations: p.allocations ? { ...p.allocations } : {},
          alloc_ts: p.alloc_ts ? { ...p.alloc_ts } : {}
        };
      } else {
        if (p.name) merged[code].name = p.name;
        const incJoined = Number(p.joined_at || 0);
        const curJoined = Number(merged[code].joined_at || 0);
        if (incJoined > 0 && (curJoined <= 0 || incJoined < curJoined)) {
          merged[code].joined_at = incJoined;
        }
        const incAllocs = p.allocations || {};
        const incTsMap = p.alloc_ts || {};
        for (const stg of ['1', '2', '3']) {
          if (!incAllocs[stg]) continue;
          const incTs = Number(incTsMap[stg] || 0);
          const curTs = Number(merged[code].alloc_ts[stg] || 0);
          if (!merged[code].allocations[stg] || incTs > curTs) {
            merged[code].allocations[stg] = { ...incAllocs[stg] };
            merged[code].alloc_ts[stg] = Math.max(curTs, incTs, 1);
          }
        }
      }
    }
  };
  addSource(existingSync);
  addSource(incomingSync);
  return merged;
}

function applyIncomingState(newState, force = false) {
  if (!newState) return;
  if (gameState) {
    const curSess = gameState.session_id || 0;
    const newSess = newState.session_id || 0;
    const curVer = gameState.state_version || 0;
    const newVer = newState.state_version || 0;

    if (newSess < curSess) {
      return;
    }

    if (newSess === curSess) {
      const curEpoch = gameState.roster_epoch || 0;
      const newEpoch = newState.roster_epoch || 0;
      if (!force && newEpoch < curEpoch) return;

      const isSameEpoch = (newEpoch === curEpoch);
      if (isSameEpoch) {
        if (gameState.participants_sync) {
          newState.participants_sync = mergeParticipantsSync(gameState.participants_sync, newState.participants_sync);
        }
        const curRound = gameState.current_round || 0;
        const newRound = newState.current_round || 0;
        const curTotalP = gameState.total_participants || 0;
        const newTotalP = newState.total_participants || 0;

        if (newRound < curRound) {
          newState.current_round = curRound;
          newState.drawn_card_ids = gameState.drawn_card_ids || [];
          newState.last_drawn_card = gameState.last_drawn_card;
          newState.recent_cards = gameState.recent_cards || [];
          newState.asset_indexes = gameState.asset_indexes;
          newState.asset_history = gameState.asset_history;
          newState.leaderboard_top10 = gameState.leaderboard_top10 || [];
          newState.investor_tangguh_top5 = gameState.investor_tangguh_top5 || [];
        } else if (!force && newRound === curRound && newTotalP < curTotalP && gameState.leaderboard_top10 && gameState.leaderboard_top10.length > 0) {
          newState.leaderboard_top10 = gameState.leaderboard_top10;
          newState.investor_tangguh_top5 = gameState.investor_tangguh_top5 || newState.investor_tangguh_top5;
        }
        if ((!newState.leaderboard_top10 || newState.leaderboard_top10.length === 0) && (gameState.leaderboard_top10 && gameState.leaderboard_top10.length > 0)) {
          newState.leaderboard_top10 = gameState.leaderboard_top10;
        }
        if ((!newState.investor_tangguh_top5 || newState.investor_tangguh_top5.length === 0) && (gameState.investor_tangguh_top5 && gameState.investor_tangguh_top5.length > 0)) {
          newState.investor_tangguh_top5 = gameState.investor_tangguh_top5;
        }
        const syncCount = Object.keys(newState.participants_sync || {}).length;
        newState.total_participants = Math.max(newTotalP, syncCount, curTotalP);

        if (!force && newVer < curVer) {
          return;
        }
      }
    }
  }
  gameState = newState;
  setSyncError(null);
  renderUI();
}

async function fetchState() {
  if (actionInFlight) return;
  try {
    localStorage.removeItem('danarakca_facilitator_sync');
    const res = await fetch('/api/state/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getAdminToken()
      },
      body: JSON.stringify({ client_sync: buildClientSync() })
    });
    const json = await res.json();
    if (res.ok && json.success && !actionInFlight) {
      applyIncomingState(json.data, false);
    } else if (!res.ok) {
      setSyncError(json.error || 'Gagal menyinkronkan status permainan.');
    }
  } catch (err) {
    console.error('Error fetching state:', err);
    setSyncError('Koneksi ke server terputus. Mengulang sinkronisasi...');
  }
}

function renderUI() {
  if (!gameState) return;

  const actionBusy = actionInFlight || drawCooldown;
  document.querySelectorAll('[data-action-btn="1"]').forEach(btn => {
    btn.disabled = actionBusy;
  });

  const round = gameState.current_round;
  const totalRounds = gameState.total_rounds;

  document.getElementById('badgeRound').innerText = `${round} / ${totalRounds}`;

  if (round === 0) {
    document.getElementById('badgeSimTime').innerText = 'Tahun 1 · Awal';
  } else {
    const year = Math.ceil(round / 4);
    const qtr = ((round - 1) % 4) + 1;
    document.getElementById('badgeSimTime').innerText = `Tahun ${year} · Q${qtr}`;
  }

  document.getElementById('badgeStage').innerText = `${gameState.current_stage} / ${gameState.total_stages}`;
  document.getElementById('badgeParticipants').innerText = `${gameState.total_participants}`;

  const top1 = (gameState.leaderboard_top10 || [])[0];
  document.getElementById('badgeHighestWealth').innerText = top1 ? formatJuta(top1.current_value) : 'Rp 100,0 Jt';

  const nextRound = round + 1;
  const btnDraw = document.getElementById('btnDrawCard');
  const btnDrawText = document.getElementById('btnDrawCardText');

  if (round >= totalRounds) {
    btnDraw.disabled = true;
    btnDrawText.innerText = 'Permainan Selesai';
  } else {
    btnDraw.disabled = actionBusy;
    btnDrawText.innerText = `Kocok Kartu Putaran ${nextRound}`;
  }

  // Toggle Input Button (solid token contrast instead of opacity-60)
  const btnToggle = document.getElementById('btnToggleInput');
  const btnToggleText = document.getElementById('btnToggleInputText');
  if (btnToggle) {
    btnToggle.disabled = actionBusy;
    btnToggle.setAttribute('aria-pressed', gameState.stage_input_open ? 'true' : 'false');
    if (gameState.stage_input_open) {
      btnToggleText.innerText = 'Input Alokasi: Terbuka';
      btnToggle.className = 'btn-ghost px-3 sm:px-4 text-caption font-mono text-center justify-center border-chalk text-chalk';
    } else {
      btnToggleText.innerText = 'Input Alokasi: Ditutup';
      btnToggle.className = 'btn-ghost px-3 sm:px-4 text-caption font-mono text-center justify-center border-ui text-smoke';
    }
  }

  const btnNextStage = document.getElementById('btnNextStage');
  const btnNextStageText = document.getElementById('btnNextStageText');
  const currentStage = gameState.current_stage;
  const roundsPerStage = gameState.rounds_per_stage || 10;
  const stageRoundsFinished = round >= (currentStage * roundsPerStage);

  if (currentStage >= gameState.total_stages) {
    btnNextStage.disabled = true;
    btnNextStageText.innerText = 'Tahap Akhir';
  } else if (!stageRoundsFinished) {
    btnNextStage.disabled = true;
    const roundsInCurrentStage = Math.max(0, round - ((currentStage - 1) * roundsPerStage));
    btnNextStageText.innerText = `Maju ke Tahap ${currentStage + 1} (${roundsInCurrentStage}/${roundsPerStage} Putaran)`;
  } else {
    btnNextStage.disabled = actionBusy;
    btnNextStageText.innerText = `Maju ke Tahap ${currentStage + 1}`;
  }

  updateModeButtonsUI(gameState.total_stages);

  const lastCard = gameState.last_drawn_card;
  const placeholder = document.getElementById('cardPlaceholder');
  const cardContent = document.getElementById('cardContent');
  const phTitle = document.getElementById('cardPlaceholderTitle');
  const phDesc = document.getElementById('cardPlaceholderDesc');
  if (phTitle) phTitle.innerText = 'Belum Ada Kartu yang Dikocok';
  if (phDesc) phDesc.innerText = 'Peserta dapat mengatur alokasi di ponsel masing-masing. Klik tombol "Kocok Kartu Putaran 1" di atas untuk memicu skenario ekonomi makro.';

  if (lastCard && lastCard.card) {
    placeholder.classList.add('hidden');
    cardContent.classList.remove('hidden');
    cardContent.classList.add('flex');

    const c = lastCard.card;
    document.getElementById('cardRoundTag').innerText = `PUTARAN ${lastCard.round} · ${c.id}`;
    document.getElementById('cardCategoryTag').innerText = c.category;
    document.getElementById('cardTitle').innerText = c.title;
    document.getElementById('cardNarration').innerText = c.narration;
    document.getElementById('cardExplanation').innerText = c.explanation;

    const ret = lastCard.returns || {};
    const assets = (gameState.config && gameState.config.assets) || [];
    for (const [id, domKey] of ASSET_META) {
      const baseRet = assets.find(a => a.id === id)?.base_return || 0;
      setImpactUI(domKey, ret[id], baseRet, c[`return_${id}`]);
    }
  } else {
    placeholder.classList.remove('hidden');
    cardContent.classList.add('hidden');
    cardContent.classList.remove('flex');
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
  const colorClass = totalReturn > 0 ? 'text-pulse' : (totalReturn < 0 ? 'text-loss' : 'text-smoke');
  el.className = `text-heading-xs ${colorClass} tabular`;
  sub.innerText = `Dasar ${formatPercent(baseReturn)} · K ${formatPercent(cardEffect)}`;
}

function renderRecentCards() {
  const container = document.getElementById('recentCardsList');
  if (!container) return;
  if (!gameState.recent_cards || gameState.recent_cards.length === 0) {
    if (lastRecentCardsHash !== 'EMPTY') {
      lastRecentCardsHash = 'EMPTY';
      container.innerHTML = '<div class="text-caption text-smoke italic py-2">Belum ada riwayat kartu sebelumnya.</div>';
    }
    return;
  }

  const hash = gameState.recent_cards.map(c => `${c.round}:${c.card_id || (c.card && c.card.id)}`).join('|');
  if (hash === lastRecentCardsHash) return;
  lastRecentCardsHash = hash;

  container.innerHTML = gameState.recent_cards.map(c => `
    <div class="flex items-center justify-between p-3 panel bg-obsidian text-caption">
      <div class="flex items-center gap-3">
        <span class="font-mono text-ash text-[11px] border border-graphite px-1.5 py-0.5 rounded-tag">
          Q${Number(c.round) || 0}
        </span>
        <span class="text-chalk">${escapeHtml(c.card?.title)}</span>
      </div>
      <span class="meta text-[11px]">${escapeHtml(c.card?.category)}</span>
    </div>
  `).join('');
}

function handleTabKeydown(e, tab) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const nextTab = (e.key === 'Home' || (e.key !== 'End' && tab !== 'top10')) ? 'top10' : 'tangguh';
  switchLbTab(nextTab);
  const nextEl = document.getElementById(nextTab === 'top10' ? 'btnTabTop10' : 'btnTabTangguh');
  if (nextEl) nextEl.focus();
}

function switchLbTab(tab) {
  currentTab = tab;
  lastLeaderboardHash = '';
  const isTop10 = tab === 'top10';
  const btn10 = document.getElementById('btnTabTop10');
  const btnT = document.getElementById('btnTabTangguh');
  const title = document.getElementById('lbTabTitle');
  const sub = document.getElementById('lbTabSub');
  const activeCls = 'min-h-[44px] px-3 py-1 rounded-card bg-chalk text-obsidian transition-colors cursor-pointer focus-visible:relative focus-visible:z-10';
  const idleCls = 'min-h-[44px] px-3 py-1 rounded-card text-smoke hover:text-chalk transition-colors cursor-pointer focus-visible:relative focus-visible:z-10';

  btn10.className = isTop10 ? activeCls : idleCls;
  btnT.className = isTop10 ? idleCls : activeCls;
  btn10.setAttribute('aria-selected', isTop10 ? 'true' : 'false');
  btnT.setAttribute('aria-selected', isTop10 ? 'false' : 'true');
  title.innerText = isTop10 ? 'Papan Peringkat (Top 10)' : 'Investor Tangguh (Disiplin Risiko)';
  sub.innerText = isTop10 ? 'Akumulasi total portofolio tertinggi' : 'Peserta dengan toleransi drawdown terbaik';
  renderLeaderboard();
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboardTbody');
  if (!tbody || !gameState) return;

  let list = currentTab === 'top10' ? (gameState.leaderboard_top10 || []) : (gameState.investor_tangguh_top5 || []);

  if (currentTab === 'tangguh' && list.length === 0 && (gameState.leaderboard_top10 || []).length > 0) {
    list = gameState.leaderboard_top10;
  }

  if (list.length === 0 && gameState.participants_sync && Object.keys(gameState.participants_sync).length > 0) {
    const initial = (gameState.config && gameState.config.initial_capital) || 100000000;
    list = Object.values(gameState.participants_sync).map((p, idx) => ({
      name: p.name || 'Peserta',
      current_value: initial,
      prev_rank: idx + 1,
      current_rank: idx + 1,
      max_drawdown: 0.0
    }));
  }

  if (list.length === 0) {
    if (lastLeaderboardHash !== 'EMPTY') {
      lastLeaderboardHash = 'EMPTY';
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-10 text-smoke italic">
            Menunggu peserta mendaftar...
          </td>
        </tr>
      `;
    }
    return;
  }

  const lbHash = `${currentTab}:${gameState.session_id}:${gameState.current_round}:${list.map(p => `${p.code || p.name}:${Math.round(p.current_value || 0)}:${p.current_rank}:${p.prev_rank}`).join('|')}`;
  if (lbHash === lastLeaderboardHash) return;
  lastLeaderboardHash = lbHash;

  tbody.innerHTML = list.map((p, idx) => {
    if (!p) return '';
    const rankNum = idx + 1;

    const prevRank = p.prev_rank != null ? p.prev_rank : rankNum;
    const currRank = p.current_rank != null ? p.current_rank : rankNum;
    const delta = prevRank - currRank;
    let deltaHtml = '<span class="rank-same" aria-label="Tidak berubah">–</span>';
    if (delta > 0) {
      deltaHtml = `<span class="rank-up font-mono">↑${delta}</span>`;
    } else if (delta < 0) {
      deltaHtml = `<span class="rank-down font-mono">↓${Math.abs(delta)}</span>`;
    }

    const initial = (gameState.config && gameState.config.initial_capital) || 100000000;
    const currentVal = p.current_value != null ? p.current_value : initial;
    const returnPct = ((currentVal / initial - 1) * 100).toFixed(1).replace('.', ',');
    const returnSign = (currentVal >= initial ? '+' : '') + returnPct + '%';
    const returnColor = currentVal >= initial ? 'text-pulse' : 'text-loss';
    const mdd = p.max_drawdown != null ? p.max_drawdown : 0.0;
    const mddPct = (mdd * 100).toFixed(1).replace('.', ',') + '%';

    return `
      <tr class="hover:bg-carbon transition-colors">
        <td class="py-2.5 px-1 text-center font-mono text-ash">${rankNum}</td>
        <td class="py-2.5 px-1 text-center">${deltaHtml}</td>
        <td class="py-2.5 px-2">
          <div class="text-chalk truncate max-w-[150px] sm:max-w-none">${escapeHtml(p.name || 'Peserta')}</div>
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

  const chartsHash = `${gameState.session_id}:${currentRound}:${top5.map(p => `${p.code || p.name}:${Math.round(p.current_value || 0)}`).join('|')}`;
  if (chartsHash === lastChartsHash) return;
  lastChartsHash = chartsHash;

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
    borderWidth: 1.5,
    pointRadius: 2
  }));

  chartTopPlayers.data.labels = labels;
  chartTopPlayers.data.datasets = playerDatasets;
  chartTopPlayers.update('none');

  chartAssetIndexes.data.labels = labels;
  if (gameState.asset_history) {
    ASSET_META.forEach(([id], idx) => {
      chartAssetIndexes.data.datasets[idx].data = gameState.asset_history[id];
    });
  }
  chartAssetIndexes.update('none');
}

let drawCooldown = false;

async function postFacilitatorAction(url, payload, fallbackError, { delayUnlockMs = 0 } = {}) {
  actionInFlight = true;
  setActionButtonsDisabled(true);
  let delayedUnlock = false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getAdminToken()
      },
      body: JSON.stringify(payload)
    });
    if (res.status === 401 || res.status === 403) {
      handleExpiredAdminSession();
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.success) {
      return json;
    }
    showToast(json.error || fallbackError, 'error');
    return null;
  } catch (err) {
    showToast('Koneksi server gagal: ' + err.message, 'error');
    return null;
  } finally {
    actionInFlight = false;
    if (delayUnlockMs > 0) {
      delayedUnlock = true;
      setTimeout(() => {
        drawCooldown = false;
        setActionButtonsDisabled(false);
      }, delayUnlockMs);
    }
    if (!delayedUnlock) {
      setActionButtonsDisabled(false);
    }
  }
}

async function drawCard() {
  if (drawCooldown || actionInFlight) return;
  drawCooldown = true;

  const json = await postFacilitatorAction(
    '/api/facilitator/draw-card',
    { client_sync: buildClientSync() },
    'Gagal mengocok kartu',
    { delayUnlockMs: 250 }
  );
  if (!json) return;

  applyIncomingState(json.state, true);
  broadcastLivePush('CARD_DRAWN', {
    round: gameState.current_round,
    stage: gameState.current_stage,
    card: gameState.last_drawn_card ? gameState.last_drawn_card.card : null,
    returns: gameState.last_drawn_card ? gameState.last_drawn_card.returns : null,
    message: gameState.message
  });
  if (gameState.last_drawn_card && gameState.last_drawn_card.card) {
    showToast(`Kartu Putaran ${gameState.current_round} terbuka: ${gameState.last_drawn_card.card.title}`, 'success');
  }
}

async function toggleStageInput() {
  if (actionInFlight) return;
  const targetOpen = gameState ? !gameState.stage_input_open : false;
  const json = await postFacilitatorAction(
    '/api/facilitator/toggle-input',
    { open: targetOpen, client_sync: buildClientSync() },
    'Gagal mengubah status alokasi'
  );
  if (!json) return;

  if (json.state) {
    applyIncomingState(json.state, true);
  } else {
    await fetchState();
  }
  broadcastLivePush('STAGE_INPUT_TOGGLED', {
    stage_input_open: gameState.stage_input_open,
    current_stage: gameState.current_stage,
    message: gameState.message
  });
  showToast(`Status alokasi: ${gameState && gameState.stage_input_open ? 'Terbuka' : 'Ditutup'}`, 'info');
}

async function advanceStage() {
  if (actionInFlight) return;
  const nextStage = (gameState?.current_stage || 1) + 1;
  const res = await showConfirmDialog({
    meta: 'Tahap Simulasi',
    title: `Majukan ke Tahap ${nextStage}`,
    message: 'Alokasi portofolio baru akan dibuka untuk seluruh peserta pada Kuartal saat ini. Lanjutkan transisi tahap?',
    okText: 'Majukan Tahap'
  });
  if (!res.confirmed) return;

  const json = await postFacilitatorAction(
    '/api/facilitator/next-stage',
    { client_sync: buildClientSync() },
    'Gagal memajukan tahap'
  );
  if (!json) return;

  applyIncomingState(json.state, true);
  broadcastLivePush('STAGE_ADVANCED', {
    current_stage: gameState.current_stage,
    stage_input_open: gameState.stage_input_open,
    message: gameState.message
  });
  showToast(`Berhasil maju ke Tahap ${gameState.current_stage}`, 'success');
}

function updateModeButtonsUI(totalStages) {
  const currentStage = gameState ? gameState.current_stage : 1;
  const actionBusy = actionInFlight || drawCooldown;
  [1, 2, 3].forEach(m => {
    const btn = document.getElementById(`btnMode${m}`);
    if (!btn) return;
    const isLocked = m < currentStage;
    if (isLocked) {
      btn.disabled = true;
      btn.setAttribute('aria-pressed', 'false');
      btn.className = 'min-h-[44px] px-2.5 sm:px-3.5 flex items-center justify-center cursor-not-allowed opacity-40 bg-obsidian text-smoke text-xs sm:text-caption first:rounded-l-[7px] last:rounded-r-[7px] focus-visible:relative focus-visible:z-10';
      btn.title = `Tahap ${m} sudah terlewati`;
    } else if (m === totalStages) {
      btn.disabled = actionBusy;
      btn.setAttribute('aria-pressed', 'true');
      btn.className = 'min-h-[44px] px-2.5 sm:px-3.5 flex items-center justify-center transition-colors cursor-pointer bg-chalk text-obsidian text-xs sm:text-caption first:rounded-l-[7px] last:rounded-r-[7px] focus-visible:relative focus-visible:z-10';
      btn.title = `Mode ${m} Tahap aktif`;
    } else {
      btn.disabled = actionBusy;
      btn.setAttribute('aria-pressed', 'false');
      btn.className = 'min-h-[44px] px-2.5 sm:px-3.5 flex items-center justify-center transition-colors cursor-pointer bg-obsidian text-smoke hover:text-chalk hover:bg-carbon text-xs sm:text-caption first:rounded-l-[7px] last:rounded-r-[7px] focus-visible:relative focus-visible:z-10';
      btn.title = `Ubah ke Mode ${m} Tahap`;
    }
  });
}

async function setGameMode(stages) {
  if (actionInFlight) return;
  stages = parseInt(stages, 10);
  if (![1, 2, 3].includes(stages)) return;

  if (gameState && stages < gameState.current_stage) {
    showToast(`Tidak bisa ubah ke ${stages} Tahap karena sedang berada di Tahap ${gameState.current_stage}`, 'error');
    return;
  }

  const targetRounds = stages * (gameState?.rounds_per_stage || 10);
  if (gameState && gameState.current_round > 0 && gameState.current_round >= targetRounds) {
    const confirmRes = await showConfirmDialog({
      meta: 'Mode Durasi',
      title: `Selesaikan Simulasi di ${stages} Tahap`,
      message: `Putaran saat ini (${gameState.current_round}) mencapai batas ${stages} Tahap (${targetRounds} Putaran). Mengubah mode sekarang akan langsung menyelesaikan simulasi.`,
      okText: 'Ubah & Selesaikan'
    });
    if (!confirmRes.confirmed) return;
  }

  const json = await postFacilitatorAction(
    '/api/facilitator/set-mode',
    { total_stages: stages, client_sync: buildClientSync() },
    'Gagal mengubah mode tahap'
  );
  if (!json) return;

  applyIncomingState(json.state, true);
  broadcastLivePush('MODE_CHANGED', {
    total_stages: gameState.total_stages,
    total_rounds: gameState.total_rounds,
    status: gameState.status,
    message: gameState.message
  });
  showToast(`Mode diubah: ${stages} Tahap (${targetRounds} Putaran)`, 'success');
}

async function seedMockUsers(count = 200) {
  if (actionInFlight) return;
  const res = await showConfirmDialog({
    meta: 'Simulasi Beban',
    title: `Simulasi ${count} Bot Peserta`,
    message: `Sistem akan mengganti daftar peserta saat ini dengan ${count} portofolio simulasi bot untuk menguji papan peringkat dan tolok ukur. Lanjutkan?`,
    okText: 'Mulai Simulasi'
  });
  if (!res.confirmed) return;

  const json = await postFacilitatorAction(
    '/api/facilitator/seed-mock-users',
    { count, client_sync: buildClientSync() },
    'Gagal membuat bot peserta'
  );
  if (!json) return;

  lastLeaderboardHash = '';
  lastChartsHash = '';
  applyIncomingState(json.state, true);
  broadcastLivePush('USERS_SEEDED', {});
  showToast(`Berhasil membuat ${count} bot peserta`, 'success');
}

async function exportCSV() {
  try {
    const res = await fetch('/api/export', {
      headers: { 'X-Admin-Token': getAdminToken() }
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        handleExpiredAdminSession();
        return;
      }
      const errJson = await res.json().catch(() => ({}));
      showToast(errJson.error || 'Gagal mengunduh CSV', 'error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'danarakca_leaderboard.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('Rekap CSV berhasil diunduh', 'success');
  } catch (err) {
    showToast('Gagal mengunduh CSV: ' + err.message, 'error');
  }
}

async function confirmReset() {
  if (actionInFlight) return;
  const res = await showConfirmDialog({
    meta: 'Tindakan Kritis',
    title: 'Inisialisasi Ulang Simulasi (Reset Game)',
    message: 'Permainan akan dikembalikan ke Kuartal 0 dan riwayat transaksi akan dihapus. Anda dapat mempertahankan peserta yang telah mendaftar agar tidak perlu registrasi ulang.',
    okText: 'Reset Permainan',
    isDanger: true,
    showCheckbox: true,
    checkboxLabel: 'Pertahankan data peserta/tim yang telah terdaftar'
  });
  if (!res.confirmed) return;
  const preserve = res.checkbox;

  const json = await postFacilitatorAction(
    '/api/facilitator/reset',
    {
      preserve_participants: preserve,
      total_stages: gameState ? gameState.total_stages : 3,
      client_sync: buildClientSync()
    },
    'Gagal me-reset permainan'
  );
  if (!json) return;

  lastRecentCardsHash = '';
  lastLeaderboardHash = '';
  lastChartsHash = '';
  applyIncomingState(json.state, true);
  broadcastLivePush('GAME_RESET', {});
  showToast(preserve ? 'Game di-reset (Peserta dipertahankan)' : 'Game di-reset total', 'info');
}

function getDefaultPlayerUrl() {
  const pub = gameState?.config?.public_url?.trim();
  if (pub) return pub.replace(/\/+$/, '') + '/player.html';
  return window.location.origin + '/player.html';
}

function getPlayerUrl() {
  return localStorage.getItem('danarakca_player_url')?.trim() || getDefaultPlayerUrl();
}

function updateQRCodeImage(url) {
  const container = document.getElementById('qrCodeContainer');
  if (!container) return;
  if (cachedQrUrl === url && cachedQrHtml) {
    container.innerHTML = cachedQrHtml;
    return;
  }
  const renderFallback = () => {
    container.textContent = '';
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'text-obsidian underline text-xs font-mono';
    link.textContent = 'Buka Tautan Peserta';
    container.appendChild(link);
  };
  try {
    if (typeof qrcode === 'function') {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      cachedQrHtml = qr.createImgTag(5, 8);
      cachedQrUrl = url;
      container.innerHTML = cachedQrHtml;
    } else {
      renderFallback();
    }
  } catch (err) {
    renderFallback();
  }
}

function showQRModal() {
  lastModalTrigger = document.activeElement;
  const url = getPlayerUrl();
  const input = document.getElementById('inputPlayerUrl');
  if (input) input.value = url;
  updateQRCodeImage(url);
  const modal = document.getElementById('modalQR');
  if (modal) {
    modal.classList.remove('hidden');
    const closeBtn = document.getElementById('btnCloseQRModal');
    if (closeBtn) closeBtn.focus();
  }
}

function hideQRModal() {
  const modal = document.getElementById('modalQR');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  if (lastModalTrigger && typeof lastModalTrigger.focus === 'function') {
    lastModalTrigger.focus();
    lastModalTrigger = null;
  }
}

function onPlayerUrlChange() {
  const input = document.getElementById('inputPlayerUrl');
  if (!input) return;
  const url = input.value.trim();
  if (url) {
    localStorage.setItem('danarakca_player_url', url);
    updateQRCodeImage(url);
  }
}

function copyPlayerUrl() {
  const input = document.getElementById('inputPlayerUrl');
  const url = input ? input.value.trim() : getPlayerUrl();
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    showToast('Tautan akses peserta berhasil disalin ke clipboard', 'success');
  }).catch(() => {
    if (input) {
      input.select();
      document.execCommand('copy');
      showToast('Tautan disalin', 'success');
    }
  });
}

function resetPlayerUrlDefault() {
  localStorage.removeItem('danarakca_player_url');
  const defaultUrl = getDefaultPlayerUrl();
  const input = document.getElementById('inputPlayerUrl');
  if (input) input.value = defaultUrl;
  updateQRCodeImage(defaultUrl);
  showToast('URL direset ke default (' + defaultUrl + ')', 'info');
}

let facilitatorPollTimeout = null;

function scheduleFacilitatorPoll() {
  if (facilitatorPollTimeout) clearTimeout(facilitatorPollTimeout);
  const baseInterval = facilitatorSseActive ? 3500 : 1800;
  const jitter = Math.floor(Math.random() * 500);

  facilitatorPollTimeout = setTimeout(async () => {
    if (!document.hidden && !actionInFlight) {
      await fetchState();
    }
    scheduleFacilitatorPoll();
  }, baseInterval + jitter);
}

function trapModalFocus(modal, e) {
  const focusables = Array.from(
    modal.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
  ).filter(el => el.offsetParent !== null);
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

window.addEventListener('DOMContentLoaded', async () => {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (!facilitatorInitialized) {
        retryFacilitatorInit();
        return;
      }
      fetchState();
      scheduleFacilitatorPoll();
    }
  });

  document.addEventListener('keydown', (e) => {
    const confirmModal = document.getElementById('modalConfirm');
    const qrModal = document.getElementById('modalQR');
    if (e.key === 'Tab') {
      if (confirmModal && !confirmModal.classList.contains('hidden')) {
        trapModalFocus(confirmModal, e);
      } else if (qrModal && !qrModal.classList.contains('hidden')) {
        trapModalFocus(qrModal, e);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (confirmModal && !confirmModal.classList.contains('hidden')) {
        closeConfirmModal(false);
        return;
      }
      hideQRModal();
    }
  });

  document.addEventListener('click', (e) => {
    const qrModal = document.getElementById('modalQR');
    if (qrModal && e.target === qrModal) {
      hideQRModal();
      return;
    }
    const confirmModal = document.getElementById('modalConfirm');
    if (confirmModal && e.target === confirmModal) {
      closeConfirmModal(false);
    }
  });

  await retryFacilitatorInit();
});
