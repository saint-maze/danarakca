import json
import random
import os
import copy
from datetime import datetime

class GameEngine:
    def __init__(self, data_dir=None):
        if data_dir is None:
            data_dir = os.path.join(os.path.dirname(__file__), 'data')
        self.data_dir = data_dir
        self.cards_file = os.path.join(data_dir, 'cards.json')
        self.config_file = os.path.join(data_dir, 'config.json')
        self.state_file = os.path.join(data_dir, 'state.json')

        self.load_cards()
        self.load_config()
        self.load_or_init_state()

    def load_cards(self):
        with open(self.cards_file, 'r', encoding='utf-8') as f:
            self.cards = json.load(f)
        self.cards_by_id = {c['id']: c for c in self.cards}

    def load_config(self):
        with open(self.config_file, 'r', encoding='utf-8') as f:
            self.config = json.load(f)

    def load_or_init_state(self):
        if os.path.exists(self.state_file):
            try:
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    self.state = json.load(f)
                return
            except Exception as e:
                print(f"Error loading state.json: {e}, reinitializing...")
        self.reset_game()

    def save_state(self):
        with open(self.state_file, 'w', encoding='utf-8') as f:
            json.dump(self.state, f, ensure_ascii=False, indent=2)

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

        participants = {}
        if preserve_participants and hasattr(self, 'state') and 'participants' in self.state:
            # Keep registered participants but reset their portfolios
            for code, p in self.state['participants'].items():
                participants[code] = {
                    'code': code,
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
            'status': 'WAITING_STAGE_1', # WAITING_STAGE_1, ROUND_IN_PROGRESS, GAME_FINISHED
            'current_round': 0,
            'current_stage': 1,
            'stage_input_open': True, # Facilitator opens input for Stage 1 initially
            'total_rounds': total_rounds,
            'rounds_per_stage': rounds_per_stage,
            'total_stages': total_stages,
            'drawn_cards': [], # List of rounds played
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
        self.save_state()

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
            self.state['status'] = 'ROUND_IN_PROGRESS'

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
        for existing_code, p in self.state['participants'].items():
            if p['name'].strip().lower() == name.lower():
                return p

        # Auto-assign internal code if not provided
        if not code or not str(code).strip():
            count = len(self.state['participants']) + 1
            code = f"P{count:03d}" if count > 99 else f"P{count:02d}"
            while code in self.state['participants']:
                count += 1
                code = f"P{count:03d}" if count > 99 else f"P{count:02d}"
        else:
            code = str(code).strip().upper()

        current_r = self.state.get('current_round', 0)
        initial_history = [
            {
                'round': r,
                'value': self.config['initial_capital'],
                'drawdown': 0.0,
                'rank': len(self.state['participants']) + 1
            }
            for r in range(current_r + 1)
        ]
        self.state['participants'][code] = {
            'code': code,
            'name': name,
            'allocations': {},
            'current_value': self.config['initial_capital'],
            'prev_value': self.config['initial_capital'],
            'current_rank': len(self.state['participants']) + 1,
            'prev_rank': len(self.state['participants']) + 1,
            'max_drawdown': 0.0,
            'history': initial_history
        }

        self.save_state()
        return self.state['participants'][code]

    def submit_allocation(self, code_or_name, stage, allocation):
        key = str(code_or_name).strip()
        p = self.state['participants'].get(key.upper())
        if not p:
            # Look up by name
            for existing in self.state['participants'].values():
                if existing['name'].strip().lower() == key.lower():
                    p = existing
                    break
        if not p:
            raise ValueError(f"Peserta '{key}' belum terdaftar")

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
        # We need the portfolio value at the start of each stage
        # Stage 1 starts at Round 0 with initial_capital
        # Stage 2 starts at Round 10 with value at Round 10
        # Stage 3 starts at Round 20 with value at Round 20
        rounds_per_stage = self.state['rounds_per_stage']

        for code, p in self.state['participants'].items():
            p['prev_value'] = p.get('current_value', self.config['initial_capital'])
            p['prev_rank'] = p.get('current_rank', 1)

            # Find stage start base value safely
            if current_stage <= 1:
                base_val = self.config['initial_capital']
            else:
                target_round = (current_stage - 1) * rounds_per_stage
                base_val = None
                # Check history for the exact target round
                for h in p.get('history', []):
                    if h.get('round') == target_round:
                        base_val = h.get('value')
                        break
                if base_val is None:
                    # Look for the latest available round <= target_round
                    valid_h = [h for h in p.get('history', []) if h.get('round', 0) <= target_round]
                    if valid_h:
                        base_val = valid_h[-1].get('value', self.config['initial_capital'])
                    else:
                        base_val = p.get('current_value', self.config['initial_capital'])

            # Get effective allocation for this stage
            alloc = self.get_effective_allocation(code, current_stage)

            # Portfolio growth factor within this stage = sum(weight_i * stage_factor_i)
            # weights are in percent (0-100), divide by 100
            growth = sum(
                (alloc.get(a, 0.0) / 100.0) * self.state['stage_factors'].get(a, 1.0)
                for a in ['sukuk', 'saham', 'rdpu', 'emas', 'campuran']
            )

            current_val = base_val * growth
            p['current_value'] = current_val

            # Calculate Drawdown
            all_values = [h.get('value', base_val) for h in p.get('history', [])] + [current_val]
            peak = max(all_values) if all_values else current_val
            drawdown = max(0.0, 1.0 - (current_val / peak)) if peak > 0 else 0.0

            # Max drawdown so far
            prev_mdd = p.get('max_drawdown', 0.0)
            p['max_drawdown'] = max(prev_mdd, drawdown)

            # Add to history
            if 'history' not in p:
                p['history'] = []
            p['history'].append({
                'round': current_round,
                'value': current_val,
                'drawdown': drawdown,
                'rank': p.get('current_rank', 1)
            })

        # Update rankings
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

        # Filter participants whose max drawdown <= limit
        eligible = [
            p for p in self.state['participants'].values()
            if p.get('max_drawdown', 0.0) <= max_dd_limit
        ]
        return sorted(eligible, key=lambda p: p['current_value'], reverse=True)

    def seed_mock_participants(self, count=200):
        """Generates realistic mock participants with diverse strategies for demo/stress-testing."""
        strategies = [
            # Sukuk Heavy (Conservative)
            {'name': 'Konservatif Sukuk', 'alloc': {'sukuk': 50, 'saham': 10, 'rdpu': 25, 'emas': 10, 'campuran': 5}},
            # Saham Heavy (Aggressive)
            {'name': 'Agresif Saham', 'alloc': {'sukuk': 10, 'saham': 60, 'rdpu': 10, 'emas': 10, 'campuran': 10}},
            # Balanced (All Rounder)
            {'name': 'Seimbang Moderat', 'alloc': {'sukuk': 20, 'saham': 20, 'rdpu': 20, 'emas': 20, 'campuran': 20}},
            # Gold Hedger
            {'name': 'Hedger Emas', 'alloc': {'sukuk': 20, 'saham': 10, 'rdpu': 10, 'emas': 50, 'campuran': 10}},
            # Campuran Flexible
            {'name': 'Campuran Taktis', 'alloc': {'sukuk': 20, 'saham': 20, 'rdpu': 10, 'emas': 10, 'campuran': 40}},
            # Pasar Uang Safe Haven
            {'name': 'Pasar Uang Stabil', 'alloc': {'sukuk': 20, 'saham': 5, 'rdpu': 55, 'emas': 15, 'campuran': 5}},
        ]

        sample_team_names = [
            "Garuda Investa", "Nusantara Capital", "Merdeka Alpha", "Srikandi Wealth", "Kencana Fund",
            "Bintang Timur", "Samudera Aset", "Pertiwi Syariah", "Barito Ventura", "Cakrawala Prima",
            "Trisula Asset", "Mandiri Dinamis", "Bumi Inti", "Artha Mulia", "Adiwarna Prima",
            "Sentosa Global", "Dharma Sejahtera", "Pandawa Lima", "Krakatau Fund", "Wijaya Makmur"
        ]

        current_r = self.state.get('current_round', 0)
        curr_stage = self.state.get('current_stage', 1)

        self.state['participants'] = {}
        for i in range(1, count + 1):
            code = f"P{i:03d}" if count > 99 else f"P{i:02d}"
            strat = random.choice(strategies)
            base_name = sample_team_names[(i - 1) % len(sample_team_names)]
            team_name = f"{base_name} {i}"

            # Add slight random variations in allocations
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

            initial_history = [
                {
                    'round': r,
                    'value': self.config['initial_capital'],
                    'drawdown': 0.0,
                    'rank': i
                }
                for r in range(current_r + 1)
            ]

            p = {
                'code': code,
                'name': team_name,
                'allocations': allocations,
                'current_value': self.config['initial_capital'],
                'prev_value': self.config['initial_capital'],
                'current_rank': i,
                'prev_rank': i,
                'max_drawdown': 0.0,
                'history': initial_history
            }
            self.state['participants'][code] = p

        self.state['message'] = f"Berhasil membuat {count} peserta simulasi."
        self.save_state()
        return len(self.state['participants'])

    def get_public_state(self):
        """Returns clean state for API."""
        return {
            'status': self.state.get('status', 'WAITING_STAGE_1'),
            'current_round': self.state.get('current_round', 0),
            'current_stage': self.state.get('current_stage', 1),
            'stage_input_open': self.state.get('stage_input_open', False),
            'total_rounds': self.state.get('total_rounds', 30),
            'rounds_per_stage': self.state.get('rounds_per_stage', 10),
            'total_stages': self.state.get('total_stages', 3),
            'total_participants': len(self.state.get('participants', {})),
            'last_drawn_card': self.state['drawn_cards'][-1] if self.state.get('drawn_cards') else None,
            'recent_cards': list(reversed(self.state['drawn_cards'][-5:])) if self.state.get('drawn_cards') else [],
            'asset_indexes': {k: (v[-1] if v else 100.0) for k, v in self.state.get('asset_indexes', {}).items()},
            'asset_history': self.state.get('asset_indexes', {}),
            'message': self.state.get('message', ''),
            'config': {k: v for k, v in self.config.items() if k != 'admin'},
            'leaderboard_top10': self.get_leaderboard(limit=10),
            'investor_tangguh_top5': self.get_investor_tangguh(max_dd_limit=0.10)[:5]
        }
