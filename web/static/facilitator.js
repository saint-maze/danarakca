// Facilitator View Logic — Hyperstudio Dark Editorial Edition

let gameState = null;
let currentTab = 'top10'; // 'top10' or 'tangguh'
let chartTopPlayers = null;
let chartAssetIndexes = null;

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

// Chart.js initialization with DESIGN.md color tokens
function initCharts() {
  const chartOptionsBase = {
    responsive: true,
    maintainAspectRatio: false,
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
    const json = await res.json();
    if (!json.success || !json.authenticated) {
      localStorage.removeItem('danarakca_admin_token');
      window.location.href = 'admin-login.html';
      return false;
    }
    return true;
  } catch (err) {
    console.error('Auth verification error:', err);
    return true;
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

// In-App Toast Notification (Pengganti alert() basic)
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
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

// Modal Konfirmasi Operasional (Pengganti confirm() basic)
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
      if (isDanger) {
        btnOk.className = 'btn-pill text-caption py-2 px-5 bg-loss text-chalk hover:bg-loss/80 transition-colors cursor-pointer';
      } else {
        btnOk.className = 'btn-pill text-caption py-2 px-5 cursor-pointer';
      }
      btnOk.onclick = () => {
        const checked = checkboxEl ? checkboxEl.checked : false;
        closeConfirmModal(true, checked);
      };
    }

    const modal = document.getElementById('modalConfirm');
    if (modal) modal.classList.remove('hidden');
  });
}

function closeConfirmModal(result = false, extraData = false) {
  const modal = document.getElementById('modalConfirm');
  if (modal) modal.classList.add('hidden');
  if (confirmResolver) {
    const res = confirmResolver;
    confirmResolver = null;
    res({ confirmed: !!result, checkbox: !!extraData });
  }
}

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    const json = await res.json();
    if (json.success) {
      gameState = json.data;
      renderUI();
    }
  } catch (err) {
    console.error('Error fetching state:', err);
  }
}

function renderUI() {
  if (!gameState) return;

  const round = gameState.current_round;
  const totalRounds = gameState.total_rounds;

  // Badges
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

  const top1 = gameState.leaderboard_top10[0];
  if (top1) {
    document.getElementById('badgeHighestWealth').innerText = formatJuta(top1.current_value);
  } else {
    document.getElementById('badgeHighestWealth').innerText = 'Rp 100,0 Jt';
  }

  // Draw Button
  const nextRound = round + 1;
  const btnDraw = document.getElementById('btnDrawCard');
  const btnDrawText = document.getElementById('btnDrawCardText');

  if (round >= totalRounds) {
    btnDraw.disabled = true;
    btnDrawText.innerText = 'Permainan Selesai';
  } else {
    btnDraw.disabled = false;
    btnDrawText.innerText = `Kocok Kartu Putaran ${nextRound}`;
  }

  // Toggle Input Button
  const btnToggle = document.getElementById('btnToggleInput');
  const btnToggleText = document.getElementById('btnToggleInputText');
  if (gameState.stage_input_open) {
    btnToggleText.innerText = 'Input Alokasi: Terbuka';
    btnToggle.classList.remove('opacity-60');
  } else {
    btnToggleText.innerText = 'Input Alokasi: Ditutup';
    btnToggle.classList.add('opacity-60');
  }

  // Next Stage Button
  const btnNextStage = document.getElementById('btnNextStage');
  const btnNextStageText = document.getElementById('btnNextStageText');
  const currentStage = gameState.current_stage;
  const roundsPerStage = gameState.rounds_per_stage;

  if (currentStage < gameState.total_stages && round >= currentStage * roundsPerStage) {
    btnNextStage.disabled = false;
    btnNextStageText.innerText = `Maju ke Tahap ${currentStage + 1}`;
  } else {
    btnNextStage.disabled = true;
    btnNextStageText.innerText = currentStage >= gameState.total_stages ? 'Tahap Akhir' : `Maju ke Tahap ${currentStage + 1}`;
  }

  // Card Content
  const lastCard = gameState.last_drawn_card;
  const placeholder = document.getElementById('cardPlaceholder');
  const cardContent = document.getElementById('cardContent');

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

    const ret = lastCard.returns;
    const baseSukuk = gameState.config.assets.find(a => a.id === 'sukuk')?.base_return || 0;
    const baseSaham = gameState.config.assets.find(a => a.id === 'saham')?.base_return || 0;
    const baseRdpu = gameState.config.assets.find(a => a.id === 'rdpu')?.base_return || 0;
    const baseEmas = gameState.config.assets.find(a => a.id === 'emas')?.base_return || 0;
    const baseCampuran = gameState.config.assets.find(a => a.id === 'campuran')?.base_return || 0;

    setImpactUI('Sukuk', ret.sukuk, baseSukuk, c.return_sukuk);
    setImpactUI('Saham', ret.saham, baseSaham, c.return_saham);
    setImpactUI('Rdpu', ret.rdpu, baseRdpu, c.return_rdpu);
    setImpactUI('Emas', ret.emas, baseEmas, c.return_emas);
    setImpactUI('Campuran', ret.campuran, baseCampuran, c.return_campuran);
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
  if (totalReturn > 0) {
    el.className = 'text-heading-xs text-pulse tabular font-normal';
  } else if (totalReturn < 0) {
    el.className = 'text-heading-xs text-loss tabular font-normal';
  } else {
    el.className = 'text-heading-xs text-smoke tabular font-normal';
  }

  sub.innerText = `Dasar ${formatPercent(baseReturn)} · K ${formatPercent(cardEffect)}`;
}

function renderRecentCards() {
  const container = document.getElementById('recentCardsList');
  if (!gameState.recent_cards || gameState.recent_cards.length === 0) {
    container.innerHTML = '<div class="text-caption text-smoke italic py-2">Belum ada riwayat kartu sebelumnya.</div>';
    return;
  }

  container.innerHTML = gameState.recent_cards.map(c => `
    <div class="flex items-center justify-between p-3 panel bg-obsidian text-caption">
      <div class="flex items-center gap-3">
        <span class="font-mono text-ash text-[11px] border border-graphite px-1.5 py-0.5 rounded-tag">
          Q${c.round}
        </span>
        <span class="text-chalk">${c.card.title}</span>
      </div>
      <span class="meta text-[11px]">${c.card.category}</span>
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
    btn10.className = 'px-2.5 py-1 rounded-card bg-chalk text-obsidian transition-colors';
    btnT.className = 'px-2.5 py-1 rounded-card text-smoke hover:text-chalk transition-colors';
    title.innerText = 'Papan Peringkat (Top 10)';
    sub.innerText = 'Akumulasi total portofolio tertinggi';
  } else {
    btnT.className = 'px-2.5 py-1 rounded-card bg-chalk text-obsidian transition-colors';
    btn10.className = 'px-2.5 py-1 rounded-card text-smoke hover:text-chalk transition-colors';
    title.innerText = 'Investor Tangguh (Max DD ≤ 10%)';
    sub.innerText = 'Portofolio tertinggi dengan disiplin drawdown';
  }
  renderLeaderboard();
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboardTbody');
  if (!tbody || !gameState) return;

  const list = currentTab === 'top10' ? gameState.leaderboard_top10 : gameState.investor_tangguh_top5;

  if (!list || list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-10 text-smoke italic">
          ${currentTab === 'top10' ? 'Menunggu peserta mendaftar...' : 'Belum ada peserta yang memenuhi syarat Max DD ≤ 10%'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list.map((p, idx) => {
    const rankNum = idx + 1;

    // Rank delta indicator
    const delta = p.prev_rank - p.current_rank;
    let deltaHtml = '<span class="rank-same">–</span>';
    if (delta > 0) {
      deltaHtml = `<span class="rank-up font-mono">↑${delta}</span>`;
    } else if (delta < 0) {
      deltaHtml = `<span class="rank-down font-mono">↓${Math.abs(delta)}</span>`;
    }

    const initial = gameState.config.initial_capital;
    const returnPct = ((p.current_value / initial - 1) * 100).toFixed(1).replace('.', ',');
    const returnSign = (p.current_value >= initial ? '+' : '') + returnPct + '%';
    const returnColor = p.current_value >= initial ? 'text-pulse' : 'text-loss';
    const mddPct = (p.max_drawdown * 100).toFixed(1).replace('.', ',') + '%';

    return `
      <tr class="hover:bg-carbon transition-colors">
        <td class="py-2.5 px-1 text-center font-mono text-ash">${rankNum}</td>
        <td class="py-2.5 px-1 text-center">${deltaHtml}</td>
        <td class="py-2.5 px-2">
          <div class="text-chalk truncate max-w-[140px] sm:max-w-none">${p.name}</div>
          <div class="text-[10px] text-smoke font-mono">${p.code}</div>
        </td>
        <td class="py-2.5 px-2 text-right font-mono text-chalk">${formatRupiah(p.current_value)}</td>
        <td class="py-2.5 px-1 text-right font-mono ${returnColor}">${returnSign}</td>
        <td class="py-2.5 px-1 text-right font-mono text-smoke">${mddPct}</td>
      </tr>
    `;
  }).join('');
}

function updateCharts() {
  if (!gameState || !chartTopPlayers || !chartAssetIndexes) return;

  const currentRound = gameState.current_round;
  const labels = ['Awal'];
  for (let r = 1; r <= currentRound; r++) {
    labels.push(`K${r}`);
  }

  // Top 5 Players
  const top5 = gameState.leaderboard_top10.slice(0, 5);
  const lineColors = ['#f3f3f3', '#8fb3d9', '#8fd9a8', '#d9c38f', '#b38fd9'];

  const playerDatasets = top5.map((p, idx) => ({
    label: p.name,
    data: p.history.map(h => h.value),
    borderColor: lineColors[idx % lineColors.length],
    backgroundColor: lineColors[idx % lineColors.length],
    tension: 0.2,
    borderWidth: 1.5,
    pointRadius: 2
  }));

  chartTopPlayers.data.labels = labels;
  chartTopPlayers.data.datasets = playerDatasets;
  chartTopPlayers.update('none');

  // Asset Benchmark Indexes
  chartAssetIndexes.data.labels = labels;
  if (gameState.asset_history) {
    chartAssetIndexes.data.datasets[0].data = gameState.asset_history.sukuk;
    chartAssetIndexes.data.datasets[1].data = gameState.asset_history.saham;
    chartAssetIndexes.data.datasets[2].data = gameState.asset_history.rdpu;
    chartAssetIndexes.data.datasets[3].data = gameState.asset_history.emas;
    chartAssetIndexes.data.datasets[4].data = gameState.asset_history.campuran;
  }
  chartAssetIndexes.update('none');
}

async function drawCard() {
  const btn = document.getElementById('btnDrawCard');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/facilitator/draw-card', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getAdminToken()
      },
      body: JSON.stringify({})
    });
    const json = await res.json();
    if (json.success) {
      gameState = json.state;
      renderUI();
      if (gameState.current_card) {
        showToast(`Kartu Putaran ${gameState.current_round} terbuka: ${gameState.current_card.title}`, 'success');
      }
    } else {
      if (res.status === 403) {
        showToast('Sesi fasilitator berakhir', 'error');
        window.location.href = 'admin-login.html';
        return;
      }
      showToast(json.error || 'Gagal mengocok kartu', 'error');
    }
  } catch (err) {
    showToast('Koneksi server gagal: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function toggleStageInput() {
  try {
    const res = await fetch('/api/facilitator/toggle-input', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getAdminToken()
      },
      body: JSON.stringify({})
    });
    const json = await res.json();
    if (json.success) {
      await fetchState();
      showToast(`Status alokasi: ${gameState && gameState.stage_input_allowed ? 'Terbuka' : 'Ditutup'}`, 'info');
    } else if (res.status === 403) {
      showToast('Sesi berakhir', 'error');
      window.location.href = 'admin-login.html';
    }
  } catch (err) {
    showToast('Gagal mengubah status alokasi: ' + err.message, 'error');
  }
}

async function advanceStage() {
  const nextStage = (gameState?.current_stage || 1) + 1;
  const res = await showConfirmDialog({
    meta: 'Tahap Simulasi',
    title: `Majukan ke Tahap ${nextStage}`,
    message: 'Alokasi portofolio baru akan dibuka untuk seluruh peserta pada Kuartal saat ini. Lanjutkan transisi tahap?',
    okText: 'Majukan Tahap'
  });
  if (!res.confirmed) return;

  try {
    const res = await fetch('/api/facilitator/next-stage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getAdminToken()
      },
      body: JSON.stringify({})
    });
    const json = await res.json();
    if (json.success) {
      gameState = json.state;
      renderUI();
      showToast(`Berhasil maju ke Tahap ${gameState.current_stage}`, 'success');
    } else {
      if (res.status === 403) {
        window.location.href = 'admin-login.html';
        return;
      }
      showToast(json.error || 'Gagal memajukan tahap', 'error');
    }
  } catch (err) {
    showToast('Koneksi server gagal: ' + err.message, 'error');
  }
}

async function seedMockUsers(count = 200) {
  const res = await showConfirmDialog({
    meta: 'Simulasi Beban',
    title: `Injeksi ${count} Bot Peserta`,
    message: `Sistem akan menambahkan ${count} portofolio simulasi bot dengan alokasi otomatis untuk menguji papan peringkat dan tolok ukur. Lanjutkan?`,
    okText: 'Mulai Injeksi'
  });
  if (!res.confirmed) return;

  try {
    const res = await fetch('/api/facilitator/seed-mock-users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getAdminToken()
      },
      body: JSON.stringify({ count: count })
    });
    const json = await res.json();
    if (json.success) {
      gameState = json.state;
      renderUI();
      showToast(`Berhasil menambahkan ${count} bot peserta`, 'success');
    } else {
      showToast(json.error || 'Gagal membuat bot peserta', 'error');
    }
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  }
}

function exportCSV() {
  window.open('/api/export', '_blank');
}

async function confirmReset() {
  const res = await showConfirmDialog({
    meta: 'Tindakan Kritis',
    title: 'Inisialisasi Ulang Simulasi (Reset Game)',
    message: 'Permainan akan dikembalikan ke Kuartal 0 dan riwayat transaksi akan dihapus. Anda dapat mempertahankan peserta yang telah mendaftar agar tidak perlu registrasi ulang.',
    okText: 'Reset Permainan',
    isDanger: true,
    showCheckbox: true,
    checkboxLabel: 'Pertahankan profil & kode akses peserta terdaftar'
  });
  if (!res.confirmed) return;
  const preserve = res.checkbox;

  try {
    const res = await fetch('/api/facilitator/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getAdminToken()
      },
      body: JSON.stringify({ preserve_participants: preserve })
    });
    const json = await res.json();
    if (json.success) {
      gameState = json.state;
      renderUI();
      showToast('Permainan berhasil direset ke Kuartal 0', 'success');
    } else {
      showToast('Gagal reset: ' + (json.error || 'Terjadi kesalahan'), 'error');
    }
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  }
}

function getPlayerUrl() {
  const saved = localStorage.getItem('danarakca_player_url');
  if (saved && saved.trim()) return saved.trim();
  if (gameState && gameState.config && gameState.config.public_url && gameState.config.public_url.trim()) {
    const pub = gameState.config.public_url.trim().replace(/\/+$/, '');
    return pub + '/player.html';
  }
  return window.location.origin + '/player.html';
}

function updateQRCodeImage(url) {
  const img = document.getElementById('qrImage');
  if (img) {
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(url)}`;
  }
}

function showQRModal() {
  const url = getPlayerUrl();
  const input = document.getElementById('inputPlayerUrl');
  if (input) input.value = url;
  updateQRCodeImage(url);
  document.getElementById('modalQR').classList.remove('hidden');
}

function hideQRModal() {
  document.getElementById('modalQR').classList.add('hidden');
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
  let defaultUrl = window.location.origin + '/player.html';
  if (gameState && gameState.config && gameState.config.public_url && gameState.config.public_url.trim()) {
    defaultUrl = gameState.config.public_url.trim().replace(/\/+$/, '') + '/player.html';
  }
  const input = document.getElementById('inputPlayerUrl');
  if (input) input.value = defaultUrl;
  updateQRCodeImage(defaultUrl);
  showToast('URL direset ke default (' + defaultUrl + ')', 'info');
}

window.addEventListener('DOMContentLoaded', async () => {
  const isAuthed = await verifyAdminAuth();
  if (!isAuthed) return;

  initCharts();
  await fetchState();
  setInterval(fetchState, 3000);
});
