// Player Front-End Logic (Hyperstudio Dark Editorial Edition)

const LIVE_CHANNEL = 'danarakca_live_fafc19b30c66';
let liveEventSource = null;
let currentLiveChannel = null;
let localBus = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    localBus = new BroadcastChannel('danarakca_live_bus');
    localBus.onmessage = (e) => {
      if (e.data && e.data.event) {
        handleRealtimeEvent(e.data, Date.now() / 1000);
      }
    };
  }
} catch (e) {}

const ASSET_KEYS = ['sukuk', 'saham', 'rdpu', 'emas', 'campuran'];
const DEFAULT_ALLOCATION = { sukuk: 20, saham: 20, rdpu: 20, emas: 20, campuran: 20 };
const PRESETS = {
  rata: { id: 'btnPresetRata', alloc: { ...DEFAULT_ALLOCATION } },
  konservatif: { id: 'btnPresetKonservatif', alloc: { sukuk: 50, saham: 10, rdpu: 25, emas: 10, campuran: 5 } },
  agresif: { id: 'btnPresetAgresif', alloc: { sukuk: 10, saham: 60, rdpu: 10, emas: 10, campuran: 10 } }
};

let currentUser = null;
let gameState = null;
let participantData = null;
let lastLogoutTrigger = null;

let allocation = { ...DEFAULT_ALLOCATION };

let userIsEditing = false;
let submitInFlight = false;
let lastLoadedStage = null;
let savedAllocations = {};
let savedAllocTs = {};

function getPlayerToken() {
  return localStorage.getItem('danarakca_player_token') || '';
}

function setPlayerSyncError(msg) {
  const banner = document.getElementById('playerSyncError');
  const txt = document.getElementById('playerSyncErrorText');
  if (!banner) return;
  if (msg) {
    if (txt) txt.innerText = msg;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function isStaleRealtimeEvent(msg, sentAtSec) {
  if (sentAtSec && (Date.now() / 1000 - sentAtSec) > 60) return true;
  if (!gameState) return false;
  const curSess = gameState.session_id || 0;
  const msgSess = msg.session_id || 0;
  if (msg.event === 'GAME_RESET') return msgSess <= curSess;
  return Boolean(msgSess && curSess && msgSess !== curSess);
}

// Treat external SSE events strictly as a wake-up signal to fetch authoritative server state
function handleRealtimeEvent(msg, sentAtSec) {
  if (!msg || !msg.event) return;
  if (isStaleRealtimeEvent(msg, sentAtSec)) return;

  if (msg.event === 'CARD_DRAWN' && navigator.vibrate) {
    try { navigator.vibrate([25, 40, 25]); } catch (e) {}
  }
  fetchStateAndParticipant();
}

let sseErrorCount = 0;
let isSseActive = false;

function initRealtimeStream(channel) {
  const targetChannel = channel || (gameState && gameState.live_channel) || LIVE_CHANNEL;
  if (liveEventSource && currentLiveChannel === targetChannel) return;
  if (liveEventSource) {
    try { liveEventSource.close(); } catch (e) {}
  }
  currentLiveChannel = targetChannel;
  sseErrorCount = 0;
  isSseActive = false;

  try {
    liveEventSource = new EventSource(`https://ntfy.sh/${targetChannel}/sse?since=now`);
    liveEventSource.onopen = () => {
      sseErrorCount = 0;
      isSseActive = true;
    };
    liveEventSource.onmessage = (e) => {
      try {
        const raw = JSON.parse(e.data);
        if (raw.event !== 'message' || !raw.message) return;
        const msg = typeof raw.message === 'string' ? JSON.parse(raw.message) : raw.message;
        handleRealtimeEvent(msg, raw.time);
      } catch (err) {
        fetchStateAndParticipant();
      }
    };
    liveEventSource.onerror = () => {
      sseErrorCount++;
      isSseActive = false;
      if (liveEventSource && (liveEventSource.readyState === EventSource.CLOSED || sseErrorCount >= 2)) {
        try { liveEventSource.close(); } catch (e) {}
        liveEventSource = null;
      }
    };
  } catch (err) {
    isSseActive = false;
    liveEventSource = null;
  }
}

function readStoredJsonObject(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {}
  return {};
}

function loadSavedAllocations() {
  savedAllocations = readStoredJsonObject('danarakca_allocations');
  savedAllocTs = readStoredJsonObject('danarakca_alloc_ts');
}

function persistSavedAllocations() {
  try {
    localStorage.setItem('danarakca_allocations', JSON.stringify(savedAllocations));
    localStorage.setItem('danarakca_alloc_ts', JSON.stringify(savedAllocTs));
  } catch (e) {}
}

function buildParticipantSync() {
  if (!currentUser) return null;
  const savedSess = parseInt(localStorage.getItem('danarakca_session_id') || '0', 10);
  return {
    code: currentUser.code,
    name: currentUser.name,
    session_id: gameState ? (gameState.session_id || savedSess) : savedSess,
    allocations: savedAllocations,
    alloc_ts: savedAllocTs
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

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainerPlayer');
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

function initAuth() {
  loadSavedAllocations();
  const savedName = localStorage.getItem('danarakca_name');
  const savedCode = localStorage.getItem('danarakca_code');
  const savedToken = getPlayerToken();

  if (savedName && savedToken) {
    currentUser = { code: savedCode || savedName, name: savedName };
    showDashboard();
  } else {
    clearPlayerSession();
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('dashboardScreen').classList.add('hidden');
  document.getElementById('userHeaderBadge').classList.add('hidden');
  document.getElementById('userHeaderBadge').classList.remove('flex');
  const hdrInfo = document.getElementById('headerRoundInfo');
  if (hdrInfo) hdrInfo.innerText = 'Peserta';
  setPlayerSyncError(null);
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

  syncPresetPressedState();
  fetchStateAndParticipant();
}

async function handleLogin(e) {
  e.preventDefault();
  const inputEl = document.getElementById('inputName');
  const btnEl = document.getElementById('btnLoginSubmit');
  const name = inputEl ? inputEl.value.trim() : '';

  if (!name) {
    showToast('Nama peserta / tim wajib diisi', 'error');
    return;
  }

  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerText = 'Memproses...';
  }

  try {
    const res = await fetch('/api/participant/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Participant-Token': getPlayerToken()
      },
      body: JSON.stringify({
        name: name,
        participant_token: getPlayerToken()
      })
    });
    const json = await res.json();
    if (res.ok && json.success && json.data) {
      const p = json.data;
      localStorage.setItem('danarakca_code', p.code);
      localStorage.setItem('danarakca_name', p.name);
      if (json.participant_token) {
        localStorage.setItem('danarakca_player_token', json.participant_token);
      }
      if (json.state && json.state.session_id) {
        localStorage.setItem('danarakca_session_id', String(json.state.session_id));
      }
      if (p.allocations && Object.keys(p.allocations).length > 0) {
        savedAllocations = { ...p.allocations };
        savedAllocTs = (p.alloc_ts && typeof p.alloc_ts === 'object') ? { ...p.alloc_ts } : {};
        persistSavedAllocations();
      }
      currentUser = { code: p.code, name: p.name };
      lastLoadedStage = null;
      setPlayerSyncError(null);
      showDashboard();
    } else {
      showToast(json.error || 'Gagal mendaftar', 'error');
    }
  } catch (err) {
    showToast('Koneksi server gagal: ' + err.message, 'error');
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerText = 'Masuk';
    }
  }
}

function logout() {
  lastLogoutTrigger = document.activeElement;
  const modal = document.getElementById('modalConfirmPlayer');
  if (modal) {
    modal.classList.remove('hidden');
    const cancelBtn = document.getElementById('btnCancelLogoutPlayer');
    if (cancelBtn) cancelBtn.focus();
  }
}

function closePlayerModal() {
  const modal = document.getElementById('modalConfirmPlayer');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  if (lastLogoutTrigger && typeof lastLogoutTrigger.focus === 'function') {
    lastLogoutTrigger.focus();
    lastLogoutTrigger = null;
  }
}

function confirmLogoutAction() {
  lastLogoutTrigger = null;
  closePlayerModal();
  clearPlayerSession();
  showLogin();
  const inputName = document.getElementById('inputName');
  if (inputName) inputName.focus();
}

function clearPlayerSession() {
  localStorage.removeItem('danarakca_code');
  localStorage.removeItem('danarakca_name');
  localStorage.removeItem('danarakca_player_token');
  localStorage.removeItem('danarakca_allocations');
  localStorage.removeItem('danarakca_alloc_ts');
  localStorage.removeItem('danarakca_session_id');
  currentUser = null;
  participantData = null;
  savedAllocations = {};
  savedAllocTs = {};
  allocation = { ...DEFAULT_ALLOCATION };
  userIsEditing = false;
  lastLoadedStage = null;
}

// Facilitator reset without keeping participants: send player cleanly back to login
function forceRelogin(newState) {
  if (!currentUser) return;
  const prevName = currentUser.name;
  clearPlayerSession();
  gameState = newState || null;
  showLogin();
  const inputEl = document.getElementById('inputName');
  if (inputEl) inputEl.value = prevName || '';
  showToast('Sesi permainan diperbarui. Silakan masuk kembali untuk bergabung.', 'info');
}

function applyPlayerSyncResponse(newState, newParticipant, force = false) {
  if (newState) {
    const savedSess = parseInt(localStorage.getItem('danarakca_session_id') || '0', 10);
    const curSess = gameState ? (gameState.session_id || savedSess) : savedSess;
    const newSess = newState.session_id || 1;
    const curVer = gameState ? (gameState.state_version || 0) : 0;
    const newVer = newState.state_version || 0;

    if (!force && curSess > 0 && newSess < curSess) return;

    if (curSess > 0 && newSess !== curSess) {
      savedAllocations = {};
      savedAllocTs = {};
      persistSavedAllocations();
      allocation = { ...DEFAULT_ALLOCATION };
      userIsEditing = false;
      lastLoadedStage = null;
    } else if (gameState && newSess === curSess) {
      const curEpoch = gameState.roster_epoch || 0;
      const newEpoch = newState.roster_epoch || 0;
      const curRound = gameState.current_round || 0;
      const newRound = newState.current_round || 0;
      const curTotalP = gameState.total_participants || 0;
      const newTotalP = newState.total_participants || 0;

      if (!force) {
        if (newEpoch < curEpoch) return;
        if (newEpoch === curEpoch) {
          if (newRound < curRound) return;
          if (newRound === curRound && newTotalP < curTotalP) return;
          if (newVer < curVer && newRound <= curRound && newTotalP <= curTotalP) return;
        }
      } else if (newEpoch === curEpoch && (newRound < curRound || newTotalP < curTotalP)) {
        newState.current_round = Math.max(curRound, newRound);
        newState.total_participants = Math.max(curTotalP, newTotalP);
        newState.current_stage = Math.max(gameState.current_stage || 1, newState.current_stage || 1);
        if (participantData && newParticipant) {
          newParticipant.current_rank = participantData.current_rank;
          newParticipant.current_value = participantData.current_value;
          newParticipant.max_drawdown = participantData.max_drawdown;
        }
      }
    }
    localStorage.setItem('danarakca_session_id', String(newSess));
    gameState = newState;

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
      const incAllocs = newParticipant.allocations;
      const incTsMap = (newParticipant.alloc_ts && typeof newParticipant.alloc_ts === 'object') ? newParticipant.alloc_ts : {};
      for (const stg of Object.keys(incAllocs)) {
        const incTs = Number(incTsMap[stg] || 0);
        const curTs = Number(savedAllocTs[stg] || 0);
        if (!savedAllocations[stg] || incTs > curTs) {
          savedAllocations[stg] = { ...incAllocs[stg] };
          savedAllocTs[stg] = Math.max(curTs, incTs, 1);
        }
      }
      persistSavedAllocations();
    }
    participantData = newParticipant;
    updateParticipantUI();
  }
}

async function fetchStateAndParticipant() {
  if (!currentUser || submitInFlight) return;
  const sentName = currentUser.name;

  try {
    const res = await fetch('/api/player/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Participant-Token': getPlayerToken()
      },
      body: JSON.stringify({
        name: currentUser.name,
        code: currentUser.code,
        participant_token: getPlayerToken(),
        participant_sync: buildParticipantSync()
      })
    });
    const json = await res.json();
    if (!currentUser || currentUser.name !== sentName) return;
    if (json.success && json.data && json.data.session_expired) {
      forceRelogin(json.data.state);
      return;
    }
    if (res.ok && json.success && json.data && !submitInFlight) {
      if (json.data.participant_token) {
        localStorage.setItem('danarakca_player_token', json.data.participant_token);
      }
      setPlayerSyncError(null);
      applyPlayerSyncResponse(json.data.state, json.data.participant, false);
    } else if (!res.ok || !json.success) {
      setPlayerSyncError(json.error || 'Gagal menyinkronkan data dengan server.');
    }
  } catch (err) {
    console.error('Error syncing participant data:', err);
    setPlayerSyncError('Koneksi ke server terputus. Coba lagi sebentar.');
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

  const mdd = participantData.max_drawdown || 0;
  const mddEl = document.getElementById('displayMaxDd');
  mddEl.innerText = formatPercent(mdd, false);
  if (mdd === 0) {
    mddEl.className = 'font-mono text-smoke tabular';
  } else if (mdd <= 0.10) {
    mddEl.className = 'font-mono text-ash tabular';
  } else {
    mddEl.className = 'font-mono text-loss tabular';
  }

  const totalPart = Math.max(1, gameState.total_participants || 1);
  document.getElementById('displayRank').innerText = `Peringkat #${participantData.current_rank} / ${totalPart}`;

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

  if (!gameState.stage_input_open && userIsEditing) {
    userIsEditing = false;
    const stageKey = String(currStage);
    const serverAlloc = savedAllocations[stageKey] || participantData.allocations?.[stageKey];
    if (serverAlloc) {
      allocation = { ...serverAlloc };
    }
    syncSliders();
  }
}

let lastAllocBannerKey = '';

function updateStageInputStatus() {
  if (!gameState) return;
  const banner = document.getElementById('allocationBanner');
  const presetsGroup = document.getElementById('presetButtonsGroup');
  const currentStage = Number(gameState.current_stage) || 1;
  const isFinished = gameState.status === 'GAME_FINISHED';
  const isEditable = !isFinished && Boolean(gameState.stage_input_open);
  const bannerKey = `${isFinished}:${isEditable}:${currentStage}`;

  if (banner && bannerKey !== lastAllocBannerKey) {
    lastAllocBannerKey = bannerKey;
    let borderCls = '';
    let dotCls = 'bg-smoke';
    let titleCls = 'text-ash';
    let titleText = 'Sesi Alokasi Ditutup';
    let descText = 'Putaran sedang berlangsung. Menunggu arahan fasilitator.';

    if (isFinished) {
      borderCls = 'border-pulse/30';
      dotCls = 'bg-pulse';
      titleCls = 'text-pulse';
      titleText = 'Simulasi Selesai';
      descText = 'Seluruh putaran telah usai. Cek pengumuman pemenang di layar proyektor booth.';
    } else if (isEditable) {
      dotCls = 'bg-pulse';
      titleCls = 'text-chalk';
      titleText = `Sesi Alokasi Tahap ${currentStage} Terbuka`;
      descText = 'Silakan sesuaikan alokasi portofolio tim lalu simpan.';
    }

    banner.className = `p-3.5 rounded-card hairline bg-carbon text-caption flex items-center justify-between gap-3 ${borderCls}`.trim();
    banner.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-1.5 h-1.5 rounded-full ${dotCls} shrink-0"></span>
        <div>
          <div class="${titleCls} font-mono text-[12px]">${titleText}</div>
          <div class="text-smoke text-[11px]">${descText}</div>
        </div>
      </div>
    `;
  }
  presetsGroup.classList.toggle('opacity-40', !isEditable);
  presetsGroup.classList.toggle('pointer-events-none', !isEditable);
  enableSliders(isEditable);
  checkTotalSum();
}

function enableSliders(enable) {
  ASSET_KEYS.forEach(asset => {
    const el = document.getElementById(`range${capitalize(asset)}`);
    if (el) el.disabled = !enable;
  });
  const btnAuto = document.getElementById('btnAutoBalance');
  if (btnAuto) btnAuto.disabled = !enable;
  Object.values(PRESETS).forEach(({ id }) => {
    const pBtn = document.getElementById(id);
    if (pBtn) pBtn.disabled = !enable;
  });
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

  preview.classList.remove('hidden');
  document.getElementById('previewRound').innerText = `Putaran ${lastCard.round} · ${card.id}`;
  document.getElementById('previewCategory').innerText = card.category;
  document.getElementById('previewTitle').innerText = card.title;
  document.getElementById('previewNarration').innerText = card.narration;
}

function onSliderChange(asset, value) {
  userIsEditing = true;
  let targetVal = Math.max(0, Math.min(100, parseInt(value, 10) || 0));

  const otherKeys = ASSET_KEYS.filter(k => k !== asset);
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
  const currentSum = ASSET_KEYS.reduce((s, k) => s + (allocation[k] || 0), 0);

  if (currentSum === 100) return;

  if (currentSum === 0) {
    allocation = { ...DEFAULT_ALLOCATION };
  } else {
    let scaled = {};
    let newSum = 0;
    ASSET_KEYS.forEach(k => {
      scaled[k] = Math.round((allocation[k] / currentSum) * 100);
      newSum += scaled[k];
    });

    let diff = 100 - newSum;
    if (diff !== 0) {
      const maxKey = ASSET_KEYS.reduce((max, k) => scaled[k] > scaled[max] ? k : max, ASSET_KEYS[0]);
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
  const sum = ASSET_KEYS.reduce((s, k) => s + (allocation[k] || 0), 0);
  const sumBadge = document.getElementById('sumBadge');
  const btnSubmit = document.getElementById('btnSubmitAllocation');
  const btnAutoBalance = document.getElementById('btnAutoBalance');
  if (!sumBadge) return;

  sumBadge.innerText = `Total: ${sum}%`;
  const inputAllowed = Boolean(gameState && gameState.stage_input_open && gameState.status !== 'GAME_FINISHED');

  if (sum === 100) {
    sumBadge.className = 'px-3.5 py-2 rounded-button font-mono text-sm tabular border bg-obsidian text-white border-chalk';
    if (btnAutoBalance) btnAutoBalance.classList.add('hidden');
    if (btnSubmit) {
      btnSubmit.disabled = submitInFlight || !inputAllowed;
    }
  } else {
    sumBadge.className = 'px-3.5 py-2 rounded-button font-mono text-sm tabular border bg-obsidian text-loss border-loss';
    if (btnAutoBalance) {
      btnAutoBalance.classList.remove('hidden');
      btnAutoBalance.innerText = sum < 100 ? `Seimbangkan (+${100 - sum}%)` : 'Seimbangkan 100%';
    }
    if (btnSubmit) btnSubmit.disabled = true;
  }
}

function syncPresetPressedState() {
  for (const { id, alloc } of Object.values(PRESETS)) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const match = ASSET_KEYS.every(k => allocation[k] === alloc[k]);
    btn.setAttribute('aria-pressed', match ? 'true' : 'false');
    btn.classList.toggle('bg-chalk', match);
    btn.classList.toggle('text-obsidian', match);
    btn.classList.toggle('bg-obsidian', !match);
    btn.classList.toggle('text-smoke', !match);
    btn.classList.toggle('hover:text-chalk', !match);
    btn.classList.toggle('hover:bg-carbon', !match);
  }
}

function syncSliders() {
  ASSET_KEYS.forEach(asset => {
    const el = document.getElementById(`range${capitalize(asset)}`);
    const valEl = document.getElementById(`val${capitalize(asset)}`);
    if (el) el.value = allocation[asset];
    if (valEl) valEl.innerText = `${allocation[asset]}%`;
  });
  syncPresetPressedState();
  checkTotalSum();
}

function applyPreset(type) {
  if (!PRESETS[type]) return;
  userIsEditing = true;
  allocation = { ...PRESETS[type].alloc };
  if (navigator.vibrate) {
    try { navigator.vibrate(12); } catch (e) {}
  }
  syncSliders();
}

async function handleAllocationSubmit(e) {
  e.preventDefault();
  if (!gameState || !currentUser || submitInFlight) return;

  const sum = ASSET_KEYS.reduce((s, k) => s + (allocation[k] || 0), 0);
  if (sum !== 100) {
    showToast(`Total alokasi harus tepat 100% (saat ini ${sum}%)`, 'error');
    return;
  }

  const btn = document.getElementById('btnSubmitAllocation');
  btn.disabled = true;
  btn.innerText = 'Menyimpan...';
  submitInFlight = true;

  const stageKey = String(gameState.current_stage);

  try {
    const res = await fetch('/api/participant/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Participant-Token': getPlayerToken()
      },
      body: JSON.stringify({
        code: currentUser.code,
        name: currentUser.name,
        stage: gameState.current_stage,
        allocation: allocation,
        participant_token: getPlayerToken(),
        participant_sync: buildParticipantSync()
      })
    });
    const json = await res.json();
    if (res.ok && json.success) {
      if (navigator.vibrate) {
        try { navigator.vibrate([15, 50, 20]); } catch (e) {}
      }
      showToast(`Alokasi portofolio Tahap ${gameState.current_stage} berhasil disimpan!`, 'success');
      userIsEditing = false;
      lastLoadedStage = gameState.current_stage;
      savedAllocations[stageKey] = { ...allocation };
      savedAllocTs[stageKey] = json.participant?.alloc_ts?.[stageKey] || Math.max((savedAllocTs[stageKey] || 0) + 1, Date.now());
      persistSavedAllocations();
      setPlayerSyncError(null);
      applyPlayerSyncResponse(json.state, json.participant, true);
    } else if (json.session_expired || res.status === 401) {
      forceRelogin(null);
    } else {
      showToast(json.error || 'Gagal menyimpan alokasi', 'error');
    }
  } catch (err) {
    showToast('Koneksi server gagal: ' + err.message, 'error');
  } finally {
    submitInFlight = false;
    btn.innerText = 'Simpan Alokasi Tahap Ini';
    checkTotalSum();
  }
}

let playerPollTimeout = null;

function schedulePlayerPoll() {
  if (playerPollTimeout) clearTimeout(playerPollTimeout);
  const baseInterval = isSseActive ? 5000 : 2400;
  const jitter = Math.floor(Math.random() * 800);

  playerPollTimeout = setTimeout(async () => {
    if (!document.hidden && currentUser) {
      await fetchStateAndParticipant();
    }
    schedulePlayerPoll();
  }, baseInterval + jitter);
}

window.addEventListener('DOMContentLoaded', () => {
  initRealtimeStream();
  initAuth();
  schedulePlayerPoll();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentUser) {
      fetchStateAndParticipant();
      schedulePlayerPoll();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePlayerModal();
      return;
    }
    if (e.key === 'Tab') {
      const modal = document.getElementById('modalConfirmPlayer');
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
    const modal = document.getElementById('modalConfirmPlayer');
    if (modal && e.target === modal) {
      closePlayerModal();
    }
  });
});
