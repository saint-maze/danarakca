// Player Front-End Logic — Hyperstudio Dark Editorial Edition

const LIVE_CHANNEL = 'danarakca_live_fafc19b30c66';
let liveEventSource = null;
let lastProcessedCardRound = -1;
let currentLiveChannel = null;

let currentUser = null; // { code, name }
let gameState = null;
let participantData = null;

let allocation = {
  sukuk: 20,
  saham: 20,
  rdpu: 20,
  emas: 20,
  campuran: 20
};

let userIsEditing = false;
let submitInFlight = false;
let lastLoadedStage = null;
let savedAllocations = {};

function renderInstantCardPreview(round, card) {
  const preview = document.getElementById('playerCardPreview');
  if (!preview || !card) return;

  preview.classList.remove('hidden');

  // Re-trigger animation
  preview.classList.remove('card-in');
  void preview.offsetWidth; // Force DOM reflow
  preview.classList.add('card-in');

  const roundEl = document.getElementById('previewRound');
  const catEl = document.getElementById('previewCategory');
  const titleEl = document.getElementById('previewTitle');
  const narrEl = document.getElementById('previewNarration');

  if (roundEl) roundEl.innerText = `Putaran ${round} · ${card.id || ''}`;
  if (catEl) catEl.innerText = card.category || 'Berita Pasar';
  if (titleEl) titleEl.innerText = card.title || '';
  if (narrEl) narrEl.innerText = card.narration || '';
}

function handleRealtimeEvent(msg) {
  if (!msg || !msg.event) return;

  if (msg.event === 'CARD_DRAWN') {
    const round = msg.round || msg.current_round;
    const card = msg.card || (msg.card_entry && msg.card_entry.card);

    if (round && round <= lastProcessedCardRound) return;
    if (round) lastProcessedCardRound = round;

    // 1. Instantly display drawn card with zero delay
    if (card) {
      renderInstantCardPreview(round, card);
    }

    // 2. Immediately update header badge
    if (round) {
      const total = gameState ? gameState.total_rounds : 30;
      const stage = msg.stage || (gameState ? gameState.current_stage : 1);
      const headerRound = document.getElementById('headerRoundInfo');
      if (headerRound) headerRound.innerText = `Putaran ${round}/${total} · Tahap ${stage}`;
    }

    // 3. Immediately close allocation banner if card was drawn
    if (gameState) {
      gameState.stage_input_open = false;
      gameState.current_round = round;
      updateStageInputStatus();
    }

    // 4. Subtle haptic pulse
    if (navigator.vibrate) {
      try { navigator.vibrate([25, 40, 25]); } catch (e) {}
    }

    // 5. Instantly trigger background sync for updated portfolio balance and rank
    fetchStateAndParticipant();
  } else if (msg.event === 'STAGE_INPUT_TOGGLED') {
    if (gameState) {
      gameState.stage_input_open = Boolean(msg.stage_input_open);
      if (msg.current_stage) gameState.current_stage = msg.current_stage;
      updateStageInputStatus();
    }
    fetchStateAndParticipant();
  } else if (msg.event === 'STAGE_ADVANCED') {
    if (gameState) {
      gameState.current_stage = msg.current_stage;
      gameState.stage_input_open = true;
      updateHeaderRoundInfo();
      updateStageInputStatus();
    }
    fetchStateAndParticipant();
  } else if (msg.event === 'GAME_RESET') {
    lastProcessedCardRound = -1;
    fetchStateAndParticipant();
  }
}

function initRealtimeStream(channel) {
  const targetChannel = channel || (gameState && gameState.live_channel) || LIVE_CHANNEL;
  if (liveEventSource && currentLiveChannel === targetChannel) return;
  if (liveEventSource) {
    try { liveEventSource.close(); } catch (e) {}
  }
  currentLiveChannel = targetChannel;
  try {
    liveEventSource = new EventSource(`https://ntfy.sh/${targetChannel}/sse`);
    liveEventSource.onmessage = (e) => {
      try {
        const raw = JSON.parse(e.data);
        if (raw.event !== 'message' || !raw.message) return;
        const msg = typeof raw.message === 'string' ? JSON.parse(raw.message) : raw.message;
        handleRealtimeEvent(msg);
      } catch (err) {}
    };
  } catch (err) {
    console.warn('Realtime SSE unavailable:', err);
  }
}

function loadSavedAllocations() {
  try {
    const raw = localStorage.getItem('danarakca_allocations');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        savedAllocations = parsed;
      }
    }
  } catch (e) {
    savedAllocations = {};
  }
}

function persistSavedAllocations() {
  try {
    localStorage.setItem('danarakca_allocations', JSON.stringify(savedAllocations));
  } catch (e) {}
}

function buildParticipantSync() {
  if (!currentUser) return null;
  const savedSess = parseInt(localStorage.getItem('danarakca_session_id') || '0', 10);
  return {
    code: currentUser.code,
    name: currentUser.name,
    session_id: gameState ? (gameState.session_id || savedSess) : savedSess,
    allocations: savedAllocations
  };
}

function formatRupiah(num) {
  if (num === null || num === undefined) return 'Rp 0';
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

function formatPercent(num, withSign = true) {
  if (num === null || num === undefined) return '0%';
  const pct = (num * 100).toFixed(1).replace('.', ',');
  if (withSign && num > 0) return '+' + pct + '%';
  return pct + '%';
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// In-App Toast Notification (Ganti alert() basic)
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainerPlayer');
  if (!container) return;
  const toast = document.createElement('div');
  const borderCol = type === 'error' ? 'border-loss text-loss' : (type === 'success' ? 'border-pulse text-chalk' : 'border-graphite text-chalk');
  toast.className = `panel px-4 py-3 bg-carbon text-caption pointer-events-auto shadow-2xl flex items-center gap-2.5 rounded-card card-in ${borderCol}`;
  toast.innerHTML = `<span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// 1. Auth & View State
function initAuth() {
  loadSavedAllocations();
  const savedName = localStorage.getItem('danarakca_name');
  const savedCode = localStorage.getItem('danarakca_code');

  if (savedName) {
    currentUser = { code: savedCode || savedName, name: savedName };
    showDashboard();
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('dashboardScreen').classList.add('hidden');
  document.getElementById('userHeaderBadge').classList.add('hidden');
  document.getElementById('userHeaderBadge').classList.remove('flex');
}

function showDashboard() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('dashboardScreen').classList.remove('hidden');
  document.getElementById('userHeaderBadge').classList.remove('hidden');
  document.getElementById('userHeaderBadge').classList.add('flex');
  
  const badgeEl = document.getElementById('badgeUserName') || document.getElementById('badgeUserCode');
  if (badgeEl) badgeEl.innerText = currentUser.name;
  
  const teamEl = document.getElementById('displayTeamName');
  if (teamEl) teamEl.innerText = currentUser.name;

  fetchStateAndParticipant();
}

async function handleLogin(e) {
  e.preventDefault();
  const inputEl = document.getElementById('inputName');
  const name = inputEl ? inputEl.value.trim() : '';

  if (!name) {
    showToast('Nama peserta / tim wajib diisi', 'error');
    return;
  }

  try {
    const res = await fetch('/api/participant/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    const json = await res.json();
    if (json.success && json.data) {
      const p = json.data;
      localStorage.setItem('danarakca_code', p.code);
      localStorage.setItem('danarakca_name', p.name);
      if (json.state && json.state.session_id) {
        localStorage.setItem('danarakca_session_id', String(json.state.session_id));
      }
      if (p.allocations && Object.keys(p.allocations).length > 0) {
        savedAllocations = { ...p.allocations };
        persistSavedAllocations();
      }
      currentUser = { code: p.code, name: p.name };
      lastLoadedStage = null;
      showDashboard();
    } else {
      showToast(json.error || 'Gagal mendaftar', 'error');
    }
  } catch (err) {
    showToast('Koneksi server gagal: ' + err.message, 'error');
  }
}

function logout() {
  const modal = document.getElementById('modalConfirmPlayer');
  if (modal) modal.classList.remove('hidden');
}

function closePlayerModal() {
  const modal = document.getElementById('modalConfirmPlayer');
  if (modal) modal.classList.add('hidden');
}

function confirmLogoutAction() {
  closePlayerModal();
  localStorage.removeItem('danarakca_code');
  localStorage.removeItem('danarakca_name');
  localStorage.removeItem('danarakca_allocations');
  localStorage.removeItem('danarakca_session_id');
  currentUser = null;
  participantData = null;
  savedAllocations = {};
  lastLoadedStage = null;
  showLogin();
}

function applyPlayerSyncResponse(newState, newParticipant, force = false) {
  if (newState) {
    const savedSess = parseInt(localStorage.getItem('danarakca_session_id') || '0', 10);
    const curSess = gameState ? (gameState.session_id || savedSess) : savedSess;
    const newSess = newState.session_id || 1;
    const curVer = gameState ? (gameState.state_version || 0) : 0;
    const newVer = newState.state_version || 0;

    // Detect game reset by Facilitator
    if (curSess > 0 && newSess > curSess) {
      savedAllocations = {};
      persistSavedAllocations();
      localStorage.setItem('danarakca_session_id', String(newSess));
      allocation = { sukuk: 20, saham: 20, rdpu: 20, emas: 20, campuran: 20 };
      userIsEditing = false;
      lastLoadedStage = null;
      gameState = newState;
    } else if (!force && gameState && newSess === curSess && newVer < curVer) {
      // Ignore stale response from lagging container
      return;
    } else {
      localStorage.setItem('danarakca_session_id', String(newSess));
      gameState = newState;
    }

    if (newState.live_channel && newState.live_channel !== currentLiveChannel) {
      initRealtimeStream(newState.live_channel);
    }

    updateHeaderRoundInfo();
    updateStageInputStatus();
    updateCardPreview();
  }

  if (newParticipant) {
    if (newParticipant.code && currentUser && currentUser.code !== newParticipant.code) {
      currentUser.code = newParticipant.code;
      localStorage.setItem('danarakca_code', newParticipant.code);
    }
    if (newParticipant.allocations && typeof newParticipant.allocations === 'object') {
      savedAllocations = { ...newParticipant.allocations, ...savedAllocations };
      persistSavedAllocations();
    }
    participantData = newParticipant;
    updateParticipantUI();
  }
}

// 2. Fetch Data (Single Atomic Sync Request)
async function fetchStateAndParticipant() {
  if (!currentUser || submitInFlight) return;

  try {
    const res = await fetch('/api/player/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: currentUser.name,
        code: currentUser.code,
        participant_sync: buildParticipantSync()
      })
    });
    const json = await res.json();
    if (json.success && json.data && !submitInFlight) {
      applyPlayerSyncResponse(json.data.state, json.data.participant, false);
    }
  } catch (err) {
    console.error('Error syncing participant data:', err);
  }
}

function updateHeaderRoundInfo() {
  if (!gameState) return;
  const round = gameState.current_round;
  const total = gameState.total_rounds;
  const stage = gameState.current_stage;
  document.getElementById('headerRoundInfo').innerText = `Putaran ${round}/${total} · Tahap ${stage}`;
  document.getElementById('labelCurrentStage').innerText = `Tahap ${stage}`;
}

function updateParticipantUI() {
  if (!participantData || !gameState) return;

  document.getElementById('displayTotalAsset').innerText = formatRupiah(participantData.current_value);

  const initial = gameState.config.initial_capital;
  const ret = (participantData.current_value / initial) - 1;
  const retEl = document.getElementById('displayReturn');
  retEl.innerText = formatPercent(ret);
  if (ret >= 0) {
    retEl.className = 'font-mono tabular text-pulse';
  } else {
    retEl.className = 'font-mono tabular text-loss';
  }

  // Drawdown with high-contrast color according to financial risk definitions
  const mdd = participantData.max_drawdown || 0;
  const mddEl = document.getElementById('displayMaxDd');
  mddEl.innerText = formatPercent(mdd, false);
  if (mdd === 0) {
    mddEl.className = 'font-mono text-smoke tabular';
  } else if (mdd <= 0.05) {
    mddEl.className = 'font-mono text-[#f5b721] tabular font-medium';
  } else if (mdd <= 0.10) {
    mddEl.className = 'font-mono text-[#fb923c] tabular font-bold';
  } else {
    mddEl.className = 'font-mono text-loss tabular font-bold';
  }

  const totalPart = Math.max(1, gameState.total_participants || 1);
  document.getElementById('displayRank').innerText = `Peringkat #${participantData.current_rank} / ${totalPart}`;

  // Only initialize/sync sliders once per stage transition so polling never moves sliders by itself
  const currStage = gameState.current_stage;
  if (lastLoadedStage !== currStage && !userIsEditing) {
    const stageKey = String(currStage);
    const stageAlloc = savedAllocations[stageKey] || participantData.allocations?.[stageKey];
    if (stageAlloc) {
      allocation = { ...stageAlloc };
    } else {
      for (let s = currStage - 1; s >= 1; s--) {
        const prevAlloc = savedAllocations[String(s)] || participantData.allocations?.[String(s)];
        if (prevAlloc) {
          allocation = { ...prevAlloc };
          break;
        }
      }
    }
    syncSliders();
    lastLoadedStage = currStage;
  }
}

function updateStageInputStatus() {
  if (!gameState) return;
  const banner = document.getElementById('allocationBanner');
  const btnSubmit = document.getElementById('btnSubmitAllocation');
  const presetsGroup = document.getElementById('presetButtonsGroup');
  const isOpen = gameState.stage_input_open;
  if (gameState.status === 'GAME_FINISHED') {
    banner.className = 'p-3.5 rounded-card hairline bg-carbon text-caption flex items-center justify-between gap-3 border-pulse/30';
    banner.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-1.5 h-1.5 rounded-full bg-pulse shrink-0 animate-pulse"></span>
        <div>
          <div class="text-pulse font-mono text-[12px] font-semibold">Simulasi Selesai</div>
          <div class="text-smoke text-[11px]">Seluruh putaran telah usai. Cek pengumuman pemenang di layar proyektor booth.</div>
        </div>
      </div>
    `;
    btnSubmit.disabled = true;
    presetsGroup.classList.add('opacity-40', 'pointer-events-none');
    enableSliders(false);
    return;
  }

  const currentStage = gameState.current_stage;

  if (isOpen) {
    banner.className = 'p-3.5 rounded-card hairline bg-carbon text-caption flex items-center justify-between gap-3';
    banner.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-1.5 h-1.5 rounded-full bg-chalk shrink-0"></span>
        <div>
          <div class="text-chalk font-mono text-[12px]">Sesi Alokasi Tahap ${currentStage} Terbuka</div>
          <div class="text-smoke text-[11px]">Silakan sesuaikan alokasi portofolio tim lalu simpan.</div>
        </div>
      </div>
    `;
    checkTotalSum();
    presetsGroup.classList.remove('opacity-40', 'pointer-events-none');
    enableSliders(true);
  } else {
    banner.className = 'p-3.5 rounded-card hairline bg-carbon text-caption flex items-center justify-between gap-3';
    banner.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-1.5 h-1.5 rounded-full bg-iron shrink-0"></span>
        <div>
          <div class="text-ash font-mono text-[12px]">Sesi Alokasi Ditutup</div>
          <div class="text-smoke text-[11px]">Putaran sedang berlangsung. Menunggu arahan fasilitator.</div>
        </div>
      </div>
    `;
    btnSubmit.disabled = true;
    presetsGroup.classList.add('opacity-40', 'pointer-events-none');
    enableSliders(false);
  }
}

function enableSliders(enable) {
  ['sukuk', 'saham', 'rdpu', 'emas', 'campuran'].forEach(asset => {
    const el = document.getElementById(`range${capitalize(asset)}`);
    if (el) el.disabled = !enable;
  });
  const btnAuto = document.getElementById('btnAutoBalance');
  if (btnAuto) btnAuto.disabled = !enable;
}

function updateCardPreview() {
  const preview = document.getElementById('playerCardPreview');
  if (!preview) return;
  if (!gameState || !gameState.last_drawn_card || !gameState.last_drawn_card.card) {
    preview.classList.add('hidden');
    return;
  }
  const lastCard = gameState.last_drawn_card;
  const card = lastCard.card;
  lastProcessedCardRound = lastCard.round;

  preview.classList.remove('hidden');
  document.getElementById('previewRound').innerText = `Putaran ${lastCard.round} · ${card.id}`;
  document.getElementById('previewCategory').innerText = card.category;
  document.getElementById('previewTitle').innerText = card.title;
  document.getElementById('previewNarration').innerText = card.narration;
}

// 3. Sliders & Presets
function onSliderChange(asset, value) {
  userIsEditing = true;
  let targetVal = Math.max(0, Math.min(100, parseInt(value, 10) || 0));

  const assetKeys = ['sukuk', 'saham', 'rdpu', 'emas', 'campuran'];
  const otherKeys = assetKeys.filter(k => k !== asset);
  const otherSum = otherKeys.reduce((sum, k) => sum + (allocation[k] || 0), 0);
  const total = targetVal + otherSum;

  if (total > 100) {
    let excess = total - 100;
    if (otherSum > 0) {
      let remainingExcess = excess;
      const sortedOthers = [...otherKeys].sort((a, b) => allocation[b] - allocation[a]);
      for (const k of sortedOthers) {
        const deduct = Math.min(allocation[k], Math.round(excess * (allocation[k] / otherSum)));
        allocation[k] -= deduct;
        remainingExcess -= deduct;
      }
      if (remainingExcess > 0) {
        for (const k of sortedOthers) {
          const deduct = Math.min(allocation[k], remainingExcess);
          allocation[k] -= deduct;
          remainingExcess -= deduct;
          if (remainingExcess <= 0) break;
        }
      } else if (remainingExcess < 0) {
        allocation[sortedOthers[0]] -= remainingExcess;
      }
    } else {
      targetVal = 100;
    }
  }

  allocation[asset] = targetVal;
  syncSliders();

  if (navigator.vibrate && allocation[asset] % 10 === 0) {
    try { navigator.vibrate(6); } catch (e) {}
  }
}

function autoBalanceAllocation() {
  userIsEditing = true;
  const assetKeys = ['sukuk', 'saham', 'rdpu', 'emas', 'campuran'];
  const currentSum = assetKeys.reduce((s, k) => s + (allocation[k] || 0), 0);

  if (currentSum === 100) return;

  if (currentSum === 0) {
    allocation = { sukuk: 20, saham: 20, rdpu: 20, emas: 20, campuran: 20 };
  } else {
    let scaled = {};
    let newSum = 0;
    assetKeys.forEach(k => {
      scaled[k] = Math.round((allocation[k] / currentSum) * 100);
      newSum += scaled[k];
    });

    let diff = 100 - newSum;
    if (diff !== 0) {
      const maxKey = assetKeys.reduce((max, k) => scaled[k] > scaled[max] ? k : max, assetKeys[0]);
      scaled[maxKey] += diff;
    }
    allocation = scaled;
  }

  if (navigator.vibrate) {
    try { navigator.vibrate([15, 30, 15]); } catch (e) {}
  }

  syncSliders();
  showToast('Alokasi berhasil diseimbangkan pas 100%', 'info');
}

function checkTotalSum() {
  const sum = allocation.sukuk + allocation.saham + allocation.rdpu + allocation.emas + allocation.campuran;
  const sumBadge = document.getElementById('sumBadge');
  const btnSubmit = document.getElementById('btnSubmitAllocation');
  const btnAutoBalance = document.getElementById('btnAutoBalance');
  if (!sumBadge) return;

  sumBadge.innerText = `Total: ${sum}%`;

  if (sum === 100) {
    sumBadge.className = 'px-3.5 py-1.5 rounded-button font-mono text-sm font-semibold tabular border bg-obsidian text-white border-chalk shadow-sm';
    if (btnAutoBalance) btnAutoBalance.classList.add('hidden');
    if (gameState && gameState.stage_input_open && btnSubmit) {
      btnSubmit.disabled = false;
    }
  } else {
    sumBadge.className = 'px-3.5 py-1.5 rounded-button font-mono text-sm font-semibold tabular border bg-obsidian text-loss border-loss shadow-sm';
    if (btnAutoBalance) {
      btnAutoBalance.classList.remove('hidden');
      if (sum < 100) {
        btnAutoBalance.innerText = `⚡ Seimbangkan 100% (+${100 - sum}%)`;
      } else {
        btnAutoBalance.innerText = `⚡ Seimbangkan 100%`;
      }
    }
    if (btnSubmit) btnSubmit.disabled = true;
  }
}

function syncSliders() {
  ['sukuk', 'saham', 'rdpu', 'emas', 'campuran'].forEach(asset => {
    const el = document.getElementById(`range${capitalize(asset)}`);
    const valEl = document.getElementById(`val${capitalize(asset)}`);
    if (el) el.value = allocation[asset];
    if (valEl) valEl.innerText = `${allocation[asset]}%`;
  });
  checkTotalSum();
}

function applyPreset(type) {
  userIsEditing = true;
  if (type === 'rata') {
    allocation = { sukuk: 20, saham: 20, rdpu: 20, emas: 20, campuran: 20 };
  } else if (type === 'konservatif') {
    allocation = { sukuk: 50, saham: 10, rdpu: 25, emas: 10, campuran: 5 };
  } else if (type === 'agresif') {
    allocation = { sukuk: 10, saham: 60, rdpu: 10, emas: 10, campuran: 10 };
  }
  if (navigator.vibrate) {
    try { navigator.vibrate(12); } catch (e) {}
  }
  syncSliders();
}

async function handleAllocationSubmit(e) {
  e.preventDefault();
  if (!gameState || !currentUser) return;

  const sum = allocation.sukuk + allocation.saham + allocation.rdpu + allocation.emas + allocation.campuran;
  if (sum !== 100) {
    showToast(`Total alokasi harus tepat 100% (saat ini ${sum}%)`, 'error');
    return;
  }

  const btn = document.getElementById('btnSubmitAllocation');
  btn.disabled = true;
  btn.innerText = 'Menyimpan...';
  submitInFlight = true;

  const stageKey = String(gameState.current_stage);
  savedAllocations[stageKey] = { ...allocation };
  persistSavedAllocations();

  try {
    const res = await fetch('/api/participant/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: currentUser.code,
        name: currentUser.name,
        stage: gameState.current_stage,
        allocation: allocation,
        participant_sync: buildParticipantSync()
      })
    });
    const json = await res.json();
    if (json.success) {
      if (navigator.vibrate) {
        try { navigator.vibrate([15, 50, 20]); } catch (e) {}
      }
      showToast(`Alokasi portofolio Tahap ${gameState.current_stage} berhasil disimpan!`, 'success');
      userIsEditing = false;
      lastLoadedStage = gameState.current_stage;
      applyPlayerSyncResponse(json.state, json.participant, true);
    } else {
      showToast(json.error || 'Gagal menyimpan alokasi', 'error');
    }
  } catch (err) {
    showToast('Koneksi server gagal: ' + err.message, 'error');
  } finally {
    submitInFlight = false;
    btn.disabled = false;
    btn.innerText = 'Simpan Alokasi Tahap Ini ↗';
    checkTotalSum();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initRealtimeStream();
  initAuth();
  // Active fallback polling: checks every 1200ms when screen active
  setInterval(() => {
    if (!document.hidden) fetchStateAndParticipant();
  }, 1200);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchStateAndParticipant();
  });
});
