import { CARDS } from '../data/cards.js';
import { CONFIG } from '../data/config.js';

const ADMIN_SALT = "danarakca_salt_2026";
const cardsById = new Map(CARDS.map(c => [c.id, c]));

function getKV(env) {
  return env.DANARAKCA_KV || env.GAME_KV || env.KV || null;
}

function initDefaultState() {
  return {
    status: 'WAITING_STAGE_1',
    current_round: 0,
    current_stage: 1,
    stage_input_open: true,
    total_rounds: CONFIG.total_rounds || 30,
    rounds_per_stage: CONFIG.rounds_per_stage || 10,
    total_stages: CONFIG.total_stages || 3,
    drawn_cards: [],
    available_cards: CARDS.map(c => c.id),
    participants: {},
    asset_indexes: {
      sukuk: 100.0,
      saham: 100.0,
      rdpu: 100.0,
      emas: 100.0,
      campuran: 100.0
    },
    asset_history: {
      sukuk: [100.0],
      saham: [100.0],
      rdpu: [100.0],
      emas: [100.0],
      campuran: [100.0]
    },
    message: 'Game dimulai. Silakan peserta mendaftar dan mengisi alokasi Tahap 1.'
  };
}

async function getState(env) {
  const kv = getKV(env);
  if (kv) {
    const raw = await kv.get('danarakca_state', 'json');
    if (raw) return raw;
  } else if (globalThis.__danarakcaState) {
    return globalThis.__danarakcaState;
  }
  const initial = initDefaultState();
  await saveState(env, initial);
  return initial;
}

async function saveState(env, state) {
  const kv = getKV(env);
  if (kv) {
    await kv.put('danarakca_state', JSON.stringify(state));
  } else {
    globalThis.__danarakcaState = state;
  }
}

async function makeAdminToken(u, p) {
  const msg = `${u}:${p}:${ADMIN_SALT}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkAdminToken(request, config) {
  let token = request.headers.get('X-Admin-Token') || '';
  if (!token) {
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Bearer ')) token = auth.slice(7);
  }
  const adminCfg = config.admin || {};
  const expectedU = adminCfg.username || 'admin';
  const expectedP = adminCfg.password || 'danarakca2026';
  const expectedToken = await makeAdminToken(expectedU, expectedP);
  return token === expectedToken;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, Authorization'
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message, success: false }, status);
}

function getEffectiveAllocation(participant, stage) {
  const allocs = participant.allocations || {};
  for (let s = stage; s >= 1; s--) {
    if (allocs[String(s)]) {
      return allocs[String(s)];
    }
  }
  return { sukuk: 20, saham: 20, rdpu: 20, emas: 20, campuran: 20 };
}

function getLeaderboard(state, limit = null) {
  const sorted = Object.values(state.participants || {}).sort((a, b) => b.current_value - a.current_value);
  if (limit) return sorted.slice(0, limit);
  return sorted;
}

function getPublicState(state, config) {
  const cleanConfig = { ...config };
  delete cleanConfig.admin;
  const sorted = getLeaderboard(state);
  const maxDdLimit = config.max_drawdown_award || 0.10;
  let tangguh = sorted.filter(p => (p.max_drawdown || 0) <= maxDdLimit).slice(0, 5);
  if (tangguh.length === 0 && sorted.length > 0) {
    tangguh = [...sorted].sort((a, b) => ((a.max_drawdown || 0) - (b.max_drawdown || 0)) || (b.current_value - a.current_value)).slice(0, 5);
  }

  return {
    status: state.status || 'WAITING_STAGE_1',
    current_round: state.current_round || 0,
    current_stage: state.current_stage || 1,
    stage_input_open: !!state.stage_input_open,
    total_rounds: state.total_rounds || 30,
    rounds_per_stage: state.rounds_per_stage || 10,
    total_stages: state.total_stages || 3,
    total_participants: Object.keys(state.participants || {}).length,
    last_drawn_card: (state.drawn_cards && state.drawn_cards.length > 0) ? state.drawn_cards[state.drawn_cards.length - 1] : null,
    recent_cards: (state.drawn_cards && state.drawn_cards.length > 0) ? [...state.drawn_cards].slice(-5).reverse() : [],
    asset_indexes: state.asset_indexes || {},
    asset_history: state.asset_history || {},
    message: state.message || '',
    config: cleanConfig,
    leaderboard_top10: sorted.slice(0, 10),
    investor_tangguh_top5: tangguh
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, Authorization'
      }
    });
  }

  const state = await getState(env);

  // --- GET ROUTES ---
  if (request.method === 'GET') {
    if (path === '/api/state') {
      return jsonResponse({ success: true, data: getPublicState(state, CONFIG) });
    }

    if (path === '/api/leaderboard') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit && !isNaN(rawLimit) ? parseInt(rawLimit) : 100;
      return jsonResponse({ success: true, data: getLeaderboard(state, limit) });
    }

    if (path.startsWith('/api/participant/')) {
      const code = path.split('/').pop().toUpperCase();
      const p = state.participants ? state.participants[code] : null;
      if (!p) {
        return errorResponse(`Peserta dengan kode ${code} tidak ditemukan`, 404);
      }
      return jsonResponse({ success: true, data: p });
    }

    if (path === '/api/cards') {
      return jsonResponse({ success: true, data: CARDS });
    }

    if (path === '/api/admin/verify') {
      const ok = await checkAdminToken(request, CONFIG);
      if (ok) return jsonResponse({ success: true, authenticated: true });
      return errorResponse('Sesi Fasilitator tidak valid atau telah berakhir', 401);
    }

    if (path === '/api/export') {
      const lb = getLeaderboard(state);
      const rows = [
        ['Peringkat', 'Kode', 'Nama', 'Nilai Portofolio', 'Return Kumulatif (%)', 'Max Drawdown (%)', 'Tahap 1 Alloc', 'Tahap 2 Alloc', 'Tahap 3 Alloc']
      ];
      for (const p of lb) {
        const t1 = p.allocations?.['1'] || {};
        const t2 = p.allocations?.['2'] || {};
        const t3 = p.allocations?.['3'] || {};
        const returnPct = (((p.current_value / CONFIG.initial_capital) - 1) * 100).toFixed(2);
        const mddPct = ((p.max_drawdown || 0) * 100).toFixed(2);
        rows.push([
          p.current_rank,
          p.code,
          `"${p.name.replace(/"/g, '""')}"`,
          Math.round(p.current_value),
          `${returnPct}%`,
          `${mddPct}%`,
          `"S:${t1.sukuk || 0}/Sh:${t1.saham || 0}/U:${t1.rdpu || 0}/E:${t1.emas || 0}/C:${t1.campuran || 0}"`,
          `"S:${t2.sukuk || 0}/Sh:${t2.saham || 0}/U:${t2.rdpu || 0}/E:${t2.emas || 0}/C:${t2.campuran || 0}"`,
          `"S:${t3.sukuk || 0}/Sh:${t3.saham || 0}/U:${t3.rdpu || 0}/E:${t3.emas || 0}/C:${t3.campuran || 0}"`
        ]);
      }
      const csvContent = rows.map(r => r.join(',')).join('\n');
      return new Response(csvContent, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="danarakca_leaderboard.csv"',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return errorResponse(`Endpoint ${path} tidak ditemukan`, 404);
  }

  // --- POST ROUTES ---
  if (request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      body = {};
    }

    if (path === '/api/admin/login') {
      const u = (body.username || '').trim();
      const p = (body.password || '').trim();
      const adminCfg = CONFIG.admin || {};
      const expectedU = adminCfg.username || 'admin';
      const expectedP = adminCfg.password || 'danarakca2026';
      if (u === expectedU && p === expectedP) {
        const token = await makeAdminToken(u, p);
        return jsonResponse({ success: true, token, message: 'Login Fasilitator Berhasil!' });
      }
      return errorResponse('ID atau Password Fasilitator salah!', 401);
    }

    if (path === '/api/participant/register') {
      const code = (body.code || '').trim().toUpperCase();
      const name = (body.name || '').trim();
      if (!code || !name) {
        return errorResponse('Kode dan nama peserta wajib diisi');
      }
      if (!state.participants) state.participants = {};

      if (!state.participants[code]) {
        const curRound = state.current_round || 0;
        const initialHist = [];
        for (let r = 0; r <= curRound; r++) {
          initialHist.push({
            round: r,
            value: CONFIG.initial_capital,
            drawdown: 0.0,
            rank: Object.keys(state.participants).length + 1
          });
        }
        state.participants[code] = {
          code,
          name,
          allocations: {},
          current_value: CONFIG.initial_capital,
          prev_value: CONFIG.initial_capital,
          current_rank: Object.keys(state.participants).length + 1,
          prev_rank: Object.keys(state.participants).length + 1,
          max_drawdown: 0.0,
          history: initialHist
        };
      } else {
        state.participants[code].name = name;
      }
      await saveState(env, state);
      return jsonResponse({ success: true, data: state.participants[code] });
    }

    if (path === '/api/participant/submit') {
      const code = (body.code || '').trim().toUpperCase();
      const stage = parseInt(body.stage);
      const alloc = body.allocation || {};

      if (!state.participants || !state.participants[code]) {
        return errorResponse(`Peserta ${code} belum terdaftar`);
      }
      if (stage !== state.current_stage) {
        return errorResponse(`Hanya dapat mengisi alokasi untuk Tahap ${state.current_stage}`);
      }
      if (!state.stage_input_open) {
        return errorResponse('Input alokasi sedang ditutup oleh fasilitator');
      }

      const totalPct = (alloc.sukuk || 0) + (alloc.saham || 0) + (alloc.rdpu || 0) + (alloc.emas || 0) + (alloc.campuran || 0);
      if (Math.round(totalPct) !== 100) {
        return errorResponse(`Total alokasi harus tepat 100% (saat ini ${totalPct}%)`);
      }

      if (!state.participants[code].allocations) state.participants[code].allocations = {};
      state.participants[code].allocations[String(stage)] = {
        sukuk: alloc.sukuk || 0,
        saham: alloc.saham || 0,
        rdpu: alloc.rdpu || 0,
        emas: alloc.emas || 0,
        campuran: alloc.campuran || 0
      };

      await saveState(env, state);
      return jsonResponse({ success: true, data: state.participants[code].allocations[String(stage)], message: 'Alokasi berhasil disimpan!' });
    }

    // Protected Facilitator Routes
    if (path.startsWith('/api/facilitator/')) {
      const ok = await checkAdminToken(request, CONFIG);
      if (!ok) {
        return errorResponse('Akses ditolak: Hanya Fasilitator yang berwenang. Silakan login terlebih dahulu.', 403);
      }

      if (path === '/api/facilitator/draw-card') {
        if (state.current_round >= state.total_rounds) {
          return errorResponse('Semua putaran telah selesai');
        }

        const nextRound = state.current_round + 1;
        const expectedStage = 1 + Math.floor((nextRound - 1) / state.rounds_per_stage);
        if (state.current_stage < expectedStage) {
          return errorResponse(`Perlu memajukan Tahap ke ${expectedStage} terlebih dahulu`);
        }

        if (state.stage_input_open) state.stage_input_open = false;

        let cardId = body.card_id;
        let selectedCard = null;
        if (cardId) {
          selectedCard = cardsById.get(cardId);
          if (!selectedCard) return errorResponse(`Card ID ${cardId} tidak valid`);
          state.available_cards = (state.available_cards || []).filter(id => id !== cardId);
        } else {
          if (!state.available_cards || state.available_cards.length === 0) {
            state.available_cards = CARDS.map(c => c.id);
          }
          const randIdx = Math.floor(Math.random() * state.available_cards.length);
          cardId = state.available_cards.splice(randIdx, 1)[0];
          selectedCard = cardsById.get(cardId);
        }

        const baseMap = {};
        for (const a of CONFIG.assets) baseMap[a.id] = a.base_return;

        const roundReturns = {
          sukuk: (baseMap.sukuk || 0) + (selectedCard.return_sukuk || 0),
          saham: (baseMap.saham || 0) + (selectedCard.return_saham || 0),
          rdpu: (baseMap.rdpu || 0) + (selectedCard.return_rdpu || 0),
          emas: (baseMap.emas || 0) + (selectedCard.return_emas || 0),
          campuran: (baseMap.campuran || 0) + (selectedCard.return_campuran || 0)
        };

        // Update asset indexes
        for (const [k, ret] of Object.entries(roundReturns)) {
          const oldIdx = state.asset_indexes[k] || 100.0;
          const newIdx = oldIdx * (1.0 + ret);
          state.asset_indexes[k] = newIdx;
          if (!state.asset_history[k]) state.asset_history[k] = [100.0];
          state.asset_history[k].push(newIdx);
        }

        // Apply returns to each participant
        for (const p of Object.values(state.participants || {})) {
          const alloc = getEffectiveAllocation(p, state.current_stage);
          const weightedReturn = (
            (alloc.sukuk * roundReturns.sukuk) +
            (alloc.saham * roundReturns.saham) +
            (alloc.rdpu * roundReturns.rdpu) +
            (alloc.emas * roundReturns.emas) +
            (alloc.campuran * roundReturns.campuran)
          ) / 100.0;

          p.prev_value = p.current_value;
          p.current_value = p.current_value * (1.0 + weightedReturn);

          const peak = Math.max(...(p.history || []).map(h => h.value), p.current_value);
          const dd = Math.max(0.0, (peak - p.current_value) / peak);
          p.max_drawdown = Math.max(p.max_drawdown || 0.0, dd);

          if (!p.history) p.history = [];
          p.history.push({
            round: nextRound,
            value: p.current_value,
            drawdown: dd,
            rank: p.current_rank || 1
          });
        }

        // Update ranks
        const sortedCodes = Object.keys(state.participants || {}).sort(
          (a, b) => state.participants[b].current_value - state.participants[a].current_value
        );
        sortedCodes.forEach((c, idx) => {
          const rank = idx + 1;
          state.participants[c].prev_rank = state.participants[c].current_rank || rank;
          state.participants[c].current_rank = rank;
          if (state.participants[c].history?.length > 0) {
            state.participants[c].history[state.participants[c].history.length - 1].rank = rank;
          }
        });

        if (!state.drawn_cards) state.drawn_cards = [];
        const drawnRecord = {
          round: nextRound,
          stage: state.current_stage,
          card: selectedCard,
          returns: roundReturns
        };
        state.drawn_cards.push(drawnRecord);

        state.current_round = nextRound;
        state.status = (state.current_round >= state.total_rounds) ? 'FINISHED' : 'ROUND_IN_PROGRESS';
        state.message = `Putaran ${nextRound}: ${selectedCard.title} (${selectedCard.category})`;

        await saveState(env, state);
        return jsonResponse({ success: true, data: drawnRecord, state: getPublicState(state, CONFIG) });
      }

      if (path === '/api/facilitator/toggle-input') {
        const currentOpen = !!state.stage_input_open;
        state.stage_input_open = typeof body.open === 'boolean' ? body.open : !currentOpen;
        state.message = state.stage_input_open
          ? `Sesi alokasi Tahap ${state.current_stage} telah DIBUKA.`
          : `Sesi alokasi Tahap ${state.current_stage} telah DITUTUP.`;
        await saveState(env, state);
        return jsonResponse({ success: true, stage_input_open: state.stage_input_open, message: state.message });
      }

      if (path === '/api/facilitator/next-stage') {
        if (state.current_stage >= state.total_stages) {
          return errorResponse('Tahap maksimal sudah tercapai');
        }
        state.current_stage += 1;
        state.stage_input_open = true;

        const currStageStr = String(state.current_stage);
        for (const p of Object.values(state.participants || {})) {
          if (p.allocations && !p.allocations[currStageStr]) {
            const prevAlloc = getEffectiveAllocation(p, state.current_stage - 1);
            p.allocations[currStageStr] = { ...prevAlloc };
          }
        }
        state.message = `Memasuki Tahap ${state.current_stage}. Sesi perubahan alokasi dibuka!`;
        await saveState(env, state);
        return jsonResponse({ success: true, current_stage: state.current_stage, state: getPublicState(state, CONFIG) });
      }

      if (path === '/api/facilitator/reset') {
        const preserve = !!body.preserve_participants;
        const preservedParts = {};
        if (preserve && state.participants) {
          for (const [code, p] of Object.entries(state.participants)) {
            preservedParts[code] = {
              code,
              name: p.name,
              allocations: {},
              current_value: CONFIG.initial_capital,
              prev_value: CONFIG.initial_capital,
              current_rank: 1,
              prev_rank: 1,
              max_drawdown: 0.0,
              history: [{ round: 0, value: CONFIG.initial_capital, drawdown: 0.0, rank: 1 }]
            };
          }
        }

        const freshState = initDefaultState();
        if (preserve) freshState.participants = preservedParts;

        await saveState(env, freshState);
        return jsonResponse({ success: true, message: 'Permainan berhasil di-reset!', state: getPublicState(freshState, CONFIG) });
      }

      if (path === '/api/facilitator/seed-mock-users') {
        const count = parseInt(body.count || 200);
        const strategies = [
          { name: 'Konservatif Sukuk', alloc: { sukuk: 50, saham: 10, rdpu: 25, emas: 10, campuran: 5 } },
          { name: 'Agresif Saham', alloc: { sukuk: 10, saham: 50, rdpu: 10, emas: 10, campuran: 20 } },
          { name: 'Aman RDPU', alloc: { sukuk: 20, saham: 5, rdpu: 60, emas: 10, campuran: 5 } },
          { name: 'Lindung Nilai Emas', alloc: { sukuk: 20, saham: 15, rdpu: 15, emas: 40, campuran: 10 } },
          { name: 'All Weather Balanced', alloc: { sukuk: 25, saham: 25, rdpu: 15, emas: 15, campuran: 20 } }
        ];

        if (!state.participants) state.participants = {};
        const curRound = state.current_round || 0;

        for (let i = 1; i <= count; i++) {
          const code = `BOT${String(i).padStart(3, '0')}`;
          const strat = strategies[(i - 1) % strategies.length];
          const teamName = `Tim ${strat.name} #${i}`;
          const allocations = { '1': { ...strat.alloc }, '2': { ...strat.alloc }, '3': { ...strat.alloc } };

          const initialHist = [];
          for (let r = 0; r <= curRound; r++) {
            initialHist.push({ round: r, value: CONFIG.initial_capital, drawdown: 0.0, rank: i });
          }

          state.participants[code] = {
            code,
            name: teamName,
            allocations,
            current_value: CONFIG.initial_capital,
            prev_value: CONFIG.initial_capital,
            current_rank: i,
            prev_rank: i,
            max_drawdown: 0.0,
            history: initialHist
          };
        }

        state.message = `Berhasil membuat ${count} peserta simulasi bot.`;
        await saveState(env, state);
        return jsonResponse({ success: true, total_seeded: count, state: getPublicState(state, CONFIG) });
      }

      return errorResponse(`Endpoint ${path} tidak ditemukan`, 404);
    }

    return errorResponse(`Endpoint ${path} tidak ditemukan`, 404);
  }

  return errorResponse('Method Not Allowed', 405);
}
