// Player Front-End Logic — Hyperstudio Dark Editorial Edition

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
      currentUser = { code: p.code, name: p.name };
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
  currentUser = null;
  participantData = null;
  showLogin();
}

// 2. Fetch Data
async function fetchStateAndParticipant() {
  if (!currentUser) return;

  try {
    const resState = await fetch('/api/state');
    const jsonState = await resState.json();
    if (jsonState.success) {
      gameState = jsonState.data;
      updateHeaderRoundInfo();
      updateStageInputStatus();
      updateCardPreview();
    }

    const resPart = await fetch(`/api/participant/${currentUser.code}`);
    const jsonPart = await resPart.json();
    if (jsonPart.success) {
      participantData = jsonPart.data;
      updateParticipantUI();
    }
  } catch (err) {
    console.error('Error polling participant data:', err);
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
    // 0.1% - 5.0%: Mild drawdown (yellow warning)
    mddEl.className = 'font-mono text-[#f5b721] tabular font-medium';
  } else if (mdd <= 0.10) {
    // 5.1% - 10.0%: Moderate drawdown (orange alert near Investor Tangguh threshold)
    mddEl.className = 'font-mono text-[#fb923c] tabular font-bold';
  } else {
    // > 10.0%: Severe drawdown (high-contrast red)
    mddEl.className = 'font-mono text-loss tabular font-bold';
  }

  const totalPart = gameState.total_participants;
  document.getElementById('displayRank').innerText = `Peringkat #${participantData.current_rank} / ${totalPart}`;

  const stageAlloc = participantData.allocations?.[String(gameState.current_stage)];
  if (stageAlloc && !userIsEditing) {
    allocation = { ...stageAlloc };
    syncSliders();
  } else if (!userIsEditing && participantData.allocations) {
    for (let s = gameState.current_stage - 1; s >= 1; s--) {
      if (participantData.allocations[String(s)]) {
        allocation = { ...participantData.allocations[String(s)] };
        syncSliders();
        break;
      }
    }
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
    btnSubmit.disabled = false;
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
}

function updateCardPreview() {
  if (!gameState || !gameState.last_drawn_card) return;
  const preview = document.getElementById('playerCardPreview');
  const card = gameState.last_drawn_card.card;
  if (!card) return;

  preview.classList.remove('hidden');
  document.getElementById('previewRound').innerText = `Putaran ${gameState.last_drawn_card.round} · ${card.id}`;
  document.getElementById('previewCategory').innerText = card.category;
  document.getElementById('previewTitle').innerText = card.title;
  document.getElementById('previewNarration').innerText = card.narration;
}

// 3. Sliders & Presets
function onSliderChange(asset, value) {
  userIsEditing = true;
  allocation[asset] = parseInt(value, 10);
  document.getElementById(`val${capitalize(asset)}`).innerText = `${allocation[asset]}%`;
  if (navigator.vibrate && allocation[asset] % 10 === 0) {
    try { navigator.vibrate(6); } catch (e) {}
  }
  checkTotalSum();
}

function checkTotalSum() {
  const sum = allocation.sukuk + allocation.saham + allocation.rdpu + allocation.emas + allocation.campuran;
  const sumBadge = document.getElementById('sumBadge');
  const btnSubmit = document.getElementById('btnSubmitAllocation');
  if (!sumBadge) return;

  sumBadge.innerText = `Total: ${sum}%`;

  if (sum === 100) {
    sumBadge.className = 'px-3.5 py-1.5 rounded-button font-mono text-sm font-semibold tabular border bg-obsidian text-white border-chalk shadow-sm';
    if (gameState && gameState.stage_input_open && btnSubmit) {
      btnSubmit.disabled = false;
    }
  } else {
    sumBadge.className = 'px-3.5 py-1.5 rounded-button font-mono text-sm font-semibold tabular border bg-obsidian text-loss border-loss shadow-sm';
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

  try {
    const res = await fetch('/api/participant/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: currentUser.code,
        stage: gameState.current_stage,
        allocation: allocation
      })
    });
    const json = await res.json();
    if (json.success) {
      if (navigator.vibrate) {
        try { navigator.vibrate([15, 50, 20]); } catch (e) {}
      }
      showToast(`Alokasi portofolio Tahap ${gameState.current_stage} berhasil disimpan!`, 'success');
      userIsEditing = false;
      await fetchStateAndParticipant();
    } else {
      showToast(json.error || 'Gagal menyimpan alokasi', 'error');
    }
  } catch (err) {
    showToast('Koneksi server gagal: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Simpan Alokasi Tahap Ini ↗';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initAuth();
  // Battery & bandwidth friendly polling: pause when screen locked/tab hidden
  setInterval(() => {
    if (!document.hidden) fetchStateAndParticipant();
  }, 2500);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchStateAndParticipant();
  });
});
