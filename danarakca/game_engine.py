import json
import random
import os
import copy
import hashlib
import math
import queue
import re
import secrets
import time
import threading
from datetime import datetime

class GameEngine:
    MAX_PARTICIPANTS = 1000
    ASSET_IDS = ('sukuk', 'saham', 'rdpu', 'emas', 'campuran')
    _DEFAULT_ALLOCATION = {a: 20.0 for a in ASSET_IDS}

    def __init__(self, data_dir=None):
        self.lock = threading.RLock()
        self._last_refresh_time = 0.0
        self._mutation_seq = 0
        self._redis_read_failed = False
        self._public_view_cache = {}
        self._redis_write_queue = queue.Queue()
        self._redis_worker = None
        if data_dir is None:
            data_dir = os.path.join(os.path.dirname(__file__), 'data')
        self.data_dir = data_dir
        self.cards_file = os.path.join(data_dir, 'cards.json')
        self.config_file = os.path.join(data_dir, 'config.json')

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

    LIVE_CHANNEL = 'danarakca_live_' + hashlib.md5(b'danarakca_2026_pulse_channel').hexdigest()[:12]

    @staticmethod
    def sanitize_name(name):
        cleaned = re.sub(r'[<>"\'`\x00-\x1f\x7f]', '', str(name or ''))
        cleaned = re.sub(r'\s+', ' ', cleaned).strip()
        return cleaned[:60]

    @staticmethod
    def _safe_int(val, default=0):
        try:
            return int(val or 0)
        except (TypeError, ValueError):
            return default

    def _new_participant(self, code, name, joined_at, token_nonce=None, allocations=None, alloc_ts=None, rank=1):
        initial_cap = self.config['initial_capital']
        return {
            'code': code,
            'name': name,
            'joined_at': joined_at,
            'token_nonce': token_nonce or secrets.token_hex(8),
            'allocations': allocations if allocations is not None else {},
            'alloc_ts': alloc_ts if alloc_ts is not None else {},
            'current_value': initial_cap,
            'prev_value': initial_cap,
            'peak_value': initial_cap,
            'current_rank': rank,
            'prev_rank': rank,
            'max_drawdown': 0.0,
            'history': [],
        }

    @staticmethod
    def _merge_joined_at(target_p, incoming_joined_at):
        inc_joined = GameEngine._safe_int(incoming_joined_at)
        cur_joined = GameEngine._safe_int(target_p.get('joined_at'))
        if inc_joined > 0 and (cur_joined <= 0 or inc_joined < cur_joined):
            target_p['joined_at'] = inc_joined
            return True
        return False

    @staticmethod
    def _rank_sort_key(p):
        return (
            -round(p.get('current_value', 0.0), 6),
            round(p.get('max_drawdown', 0.0), 6),
            0 if p.get('allocations') else 1,
            int(p.get('joined_at', 0) or 0) or (1 << 62),
            p.get('name', '').lower(),
            p.get('code', '')
        )

    @staticmethod
    def _validate_allocation(allocation, raise_on_error=False):
        if not isinstance(allocation, dict):
            if raise_on_error:
                raise ValueError("Data alokasi tidak valid")
            return None
        clean_alloc = {}
        total = 0.0
        for a in GameEngine.ASSET_IDS:
            try:
                val = float(allocation.get(a, 0))
            except (TypeError, ValueError):
                if raise_on_error:
                    raise ValueError(f"Nilai alokasi untuk {a} tidak valid")
                return None
            if not math.isfinite(val) or val < 0.0 or val > 100.0:
                if raise_on_error:
                    raise ValueError(f"Alokasi untuk {a} harus antara 0 dan 100")
                return None
            clean_alloc[a] = val
            total += val
        if abs(total - 100.0) > 1e-6:
            if raise_on_error:
                raise ValueError(f"Total alokasi harus tepat 100% (saat ini {round(total, 2)}%)")
            return None
        return clean_alloc

    @staticmethod
    def sanitize_allocation(allocation):
        return GameEngine._validate_allocation(allocation, raise_on_error=False)

    @staticmethod
    def _copy_participant(p, include_nonce=True, include_history=True):
        if not isinstance(p, dict):
            return None
        allocs = p.get('allocations')
        alloc_ts = p.get('alloc_ts')
        out = {
            'code': p['code'],
            'name': p['name'],
            'joined_at': p.get('joined_at', 0),
            'allocations': {k: dict(v) for k, v in allocs.items()} if isinstance(allocs, dict) else {},
            'alloc_ts': dict(alloc_ts) if isinstance(alloc_ts, dict) else {},
            'current_value': p.get('current_value', 0),
            'prev_value': p.get('prev_value', 0),
            'peak_value': p.get('peak_value', 0),
            'current_rank': p.get('current_rank', 1),
            'prev_rank': p.get('prev_rank', 1),
            'max_drawdown': p.get('max_drawdown', 0.0),
        }
        if include_nonce and 'token_nonce' in p:
            out['token_nonce'] = p['token_nonce']
        if include_history:
            hist = p.get('history')
            out['history'] = [dict(h) for h in hist] if isinstance(hist, list) else []
        return out

    @staticmethod
    def _public_participant(p, include_history=True):
        return GameEngine._copy_participant(p, include_nonce=False, include_history=include_history)

    @staticmethod
    def make_participant_code(name):
        clean = GameEngine.sanitize_name(name).lower()
        digest = hashlib.md5(clean.encode('utf-8')).hexdigest()[:6].upper()
        return f"T{digest}"

    def _build_live_payload_locked(self, event_type, data=None):
        st = self.state if hasattr(self, 'state') and isinstance(self.state, dict) else {}
        payload = {
            'event': event_type,
            'session_id': st.get('session_id', 1),
            'state_version': st.get('state_version', 1),
            'current_round': st.get('current_round', 0),
            'current_stage': st.get('current_stage', 1),
            'stage_input_open': st.get('stage_input_open', False),
            'status': st.get('status', 'WAITING_STAGE_1'),
            'message': st.get('message', ''),
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        }
        if data and isinstance(data, dict):
            payload.update(data)
        return payload

    def _publish_live_event(self, event_type, data=None, prebuilt_payload=None):
        """Broadcasts real-time events to connected participant phones outside self.lock."""
        if prebuilt_payload is not None:
            payload = prebuilt_payload
        else:
            with self.lock:
                payload = self._build_live_payload_locked(event_type, data=data)

        def _send():
            import urllib.request
            try:
                body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                req = urllib.request.Request(
                    f"https://ntfy.sh/{self.LIVE_CHANNEL}",
                    data=body,
                    headers={
                        'Title': f"Danarakca: {event_type}",
                        'Priority': 'urgent',
                        'User-Agent': 'Danarakca-Engine/1.0'
                    },
                    method='POST'
                )
                with urllib.request.urlopen(req, timeout=0.8):
                    pass
            except Exception:
                pass

        if os.environ.get('VERCEL') == '1':
            _send()
        else:
            t = threading.Thread(target=_send, daemon=True)
            t.start()

    def _next_join_seq(self):
        now_ms = int(datetime.now().timestamp() * 1000)
        cur_max = 0
        if hasattr(self, 'state') and isinstance(self.state, dict):
            for p in self.state.get('participants', {}).values():
                if isinstance(p, dict):
                    cur_max = max(cur_max, self._safe_int(p.get('joined_at')))
        return max(now_ms, cur_max + 1)

    def _merge_roster_entries(self, state_dict, roster_raw):
        if not isinstance(state_dict, dict) or not roster_raw:
            return False
        cur_sess = int(state_dict.get('session_id', 0))
        cur_epoch = int(state_dict.get('roster_epoch', 0))
        participants = state_dict.setdefault('participants', {})
        if isinstance(roster_raw, dict):
            pairs = list(roster_raw.items())
        elif isinstance(roster_raw, list):
            pairs = [(roster_raw[i], roster_raw[i + 1]) for i in range(0, len(roster_raw) - 1, 2)]
        else:
            pairs = []

        changed = False
        for _, raw_val in pairs:
            try:
                p_meta = json.loads(raw_val) if isinstance(raw_val, str) else raw_val
            except Exception:
                continue
            if not isinstance(p_meta, dict):
                continue
            if int(p_meta.get('session_id', 0)) != cur_sess or int(p_meta.get('roster_epoch', 0)) != cur_epoch:
                continue
            name = self.sanitize_name(p_meta.get('name', ''))
            if not name:
                continue
            det_code = self.make_participant_code(name)
            inc_joined = self._safe_int(p_meta.get('joined_at'))
            inc_nonce = str(p_meta.get('token_nonce', '') or '')
            if det_code not in participants:
                participants[det_code] = self._new_participant(
                    det_code,
                    name,
                    joined_at=inc_joined or self._next_join_seq(),
                    token_nonce=inc_nonce,
                )
                changed = True
            else:
                if self._merge_joined_at(participants[det_code], inc_joined):
                    changed = True
                if inc_nonce and not participants[det_code].get('token_nonce'):
                    participants[det_code]['token_nonce'] = inc_nonce
            if self._merge_participant_allocations(
                participants[det_code],
                p_meta.get('allocations'),
                p_meta.get('alloc_ts'),
                max_stage=3
            ):
                changed = True
        return changed

    def _redis_request(self, path='', payload_obj=None, parse_json=True):
        import urllib.request
        url = f"{self.redis_url}{path}"
        data = None
        method = "GET"
        if payload_obj is not None:
            data = json.dumps(payload_obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            method = "POST"
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.redis_token}")
        req.add_header("User-Agent", "Danarakca-Server/1.0")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read().decode('utf-8')) if parse_json else None

    @staticmethod
    def _unwrap_json_dict(val):
        while isinstance(val, str):
            val = json.loads(val)
        return val if isinstance(val, dict) else None

    def _load_from_redis(self):
        if not self.redis_url or not self.redis_token:
            return None, False
        try:
            results = self._redis_request("/pipeline", [["GET", "danarakca_state"], ["HGETALL", "danarakca_roster"]])
            if isinstance(results, list) and results:
                val = self._unwrap_json_dict(results[0].get("result") if isinstance(results[0], dict) else None)
                if val is not None:
                    roster_res = results[1].get("result") if len(results) > 1 and isinstance(results[1], dict) else None
                    if roster_res and self._merge_roster_entries(val, roster_res):
                        val['_roster_merged'] = True
                    return val, False
        except Exception:
            pass

        try:
            data = self._redis_request("/get/danarakca_state")
            val = self._unwrap_json_dict(data.get("result"))
            if val is not None:
                return val, False
        except Exception as e:
            print(f"Redis get error: {e}")
            return None, True
        return None, False

    def _ensure_redis_worker(self):
        if self._redis_worker is None or not self._redis_worker.is_alive():
            def _worker():
                while True:
                    payload = self._redis_write_queue.get()
                    try:
                        self._flush_redis_payload(payload)
                    except Exception:
                        pass
                    finally:
                        self._redis_write_queue.task_done()

            self._redis_worker = threading.Thread(target=_worker, daemon=True)
            self._redis_worker.start()

    def _build_redis_payload_locked(self, clear_roster=False, dirty_codes=None, state_json=None):
        st = self.state
        read_failed = bool(self._redis_read_failed)
        cur_round = int(st.get('current_round', 0))
        participants_map = st.get('participants', {})
        part_count = len(participants_map)
        if state_json is None:
            state_json = json.dumps(st, ensure_ascii=False, separators=(',', ':'))

        cur_sess = int(st.get('session_id', 1))
        cur_epoch = int(st.get('roster_epoch', 0))
        codes_to_sync = list(participants_map.keys()) if clear_roster else [
            c for c in (dirty_codes or ()) if c in participants_map
        ]
        roster_entries = []
        for code in codes_to_sync:
            p = participants_map.get(code)
            if not isinstance(p, dict):
                continue
            p_meta = json.dumps({
                'session_id': cur_sess,
                'roster_epoch': cur_epoch,
                'code': code,
                'name': p.get('name', ''),
                'joined_at': self._safe_int(p.get('joined_at')),
                'token_nonce': p.get('token_nonce', ''),
                'allocations': p.get('allocations', {}),
                'alloc_ts': p.get('alloc_ts', {})
            }, ensure_ascii=False, separators=(',', ':'))
            roster_entries.append((code, p_meta))
        return state_json, cur_round, part_count, roster_entries, clear_roster, read_failed

    def _flush_redis_payload(self, payload):
        if not self.redis_url or not self.redis_token:
            return
        state_json, cur_round, part_count, roster_entries, clear_roster, redis_read_failed = payload
        # Avoid rolling back shared Redis state when the read failed and self.state is a stale fallback
        if redis_read_failed:
            return
        # Guard against overwriting an active Redis session with an empty container state
        if cur_round > 0 and part_count == 0:
            return

        try:
            commands = [["DEL", "danarakca_roster"]] if clear_roster else []
            for code, p_meta in roster_entries:
                commands.append(["HSET", "danarakca_roster", code, p_meta])
            commands.append(["SET", "danarakca_state", state_json])

            self._redis_request("/pipeline", commands, parse_json=False)
            return
        except Exception:
            pass

        try:
            self._redis_request("", ["SET", "danarakca_state", state_json], parse_json=False)
        except Exception as e:
            print(f"Redis set error: {e}")

    def _save_to_redis(self, clear_roster=False, dirty_codes=None):
        with self.lock:
            payload = self._build_redis_payload_locked(clear_roster=clear_roster, dirty_codes=dirty_codes)
        self._flush_redis_payload(payload)

    def load_cards(self):
        with open(self.cards_file, 'r', encoding='utf-8') as f:
            self.cards = json.load(f)
        self.cards_by_id = {c['id']: c for c in self.cards}

    def load_config(self):
        with open(self.config_file, 'r', encoding='utf-8') as f:
            self.config = json.load(f)

    @staticmethod
    def _merge_participant_allocations(target_p, incoming_allocs, incoming_ts=None, max_stage=3, lock_existing_stage=None, only_stage=None):
        if not isinstance(incoming_allocs, dict) or not incoming_allocs:
            return False
        cur_allocs = target_p.setdefault('allocations', {})
        cur_ts_map = target_p.setdefault('alloc_ts', {})
        ts_in = incoming_ts if isinstance(incoming_ts, dict) else {}
        changed = False
        for stg, alloc in incoming_allocs.items():
            stg_str = str(stg)
            if stg_str not in ('1', '2', '3') or int(stg_str) > max_stage:
                continue
            if only_stage is not None and stg_str != str(only_stage):
                continue
            if lock_existing_stage is not None and stg_str == str(lock_existing_stage) and stg_str in cur_allocs:
                continue
            valid_alloc = GameEngine.sanitize_allocation(alloc)
            if not valid_alloc:
                continue
            inc_ts = GameEngine._safe_int(ts_in.get(stg_str))
            cur_ts = GameEngine._safe_int(cur_ts_map.get(stg_str))
            if stg_str not in cur_allocs or inc_ts > cur_ts:
                cur_allocs[stg_str] = valid_alloc
                cur_ts_map[stg_str] = max(cur_ts, inc_ts, 1)
                changed = True
        return changed

    def refresh_state(self, force=False, min_version=0, min_round=0, min_session=0):
        with self.lock:
            now = time.time()
            has_state = hasattr(self, 'state') and isinstance(self.state, dict)
            if not force and has_state:
                cur_ver = int(self.state.get('state_version', 0))
                cur_rnd = int(self.state.get('current_round', 0))
                cur_sess = int(self.state.get('session_id', 0))
                behind = (
                    (min_version > 0 and cur_ver < min_version)
                    or (min_round > 0 and cur_rnd < min_round)
                    or (min_session > 0 and cur_sess < min_session)
                )
                if not behind and (now - self._last_refresh_time < 0.75):
                    return True

            self._redis_read_failed = False
            loaded = None

            if self.redis_url and self.redis_token:
                redis_state, read_failed = self._load_from_redis()
                self._redis_read_failed = read_failed
                if isinstance(redis_state, dict):
                    loaded = redis_state

            if not loaded and os.path.exists(self.state_file):
                try:
                    with open(self.state_file, 'r', encoding='utf-8') as f:
                        file_state = json.load(f)
                    if isinstance(file_state, dict):
                        loaded = file_state
                except Exception:
                    pass

            if not loaded:
                return has_state

            self._last_refresh_time = time.time()
            roster_merged = bool(loaded.pop('_roster_merged', False))

            def _adopt_loaded():
                self.state = loaded
                if roster_merged:
                    self._rebuild_simulation()
                self._public_view_cache.clear()
                return True

            if not has_state:
                return _adopt_loaded()

            file_sess = int(loaded.get('session_id', 0))
            mem_sess = int(self.state.get('session_id', 0))
            file_ver = int(loaded.get('state_version', 0))
            mem_ver = int(self.state.get('state_version', 0))

            if file_sess > mem_sess:
                return _adopt_loaded()
            if file_sess < mem_sess:
                return True

            # Same session: keep the newer roster epoch, otherwise merge participants and drawn cards
            file_epoch = int(loaded.get('roster_epoch', 0))
            mem_epoch = int(self.state.get('roster_epoch', 0))
            if file_epoch > mem_epoch:
                return _adopt_loaded()
            if mem_epoch > file_epoch:
                return True

            mem_participants = self.state.get('participants', {})
            loaded_participants = loaded.get('participants', {})
            mem_cards = self.state.get('drawn_cards', [])
            loaded_cards = loaded.get('drawn_cards', [])

            # Compare progression tuple (rounds, stage, version) so a lagging container never rolls back stage/round
            file_prog = (len(loaded_cards), int(loaded.get('current_stage', 1)), file_ver)
            mem_prog = (len(mem_cards), int(self.state.get('current_stage', 1)), mem_ver)
            file_is_newer = (file_prog >= mem_prog)

            if file_is_newer:
                primary_participants, secondary_participants = loaded_participants, mem_participants
            else:
                primary_participants, secondary_participants = mem_participants, loaded_participants

            merged_participants = {k: copy.deepcopy(v) for k, v in primary_participants.items()}
            need_rebuild = roster_merged or (file_is_newer and len(merged_participants) != len(loaded_participants))

            for code, p in secondary_participants.items():
                if code not in merged_participants:
                    merged_participants[code] = copy.deepcopy(p)
                    need_rebuild = True
                    continue
                if self._merge_joined_at(merged_participants[code], p.get('joined_at')):
                    need_rebuild = True
                if p.get('token_nonce') and not merged_participants[code].get('token_nonce'):
                    merged_participants[code]['token_nonce'] = p.get('token_nonce')
                if isinstance(p.get('allocations'), dict) and self._merge_participant_allocations(
                    merged_participants[code],
                    p.get('allocations'),
                    p.get('alloc_ts'),
                    max_stage=3
                ):
                    need_rebuild = True

            target_round_len = max(len(mem_cards), len(loaded_cards))
            if any(len(p.get('history', [])) != target_round_len + 1 for p in merged_participants.values()):
                need_rebuild = True

            if file_is_newer:
                self.state = loaded
                extra_cards = mem_cards if len(mem_cards) > len(loaded_cards) else None
            else:
                extra_cards = loaded_cards if len(loaded_cards) > len(mem_cards) else None
            self.state['participants'] = merged_participants
            if extra_cards is not None:
                self.state['drawn_cards'] = extra_cards
                self.state['current_round'] = len(extra_cards)
                need_rebuild = True
            self.state['state_version'] = max(file_ver, mem_ver)

            if need_rebuild:
                self._rebuild_simulation()
                if self.state.get('current_round', 0) >= self.state.get('total_rounds', 30):
                    self.state['status'] = 'GAME_FINISHED'

            self._public_view_cache.clear()
            return True

    def load_or_init_state(self):
        if not self.refresh_state():
            self.reset_game()
        else:
            if 'session_id' not in self.state:
                self.state['session_id'] = 1
            if 'state_version' not in self.state:
                self.state['state_version'] = 1

    def _bump_version(self, use_wall_clock=True):
        cur_ver = int(self.state.get('state_version', 0))
        if use_wall_clock:
            now_ms = int(datetime.now().timestamp() * 1000)
            self.state['state_version'] = max(cur_ver + 1, now_ms)
        else:
            self.state['state_version'] = cur_ver + 1

    def save_state(self, bump_version=True, use_wall_clock=True, clear_roster=False, dirty_codes=None):
        with self.lock:
            if bump_version:
                self._bump_version(use_wall_clock=use_wall_clock)
            self._mutation_seq += 1
            self._public_view_cache.clear()
            state_json = json.dumps(self.state, ensure_ascii=False, separators=(',', ':'))
            tmp_file = f"{self.state_file}.tmp.{os.getpid()}.{threading.get_ident()}"
            try:
                with open(tmp_file, 'w', encoding='utf-8') as f:
                    f.write(state_json)
                    f.flush()
                os.replace(tmp_file, self.state_file)
            except Exception:
                try:
                    if os.path.exists(tmp_file):
                        os.remove(tmp_file)
                except Exception:
                    pass

            self._last_refresh_time = time.time()
            # Sync to Upstash Redis if available (ordered queue avoids out-of-order overwrites)
            if self.redis_url and self.redis_token:
                payload = self._build_redis_payload_locked(
                    clear_roster=clear_roster,
                    dirty_codes=dirty_codes,
                    state_json=state_json
                )
                if os.environ.get('VERCEL') == '1':
                    self._flush_redis_payload(payload)
                else:
                    self._ensure_redis_worker()
                    self._redis_write_queue.put(payload)

    def reset_game(self, preserve_participants=False, total_stages=None):
        with self.lock:
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
            prev_ver = int(self.state.get('state_version', 0)) if hasattr(self, 'state') and isinstance(self.state, dict) else 0
            new_session_id = max(prev_sess + 1, now_ms)
            new_state_version = max(new_session_id, prev_ver + 1)

            participants = {}
            if preserve_participants and hasattr(self, 'state') and isinstance(self.state, dict) and 'participants' in self.state:
                for idx, (_, p) in enumerate(self.state['participants'].items(), start=1):
                    det_code = self.make_participant_code(p['name'])
                    participants[det_code] = self._new_participant(
                        det_code,
                        p['name'],
                        joined_at=self._safe_int(p.get('joined_at')) or idx,
                        token_nonce=p.get('token_nonce'),
                    )

            self.state = {
                'session_id': new_session_id,
                'state_version': new_state_version,
                'roster_epoch': 0,
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
                'asset_indexes': {a: [100.0] for a in self.ASSET_IDS},
                'stage_factors': {a: 1.0 for a in self.ASSET_IDS},
                'message': f'Game dimulai ({total_stages} Tahap / {total_rounds} Putaran). Silakan peserta mendaftar dan mengisi alokasi Tahap 1.'
            }
            self._rebuild_simulation([])
            self.save_state(bump_version=False, clear_roster=True)
            live_payload = self._build_live_payload_locked('GAME_RESET')
        self._publish_live_event('GAME_RESET', prebuilt_payload=live_payload)

    def _apply_card_round(self, round_num, stage_num, selected_card, timestamp=None, base_returns=None):
        if base_returns is None:
            base_returns = {a['id']: a['base_return'] for a in self.config['assets']}
        round_returns = {
            a: base_returns[a] + selected_card[f'return_{a}']
            for a in self.ASSET_IDS
        }
        rounds_per_stage = self.state.get('rounds_per_stage', 10)
        if (round_num - 1) % rounds_per_stage == 0:
            self.state['stage_factors'] = {a: 1.0 + round_returns[a] for a in self.ASSET_IDS}
        else:
            for a in self.ASSET_IDS:
                self.state['stage_factors'][a] *= (1.0 + round_returns[a])

        asset_indexes = self.state.setdefault('asset_indexes', {})
        for a in self.ASSET_IDS:
            series = asset_indexes.get(a)
            if not series:
                series = [100.0]
                asset_indexes[a] = series
            series.append(round(series[-1] * (1.0 + round_returns[a]), 4))

        card_log_entry = {
            'round': round_num,
            'stage': stage_num,
            'card_id': selected_card['id'],
            'timestamp': timestamp or datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'card': selected_card,
            'returns': round_returns,
            'stage_factors': dict(self.state['stage_factors'])
        }
        self._recalculate_participants(round_num, stage_num)
        return card_log_entry

    def _rebuild_simulation(self, drawn_card_ids=None):
        """Deterministically rebuilds asset indexes, stage factors, drawn cards, and all participant histories."""
        self._mutation_seq += 1
        if drawn_card_ids is None:
            drawn_card_ids = [d['card_id'] for d in self.state.get('drawn_cards', []) if isinstance(d, dict) and 'card_id' in d]

        valid_card_ids = [cid for cid in drawn_card_ids if cid in self.cards_by_id]
        rounds_per_stage = self.state.get('rounds_per_stage', 10)
        initial_cap = self.config['initial_capital']
        base_returns = {a['id']: a['base_return'] for a in self.config['assets']}

        self.state['asset_indexes'] = {a: [100.0] for a in self.ASSET_IDS}
        self.state['stage_factors'] = {a: 1.0 for a in self.ASSET_IDS}

        existing_timestamps = {
            d['card_id']: d.get('timestamp')
            for d in self.state.get('drawn_cards', [])
            if isinstance(d, dict) and 'card_id' in d
        }

        for p in self.state.get('participants', {}).values():
            p['current_value'] = initial_cap
            p['prev_value'] = initial_cap
            p['peak_value'] = initial_cap
            p['current_rank'] = 1
            p['prev_rank'] = 1
            p['max_drawdown'] = 0.0
            p['history'] = [{
                'round': 0,
                'value': initial_cap,
                'drawdown': 0.0,
                'rank': 1
            }]

        # Rank at round 0: prioritize active allocations and first-come registration order (joined_at)
        sorted_codes = sorted(
            self.state.get('participants', {}).keys(),
            key=lambda c: (
                0 if self.state['participants'][c].get('allocations') else 1,
                self._safe_int(self.state['participants'][c].get('joined_at')) or (1 << 62),
                self.state['participants'][c]['name'].lower(),
                c
            )
        )
        for rank, code in enumerate(sorted_codes, start=1):
            self.state['participants'][code]['current_rank'] = rank
            self.state['participants'][code]['prev_rank'] = rank
            self.state['participants'][code]['history'][0]['rank'] = rank

        new_drawn_cards = []
        for idx, card_id in enumerate(valid_card_ids):
            r = idx + 1
            expected_stage = 1 + (r - 1) // rounds_per_stage
            new_drawn_cards.append(
                self._apply_card_round(
                    r,
                    expected_stage,
                    self.cards_by_id[card_id],
                    timestamp=existing_timestamps.get(card_id),
                    base_returns=base_returns,
                )
            )

        drawn_set = set(valid_card_ids)
        self.state['drawn_cards'] = new_drawn_cards
        self.state['available_cards'] = [c['id'] for c in self.cards if c['id'] not in drawn_set]
        self.state['current_round'] = len(new_drawn_cards)

    def _sync_client_state(self, client_sync, cur_session, cur_version, dirty_codes):
        if not isinstance(client_sync, dict) or not client_sync:
            return False
        changed = False
        inc_session = int(client_sync.get('session_id') or 0)
        inc_version = int(client_sync.get('state_version') or 0)
        inc_cards = client_sync.get('drawn_card_ids')
        cur_cards = [d['card_id'] for d in self.state.get('drawn_cards', [])]

        # Newer session (e.g. facilitator reset game on another container)
        if inc_session > cur_session:
            self.state['session_id'] = inc_session
            self.state['state_version'] = inc_version
            self.state['roster_epoch'] = int(client_sync.get('roster_epoch') or 0)
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
            if isinstance(inc_cards, list):
                cur_cards = inc_cards
            changed = True
        elif inc_session == cur_session or cur_session <= 1:
            if inc_session > 1 and cur_session <= 1:
                self.state['session_id'] = inc_session
                cur_session = inc_session
                changed = True

            inc_epoch = int(client_sync.get('roster_epoch') or 0)
            cur_epoch = int(self.state.get('roster_epoch', 0))
            if inc_epoch < cur_epoch:
                return False
            if inc_epoch > cur_epoch:
                self.state['roster_epoch'] = inc_epoch
                self.state['participants'] = {}
                changed = True

            if inc_version > cur_version or inc_epoch > cur_epoch or (isinstance(inc_cards, list) and len(inc_cards) > len(cur_cards)):
                self.state['state_version'] = max(cur_version, inc_version)
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

        if inc_session == cur_session and isinstance(client_sync.get('participants_sync'), dict):
            for p_data in client_sync['participants_sync'].values():
                if not isinstance(p_data, dict) or not p_data.get('name'):
                    continue
                name = self.sanitize_name(p_data['name'])
                if not name:
                    continue
                det_code = self.make_participant_code(name)
                inc_joined = self._safe_int(p_data.get('joined_at'))
                p_dirty = False
                if det_code not in self.state['participants']:
                    self.state['participants'][det_code] = self._new_participant(
                        det_code,
                        name,
                        joined_at=inc_joined or self._next_join_seq(),
                    )
                    p_dirty = True
                elif self._merge_joined_at(self.state['participants'][det_code], inc_joined):
                    p_dirty = True
                if self._merge_participant_allocations(
                    self.state['participants'][det_code],
                    p_data.get('allocations'),
                    p_data.get('alloc_ts'),
                    max_stage=3
                ):
                    p_dirty = True
                if p_dirty:
                    dirty_codes.add(det_code)
                    changed = True

        if changed:
            self._rebuild_simulation(cur_cards)
        return changed

    def _sync_participant(self, participant_sync, cur_session, dirty_codes):
        # Never allow participant_sync to alter cards, stage, or joined_at
        if not isinstance(participant_sync, dict) or not participant_sync.get('name'):
            return False
        p_sess = int(participant_sync.get('_token_session_id') or participant_sync.get('session_id') or 0)
        token_nonce = str(participant_sync.get('_token_nonce', '') or '')
        token_joined = self._safe_int(participant_sync.get('_token_joined_at'))
        name = self.sanitize_name(participant_sync.get('_token_name') or participant_sync['name'])
        if not name or not token_nonce:
            return False
        if self.is_participant_session_expired(name, p_sess, token_nonce=token_nonce):
            return False

        det_code = self.make_participant_code(name)
        session_matches = (p_sess == cur_session) or (cur_session <= 1 and p_sess >= 1)
        need_force_refresh = det_code not in self.state['participants']
        cur_stg_num = int(self.state.get('current_stage', 1))
        can_merge_current = bool(self.state.get('stage_input_open', False)) and self.state.get('status') != 'GAME_FINISHED'
        inc_allocs = participant_sync.get('allocations')

        if not need_force_refresh and session_matches and can_merge_current and isinstance(inc_allocs, dict):
            existing_p = self.state['participants'][det_code]
            existing_allocs = existing_p.get('allocations', {})
            existing_ts = existing_p.get('alloc_ts', {})
            inc_ts_map = participant_sync.get('alloc_ts') if isinstance(participant_sync.get('alloc_ts'), dict) else {}
            stg_str = str(cur_stg_num)
            if stg_str in inc_allocs:
                inc_ts = self._safe_int(inc_ts_map.get(stg_str))
                cur_ts = self._safe_int(existing_ts.get(stg_str))
                if stg_str not in existing_allocs or inc_ts > cur_ts:
                    need_force_refresh = True

        if need_force_refresh:
            self.refresh_state(force=True)
            cur_session = int(self.state.get('session_id', 1))
            session_matches = (p_sess == cur_session) or (cur_session <= 1 and p_sess >= 1)

        if self.is_participant_session_expired(name, p_sess, token_nonce=token_nonce):
            return False

        p_changed = False
        is_new_p = False
        if det_code not in self.state['participants'] and len(self.state['participants']) < self.MAX_PARTICIPANTS:
            self.state['participants'][det_code] = self._new_participant(
                det_code,
                name,
                joined_at=token_joined or self._next_join_seq(),
                token_nonce=token_nonce,
            )
            p_changed = True
            is_new_p = True

        if det_code in self.state['participants']:
            cur_stg_num = int(self.state.get('current_stage', 1))
            can_merge_current = bool(self.state.get('stage_input_open', False)) and self.state.get('status') != 'GAME_FINISHED'
            if session_matches and can_merge_current and self._merge_participant_allocations(
                self.state['participants'][det_code],
                inc_allocs,
                participant_sync.get('alloc_ts'),
                max_stage=cur_stg_num,
                only_stage=cur_stg_num
            ):
                p_changed = True

        if p_changed:
            dirty_codes.add(det_code)
            if not self._recalculate_single_participant(det_code, start_stage=1 if is_new_p else cur_stg_num):
                self._rebuild_simulation()
        return p_changed

    def sync_state(self, client_sync=None, participant_sync=None):
        """Synchronizes state across stateless serverless containers using monotonic session_id and state_version."""
        with self.lock:
            dirty_codes = set()
            cur_session = int(self.state.get('session_id', 1))
            cur_version = int(self.state.get('state_version', 1))
            changed = self._sync_client_state(client_sync, cur_session, cur_version, dirty_codes)
            cur_session = int(self.state.get('session_id', 1))
            if self._sync_participant(participant_sync, cur_session, dirty_codes):
                changed = True
            if changed:
                self._public_view_cache.clear()
                self.save_state(bump_version=True, use_wall_clock=False, dirty_codes=dirty_codes)

    def is_participant_session_expired(self, name, session_id, token_nonce=None):
        """True when a player session is invalid, reset without preserve, or superseded."""
        with self.lock:
            p_sess = int(session_id or 0)
            cur_session = int(self.state.get('session_id', 1))
            if not p_sess:
                return True
            det_code = self.make_participant_code(name)
            p = self.state.get('participants', {}).get(det_code)
            if p is None:
                return p_sess != cur_session
            stored_nonce = p.get('token_nonce')
            if token_nonce and stored_nonce and str(token_nonce) != str(stored_nonce):
                return True
            return False

    def set_game_mode(self, total_stages):
        with self.lock:
            total_stages = int(total_stages)
            if total_stages not in (1, 2, 3):
                raise ValueError("Mode tahap harus 1, 2, atau 3 tahap")

            if total_stages < self.state.get('current_stage', 1):
                raise ValueError(f"Tidak dapat mengubah ke {total_stages} Tahap karena permainan sudah berada di Tahap {self.state.get('current_stage', 1)}")

            rounds_per_stage = self.state.get('rounds_per_stage', 10)
            new_total_rounds = total_stages * rounds_per_stage

            self.state['total_stages'] = total_stages
            self.state['total_rounds'] = new_total_rounds

            if self.state['current_round'] >= new_total_rounds:
                self.state['status'] = 'GAME_FINISHED'
            elif self.state['status'] == 'GAME_FINISHED' and self.state['current_round'] < new_total_rounds:
                self.state['status'] = 'ROUND_IN_PROGRESS' if self.state['current_round'] > 0 else 'WAITING_STAGE_1'

            self.state['message'] = f"Mode durasi diubah ke {total_stages} Tahap ({new_total_rounds} Putaran)."
            self._bump_version()
            self.save_state(bump_version=False)
            live_payload = self._build_live_payload_locked('MODE_CHANGED', {
                'total_stages': self.state['total_stages'],
                'total_rounds': self.state['total_rounds'],
            })
            result = {
                'total_stages': self.state['total_stages'],
                'total_rounds': self.state['total_rounds'],
                'status': self.state['status']
            }
        self._publish_live_event('MODE_CHANGED', prebuilt_payload=live_payload)
        return result

    def get_participant_nonce(self, code):
        with self.lock:
            p = self.state.get('participants', {}).get(str(code or '').upper())
            return p.get('token_nonce', '') if isinstance(p, dict) else ''

    def _find_participant(self, identifier):
        key = self.sanitize_name(identifier)
        if not key:
            return None
        participants = self.state.get('participants', {})
        p = participants.get(key.upper())
        if p:
            return p
        key_lower = key.lower()
        for part in participants.values():
            if part['name'].strip().lower() == key_lower or part['code'].lower() == key_lower:
                return part
        return None

    def get_participant_snapshot(self, identifier, include_history=True):
        with self.lock:
            return self._public_participant(self._find_participant(identifier), include_history=include_history)

    def get_export_snapshot(self):
        with self.lock:
            curr_stage = int(self.state.get('current_stage', 1))
            lb = self.get_leaderboard()
            alloc_map = {
                p['code']: {
                    1: self.get_effective_allocation(p['code'], 1),
                    2: self.get_effective_allocation(p['code'], 2),
                    3: self.get_effective_allocation(p['code'], 3)
                }
                for p in lb
            }
            return curr_stage, lb, alloc_map

    def register_participant(self, name, code=None, token_payload=None, allow_existing=False, include_history=True, require_token_session=False):
        with self.lock:
            name = self.sanitize_name(name)
            if not name:
                raise ValueError("Nama peserta / tim tidak boleh kosong")

            det_code = self.make_participant_code(name)
            name_lower = name.lower()

            def _find_existing():
                if det_code in self.state['participants']:
                    return self.state['participants'][det_code]
                for p in self.state['participants'].values():
                    if p['name'].strip().lower() == name_lower:
                        return p
                return None

            def _check_existing(existing_p):
                if isinstance(token_payload, dict) and token_payload.get('c') == existing_p.get('code'):
                    stored_nonce = existing_p.get('token_nonce')
                    if stored_nonce and token_payload.get('k') == stored_nonce:
                        return self._public_participant(existing_p, include_history=include_history)
                raise PermissionError("Nama tim sudah terdaftar di sesi ini. Gunakan nama lain.")

            existing = _find_existing()
            if existing:
                return _check_existing(existing)

            if require_token_session or (self.redis_url and self.redis_token):
                self.refresh_state(force=True)
                existing = _find_existing()
                if existing:
                    return _check_existing(existing)

            cur_session = int(self.state.get('session_id', 1))
            token_matches_session = (
                isinstance(token_payload, dict)
                and token_payload.get('c') == det_code
                and self._safe_int(token_payload.get('sid')) == cur_session
            )
            if require_token_session and not token_matches_session:
                raise PermissionError("Permainan baru telah dimulai. Silakan daftar ulang.")

            if len(self.state['participants']) >= self.MAX_PARTICIPANTS:
                raise ValueError("Kapasitas peserta sesi ini sudah penuh")

            token_nonce = ''
            token_joined = 0
            if token_matches_session:
                token_nonce = str(token_payload.get('k', '') or '')
                token_joined = self._safe_int(token_payload.get('j'))

            self.state['participants'][det_code] = self._new_participant(
                det_code,
                name,
                joined_at=token_joined or self._next_join_seq(),
                token_nonce=token_nonce,
                rank=len(self.state['participants']) + 1,
            )

            if not self._recalculate_single_participant(det_code, start_stage=1):
                self._rebuild_simulation()
            self.save_state(use_wall_clock=False, dirty_codes=(det_code,))
            return self._public_participant(self.state['participants'][det_code], include_history=include_history)

    def sync_player_session(self, name, token_payload):
        """Validates, optionally restores within same session, and snapshots player+state under a single lock."""
        with self.lock:
            def _expired():
                return {
                    'session_expired': True,
                    'state': self.get_public_state(view='player'),
                    'participant': None,
                    'token_meta': None,
                }

            if not isinstance(token_payload, dict) or not name:
                return _expired()
            token_sid = self._safe_int(token_payload.get('sid'))
            token_nonce = str(token_payload.get('k') or '')
            code = str(token_payload.get('c') or '').upper()
            if self.is_participant_session_expired(name, token_sid, token_nonce=token_nonce):
                return _expired()

            p = self.get_participant_snapshot(code or name, include_history=False)
            if p is None:
                try:
                    p = self.register_participant(
                        name=name,
                        code=code,
                        token_payload=token_payload,
                        include_history=False,
                        require_token_session=True,
                    )
                except PermissionError:
                    return _expired()

            pub_state = self.get_public_state(view='player')
            cur_sess = int(pub_state.get('session_id', 1))
            token_meta = None
            if p and token_sid < cur_sess:
                token_meta = (
                    cur_sess,
                    p['code'],
                    p['name'],
                    p.get('joined_at', 0),
                    self.get_participant_nonce(p['code']),
                )
            return {
                'session_expired': False,
                'state': pub_state,
                'participant': p,
                'token_meta': token_meta,
            }

    def register_and_snapshot(self, name, token_payload=None):
        """Registers or re-attaches participant and returns atomic snapshot + token metadata."""
        with self.lock:
            p = self.register_participant(name=name, token_payload=token_payload, include_history=False)
            pub_state = self.get_public_state(view='player')
            token_meta = (
                pub_state['session_id'],
                p['code'],
                p['name'],
                p.get('joined_at', 0),
                self.get_participant_nonce(p['code']),
            )
            return p, pub_state, token_meta

    def submit_allocation(self, code_or_name, stage, allocation, name=None, token_payload=None, allow_auto_register=False):
        with self.lock:
            if self.state.get('status') == 'GAME_FINISHED':
                raise ValueError("Simulasi telah selesai. Alokasi tidak dapat diubah.")

            key = self.sanitize_name(code_or_name or name or '')
            p = self._find_participant(key)
            if not p and name:
                clean_name = self.sanitize_name(name)
                for existing in self.state['participants'].values():
                    if existing['name'].strip().lower() == clean_name.lower():
                        p = existing
                        break
            if not p:
                if not allow_auto_register or not isinstance(token_payload, dict):
                    raise ValueError("Peserta tidak ditemukan. Silakan daftar terlebih dahulu.")
                reg_name = self.sanitize_name(token_payload.get('n') or name or key)
                if not reg_name:
                    raise ValueError("Nama peserta tidak valid")
                self.register_participant(
                    name=reg_name,
                    token_payload=token_payload,
                    include_history=False,
                    require_token_session=True,
                )
                p = self.state['participants'].get(self.make_participant_code(reg_name))
                if not p:
                    raise ValueError("Peserta gagal didaftarkan ulang")

            if isinstance(token_payload, dict):
                token_nonce = str(token_payload.get('k') or '')
                stored_nonce = str(p.get('token_nonce') or '')
                token_code = str(token_payload.get('c') or '').upper()
                if token_code != p['code'] or not stored_nonce or token_nonce != stored_nonce:
                    raise PermissionError("Permainan baru telah dimulai. Silakan daftar ulang.")

            code = p['code']
            stage = int(stage)
            if stage != self.state['current_stage']:
                raise ValueError(f"Saat ini bukan waktu pengisian Tahap {stage} (Tahap aktif: {self.state['current_stage']})")
            if not self.state['stage_input_open']:
                raise ValueError(f"Input alokasi Tahap {stage} sudah ditutup oleh Fasilitator")

            clean_alloc = self._validate_allocation(allocation, raise_on_error=True)

            now_ms = int(datetime.now().timestamp() * 1000)
            alloc_ts = self.state['participants'][code].setdefault('alloc_ts', {})
            prev_ts = self._safe_int(alloc_ts.get(str(stage)))
            alloc_ts[str(stage)] = max(prev_ts + 1, now_ms)
            self.state['participants'][code].setdefault('allocations', {})[str(stage)] = clean_alloc
            if not self._recalculate_single_participant(code, start_stage=stage):
                self._rebuild_simulation()
            self.save_state(use_wall_clock=False, dirty_codes=(code,))
            return clean_alloc

    def submit_allocation_session(self, code_or_name, stage, allocation, name=None, token_payload=None, allow_auto_register=False):
        """Submits allocation and snapshots participant+state under a single lock."""
        with self.lock:
            alloc = self.submit_allocation(
                code_or_name,
                stage,
                allocation,
                name=name,
                token_payload=token_payload,
                allow_auto_register=allow_auto_register,
            )
            p = self.get_participant_snapshot(code_or_name or name, include_history=False)
            pub_state = self.get_public_state(view='player')
            return alloc, p, pub_state

    @classmethod
    def _resolve_effective_allocation(cls, allocs, stage):
        if allocs:
            stg_s = str(stage)
            if stg_s in allocs:
                return allocs[stg_s]
            for s in range(stage - 1, 0, -1):
                prev_s = str(s)
                if prev_s in allocs:
                    return allocs[prev_s]
        return cls._DEFAULT_ALLOCATION

    def get_effective_allocation(self, code, stage):
        with self.lock:
            p = self.state['participants'].get(code)
            allocs = p.get('allocations', {}) if p else None
            return dict(self._resolve_effective_allocation(allocs, stage))

    def toggle_stage_input(self, open_status=None):
        with self.lock:
            if open_status is None:
                self.state['stage_input_open'] = not self.state['stage_input_open']
            else:
                self.state['stage_input_open'] = bool(open_status)

            status_text = "dibuka" if self.state['stage_input_open'] else "ditutup"
            self.state['message'] = f"Input alokasi Tahap {self.state['current_stage']} telah {status_text}."
            self._bump_version()
            self.save_state(bump_version=False)
            live_payload = self._build_live_payload_locked('STAGE_INPUT_TOGGLED')
            result = self.state['stage_input_open']
        self._publish_live_event('STAGE_INPUT_TOGGLED', prebuilt_payload=live_payload)
        return result

    def next_stage(self):
        with self.lock:
            if self.state['current_stage'] >= self.state['total_stages']:
                raise ValueError("Sudah mencapai tahap terakhir")

            rounds_per_stage = self.state.get('rounds_per_stage', 10)
            required_rounds = self.state['current_stage'] * rounds_per_stage
            if self.state['current_round'] < required_rounds:
                raise ValueError(f"Selesaikan putaran Tahap {self.state['current_stage']} ({required_rounds} putaran) sebelum memajukan tahap.")

            self.state['current_stage'] += 1
            self.state['stage_input_open'] = True

            self.state['message'] = f"Memasuki Tahap {self.state['current_stage']}. Sesi perubahan alokasi dibuka!"
            self._bump_version()
            self.save_state(bump_version=False)
            live_payload = self._build_live_payload_locked('STAGE_ADVANCED')
            new_stage = self.state['current_stage']
        self._publish_live_event('STAGE_ADVANCED', prebuilt_payload=live_payload)
        return new_stage

    def draw_card(self, card_id=None):
        with self.lock:
            if self.state['current_round'] >= self.state['total_rounds']:
                raise ValueError("Semua putaran telah selesai")

            next_round = self.state['current_round'] + 1
            expected_stage = 1 + (next_round - 1) // self.state['rounds_per_stage']

            if self.state['current_stage'] < expected_stage:
                raise ValueError(f"Perlu memajukan Tahap ke {expected_stage} terlebih dahulu sebelum memainkan putaran {next_round}")

            # Auto-close allocation input once a round card is drawn
            if self.state['stage_input_open']:
                self.state['stage_input_open'] = False

            if card_id:
                if card_id not in self.cards_by_id:
                    raise ValueError(f"Card ID {card_id} tidak valid")
                drawn_ids = {d.get('card_id') for d in self.state.get('drawn_cards', []) if isinstance(d, dict)}
                if card_id in drawn_ids:
                    raise ValueError(f"Card ID {card_id} sudah pernah ditarik pada sesi ini")
                if card_id in self.state['available_cards']:
                    self.state['available_cards'].remove(card_id)
            else:
                if not self.state['available_cards']:
                    # Reshuffle all cards if depleted
                    self.state['available_cards'] = [c['id'] for c in self.cards]
                card_id = random.choice(self.state['available_cards'])
                self.state['available_cards'].remove(card_id)
            selected_card = self.cards_by_id[card_id]

            card_log_entry = self._apply_card_round(next_round, expected_stage, selected_card)
            self.state['drawn_cards'].append(card_log_entry)
            self.state['current_round'] = next_round
            self.state['status'] = 'GAME_FINISHED' if next_round == self.state['total_rounds'] else 'ROUND_IN_PROGRESS'
            self.state['message'] = f"Putaran {next_round}: Kartu {selected_card['title']} keluar!"
            self._bump_version()
            self.save_state(bump_version=False)
            live_payload = self._build_live_payload_locked('CARD_DRAWN', {
                'card_entry': card_log_entry,
                'round': next_round,
                'stage': expected_stage,
                'card': selected_card,
                'returns': card_log_entry['returns'],
                'stage_factors': dict(self.state['stage_factors']),
            })
            entry_copy = copy.deepcopy(card_log_entry)
        self._publish_live_event('CARD_DRAWN', prebuilt_payload=live_payload)
        return entry_copy

    def _step_participant_round(self, p, round_num, stage_num, stage_factors, initial_cap, rounds_per_stage):
        p['prev_value'] = p.get('current_value', initial_cap)
        p['prev_rank'] = p.get('current_rank', 1)
        hist = p.get('history')
        if not isinstance(hist, list):
            hist = []
            p['history'] = hist

        if stage_num <= 1:
            base_val = initial_cap
        else:
            target_round = (stage_num - 1) * rounds_per_stage
            base_val = None
            if target_round < len(hist) and isinstance(hist[target_round], dict) and hist[target_round].get('round') == target_round:
                base_val = hist[target_round].get('value')
            if base_val is None:
                base_val = next((h.get('value') for h in hist if h.get('round') == target_round), None)
            if base_val is None:
                valid_h = [h for h in hist if h.get('round', 0) <= target_round]
                base_val = valid_h[-1].get('value', initial_cap) if valid_h else p.get('current_value', initial_cap)

        alloc = self._resolve_effective_allocation(p.get('allocations'), stage_num)
        growth = sum(alloc.get(a, 0.0) * stage_factors.get(a, 1.0) for a in self.ASSET_IDS) / 100.0
        current_val = base_val * growth
        p['current_value'] = current_val

        prev_peak = p.get('peak_value')
        if prev_peak is None:
            prev_peak = max((h.get('value', base_val) for h in hist), default=base_val)
        peak = max(float(prev_peak), current_val)
        p['peak_value'] = peak
        drawdown = max(0.0, 1.0 - (current_val / peak)) if peak > 0 else 0.0
        p['max_drawdown'] = max(p.get('max_drawdown', 0.0), drawdown)

        hist.append({
            'round': round_num,
            'value': current_val,
            'drawdown': drawdown,
            'rank': p.get('current_rank', 1)
        })

    def _assign_ranks_at_round(self, hist_idx, is_latest=False, is_prev=False):
        participants = self.state.get('participants', {})
        if not participants:
            return

        if hist_idx == 0:
            def _round0_key(c):
                p = participants[c]
                return (
                    0 if p.get('allocations') else 1,
                    self._safe_int(p.get('joined_at')) or (1 << 62),
                    p.get('name', '').lower(),
                    c,
                )
            sorted_codes = sorted(participants.keys(), key=_round0_key)
        elif is_latest:
            sorted_codes = sorted(participants.keys(), key=lambda c: self._rank_sort_key(participants[c]))
        else:
            def _hist_sort_key(c):
                p = participants[c]
                hist = p.get('history') or []
                if hist_idx >= len(hist):
                    return self._rank_sort_key(p)
                val = float(hist[hist_idx].get('value', 0.0))
                cum_dd = max((float(h.get('drawdown', 0.0)) for h in hist[:hist_idx + 1]), default=0.0)
                return (
                    -round(val, 6),
                    round(cum_dd, 6),
                    0 if p.get('allocations') else 1,
                    self._safe_int(p.get('joined_at')) or (1 << 62),
                    p.get('name', '').lower(),
                    c,
                )
            sorted_codes = sorted(participants.keys(), key=_hist_sort_key)

        for rank, code in enumerate(sorted_codes, start=1):
            p = participants[code]
            hist = p.get('history')
            if hist and hist_idx < len(hist) and isinstance(hist[hist_idx], dict):
                hist[hist_idx]['rank'] = rank
            if is_latest:
                p['current_rank'] = rank
            if is_prev or (is_latest and hist_idx == 0):
                p['prev_rank'] = rank

    def _recalculate_single_participant(self, code, start_stage=1):
        """Incrementally updates one participant and affected round ranks without replaying all participants."""
        p = self.state.get('participants', {}).get(code)
        if not isinstance(p, dict):
            return False
        drawn_cards = self.state.get('drawn_cards', [])
        cur_round = len(drawn_cards)
        rounds_per_stage = self.state.get('rounds_per_stage', 10)
        initial_cap = self.config['initial_capital']
        start_stage = max(1, int(start_stage or 1))
        stage_start_round = (start_stage - 1) * rounds_per_stage + 1

        if cur_round == 0:
            p['current_value'] = initial_cap
            p['prev_value'] = initial_cap
            p['peak_value'] = initial_cap
            p['max_drawdown'] = 0.0
            p['history'] = [{'round': 0, 'value': initial_cap, 'drawdown': 0.0, 'rank': 1}]
            self._assign_ranks_at_round(0, is_latest=True, is_prev=True)
            return True

        # Stage allocation changes before any card in that stage is drawn cannot alter prior histories
        # or ranks, except when a previously allocation-less participant flips the rank tiebreaker.
        if cur_round < stage_start_round:
            has_prior_alloc = any(int(s) < start_stage for s in p.get('allocations', {}) if str(s).isdigit())
            if not has_prior_alloc:
                self._assign_ranks_at_round(cur_round - 1, is_latest=False, is_prev=True)
                self._assign_ranks_at_round(cur_round, is_latest=True, is_prev=False)
            return True

        # Fall back cleanly if any drawn_cards entry lacks stage_factors or participant history is misaligned
        if any(not isinstance(d, dict) or not isinstance(d.get('stage_factors'), dict) for d in drawn_cards[stage_start_round - 1:]):
            return False
        if stage_start_round == 1:
            hist = [{'round': 0, 'value': initial_cap, 'drawdown': 0.0, 'rank': 1}]
            p['history'] = hist
        else:
            hist = p.get('history')
            if not isinstance(hist, list) or len(hist) < stage_start_round:
                return False
            del hist[stage_start_round:]

        p['peak_value'] = max((float(h.get('value', initial_cap)) for h in hist), default=float(initial_cap))
        p['max_drawdown'] = max((float(h.get('drawdown', 0.0)) for h in hist), default=0.0)
        p['current_value'] = float(hist[-1].get('value', initial_cap))
        p['prev_value'] = float(hist[-2].get('value', initial_cap)) if len(hist) >= 2 else initial_cap
        p['current_rank'] = int(hist[-1].get('rank', 1))
        p['prev_rank'] = int(hist[-2].get('rank', 1)) if len(hist) >= 2 else int(hist[0].get('rank', 1))

        for idx in range(stage_start_round - 1, cur_round):
            d = drawn_cards[idx]
            self._step_participant_round(p, d['round'], d['stage'], d['stage_factors'], initial_cap, rounds_per_stage)

        self._assign_ranks_at_round(cur_round - 1, is_latest=False, is_prev=True)
        self._assign_ranks_at_round(cur_round, is_latest=True, is_prev=False)
        return True

    def _recalculate_participants(self, current_round, current_stage):
        rounds_per_stage = self.state['rounds_per_stage']
        initial_cap = self.config['initial_capital']
        stage_factors = self.state['stage_factors']

        for p in self.state['participants'].values():
            self._step_participant_round(p, current_round, current_stage, stage_factors, initial_cap, rounds_per_stage)

        sorted_codes = sorted(
            self.state['participants'].keys(),
            key=lambda c: self._rank_sort_key(self.state['participants'][c])
        )
        for rank, code in enumerate(sorted_codes, start=1):
            self.state['participants'][code]['current_rank'] = rank
            if self.state['participants'][code].get('history'):
                self.state['participants'][code]['history'][-1]['rank'] = rank

    def get_leaderboard(self, limit=None, include_history=True):
        with self.lock:
            sorted_participants = sorted(
                self.state.get('participants', {}).values(),
                key=self._rank_sort_key
            )
            sliced = sorted_participants[:limit] if limit else sorted_participants
            return [self._public_participant(p, include_history=include_history) for p in sliced]

    def get_investor_tangguh(self, max_dd_limit=None, limit=None, include_history=True):
        with self.lock:
            if max_dd_limit is None:
                max_dd_limit = self.config.get('max_drawdown_award', 0.10)

            participants = list(self.state.get('participants', {}).values())
            if not participants:
                return []

            eligible = [
                p for p in participants
                if p.get('max_drawdown', 0.0) <= max_dd_limit
            ]
            if eligible:
                ranked = sorted(eligible, key=self._rank_sort_key)
                sliced = ranked[:limit] if limit else ranked
                return [self._public_participant(p, include_history=include_history) for p in sliced]

            # Fallback: if all participants exceeded max_dd_limit (common in Phase 2/3 rounds 18-30),
            # rank by lowest drawdown (best risk discipline), tie-broken by higher portfolio value.
            ranked = sorted(
                participants,
                key=lambda p: (
                    round(p.get('max_drawdown', 1.0), 6),
                    -round(p.get('current_value', 0.0), 6),
                    0 if p.get('allocations') else 1,
                    self._safe_int(p.get('joined_at')) or (1 << 62),
                    p.get('name', '').lower(),
                    p.get('code', '')
                )
            )
            sliced = ranked[:limit] if limit else ranked
            return [self._public_participant(p, include_history=include_history) for p in sliced]

    def seed_mock_participants(self, count=200):
        """Generates realistic mock participants with diverse strategies for demo/stress-testing."""
        try:
            count = min(max(1, int(count or 200)), 500)
        except (TypeError, ValueError):
            count = 200
        with self.lock:
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
                team_name = f"{sample_team_names[(i - 1) % len(sample_team_names)]} {i}"
                code = self.make_participant_code(team_name)

                alloc = dict(strat['alloc'])
                diff = random.choice([-5, 0, 5])
                if alloc['saham'] + diff >= 0 and alloc['sukuk'] - diff >= 0:
                    alloc['saham'] += diff
                    alloc['sukuk'] -= diff

                allocations = {str(s): dict(alloc) for s in range(1, min(curr_stage, 3) + 1)}
                self.state['participants'][code] = self._new_participant(
                    code,
                    team_name,
                    joined_at=i,
                    allocations=allocations,
                    alloc_ts={k: 1 for k in allocations},
                    rank=i,
                )

            self.state['roster_epoch'] = int(self.state.get('roster_epoch', 0)) + 1
            self._rebuild_simulation()
            self.state['message'] = f"Berhasil membuat {count} peserta simulasi."
            self.save_state(clear_roster=True)
            return len(self.state['participants'])

    def _build_public_state_bundle_locked(self, view='facilitator'):
        if view not in ('facilitator', 'broadcast', 'player'):
            view = 'facilitator'
        max_dd_award = self.config.get('max_drawdown_award', 0.10)
        drawn_cards = self.state.get('drawn_cards', [])
        cache_key = (
            self._mutation_seq,
            self.state.get('session_id', 1),
            self.state.get('state_version', 1),
            self.state.get('roster_epoch', 0),
            self.state.get('status', 'WAITING_STAGE_1'),
            len(self.state.get('participants', {})),
            self.state.get('current_round', 0),
            self.state.get('current_stage', 1),
            self.state.get('stage_input_open', False),
            self.state.get('total_stages', 3),
            self.state.get('message', ''),
            len(drawn_cards),
            max_dd_award,
        )
        cached = self._public_view_cache.get(view)
        if cached is not None and cached[0] == cache_key:
            return cached

        def _copy_card_entry(entry):
            if not isinstance(entry, dict):
                return None
            copied = dict(entry)
            if isinstance(entry.get('returns'), dict):
                copied['returns'] = dict(entry['returns'])
            if isinstance(entry.get('stage_factors'), dict):
                copied['stage_factors'] = dict(entry['stage_factors'])
            return copied

        clean_config = {k: v for k, v in self.config.items() if k != 'admin'}
        if isinstance(clean_config.get('assets'), list):
            clean_config['assets'] = [dict(a) if isinstance(a, dict) else a for a in clean_config['assets']]

        last_card = _copy_card_entry(drawn_cards[-1]) if drawn_cards else None

        public_state = {
            'session_id': self.state.get('session_id', 1),
            'state_version': self.state.get('state_version', 1),
            'roster_epoch': self.state.get('roster_epoch', 0),
            'live_channel': self.LIVE_CHANNEL,
            'preserve_participants_on_reset': self.state.get('preserve_participants_on_reset', False),
            'status': self.state.get('status', 'WAITING_STAGE_1'),
            'current_round': self.state.get('current_round', 0),
            'current_stage': self.state.get('current_stage', 1),
            'stage_input_open': self.state.get('stage_input_open', False),
            'total_rounds': self.state.get('total_rounds', 30),
            'rounds_per_stage': self.state.get('rounds_per_stage', 10),
            'total_stages': self.state.get('total_stages', 3),
            'total_participants': len(self.state.get('participants', {})),
            'last_drawn_card': last_card,
            'asset_indexes': {k: (v[-1] if v else 100.0) for k, v in self.state.get('asset_indexes', {}).items()},
            'message': self.state.get('message', ''),
            'config': clean_config,
        }

        if view in ('facilitator', 'broadcast'):
            recent = []
            for d in reversed(drawn_cards[-5:]):
                dc = _copy_card_entry(d)
                if dc is not None:
                    recent.append(dc)
            top10 = self.get_leaderboard(limit=10, include_history=True)
            if view == 'broadcast' and len(top10) > 5:
                for p_row in top10[5:]:
                    p_row.pop('history', None)
            public_state['recent_cards'] = recent
            public_state['asset_history'] = {k: list(v) for k, v in self.state.get('asset_indexes', {}).items()}
            public_state['leaderboard_top10'] = top10
            public_state['investor_tangguh_top5'] = self.get_investor_tangguh(
                max_dd_limit=max_dd_award,
                limit=5,
                include_history=(view == 'facilitator'),
            )

        if view == 'facilitator':
            public_state['drawn_card_ids'] = [d['card_id'] for d in drawn_cards if isinstance(d, dict) and 'card_id' in d]
            public_state['participants_sync'] = {
                code: {
                    'code': p['code'],
                    'name': p['name'],
                    'joined_at': int(p.get('joined_at', 0) or 0),
                    'allocations': {k: dict(v) for k, v in p.get('allocations', {}).items()},
                    'alloc_ts': dict(p.get('alloc_ts', {}))
                }
                for code, p in list(self.state.get('participants', {}).items())
            }

        bundle = (cache_key, public_state, None)
        self._public_view_cache[view] = bundle
        return bundle

    def get_public_state(self, view='facilitator'):
        """Returns clean isolated state snapshot for API serialization."""
        with self.lock:
            return self._build_public_state_bundle_locked(view=view)[1]

    def get_public_state_response_bytes(self, view='facilitator'):
        """Returns cached UTF-8 JSON bytes for {'success': True, 'data': public_state}."""
        with self.lock:
            key, state_dict, resp_bytes = self._build_public_state_bundle_locked(view=view)
            if resp_bytes is None:
                resp_bytes = json.dumps(
                    {'success': True, 'data': state_dict},
                    ensure_ascii=False,
                    separators=(',', ':')
                ).encode('utf-8')
                self._public_view_cache[view] = (key, state_dict, resp_bytes)
            return resp_bytes
