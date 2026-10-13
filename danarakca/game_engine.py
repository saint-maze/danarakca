import json
import random
import os
import copy
import hashlib
from datetime import datetime

class GameEngine:
    def __init__(self, data_dir=None):
        if data_dir is None:
            data_dir = os.path.join(os.path.dirname(__file__), 'data')
        self.data_dir = data_dir
        self.cards_file = os.path.join(data_dir, 'cards.json')
        self.config_file = os.path.join(data_dir, 'config.json')

        # Check for Upstash Redis / Vercel KV environment variables
        self.redis_url = (
            os.environ.get('UPSTASH_REDIS_REST_URL')
            or os.environ.get('KV_REST_API_URL')
            or os.environ.get('STORAGE_REST_API_URL')
        )
        self.redis_token = (
            os.environ.get('UPSTASH_REDIS_REST_TOKEN')
            or os.environ.get('KV_REST_API_TOKEN')
            or os.environ.get('STORAGE_REST_API_TOKEN')
        )
        if self.redis_url:
            self.redis_url = self.redis_url.rstrip('/')

        # Check if environment is serverless / read-only (e.g. Vercel)
        is_serverless = os.environ.get('VERCEL') == '1' or not os.access(data_dir, os.W_OK)
        if is_serverless:
            self.state_file = os.path.join('/tmp', 'danarakca_state.json')
            if not os.path.exists(self.state_file):
                default_state = os.path.join(data_dir, 'state.json')
                if os.path.exists(default_state):
                    try:
                        import shutil
                        shutil.copy2(default_state, self.state_file)
                    except Exception:
                        pass
        else:
            self.state_file = os.path.join(data_dir, 'state.json')

        self.load_cards()
        self.load_config()
        self.load_or_init_state()

    @staticmethod
    def make_participant_code(name):
        clean = (name or '').strip().lower()
        digest = hashlib.md5(clean.encode('utf-8')).hexdigest()[:6].upper()
        return f"T{digest}"

    def _load_from_redis(self):
        if not self.redis_url or not self.redis_token:
            return None
        import urllib.request
        try:
            req = urllib.request.Request(f"{self.redis_url}/get/danarakca_state")
            req.add_header("Authorization", f"Bearer {self.redis_token}")
            req.add_header("User-Agent", "Danarakca-Server/1.0")
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                val = data.get("result")
                while isinstance(val, str):
                    val = json.loads(val)
                if isinstance(val, dict):
                    return val
        except Exception as e:
            print(f"Redis get error: {e}")
        return None

    def _save_to_redis(self):
        if not self.redis_url or not self.redis_token:
            return
        import urllib.request
        try:
            payload = json.dumps(["SET", "danarakca_state", json.dumps(self.state, ensure_ascii=False)]).encode('utf-8')
            req = urllib.request.Request(
                f"{self.redis_url}",
                data=payload,
                method="POST"
            )
            req.add_header("Authorization", f"Bearer {self.redis_token}")
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "Danarakca-Server/1.0")
            with urllib.request.urlopen(req, timeout=3) as resp:
                pass
        except Exception as e:
            print(f"Redis set error: {e}")

    def load_cards(self):
        with open(self.cards_file, 'r', encoding='utf-8') as f:
            self.cards = json.load(f)
        self.cards_by_id = {c['id']: c for c in self.cards}

    def load_config(self):
        with open(self.config_file, 'r', encoding='utf-8') as f:
            self.config = json.load(f)

    def refresh_state(self):
        # 1. Try Upstash Redis if configured
        if self.redis_url and self.redis_token:
            redis_state = self._load_from_redis()
            if isinstance(redis_state, dict):
                self.state = redis_state
                return True

        # 2. Try state file (local or /tmp)
        if os.path.exists(self.state_file):
            try:
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    if not hasattr(self, 'state') or not isinstance(self.state, dict):
                        self.state = loaded
                    else:
                        # Only overwrite in-memory state if file has newer or equal version
                        file_sess = int(loaded.get('session_id', 0))
                        mem_sess = int(self.state.get('session_id', 0))
                        file_ver = int(loaded.get('state_version', 0))
                        mem_ver = int(self.state.get('state_version', 0))
                        if file_sess > mem_sess or (file_sess == mem_sess and file_ver >= mem_ver):
                            self.state = loaded
                    return True
            except Exception as e:
                print(f"Error loading state file: {e}")
        return False

    def load_or_init_state(self):
        if not self.refresh_state():
            self.reset_game()
        else:
            if 'session_id' not in self.state:
                self.state['session_id'] = 1
            if 'state_version' not in self.state:
                self.state['state_version'] = 1

    def _bump_version(self):
        now_ms = int(datetime.now().timestamp() * 1000)
        cur_ver = int(self.state.get('state_version', 0))
        self.state['state_version'] = max(cur_ver + 1, now_ms)

    def save_state(self, bump_version=True):
        if bump_version:
            self._bump_version()
        try:
            with open(self.state_file, 'w', encoding='utf-8') as f:
                json.dump(self.state, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Warning: could not write local state file ({e})")

        # Sync to Upstash Redis if available
        self._save_to_redis()

    def reset_game(self, preserve_participants=False, total_stages=None):
        if total_stages is None:
            if hasattr(self, 'state') and isinstance(self.state, dict) and 'total_stages' in self.state:
                total_stages = self.state['total_stages']
            else:
                total_stages = self.config.get('total_stages', 3)
        total_stages = int(total_stages)
        if total_stages not in (1, 2, 3):
            total_stages = 3

        rounds_per_stage = self.config.get('rounds_per_stage', 10)
        total_rounds = total_stages * rounds_per_stage
        now_ms = int(datetime.now().timestamp() * 1000)
        prev_sess = int(self.state.get('session_id', 0)) if hasattr(self, 'state') and isinstance(self.state, dict) else 0
        new_session_id = max(prev_sess + 1, now_ms)

        participants = {}
        if preserve_participants and hasattr(self, 'state') and isinstance(self.state, dict) and 'participants' in self.state:
            for code, p in self.state['participants'].items():
                det_code = self.make_participant_code(p['name'])
                participants[det_code] = {
                    'code': det_code,
                    'name': p['name'],
                    'allocations': {},
                    'current_value': self.config['initial_capital'],
                    'prev_value': self.config['initial_capital'],
                    'current_rank': 1,
                    'prev_rank': 1,
                    'max_drawdown': 0.0,
                    'history': [
                        {
                            'round': 0,
                            'value': self.config['initial_capital'],
                            'drawdown': 0.0,
                            'rank': 1
                        }
                    ]
                }

        self.state = {
            'session_id': new_session_id,
            'state_version': new_session_id,
            'preserve_participants_on_reset': bool(preserve_participants),
            'status': 'WAITING_STAGE_1',
            'current_round': 0,
            'current_stage': 1,
            'stage_input_open': True,
            'total_rounds': total_rounds,
            'rounds_per_stage': rounds_per_stage,
            'total_stages': total_stages,
            'drawn_cards': [],
            'available_cards': [c['id'] for c in self.cards],
            'participants': participants,
            'asset_indexes': {
                'sukuk': [100.0],
                'saham': [100.0],
                'rdpu': [100.0],
                'emas': [100.0],
                'campuran': [100.0]
            },
            'stage_factors': {
                'sukuk': 1.0,
                'saham': 1.0,
                'rdpu': 1.0,
                'emas': 1.0,
                'campuran': 1.0
            },
            'message': f'Game dimulai ({total_stages} Tahap / {total_rounds} Putaran). Silakan peserta mendaftar dan mengisi alokasi Tahap 1.'
        }
        self._rebuild_simulation([])
        self.save_state(bump_version=False)

    def _rebuild_simulation(self, drawn_card_ids=None):
        """Deterministically rebuilds asset indexes, stage factors, drawn cards, and all participant histories."""
        if drawn_card_ids is None:
            drawn_card_ids = [d['card_id'] for d in self.state.get('drawn_cards', []) if isinstance(d, dict) and 'card_id' in d]

        valid_card_ids = [cid for cid in drawn_card_ids if cid in self.cards_by_id]
        rounds_per_stage = self.state.get('rounds_per_stage', 10)
        initial_cap = self.config['initial_capital']
        base_returns = {a['id']: a['base_return'] for a in self.config['assets']}

        self.state['asset_indexes'] = {
            'sukuk': [100.0],
            'saham': [100.0],
            'rdpu': [100.0],
            'emas': [100.0],
            'campuran': [100.0]
        }
        self.state['stage_factors'] = {
            'sukuk': 1.0,
            'saham': 1.0,
            'rdpu': 1.0,
            'emas': 1.0,
            'campuran': 1.0
        }

        existing_timestamps = {
            d['card_id']: d.get('timestamp')
            for d in self.state.get('drawn_cards', [])
            if isinstance(d, dict) and 'card_id' in d
        }

        # Reset participant histories to round 0 while preserving their allocations
        for code, p in self.state.get('participants', {}).items():
            p['current_value'] = initial_cap
            p['prev_value'] = initial_cap
            p['current_rank'] = 1
            p['prev_rank'] = 1
            p['max_drawdown'] = 0.0
            p['history'] = [{
                'round': 0,
                'value': initial_cap,
                'drawdown': 0.0,
                'rank': 1
            }]

        # Rank at round 0
        sorted_codes = sorted(
            self.state.get('participants', {}).keys(),
            key=lambda c: self.state['participants'][c]['name'].lower()
        )
        for rank, code in enumerate(sorted_codes, start=1):
            self.state['participants'][code]['current_rank'] = rank
            self.state['participants'][code]['prev_rank'] = rank
            self.state['participants'][code]['history'][0]['rank'] = rank

        new_drawn_cards = []
        for idx, card_id in enumerate(valid_card_ids):
            r = idx + 1
            expected_stage = 1 + (r - 1) // rounds_per_stage
            selected_card = self.cards_by_id[card_id]

            round_returns = {
                'sukuk': base_returns['sukuk'] + selected_card['return_sukuk'],
                'saham': base_returns['saham'] + selected_card['return_saham'],
                'rdpu': base_returns['rdpu'] + selected_card['return_rdpu'],
                'emas': base_returns['emas'] + selected_card['return_emas'],
                'campuran': base_returns['campuran'] + selected_card['return_campuran'],
            }

            is_stage_start = (r - 1) % rounds_per_stage == 0
            if is_stage_start:
                self.state['stage_factors'] = {a: 1.0 + round_returns[a] for a in round_returns}
            else:
                for a in round_returns:
                    self.state['stage_factors'][a] *= (1.0 + round_returns[a])

            for a in round_returns:
                last_idx = self.state['asset_indexes'][a][-1]
                new_idx = last_idx * (1.0 + round_returns[a])
                self.state['asset_indexes'][a].append(round(new_idx, 4))

            new_drawn_cards.append({
                'round': r,
                'stage': expected_stage,
                'card_id': card_id,
                'timestamp': existing_timestamps.get(card_id) or datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                'card': selected_card,
                'returns': round_returns,
                'stage_factors': dict(self.state['stage_factors'])
            })

            self._recalculate_participants(r, expected_stage)

        drawn_set = set(valid_card_ids)
        self.state['drawn_cards'] = new_drawn_cards
        self.state['available_cards'] = [c['id'] for c in self.cards if c['id'] not in drawn_set]
        self.state['current_round'] = len(new_drawn_cards)

    def sync_state(self, client_sync=None, participant_sync=None):
        """Synchronizes state across stateless serverless containers using monotonic session_id and state_version."""
        changed = False
        cur_session = int(self.state.get('session_id', 1))
        cur_version = int(self.state.get('state_version', 1))

        if isinstance(client_sync, dict) and client_sync:
            inc_session = int(client_sync.get('session_id') or 0)
            inc_version = int(client_sync.get('state_version') or 0)
            inc_cards = client_sync.get('drawn_card_ids')
            cur_cards = [d['card_id'] for d in self.state.get('drawn_cards', [])]

            # 1. Newer session (e.g. Facilitator reset game on another container)
            if inc_session > cur_session:
                self.state['session_id'] = inc_session
                self.state['state_version'] = inc_version
                self.state['preserve_participants_on_reset'] = bool(client_sync.get('preserve_participants_on_reset', False))
                self.state['status'] = client_sync.get('status', 'WAITING_STAGE_1')
                self.state['current_stage'] = int(client_sync.get('current_stage', 1))
                self.state['stage_input_open'] = bool(client_sync.get('stage_input_open', True))
                self.state['total_stages'] = int(client_sync.get('total_stages', 3))
                self.state['rounds_per_stage'] = int(client_sync.get('rounds_per_stage', 10))
                self.state['total_rounds'] = self.state['total_stages'] * self.state['rounds_per_stage']
                self.state['message'] = client_sync.get('message', self.state.get('message', ''))
                self.state['participants'] = {}
                cur_session = inc_session
                cur_version = inc_version
                if isinstance(inc_cards, list):
                    cur_cards = inc_cards
                changed = True

            # 2. Same session, incoming state has newer version or more drawn cards
            elif inc_session == cur_session or cur_session <= 1:
                if inc_session > 1 and cur_session <= 1:
                    self.state['session_id'] = inc_session
                    cur_session = inc_session
                    changed = True

                if inc_version > cur_version or (isinstance(inc_cards, list) and len(inc_cards) > len(cur_cards)):
                    self.state['state_version'] = max(cur_version, inc_version)
                    cur_version = self.state['state_version']
                    if 'status' in client_sync:
                        self.state['status'] = client_sync['status']
                    if 'current_stage' in client_sync:
                        self.state['current_stage'] = int(client_sync['current_stage'])
                    if 'stage_input_open' in client_sync:
                        self.state['stage_input_open'] = bool(client_sync['stage_input_open'])
                    if 'total_stages' in client_sync:
                        self.state['total_stages'] = int(client_sync['total_stages'])
                        self.state['total_rounds'] = self.state['total_stages'] * self.state.get('rounds_per_stage', 10)
                    if 'message' in client_sync and client_sync['message']:
                        self.state['message'] = client_sync['message']
                    if isinstance(inc_cards, list) and len(inc_cards) >= len(cur_cards):
                        cur_cards = inc_cards
                    changed = True

            # Merge participants from client_sync if session matches
            if inc_session == cur_session and isinstance(client_sync.get('participants_sync'), dict):
                for p_code, p_data in client_sync['participants_sync'].items():
                    if not isinstance(p_data, dict) or not p_data.get('name'):
                        continue
                    name = p_data['name'].strip()
                    det_code = self.make_participant_code(name)
                    if det_code not in self.state['participants']:
                        self.state['participants'][det_code] = {
                            'code': det_code,
                            'name': name,
                            'allocations': {},
                            'current_value': self.config['initial_capital'],
                            'prev_value': self.config['initial_capital'],
                            'current_rank': 1,
                            'prev_rank': 1,
                            'max_drawdown': 0.0,
                            'history': []
                        }
                        changed = True
                    inc_allocs = p_data.get('allocations', {})
                    if isinstance(inc_allocs, dict):
                        cur_allocs = self.state['participants'][det_code].setdefault('allocations', {})
                        for stg, alloc in inc_allocs.items():
                            if stg not in cur_allocs and isinstance(alloc, dict):
                                cur_allocs[str(stg)] = alloc
                                changed = True

            if changed:
                self._rebuild_simulation(cur_cards)

        # 3. Sync individual active participant (from player.js)
        if isinstance(participant_sync, dict) and participant_sync.get('name'):
            p_sess = int(participant_sync.get('session_id') or 0)
            name = participant_sync['name'].strip()
            det_code = self.make_participant_code(name)
            # Only restore participant allocations if they belong to the current session (or if player just registered)
            session_matches = (p_sess == cur_session) or (p_sess == 0) or (cur_session <= 1)

            if det_code not in self.state['participants']:
                # If facilitator explicitly reset with preserve_participants=False and player has an older session_id,
                # still keep the player registered so they don't get logged out, but clear old session allocations!
                self.state['participants'][det_code] = {
                    'code': det_code,
                    'name': name,
                    'allocations': {},
                    'current_value': self.config['initial_capital'],
                    'prev_value': self.config['initial_capital'],
                    'current_rank': 1,
                    'prev_rank': 1,
                    'max_drawdown': 0.0,
                    'history': []
                }
                changed = True

            if session_matches and isinstance(participant_sync.get('allocations'), dict):
                cur_allocs = self.state['participants'][det_code].setdefault('allocations', {})
                for stg, alloc in participant_sync['allocations'].items():
                    if isinstance(alloc, dict) and cur_allocs.get(str(stg)) != alloc:
                        cur_allocs[str(stg)] = alloc
                        changed = True

            if changed:
                self._rebuild_simulation()

        if changed:
            self.save_state(bump_version=False)

    def set_game_mode(self, total_stages):
        total_stages = int(total_stages)
        if total_stages not in (1, 2, 3):
            raise ValueError("Mode tahap harus 1, 2, atau 3 tahap")

        rounds_per_stage = self.state.get('rounds_per_stage', 10)
        new_total_rounds = total_stages * rounds_per_stage

        self.state['total_stages'] = total_stages
        self.state['total_rounds'] = new_total_rounds

        if self.state['current_round'] >= new_total_rounds:
            self.state['status'] = 'GAME_FINISHED'
        elif self.state['status'] == 'GAME_FINISHED' and self.state['current_round'] < new_total_rounds:
            self.state['status'] = 'ROUND_IN_PROGRESS' if self.state['current_round'] > 0 else 'WAITING_STAGE_1'

        self.state['message'] = f"Mode durasi diubah ke {total_stages} Tahap ({new_total_rounds} Putaran)."
        self.save_state()
        return {
            'total_stages': self.state['total_stages'],
            'total_rounds': self.state['total_rounds'],
            'status': self.state['status']
        }

    def register_participant(self, name, code=None):
        name = (name or '').strip()
        if not name:
            raise ValueError("Nama peserta / tim tidak boleh kosong")

        # Check if participant already exists by name (case-insensitive)
        for existing_code, p in list(self.state['participants'].items()):
            if p['name'].strip().lower() == name.lower():
                return p

        det_code = self.make_participant_code(name)
        if det_code in self.state['participants']:
            return self.state['participants'][det_code]

        self.state['participants'][det_code] = {
            'code': det_code,
            'name': name,
            'allocations': {},
            'current_value': self.config['initial_capital'],
            'prev_value': self.config['initial_capital'],
            'current_rank': len(self.state['participants']) + 1,
            'prev_rank': len(self.state['participants']) + 1,
            'max_drawdown': 0.0,
            'history': []
        }

        self._rebuild_simulation()
        self.save_state()
        return self.state['participants'][det_code]

    def submit_allocation(self, code_or_name, stage, allocation, name=None):
        key = str(code_or_name or name or '').strip()
        p = self.state['participants'].get(key.upper())
        if not p:
            for existing in self.state['participants'].values():
                if existing['name'].strip().lower() == key.lower() or existing['code'].lower() == key.lower():
                    p = existing
                    break
        if not p and name:
            for existing in self.state['participants'].values():
                if existing['name'].strip().lower() == str(name).strip().lower():
                    p = existing
                    break
        if not p:
            # Self-heal on serverless container: auto-register participant instead of failing
            reg_name = (name or key).strip()
            if not reg_name:
                raise ValueError("Nama peserta tidak valid")
            p = self.register_participant(name=reg_name)

        code = p['code']

        stage = int(stage)
        if stage != self.state['current_stage']:
            raise ValueError(f"Saat ini bukan waktu pengisian Tahap {stage} (Tahap aktif: {self.state['current_stage']})")

        if not self.state['stage_input_open']:
            raise ValueError(f"Input alokasi Tahap {stage} sudah ditutup oleh Fasilitator")

        # Validate allocation
        assets = ['sukuk', 'saham', 'rdpu', 'emas', 'campuran']
        clean_alloc = {}
        total = 0
        for a in assets:
            val = float(allocation.get(a, 0))
            if val < 0 or val > 100:
                raise ValueError(f"Alokasi untuk {a} harus antara 0 dan 100")
            clean_alloc[a] = val
            total += val

        if round(total) != 100:
            raise ValueError(f"Total alokasi harus tepat 100% (saat ini {round(total)}%)")

        self.state['participants'][code]['allocations'][str(stage)] = clean_alloc
        self._rebuild_simulation()
        self.save_state()
        return clean_alloc

    def get_effective_allocation(self, code, stage):
        p = self.state['participants'].get(code)
        if not p:
            return {'sukuk': 20.0, 'saham': 20.0, 'rdpu': 20.0, 'emas': 20.0, 'campuran': 20.0}

        allocs = p.get('allocations', {})
        # check current stage
        if str(stage) in allocs:
            return allocs[str(stage)]
        # fallback to previous stages
        for s in range(stage - 1, 0, -1):
            if str(s) in allocs:
                return allocs[str(s)]
        # default equal weight if participant never submitted
        return {'sukuk': 20.0, 'saham': 20.0, 'rdpu': 20.0, 'emas': 20.0, 'campuran': 20.0}

    def toggle_stage_input(self, open_status=None):
        if open_status is None:
            self.state['stage_input_open'] = not self.state['stage_input_open']
        else:
            self.state['stage_input_open'] = bool(open_status)

        status_text = "dibuka" if self.state['stage_input_open'] else "ditutup"
        self.state['message'] = f"Input alokasi Tahap {self.state['current_stage']} telah {status_text}."
        self.save_state()
        return self.state['stage_input_open']

    def next_stage(self):
        if self.state['current_stage'] >= self.state['total_stages']:
            raise ValueError("Sudah mencapai tahap terakhir")

        self.state['current_stage'] += 1
        self.state['stage_input_open'] = True

        # Pre-populate next stage allocations from previous stage if not set
        curr_stage_str = str(self.state['current_stage'])
        for p in self.state['participants'].values():
            if 'allocations' in p and curr_stage_str not in p['allocations']:
                prev_alloc = self.get_effective_allocation(p['code'], self.state['current_stage'] - 1)
                p['allocations'][curr_stage_str] = dict(prev_alloc)

        self.state['message'] = f"Memasuki Tahap {self.state['current_stage']}. Sesi perubahan alokasi dibuka!"
        self.save_state()
        return self.state['current_stage']

    def draw_card(self, card_id=None):
        if self.state['current_round'] >= self.state['total_rounds']:
            raise ValueError("Semua putaran telah selesai")

        # Determine expected stage for this round
        next_round = self.state['current_round'] + 1
        expected_stage = 1 + (next_round - 1) // self.state['rounds_per_stage']

        if self.state['current_stage'] < expected_stage:
            raise ValueError(f"Perlu memajukan Tahap ke {expected_stage} terlebih dahulu sebelum memainkan putaran {next_round}")

        # Check if stage input is still open; auto-close it when card is drawn
        if self.state['stage_input_open']:
            self.state['stage_input_open'] = False

        # Pick card
        if card_id:
            if card_id not in self.cards_by_id:
                raise ValueError(f"Card ID {card_id} tidak valid")
            selected_card = self.cards_by_id[card_id]
            if card_id in self.state['available_cards']:
                self.state['available_cards'].remove(card_id)
        else:
            if not self.state['available_cards']:
                # Reshuffle all cards if depleted
                self.state['available_cards'] = [c['id'] for c in self.cards]
            card_id = random.choice(self.state['available_cards'])
            self.state['available_cards'].remove(card_id)
            selected_card = self.cards_by_id[card_id]

        # Calculate asset returns for this round: Base + Card
        base_returns = {a['id']: a['base_return'] for a in self.config['assets']}
        round_returns = {
            'sukuk': base_returns['sukuk'] + selected_card['return_sukuk'],
            'saham': base_returns['saham'] + selected_card['return_saham'],
            'rdpu': base_returns['rdpu'] + selected_card['return_rdpu'],
            'emas': base_returns['emas'] + selected_card['return_emas'],
            'campuran': base_returns['campuran'] + selected_card['return_campuran'],
        }

        # Check if this is the start of a new stage
        is_stage_start = (next_round - 1) % self.state['rounds_per_stage'] == 0
        if is_stage_start:
            # Reset stage factors
            self.state['stage_factors'] = {
                a: 1.0 + round_returns[a] for a in round_returns
            }
        else:
            # Compound stage factors
            for a in round_returns:
                self.state['stage_factors'][a] *= (1.0 + round_returns[a])

        # Update overall asset indexes (100 base)
        for a in round_returns:
            last_idx = self.state['asset_indexes'][a][-1] if self.state['asset_indexes'].get(a) else 100.0
            new_idx = last_idx * (1.0 + round_returns[a])
            if a not in self.state['asset_indexes']:
                self.state['asset_indexes'][a] = [100.0]
            self.state['asset_indexes'][a].append(round(new_idx, 4))

        # Record drawn card log
        card_log_entry = {
            'round': next_round,
            'stage': expected_stage,
            'card_id': card_id,
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'card': selected_card,
            'returns': round_returns,
            'stage_factors': dict(self.state['stage_factors'])
        }
        self.state['drawn_cards'].append(card_log_entry)
        self.state['current_round'] = next_round
        self.state['status'] = 'GAME_FINISHED' if next_round == self.state['total_rounds'] else 'ROUND_IN_PROGRESS'

        # Recalculate participant values
        self._recalculate_participants(next_round, expected_stage)

        self.state['message'] = f"Putaran {next_round}: Kartu {selected_card['title']} keluar!"
        self.save_state()
        return card_log_entry

    def _recalculate_participants(self, current_round, current_stage):
        rounds_per_stage = self.state['rounds_per_stage']

        for code, p in self.state['participants'].items():
            p['prev_value'] = p.get('current_value', self.config['initial_capital'])
            p['prev_rank'] = p.get('current_rank', 1)

            if current_stage <= 1:
                base_val = self.config['initial_capital']
            else:
                target_round = (current_stage - 1) * rounds_per_stage
                base_val = None
                for h in p.get('history', []):
                    if h.get('round') == target_round:
                        base_val = h.get('value')
                        break
                if base_val is None:
                    valid_h = [h for h in p.get('history', []) if h.get('round', 0) <= target_round]
                    if valid_h:
                        base_val = valid_h[-1].get('value', self.config['initial_capital'])
                    else:
                        base_val = p.get('current_value', self.config['initial_capital'])

            alloc = self.get_effective_allocation(code, current_stage)

            growth = sum(
                (alloc.get(a, 0.0) / 100.0) * self.state['stage_factors'].get(a, 1.0)
                for a in ['sukuk', 'saham', 'rdpu', 'emas', 'campuran']
            )

            current_val = base_val * growth
            p['current_value'] = current_val

            all_values = [h.get('value', base_val) for h in p.get('history', [])] + [current_val]
            peak = max(all_values) if all_values else current_val
            drawdown = max(0.0, 1.0 - (current_val / peak)) if peak > 0 else 0.0

            prev_mdd = p.get('max_drawdown', 0.0)
            p['max_drawdown'] = max(prev_mdd, drawdown)

            if 'history' not in p:
                p['history'] = []
            p['history'].append({
                'round': current_round,
                'value': current_val,
                'drawdown': drawdown,
                'rank': p.get('current_rank', 1)
            })

        sorted_codes = sorted(
            self.state['participants'].keys(),
            key=lambda c: self.state['participants'][c]['current_value'],
            reverse=True
        )

        for rank, code in enumerate(sorted_codes, start=1):
            self.state['participants'][code]['current_rank'] = rank
            if self.state['participants'][code].get('history'):
                self.state['participants'][code]['history'][-1]['rank'] = rank

    def get_leaderboard(self, limit=None):
        sorted_participants = sorted(
            self.state['participants'].values(),
            key=lambda p: p['current_value'],
            reverse=True
        )
        if limit:
            return sorted_participants[:limit]
        return sorted_participants

    def get_investor_tangguh(self, max_dd_limit=None):
        if max_dd_limit is None:
            max_dd_limit = self.config.get('max_drawdown_award', 0.10)

        eligible = [
            p for p in self.state['participants'].values()
            if p.get('max_drawdown', 0.0) <= max_dd_limit
        ]
        return sorted(eligible, key=lambda p: p['current_value'], reverse=True)

    def seed_mock_participants(self, count=200):
        """Generates realistic mock participants with diverse strategies for demo/stress-testing."""
        strategies = [
            {'name': 'Konservatif Sukuk', 'alloc': {'sukuk': 50, 'saham': 10, 'rdpu': 25, 'emas': 10, 'campuran': 5}},
            {'name': 'Agresif Saham', 'alloc': {'sukuk': 10, 'saham': 60, 'rdpu': 10, 'emas': 10, 'campuran': 10}},
            {'name': 'Seimbang Moderat', 'alloc': {'sukuk': 20, 'saham': 20, 'rdpu': 20, 'emas': 20, 'campuran': 20}},
            {'name': 'Hedger Emas', 'alloc': {'sukuk': 20, 'saham': 10, 'rdpu': 10, 'emas': 50, 'campuran': 10}},
            {'name': 'Campuran Taktis', 'alloc': {'sukuk': 20, 'saham': 20, 'rdpu': 10, 'emas': 10, 'campuran': 40}},
            {'name': 'Pasar Uang Stabil', 'alloc': {'sukuk': 20, 'saham': 5, 'rdpu': 55, 'emas': 15, 'campuran': 5}},
        ]

        sample_team_names = [
            "Garuda Investa", "Nusantara Capital", "Merdeka Alpha", "Srikandi Wealth", "Kencana Fund",
            "Bintang Timur", "Samudera Aset", "Pertiwi Syariah", "Barito Ventura", "Cakrawala Prima",
            "Trisula Asset", "Mandiri Dinamis", "Bumi Inti", "Artha Mulia", "Adiwarna Prima",
            "Sentosa Global", "Dharma Sejahtera", "Pandawa Lima", "Krakatau Fund", "Wijaya Makmur"
        ]

        curr_stage = self.state.get('current_stage', 1)

        self.state['participants'] = {}
        for i in range(1, count + 1):
            strat = random.choice(strategies)
            base_name = sample_team_names[(i - 1) % len(sample_team_names)]
            team_name = f"{base_name} {i}"
            code = self.make_participant_code(team_name)

            alloc = dict(strat['alloc'])
            diff = random.choice([-5, 0, 5])
            if alloc['saham'] + diff >= 0 and alloc['sukuk'] - diff >= 0:
                alloc['saham'] += diff
                alloc['sukuk'] -= diff

            allocations = {'1': alloc}
            if curr_stage >= 2:
                allocations['2'] = dict(alloc)
            if curr_stage >= 3:
                allocations['3'] = dict(alloc)

            self.state['participants'][code] = {
                'code': code,
                'name': team_name,
                'allocations': allocations,
                'current_value': self.config['initial_capital'],
                'prev_value': self.config['initial_capital'],
                'current_rank': i,
                'prev_rank': i,
                'max_drawdown': 0.0,
                'history': []
            }

        self._rebuild_simulation()
        self.state['message'] = f"Berhasil membuat {count} peserta simulasi."
        self.save_state()
        return len(self.state['participants'])

    def get_public_state(self):
        """Returns clean state for API."""
        return {
            'session_id': self.state.get('session_id', 1),
            'state_version': self.state.get('state_version', 1),
            'preserve_participants_on_reset': self.state.get('preserve_participants_on_reset', False),
            'status': self.state.get('status', 'WAITING_STAGE_1'),
            'current_round': self.state.get('current_round', 0),
            'current_stage': self.state.get('current_stage', 1),
            'stage_input_open': self.state.get('stage_input_open', False),
            'total_rounds': self.state.get('total_rounds', 30),
            'rounds_per_stage': self.state.get('rounds_per_stage', 10),
            'total_stages': self.state.get('total_stages', 3),
            'total_participants': len(self.state.get('participants', {})),
            'drawn_card_ids': [d['card_id'] for d in self.state.get('drawn_cards', []) if isinstance(d, dict) and 'card_id' in d],
            'participants_sync': {
                code: {
                    'code': p['code'],
                    'name': p['name'],
                    'allocations': p.get('allocations', {})
                }
                for code, p in self.state.get('participants', {}).items()
            },
            'last_drawn_card': self.state['drawn_cards'][-1] if self.state.get('drawn_cards') else None,
            'recent_cards': list(reversed(self.state['drawn_cards'][-5:])) if self.state.get('drawn_cards') else [],
            'asset_indexes': {k: (v[-1] if v else 100.0) for k, v in self.state.get('asset_indexes', {}).items()},
            'asset_history': self.state.get('asset_indexes', {}),
            'message': self.state.get('message', ''),
            'config': {k: v for k, v in self.config.items() if k != 'admin'},
            'leaderboard_top10': self.get_leaderboard(limit=10),
            'investor_tangguh_top5': self.get_investor_tangguh(max_dd_limit=0.10)[:5]
        }
