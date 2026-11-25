import copy
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DANARAKCA_DIR = os.path.join(ROOT_DIR, 'danarakca')
if DANARAKCA_DIR not in sys.path:
    sys.path.insert(0, DANARAKCA_DIR)

from game_engine import GameEngine
import server


class _MockSocket:
    def __init__(self, raw_request_bytes):
        self._rfile = io.BytesIO(raw_request_bytes)
        self._wfile = io.BytesIO()
        self.timeout = None

    def settimeout(self, timeout):
        self.timeout = timeout

    def makefile(self, mode, *args, **kwargs):
        if 'r' in mode:
            return self._rfile
        return self._wfile

    def sendall(self, data):
        self._wfile.write(data)

    def close(self):
        pass


def dispatch_request(handler_cls, method, path, body=None, headers=None):
    hdrs = dict(headers or {})
    raw_body = b''
    if body is not None:
        raw_body = json.dumps(body).encode('utf-8')
        hdrs.setdefault('Content-Type', 'application/json')
        hdrs.setdefault('Content-Length', str(len(raw_body)))
    lines = [f"{method} {path} HTTP/1.1", "Host: localhost"]
    for k, v in hdrs.items():
        lines.append(f"{k}: {v}")
    raw_req = ("\r\n".join(lines) + "\r\n\r\n").encode('utf-8') + raw_body
    sock = _MockSocket(raw_req)
    mock_server = type('MockSrv', (), {})()
    handler_cls(sock, ('127.0.0.1', 50000), mock_server)
    raw_resp = sock._wfile.getvalue()
    head_bytes, _, resp_body = raw_resp.partition(b'\r\n\r\n')
    head_lines = head_bytes.decode('latin-1').split('\r\n')
    status_code = int(head_lines[0].split(' ', 2)[1])
    resp_headers = {}
    for line in head_lines[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            resp_headers[k.strip().lower()] = v.strip()
    return status_code, resp_headers, resp_body


class DanarakcaSecurityAndEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix='danarakca_test_')
        src_data = os.path.join(DANARAKCA_DIR, 'data')
        shutil.copy2(os.path.join(src_data, 'cards.json'), os.path.join(self.tmp_dir, 'cards.json'))
        shutil.copy2(os.path.join(src_data, 'config.json'), os.path.join(self.tmp_dir, 'config.json'))
        shutil.copy2(os.path.join(src_data, 'state.json'), os.path.join(self.tmp_dir, 'state.json'))

        self._orig_engine = server.engine
        self._orig_env = {k: os.environ.get(k) for k in (
            'DANARAKCA_ADMIN_USER',
            'DANARAKCA_ADMIN_USERNAME',
            'DANARAKCA_ADMIN_PASSWORD',
            'DANARAKCA_ADMIN_PASSWORD_HASH',
            'DANARAKCA_ADMIN_SECRET',
            'DANARAKCA_TOKEN_TTL_SECONDS',
            'VERCEL',
        )}
        os.environ['DANARAKCA_ADMIN_USER'] = 'admin_test'
        os.environ.pop('DANARAKCA_ADMIN_USERNAME', None)
        os.environ['DANARAKCA_ADMIN_PASSWORD'] = 's3cret_test_pw'
        os.environ['DANARAKCA_ADMIN_SECRET'] = 'test_hmac_secret_value_12345'
        os.environ.pop('DANARAKCA_ADMIN_PASSWORD_HASH', None)
        os.environ.pop('VERCEL', None)

        server.rate_limiter = server._RateLimiter()
        server.engine = GameEngine(self.tmp_dir)
        self.engine = server.engine

    def tearDown(self):
        server.engine = self._orig_engine
        for k, v in self._orig_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _login_admin(self):
        status, _, body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/admin/login',
            body={'username': 'admin_test', 'password': 's3cret_test_pw'},
        )
        self.assertEqual(status, 200)
        return json.loads(body.decode('utf-8'))['token']

    def test_admin_login_non_ascii_and_pbkdf2_and_token_ttl(self):
        status, _, body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/admin/login',
            body={'username': 'admin_üser', 'password': 'pässword'},
        )
        self.assertEqual(status, 401)
        self.assertFalse(json.loads(body.decode('utf-8'))['success'])

        salt = b'0123456789abcdef'
        digest = hashlib.pbkdf2_hmac('sha256', b'hash_pw_2026', salt, 10000).hex()
        os.environ['DANARAKCA_ADMIN_PASSWORD_HASH'] = f"pbkdf2_sha256$10000${salt.hex()}${digest}"
        status, _, body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/admin/login',
            body={'username': 'admin_test', 'password': 'hash_pw_2026'},
        )
        self.assertEqual(status, 200)
        token = json.loads(body.decode('utf-8'))['token']

        expired_token = server._sign_payload({
            't': 'admin',
            'u': 'admin_test',
            'iat': int(time.time()) - 1000,
            'exp': int(time.time()) - 10,
            'jti': 'abc',
        })
        st_exp, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'GET',
            '/api/admin/verify',
            headers={'X-Admin-Token': expired_token},
        )
        self.assertEqual(st_exp, 401)

        st_ok, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'GET',
            '/api/admin/verify',
            headers={'Authorization': f'Bearer {token}'},
        )
        self.assertEqual(st_ok, 200)

    def test_serverless_requires_configured_admin_credentials(self):
        os.environ['VERCEL'] = '1'
        os.environ.pop('DANARAKCA_ADMIN_PASSWORD', None)
        os.environ.pop('DANARAKCA_ADMIN_PASSWORD_HASH', None)
        status, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/admin/login',
            body={'username': 'admin_test', 'password': 'anything'},
        )
        self.assertEqual(status, 503)

    def test_export_requires_admin_and_sanitizes_csv(self):
        st_unauth, _, _ = dispatch_request(server.DanarakcaRequestHandler, 'GET', '/api/export')
        self.assertEqual(st_unauth, 403)

        self.engine.register_participant(' =CMD("calc")')
        admin_token = self._login_admin()
        st_ok, hdrs, body = dispatch_request(
            server.DanarakcaRequestHandler,
            'GET',
            '/api/export',
            headers={'X-Admin-Token': admin_token},
        )
        self.assertEqual(st_ok, 200)
        self.assertIn('text/csv', hdrs.get('content-type', ''))
        csv_text = body.decode('utf-8')
        self.assertIn("'=CMD(calc)", csv_text)

    def test_get_participant_is_readonly_and_static_listing_blocked(self):
        st_part, _, _ = dispatch_request(server.DanarakcaRequestHandler, 'GET', '/api/participant/TimGhost')
        self.assertEqual(st_part, 404)
        self.assertEqual(len(self.engine.state['participants']), 0)

        st_dir, _, _ = dispatch_request(server.DanarakcaRequestHandler, 'GET', '/img/')
        self.assertEqual(st_dir, 403)

    def test_cache_headers_and_unicode_digit_limit(self):
        st_css, hdrs, _ = dispatch_request(server.DanarakcaRequestHandler, 'GET', '/style.css?v=2.3')
        self.assertEqual(st_css, 200)
        self.assertIn('no-store', hdrs.get('cache-control', ''))

        st_lb, _, body = dispatch_request(server.DanarakcaRequestHandler, 'GET', '/api/leaderboard?limit=²')
        self.assertEqual(st_lb, 200)
        self.assertTrue(json.loads(body.decode('utf-8'))['success'])

    def test_participant_sync_cannot_hijack_cards_stage_or_closed_allocations(self):
        st_reg, _, reg_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/register',
            body={'name': 'Tim Alpha'},
        )
        self.assertEqual(st_reg, 200)
        reg_json = json.loads(reg_body.decode('utf-8'))
        p_token = reg_json['participant_token']
        sess_id = reg_json['state']['session_id']
        self.assertNotIn('token_nonce', reg_json['data'])

        # Attempt duplicate registration without token -> 409
        st_dup, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/register',
            body={'name': 'Tim Alpha'},
        )
        self.assertEqual(st_dup, 409)

        # Close input and attempt hijack via participant_sync
        admin_token = self._login_admin()
        dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/facilitator/toggle-input',
            headers={'X-Admin-Token': admin_token},
            body={'open': False},
        )
        st_sync, _, sync_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            headers={'X-Participant-Token': p_token},
            body={
                'name': 'Tim Alpha',
                'participant_sync': {
                    'name': 'Tim Alpha',
                    'session_id': sess_id,
                    'joined_at': 1,
                    'current_stage': 3,
                    'drawn_card_ids': ['K001', 'K002', 'K003'],
                    'allocations': {'1': {'sukuk': 100, 'saham': 0, 'rdpu': 0, 'emas': 0, 'campuran': 0}},
                    'alloc_ts': {'1': 9999999999999},
                },
            },
        )
        self.assertEqual(st_sync, 200)
        sync_json = json.loads(sync_body.decode('utf-8'))
        self.assertEqual(sync_json['data']['state']['current_round'], 0)
        self.assertEqual(sync_json['data']['state']['current_stage'], 1)
        self.assertEqual(sync_json['data']['participant']['allocations'], {})

        # Unauthenticated player sync -> session_expired
        st_noauth, _, noauth_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            body={'name': 'Tim Alpha', 'participant_sync': {'name': 'Tim Alpha', 'session_id': sess_id}},
        )
        self.assertEqual(st_noauth, 200)
        self.assertTrue(json.loads(noauth_body.decode('utf-8'))['data']['session_expired'])

    def test_allocation_precision_and_reset_token_isolation(self):
        st_reg, _, reg_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/register',
            body={'name': 'Tim Presisi'},
        )
        p_token = json.loads(reg_body.decode('utf-8'))['participant_token']

        # 100.4% must be rejected
        st_bad, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/submit',
            headers={'X-Participant-Token': p_token},
            body={
                'name': 'Tim Presisi',
                'stage': 1,
                'allocation': {'sukuk': 100.4, 'saham': 0, 'rdpu': 0, 'emas': 0, 'campuran': 0},
            },
        )
        self.assertEqual(st_bad, 400)

        # 100.0% accepted
        st_ok, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/submit',
            headers={'X-Participant-Token': p_token},
            body={
                'name': 'Tim Presisi',
                'stage': 1,
                'allocation': {'sukuk': 50, 'saham': 20, 'rdpu': 10, 'emas': 10, 'campuran': 10},
            },
        )
        self.assertEqual(st_ok, 200)

        # Full reset without preserve invalidates old token even if same name registers again
        admin_token = self._login_admin()
        dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/facilitator/reset',
            headers={'X-Admin-Token': admin_token},
            body={'preserve_participants': False, 'total_stages': 1},
        )
        st_new_reg, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/register',
            body={'name': 'Tim Presisi'},
        )
        self.assertEqual(st_new_reg, 200)

        st_hijack, _, hijack_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/submit',
            headers={'X-Participant-Token': p_token},
            body={
                'name': 'Tim Presisi',
                'stage': 1,
                'allocation': {'sukuk': 0, 'saham': 100, 'rdpu': 0, 'emas': 0, 'campuran': 0},
            },
        )
        self.assertEqual(st_hijack, 409)
        self.assertTrue(json.loads(hijack_body.decode('utf-8'))['session_expired'])

    def test_preserve_participants_and_login_rate_limit(self):
        st_reg, _, reg_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/register',
            body={'name': 'Tim Lestari'},
        )
        self.assertEqual(st_reg, 200)
        p_token = json.loads(reg_body.decode('utf-8'))['participant_token']

        admin_token = self._login_admin()
        st_rst, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/facilitator/reset',
            headers={'X-Admin-Token': admin_token},
            body={'preserve_participants': True, 'total_stages': 2},
        )
        self.assertEqual(st_rst, 200)

        st_sync, _, sync_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            headers={'X-Participant-Token': p_token},
            body={'name': 'Tim Lestari', 'participant_sync': {'name': 'Tim Lestari'}},
        )
        self.assertEqual(st_sync, 200)
        sync_json = json.loads(sync_body.decode('utf-8'))['data']
        self.assertNotIn('session_expired', sync_json)
        self.assertIsNotNone(sync_json['participant'])
        self.assertTrue(sync_json.get('participant_token'))

        # Rate limit after 10 login calls
        statuses = []
        for _ in range(11):
            st, _, _ = dispatch_request(
                server.DanarakcaRequestHandler,
                'POST',
                '/api/admin/login',
                body={'username': 'admin_test', 'password': 'wrong'},
            )
            statuses.append(st)
        self.assertIn(429, statuses)

    def test_save_before_publish_and_stale_epoch_and_proxy_ip(self):
        # 1. Verify save_state executes before _publish_live_event on all state-changing actions
        call_order = []
        orig_save = self.engine.save_state
        orig_pub = self.engine._publish_live_event

        def tracked_save(*args, **kwargs):
            call_order.append('save')
            return orig_save(*args, **kwargs)

        def tracked_pub(*args, **kwargs):
            call_order.append('publish')
            return orig_pub(*args, **kwargs)

        self.engine.save_state = tracked_save
        self.engine._publish_live_event = tracked_pub
        try:
            self.engine.toggle_stage_input(False)
            self.assertEqual(call_order, ['save', 'publish'])
            call_order.clear()
            self.engine.set_game_mode(2)
            self.assertEqual(call_order, ['save', 'publish'])
            call_order.clear()
            for _ in range(10):
                self.engine.draw_card()
                self.assertEqual(call_order[-2:], ['save', 'publish'])
            call_order.clear()
            self.engine.next_stage()
            self.assertEqual(call_order, ['save', 'publish'])
            call_order.clear()
            self.engine.reset_game()
            self.assertEqual(call_order, ['save', 'publish'])
        finally:
            self.engine.save_state = orig_save
            self.engine._publish_live_event = orig_pub

        # 2. Stale roster_epoch client_sync must not resurrect pre-seed participants
        self.engine.register_participant('PreSeedTeam')
        pre_pub = self.engine.get_public_state()
        self.engine.seed_mock_participants(5)
        self.assertNotIn(self.engine.make_participant_code('PreSeedTeam'), self.engine.state['participants'])
        self.engine.sync_state(client_sync={
            'session_id': pre_pub['session_id'],
            'state_version': pre_pub['state_version'] + 999999,
            'roster_epoch': pre_pub['roster_epoch'],
            'participants_sync': pre_pub['participants_sync'],
        })
        self.assertNotIn(self.engine.make_participant_code('PreSeedTeam'), self.engine.state['participants'])

        # 3. Expired-session token_payload passed to register_participant must not reuse old nonce/joined_at
        old_token = {'c': self.engine.make_participant_code('FreshTeam'), 'k': 'stale_nonce', 'j': 1, 'sid': 1}
        self.engine.register_participant('FreshTeam', token_payload=old_token)
        fresh_code = self.engine.make_participant_code('FreshTeam')
        self.assertNotEqual(self.engine.get_participant_nonce(fresh_code), 'stale_nonce')
        self.assertGreater(self.engine.state['participants'][fresh_code]['joined_at'], 1)

        # 4. Direct server ignores X-Forwarded-For unless proxy trust is enabled
        mock_handler = server.DanarakcaRequestHandler.__new__(server.DanarakcaRequestHandler)
        mock_handler.headers = {'X-Forwarded-For': '1.2.3.4'}
        mock_handler.client_address = ('192.168.1.50', 12345)
        self.assertEqual(mock_handler._client_ip(), '192.168.1.50')
        os.environ['DANARAKCA_TRUST_PROXY'] = '1'
        try:
            self.assertEqual(mock_handler._client_ip(), '1.2.3.4')
        finally:
            os.environ.pop('DANARAKCA_TRUST_PROXY', None)

    def test_draw_card_duplicate_and_config_drawdown_award(self):
        self.engine.config['max_drawdown_award'] = 0.05
        self.engine.draw_card('K001')
        with self.assertRaises(ValueError):
            self.engine.draw_card('K001')
        pub = self.engine.get_public_state()
        self.assertNotIn('admin', pub['config'])
        self.assertEqual(pub['config']['max_drawdown_award'], 0.05)

    def test_vercel_admin_auth_resilience_and_body_parsing(self):
        # 1. Cross-container token stability on VERCEL=1 even when DANARAKCA_ADMIN_SECRET is unset
        os.environ['VERCEL'] = '1'
        os.environ.pop('DANARAKCA_ADMIN_SECRET', None)
        os.environ.pop('DANARAKCA_ADMIN_USER', None)
        os.environ['DANARAKCA_ADMIN_USERNAME'] = ' "Admin" '
        salt = b'fedcba9876543210'
        digest = hashlib.pbkdf2_hmac('sha256', b'VercelPass!26', salt, 10000).hex()
        # Hash mistakenly placed into DANARAKCA_ADMIN_PASSWORD should still verify cleanly
        os.environ['DANARAKCA_ADMIN_PASSWORD'] = f"pbkdf2_sha256$10000${salt.hex()}${digest}"

        # Wrong password casing still rejected
        st_wrong_pw, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/admin/login',
            body={'username': 'admin', 'password': 'vercelpass!26'},
        )
        self.assertEqual(st_wrong_pw, 401)

        # Case-insensitive username succeeds and verifies after simulated container cold start
        st_ok, _, body_ok = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/admin/login',
            body={'username': 'admin', 'password': 'VercelPass!26'},
        )
        self.assertEqual(st_ok, 200)
        token = json.loads(body_ok.decode('utf-8'))['token']

        orig_runtime_secret = server._RUNTIME_ADMIN_SECRET
        server._RUNTIME_ADMIN_SECRET = 'completely_different_container_secret'
        try:
            st_verify, _, verify_body = dispatch_request(
                server.DanarakcaRequestHandler,
                'GET',
                '/api/admin/verify',
                headers={'X-Admin-Token': token},
            )
            self.assertEqual(st_verify, 200)
            self.assertTrue(json.loads(verify_body.decode('utf-8'))['authenticated'])
        finally:
            server._RUNTIME_ADMIN_SECRET = orig_runtime_secret

        # Rotating admin password invalidates previously derived cross-instance tokens
        os.environ['DANARAKCA_ADMIN_PASSWORD'] = 'DifferentPass!99'
        st_verify_after_pw_change, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'GET',
            '/api/admin/verify',
            headers={'X-Admin-Token': token},
        )
        self.assertEqual(st_verify_after_pw_change, 401)

        # 2. parse_json_body supports chunked transfer encoding & BytesIO without Content-Length
        mock_h = server.DanarakcaRequestHandler.__new__(server.DanarakcaRequestHandler)
        mock_h.headers = {'transfer-encoding': 'chunked'}
        payload_bytes = json.dumps({'username': 'Admin', 'password': 'DifferentPass!99'}).encode('utf-8')
        chunked_wire = f"{len(payload_bytes):x}\r\n".encode('ascii') + payload_bytes + b"\r\n0\r\n\r\n"
        mock_h.rfile = io.BytesIO(chunked_wire)
        self.assertEqual(mock_h.parse_json_body()['password'], 'DifferentPass!99')

        mock_h.headers = {'content-type': 'application/json'}
        mock_h.rfile = io.BytesIO(payload_bytes)
        self.assertEqual(mock_h.parse_json_body()['username'], 'Admin')

        # Truncated chunked payload raises ValueError cleanly (no partial truncation acceptance)
        mock_h.headers = {'transfer-encoding': 'chunked'}
        mock_h.rfile = io.BytesIO(b"5\r\nhello")
        with self.assertRaises(ValueError):
            mock_h.parse_json_body()

        # 3. Participant signing key is isolated from admin password oracle on VERCEL=1 & local dev
        self.assertNotEqual(server.get_participant_secret(), server.get_admin_secret())
        st_reg, _, reg_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/register',
            body={'name': 'OracleCheckTeam'},
        )
        self.assertEqual(st_reg, 200)
        p_tok = json.loads(reg_body.decode('utf-8'))['participant_token']
        self.assertIsNone(server._verify_signed_payload(p_tok))

        # Local non-VERCEL mode without Redis / DANARAKCA_ADMIN_SECRET uses ephemeral runtime admin secret
        os.environ.pop('VERCEL', None)
        if not getattr(server.engine, 'redis_token', ''):
            self.assertEqual(server.get_admin_secret(), server._RUNTIME_ADMIN_SECRET)

    def test_incremental_simulation_matches_full_rebuild(self):
        self.engine.seed_mock_participants(25)
        # Round 0 submission with allocation change
        self.engine.register_participant('Round0Joiner')
        self.engine.submit_allocation(
            'Round0Joiner',
            1,
            {'sukuk': 70, 'saham': 10, 'rdpu': 10, 'emas': 5, 'campuran': 5},
        )
        for _ in range(10):
            self.engine.draw_card()
        self.engine.next_stage()

        def _assert_matches_full_rebuild():
            inc_parts = {
                c: copy.deepcopy(p) for c, p in self.engine.state['participants'].items()
            }
            with self.engine.lock:
                self.engine._rebuild_simulation()
            ref_parts = self.engine.state['participants']

            self.assertEqual(set(inc_parts.keys()), set(ref_parts.keys()))
            for code, inc_p in inc_parts.items():
                ref_p = ref_parts[code]
                self.assertAlmostEqual(inc_p['current_value'], ref_p['current_value'], places=6)
                self.assertAlmostEqual(inc_p['max_drawdown'], ref_p['max_drawdown'], places=6)
                self.assertEqual(inc_p['current_rank'], ref_p['current_rank'])
                self.assertEqual(inc_p['prev_rank'], ref_p['prev_rank'])
                self.assertEqual(len(inc_p['history']), len(ref_p['history']))
                for h_inc, h_ref in zip(inc_p['history'], ref_p['history']):
                    self.assertAlmostEqual(h_inc['value'], h_ref['value'], places=6)
                    self.assertAlmostEqual(h_inc['drawdown'], h_ref['drawdown'], places=6)
                self.assertEqual(inc_p['history'][-1]['rank'], ref_p['history'][-1]['rank'])

        # Case 1a: Pre-card Stage 2 submission for participant with prior Stage 1 allocation
        self.engine.submit_allocation(
            'Round0Joiner',
            2,
            {'sukuk': 10, 'saham': 60, 'rdpu': 10, 'emas': 10, 'campuran': 10},
        )
        # Case 1b: Pre-card Stage 2 submission by allocation-less Round 10 joiners (tiebreaker flip)
        self.engine.register_participant('LateA')
        self.engine.register_participant('LateB')
        self.engine.submit_allocation(
            'LateB',
            2,
            {'sukuk': 20, 'saham': 20, 'rdpu': 20, 'emas': 20, 'campuran': 20},
        )
        _assert_matches_full_rebuild()

        # Case 2: Edit right after first card of Stage 2 (Round 11: cur_round == stage_start_round)
        self.engine.toggle_stage_input(True)
        self.engine.draw_card()
        self.engine.toggle_stage_input(True)
        self.engine.submit_allocation(
            'Round0Joiner',
            2,
            {'sukuk': 50, 'saham': 20, 'rdpu': 10, 'emas': 10, 'campuran': 10},
        )
        _assert_matches_full_rebuild()

        # Case 3: Draw Round 12, mid-game joiner, and mid-stage edit
        self.engine.toggle_stage_input(True)
        self.engine.draw_card()
        self.engine.register_participant('MidGameJoiner')
        self.engine.toggle_stage_input(True)
        self.engine.submit_allocation(
            'Round0Joiner',
            2,
            {'sukuk': 0, 'saham': 100, 'rdpu': 0, 'emas': 0, 'campuran': 0},
        )
        _assert_matches_full_rebuild()

    def test_tiered_views_non_ascii_tokens_and_unlocked_publish(self):
        self.engine.seed_mock_participants(12)
        self.engine.draw_card()

        # 1. Public broadcast view omits participants_sync & strips history beyond Top 5
        st_b, _, body_b = dispatch_request(server.DanarakcaRequestHandler, 'GET', '/api/state')
        self.assertEqual(st_b, 200)
        b_data = json.loads(body_b.decode('utf-8'))['data']
        self.assertNotIn('participants_sync', b_data)
        self.assertNotIn('drawn_card_ids', b_data)
        self.assertEqual(len(b_data['leaderboard_top10']), 10)
        self.assertIn('history', b_data['leaderboard_top10'][0])
        self.assertNotIn('history', b_data['leaderboard_top10'][5])
        self.assertNotIn('history', b_data['investor_tangguh_top5'][0])

        # 2. Admin state sync retains participants_sync; unauthenticated state sync uses broadcast view
        admin_token = self._login_admin()
        st_adm, _, body_adm = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/state/sync',
            headers={'X-Admin-Token': admin_token},
            body={},
        )
        self.assertEqual(st_adm, 200)
        self.assertIn('participants_sync', json.loads(body_adm.decode('utf-8'))['data'])

        st_anon, _, body_anon = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/state/sync',
            body={},
        )
        self.assertEqual(st_anon, 200)
        self.assertNotIn('participants_sync', json.loads(body_anon.decode('utf-8'))['data'])

        # 3. Player register & sync omit heavy leaderboard/asset_history/participant.history
        st_reg, _, reg_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/register',
            body={'name': 'LeanPlayer'},
        )
        self.assertEqual(st_reg, 200)
        reg_json = json.loads(reg_body.decode('utf-8'))
        self.assertNotIn('history', reg_json['data'])
        self.assertNotIn('participants_sync', reg_json['state'])
        self.assertNotIn('leaderboard_top10', reg_json['state'])
        self.assertNotIn('asset_history', reg_json['state'])

        # 4. Non-ASCII tokens fail cleanly as 401/session_expired instead of 400/500 UnicodeEncodeError
        st_bad_adm, _, _ = dispatch_request(
            server.DanarakcaRequestHandler,
            'GET',
            '/api/admin/verify',
            headers={'X-Admin-Token': 'töken.sig'},
        )
        self.assertEqual(st_bad_adm, 401)
        st_bad_pl, _, bad_pl_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            headers={'X-Participant-Token': 'töken.sig'},
            body={'name': 'LeanPlayer'},
        )
        self.assertEqual(st_bad_pl, 200)
        self.assertTrue(json.loads(bad_pl_body.decode('utf-8'))['data']['session_expired'])

        # 5. _publish_live_event runs outside self.engine.lock
        lock_acquired_in_other_thread = []
        orig_pub = self.engine._publish_live_event

        def probe_publish(*args, **kwargs):
            def check_lock():
                acquired = self.engine.lock.acquire(blocking=False)
                if acquired:
                    self.engine.lock.release()
                lock_acquired_in_other_thread.append(acquired)

            t = threading.Thread(target=check_lock)
            t.start()
            t.join(timeout=2)
            return orig_pub(*args, **kwargs)

        self.engine._publish_live_event = probe_publish
        try:
            self.engine.toggle_stage_input(False)
            self.assertEqual(lock_acquired_in_other_thread, [True])
        finally:
            self.engine._publish_live_event = orig_pub

        # 6. min_round / min_version hints bypass 0.75s refresh throttle when behind
        p_tok = reg_json['participant_token']
        other_engine = GameEngine(self.tmp_dir)
        other_engine.draw_card()  # advances state_file on disk to round 2
        target_round = other_engine.state['current_round']
        target_version = other_engine.state['state_version']

        self.engine._last_refresh_time = time.time()
        st_stale, _, stale_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            headers={'X-Participant-Token': p_tok},
            body={'name': 'LeanPlayer'},
        )
        self.assertEqual(st_stale, 200)
        self.assertLess(json.loads(stale_body.decode('utf-8'))['data']['state']['current_round'], target_round)

        st_fresh, _, fresh_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            headers={'X-Participant-Token': p_tok},
            body={'name': 'LeanPlayer', 'min_round': target_round, 'min_version': target_version},
        )
        self.assertEqual(st_fresh, 200)
        fresh_state = json.loads(fresh_body.decode('utf-8'))['data']['state']
        self.assertEqual(fresh_state['current_round'], target_round)
        self.assertGreaterEqual(fresh_state['state_version'], target_version)

        # 7. GET /api/state?min_version=... (without round bump) bypasses 0.75s throttle
        other_engine.toggle_stage_input(True)
        ver_after_toggle = other_engine.state['state_version']
        self.engine._last_refresh_time = time.time()
        st_get_stale, _, get_stale_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'GET',
            '/api/state',
        )
        self.assertEqual(st_get_stale, 200)
        self.assertFalse(json.loads(get_stale_body.decode('utf-8'))['data']['stage_input_open'])

        st_get_fresh, _, get_fresh_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'GET',
            f'/api/state?min_version={ver_after_toggle}',
        )
        self.assertEqual(st_get_fresh, 200)
        get_fresh_state = json.loads(get_fresh_body.decode('utf-8'))['data']
        self.assertTrue(get_fresh_state['stage_input_open'])
        self.assertGreaterEqual(get_fresh_state['state_version'], ver_after_toggle)

        # 8. /api/player/sync security: throttled container cannot hijack or bypass non-preserving reset
        self.engine.refresh_state(force=True)
        _, _, ghost_reg = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/participant/register',
            body={'name': 'ResetGhost'},
        )
        ghost_tok = json.loads(ghost_reg.decode('utf-8'))['participant_token']
        ghost_code = self.engine.make_participant_code('ResetGhost')

        other_engine.reset_game(preserve_participants=False, total_stages=2)
        new_sess = other_engine.state['session_id']
        prev_ghost_sess = server.extract_participant_token({}, {'participant_token': ghost_tok})['sid']
        other_engine.register_participant('LeanPlayer')  # new player claims same name in new session
        with self.engine.lock:
            self.engine.state['participants'].pop(self.engine.make_participant_code('LeanPlayer'), None)
            self.engine.state['participants'].pop(ghost_code, None)
            self.engine._last_refresh_time = time.time()

        st_ghost, _, ghost_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            headers={'X-Participant-Token': ghost_tok},
            body={
                'name': 'ResetGhost',
                'participant_sync': {
                    'name': 'ResetGhost',
                    'code': ghost_code,
                    'session_id': prev_ghost_sess,
                    'allocations': {'1': {'sukuk': 100, 'saham': 0, 'rdpu': 0, 'emas': 0, 'campuran': 0}},
                    'alloc_ts': {'1': 9999},
                },
            },
        )
        self.assertEqual(st_ghost, 200)
        ghost_json = json.loads(ghost_body.decode('utf-8'))['data']
        self.assertTrue(ghost_json.get('session_expired'))
        self.assertNotIn(ghost_code, self.engine.state['participants'])
        other_engine.refresh_state(force=True)
        self.assertEqual(other_engine.state['session_id'], new_sess)

        # Roll self.engine back to pre-reset state temporarily to also test name-collision branch with participant_sync
        with self.engine.lock:
            self.engine.state['session_id'] = prev_ghost_sess
            self.engine.state['participants'].pop(self.engine.make_participant_code('LeanPlayer'), None)
            self.engine._last_refresh_time = time.time()

        st_old_tok, _, old_tok_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            headers={'X-Participant-Token': p_tok},
            body={
                'name': 'LeanPlayer',
                'participant_sync': {
                    'name': 'LeanPlayer',
                    'code': self.engine.make_participant_code('LeanPlayer'),
                    'session_id': prev_ghost_sess,
                    'allocations': {'1': {'sukuk': 100, 'saham': 0, 'rdpu': 0, 'emas': 0, 'campuran': 0}},
                    'alloc_ts': {'1': 9999},
                },
            },
        )
        self.assertEqual(st_old_tok, 200)
        old_tok_json = json.loads(old_tok_body.decode('utf-8'))['data']
        self.assertTrue(old_tok_json.get('session_expired'))
        self.assertIsNone(old_tok_json.get('participant'))
        self.assertNotIn('participant_token', old_tok_json)

        # Also verify submit_allocation rejects stale nonce when new player claimed the same name
        with self.assertRaises(PermissionError):
            self.engine.submit_allocation(
                self.engine.make_participant_code('LeanPlayer'),
                1,
                {'sukuk': 100, 'saham': 0, 'rdpu': 0, 'emas': 0, 'campuran': 0},
                name='LeanPlayer',
                token_payload=server.extract_participant_token({}, {'participant_token': p_tok}),
            )

        # 9. /api/player/sync never downgrades token when token_sid > cur_sess on transient fallback
        newer_token = server.make_participant_token(
            new_sess + 5000,
            self.engine.make_participant_code('LeanPlayer'),
            'LeanPlayer',
            1,
            self.engine.get_participant_nonce(self.engine.make_participant_code('LeanPlayer')),
        )
        st_no_downgrade, _, no_downgrade_body = dispatch_request(
            server.DanarakcaRequestHandler,
            'POST',
            '/api/player/sync',
            headers={'X-Participant-Token': newer_token},
            body={'name': 'LeanPlayer'},
        )
        self.assertEqual(st_no_downgrade, 200)
        no_downgrade_json = json.loads(no_downgrade_body.decode('utf-8'))['data']
        self.assertNotIn('participant_token', no_downgrade_json)
        self.assertFalse(no_downgrade_json.get('session_expired', False))

    def test_concurrent_readers_and_writers_thread_safety(self):
        self.engine.seed_mock_participants(40)
        errors = []

        def writer():
            try:
                for i in range(10):
                    self.engine.register_participant(f"Concurrent Team {i}")
                    self.engine.draw_card()
            except Exception as exc:
                errors.append(exc)

        def reader():
            try:
                for _ in range(30):
                    pub = self.engine.get_public_state()
                    json.dumps(pub)
                    self.engine.get_leaderboard(limit=10)
                    self.engine.get_export_snapshot()
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=writer)] + [threading.Thread(target=reader) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main()
