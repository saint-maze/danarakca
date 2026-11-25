import http.server
import socketserver
import json
import urllib.parse
import os
import sys
import mimetypes
import csv
import io
import hashlib
import hmac
import base64
import secrets
import time
import threading
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from game_engine import GameEngine

PORT = 8080
MAX_BODY_BYTES = 262144
STATIC_DIR = os.path.join(os.path.dirname(__file__), 'static')
DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')

engine = GameEngine(DATA_DIR)

_RUNTIME_ADMIN_SECRET = secrets.token_hex(32)
_RUNTIME_PLAYER_SECRET = secrets.token_hex(32)
_RUNTIME_DEV_PASSWORD = secrets.token_urlsafe(12)
_DERIVED_ADMIN_KEY_CACHE = None


def _get_header(headers, name, default=''):
    if not headers:
        return default
    val = headers.get(name)
    if val is not None:
        return val
    target = name.lower()
    for k, v in headers.items():
        if str(k).lower() == target:
            return v
    return default


def _parse_pbkdf2_hash(val):
    if not isinstance(val, str):
        return None
    parts = val.split('$')
    if len(parts) != 4 or parts[0] != 'pbkdf2_sha256':
        return None
    if any(any(ch.isspace() for ch in part) for part in (parts[1], parts[2], parts[3])):
        return None
    try:
        iterations = int(parts[1])
        salt = bytes.fromhex(parts[2])
        digest = bytes.fromhex(parts[3])
    except ValueError:
        return None
    if iterations <= 0 or not salt or len(digest) != 32:
        return None
    return iterations, salt, parts[3].lower()


def _is_pbkdf2_hash(val):
    return _parse_pbkdf2_hash(val) is not None


def _same_username(provided, expected):
    return hmac.compare_digest(
        str(provided).strip().casefold().encode('utf-8'),
        str(expected).strip().casefold().encode('utf-8'),
    )


def _normalize_username_env(raw_val):
    val = (raw_val or '').strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
        val = val[1:-1].strip()
    return val


def get_admin_secret():
    explicit = os.environ.get('DANARAKCA_ADMIN_SECRET', '').strip()
    if explicit:
        return explicit
    redis_tok = getattr(engine, 'redis_token', '') or ''
    if os.environ.get('VERCEL') == '1' or redis_tok:
        expected_u, expected_secret, _ = get_admin_credentials()
        if expected_secret is not None:
            if redis_tok:
                material = f"{expected_u.casefold()}\x00{expected_secret}\x00{redis_tok}".encode('utf-8')
                return hmac.new(b'danarakca-admin-token-v1', material, hashlib.sha256).hexdigest()
            # Stretch cross-instance key on VERCEL=1 without Redis; never shared with player tokens
            global _DERIVED_ADMIN_KEY_CACHE
            material = f"{expected_u.casefold()}\x00{expected_secret}".encode('utf-8')
            digest_tag = hashlib.sha256(material).digest()
            if _DERIVED_ADMIN_KEY_CACHE is None or _DERIVED_ADMIN_KEY_CACHE[0] != digest_tag:
                derived = hashlib.pbkdf2_hmac('sha256', material, b'danarakca-admin-kdf-v1', 100000).hex()
                _DERIVED_ADMIN_KEY_CACHE = (digest_tag, derived)
            return _DERIVED_ADMIN_KEY_CACHE[1]
    return _RUNTIME_ADMIN_SECRET


def get_participant_secret():
    explicit = os.environ.get('DANARAKCA_ADMIN_SECRET', '').strip()
    if explicit:
        return hmac.new(b'danarakca-player-token-v1', explicit.encode('utf-8'), hashlib.sha256).hexdigest()
    redis_tok = getattr(engine, 'redis_token', '') or ''
    if redis_tok:
        return hmac.new(b'danarakca-player-redis-v1', redis_tok.encode('utf-8'), hashlib.sha256).hexdigest()
    return _RUNTIME_PLAYER_SECRET


def get_token_ttl():
    try:
        ttl = int(os.environ.get('DANARAKCA_TOKEN_TTL_SECONDS', '43200'))
    except ValueError:
        ttl = 43200
    return max(60, ttl)


def get_admin_credentials():
    expected_u = (
        _normalize_username_env(os.environ.get('DANARAKCA_ADMIN_USER'))
        or _normalize_username_env(os.environ.get('DANARAKCA_ADMIN_USERNAME'))
        or 'admin'
    )
    env_hash = os.environ.get('DANARAKCA_ADMIN_PASSWORD_HASH', '').strip()
    if env_hash and _is_pbkdf2_hash(env_hash):
        return expected_u, env_hash, True
    env_pw = os.environ.get('DANARAKCA_ADMIN_PASSWORD', '').strip()
    if env_pw:
        return expected_u, env_pw, _is_pbkdf2_hash(env_pw)
    if env_hash:
        return expected_u, env_hash, True
    if os.environ.get('VERCEL') == '1':
        return expected_u, None, False
    return expected_u, _RUNTIME_DEV_PASSWORD, False


def is_using_ephemeral_dev_password():
    return (
        os.environ.get('VERCEL') != '1'
        and not os.environ.get('DANARAKCA_ADMIN_PASSWORD_HASH', '').strip()
        and not os.environ.get('DANARAKCA_ADMIN_PASSWORD', '').strip()
    )


def verify_admin_password(password_input):
    _, expected_secret, is_hash = get_admin_credentials()
    if expected_secret is None:
        return False
    pw_bytes = str(password_input).encode('utf-8')
    if not is_hash:
        return hmac.compare_digest(pw_bytes, expected_secret.encode('utf-8'))
    parsed = _parse_pbkdf2_hash(expected_secret)
    if not parsed:
        return False
    iterations, salt, expected_digest = parsed
    computed = hashlib.pbkdf2_hmac('sha256', pw_bytes, salt, iterations).hex()
    return hmac.compare_digest(computed.encode('utf-8'), expected_digest.encode('utf-8'))


def _b64url_encode(raw_bytes):
    return base64.urlsafe_b64encode(raw_bytes).rstrip(b'=').decode('ascii')


def _b64url_decode(txt):
    pad = '=' * (-len(txt) % 4)
    return base64.urlsafe_b64decode((txt + pad).encode('ascii'))


def _hmac_hex(payload_b64, secret_key=None):
    key = get_admin_secret() if secret_key is None else secret_key
    return hmac.new(
        key.encode('utf-8'),
        payload_b64.encode('ascii'),
        hashlib.sha256
    ).hexdigest()


def _sign_payload(payload_dict, secret_key=None):
    payload_b64 = _b64url_encode(
        json.dumps(payload_dict, separators=(',', ':'), sort_keys=True).encode('utf-8')
    )
    return f"{payload_b64}.{_hmac_hex(payload_b64, secret_key=secret_key)}"


def _verify_signed_payload(token_str, secret_key=None):
    if not token_str or not isinstance(token_str, str) or '.' not in token_str:
        return None
    parts = token_str.strip().split('.', 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    payload_b64, sig = parts
    expected_sig = _hmac_hex(payload_b64, secret_key=secret_key)
    if not hmac.compare_digest(sig.encode('utf-8'), expected_sig.encode('utf-8')):
        return None
    try:
        data = json.loads(_b64url_decode(payload_b64).decode('utf-8'))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def make_admin_token(u):
    now = int(time.time())
    return _sign_payload({
        't': 'admin',
        'u': str(u),
        'iat': now,
        'exp': now + get_token_ttl(),
        'jti': secrets.token_hex(8)
    })


def check_admin_token(headers):
    expected_u, expected_secret, _ = get_admin_credentials()
    if expected_secret is None:
        return False
    token = _get_header(headers, 'X-Admin-Token', '')
    if not token:
        auth = _get_header(headers, 'Authorization', '')
        if auth.startswith('Bearer '):
            token = auth[7:]
    payload = _verify_signed_payload(token)
    if not payload or payload.get('t') != 'admin':
        return False
    try:
        if int(payload.get('exp', 0)) <= int(time.time()):
            return False
    except (TypeError, ValueError):
        return False
    return _same_username(payload.get('u', ''), expected_u)


def make_participant_token(session_id, code, name, joined_at, nonce):
    return _sign_payload({
        't': 'player',
        'sid': int(session_id or 1),
        'c': str(code),
        'n': str(name),
        'j': int(joined_at or 0),
        'k': str(nonce or ''),
        'iat': int(time.time())
    }, secret_key=get_participant_secret())


def extract_participant_token(headers, body=None):
    token = _get_header(headers, 'X-Participant-Token', '')
    if not token and isinstance(body, dict):
        token = body.get('participant_token', '')
    payload = _verify_signed_payload(token, secret_key=get_participant_secret())
    if not payload or payload.get('t') != 'player':
        return None
    return payload


_CSV_FORMULA_PREFIXES = ('=', '+', '-', '@', '\t', '\r', '\n')


def sanitize_csv_cell(val):
    s = '' if val is None else str(val)
    stripped = s.lstrip()
    if (s and s[0] in _CSV_FORMULA_PREFIXES) or (stripped and stripped[0] in _CSV_FORMULA_PREFIXES):
        return "'" + s
    return s


class _RateLimiter:
    def __init__(self):
        self._lock = threading.Lock()
        self._buckets = {}

    def allow(self, key, max_hits, window_sec=60.0):
        now = time.monotonic()
        cutoff = now - window_sec
        with self._lock:
            if len(self._buckets) > 5000:
                stale = [k for k, dq in self._buckets.items() if not dq or dq[-1] < cutoff]
                for k in stale:
                    del self._buckets[k]
            dq = self._buckets.setdefault(key, deque())
            while dq and dq[0] <= cutoff:
                dq.popleft()
            if len(dq) >= max_hits:
                return False
            dq.append(now)
            return True


rate_limiter = _RateLimiter()


class DanarakcaRequestHandler(http.server.SimpleHTTPRequestHandler):
    timeout = 15

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def _client_ip(self):
        if os.environ.get('VERCEL') == '1' or os.environ.get('DANARAKCA_TRUST_PROXY') == '1':
            fwd = _get_header(self.headers, 'X-Forwarded-For', '')
            if fwd:
                return fwd.split(',')[0].strip() or 'unknown'
        return self.client_address[0] if getattr(self, 'client_address', None) else 'unknown'

    def list_directory(self, path):
        self.send_error_json('Akses direktori ditolak', 403)
        return None

    def get_effective_path(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ('/api', '/api/', '/api/index.py'):
            fwd = _get_header(self.headers, 'x-forwarded-uri', '') or _get_header(self.headers, 'x-real-path', '')
            if fwd:
                fwd_parsed = urllib.parse.urlparse(fwd)
                if fwd_parsed.path.startswith('/api'):
                    return fwd_parsed
        return parsed

    def end_headers(self):
        cors_origin = os.environ.get('DANARAKCA_CORS_ORIGIN', '').strip()
        if cors_origin:
            self.send_header('Access-Control-Allow-Origin', cors_origin)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token, X-Participant-Token, Authorization')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), focus-without-user-activation=()')
        self.send_header('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'")
        # Cache static media; force revalidation on app routes, assets, and API responses
        if getattr(self, 'path', ''):
            req_path = urllib.parse.urlparse(self.path).path.lower()
            if req_path.endswith(('.png', '.svg', '.jpg', '.jpeg', '.webp', '.ico', '.woff2', '.ttf')):
                self.send_header('Cache-Control', 'public, max-age=86400')
            elif (
                req_path == '/'
                or req_path == '/api'
                or req_path.startswith('/api/')
                or req_path.endswith(('.css', '.js', '.html'))
            ):
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.send_header('Pragma', 'no-cache')
                self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        if os.environ.get('DANARAKCA_VERBOSE_LOG') == '1':
            super().log_message(format, *args)

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400):
        self.send_json({'error': message, 'success': False}, status=status)

    def _read_chunked_body(self):
        chunks = []
        total = 0
        framing = 0
        max_chunk_line = 4096
        max_framing = 16384
        while True:
            line = self.rfile.readline(max_chunk_line)
            if not line:
                raise ValueError("Payload chunked terpotong")
            if not line.endswith(b'\n'):
                raise ValueError("Header chunked terlalu panjang")
            framing += len(line)
            if framing > max_framing:
                raise ValueError("Overhead framing chunked melebihi batas")
            size_str = line.split(b';', 1)[0].strip()
            if not size_str:
                raise ValueError("Encoding chunked tidak valid")
            try:
                chunk_size = int(size_str, 16)
            except ValueError:
                raise ValueError("Encoding chunked tidak valid")
            if chunk_size == 0:
                while True:
                    trailer = self.rfile.readline(max_chunk_line)
                    if not trailer:
                        raise ValueError("Payload chunked terpotong")
                    if not trailer.endswith(b'\n'):
                        raise ValueError("Header chunked terlalu panjang")
                    framing += len(trailer)
                    if framing > max_framing:
                        raise ValueError("Overhead framing chunked melebihi batas")
                    if trailer in (b'\r\n', b'\n'):
                        break
                break
            if chunk_size < 0 or total + chunk_size > MAX_BODY_BYTES:
                raise ValueError("Ukuran payload melebihi batas maksimum")
            data = self.rfile.read(chunk_size)
            if len(data) < chunk_size:
                raise ValueError("Payload chunked terpotong")
            chunks.append(data)
            total += len(data)
            crlf = self.rfile.readline(4)
            if crlf not in (b'\r\n', b'\n'):
                raise ValueError("Encoding chunked tidak valid")
        return b''.join(chunks)

    def _read_body_bytes(self):
        te = str(_get_header(self.headers, 'Transfer-Encoding', '')).lower()
        if 'chunked' in te:
            return self._read_chunked_body()

        raw_len = _get_header(self.headers, 'Content-Length', None)
        if raw_len is None or str(raw_len).strip() == '':
            if not isinstance(self.rfile, io.BytesIO):
                return b''
            raw_bytes = self.rfile.read(MAX_BODY_BYTES + 1)
            if len(raw_bytes) > MAX_BODY_BYTES:
                raise ValueError("Ukuran payload melebihi batas maksimum")
            return raw_bytes

        try:
            content_length = int(str(raw_len).strip())
        except (TypeError, ValueError):
            raise ValueError("Header Content-Length tidak valid")
        if content_length < 0:
            raise ValueError("Header Content-Length tidak valid")
        if content_length == 0:
            return b''
        if content_length > MAX_BODY_BYTES:
            raise ValueError("Ukuran payload melebihi batas maksimum")
        return self.rfile.read(content_length)

    def parse_json_body(self):
        raw_bytes = self._read_body_bytes()
        if not raw_bytes:
            return {}
        raw_body = raw_bytes.decode('utf-8')
        if not raw_body.strip():
            return {}
        parsed = json.loads(raw_body)
        return parsed if isinstance(parsed, dict) else {}

    _STATIC_ALIASES = {
        '/admin': '/admin-login.html',
        '/admin/': '/admin-login.html',
        '/facilitator': '/facilitator.html',
        '/facilitator/': '/facilitator.html',
        '/player': '/player.html',
        '/player/': '/player.html',
        '/broadcast': '/broadcast.html',
        '/broadcast/': '/broadcast.html',
        '/screen': '/broadcast.html',
        '/screen/': '/broadcast.html',
    }

    def _rewrite_static_alias(self, path):
        alias = self._STATIC_ALIASES.get(path)
        if alias:
            self.path = alias

    def do_HEAD(self):
        parsed = self.get_effective_path()
        path = parsed.path
        if path.startswith('/api/'):
            known = path in ('/api/state', '/api/leaderboard', '/api/cards', '/api/admin/verify', '/api/export') or path.startswith('/api/participant/')
            self.send_response(200 if known else 404)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            return
        self._rewrite_static_alias(path)
        return super().do_HEAD()

    def do_GET(self):
        try:
            parsed = self.get_effective_path()
            path = parsed.path
            query = urllib.parse.parse_qs(parsed.query)

            if path.startswith('/api/') and not path.startswith('/api/admin/'):
                engine.refresh_state(force=('bust' in query))

            if path == '/api/state':
                return self.send_json({'success': True, 'data': engine.get_public_state()})

            elif path == '/api/leaderboard':
                raw_limit = query.get('limit', ['100'])
                limit_str = raw_limit[0] if raw_limit else ''
                limit = int(limit_str) if (limit_str.isascii() and limit_str.isdigit()) else 100
                limit = min(max(1, limit), 500)
                lb = engine.get_leaderboard(limit=limit)
                return self.send_json({'success': True, 'data': lb})

            elif path.startswith('/api/participant/'):
                identifier = path.split('/')[-1]
                decoded = engine.sanitize_name(urllib.parse.unquote(identifier))
                p = engine.get_participant_snapshot(decoded)
                if not p:
                    return self.send_error_json(f"Peserta '{decoded}' tidak ditemukan", 404)
                return self.send_json({'success': True, 'data': p})

            elif path == '/api/cards':
                return self.send_json({'success': True, 'data': engine.cards})

            elif path == '/api/admin/verify':
                if check_admin_token(self.headers):
                    return self.send_json({'success': True, 'authenticated': True})
                return self.send_error_json('Sesi Fasilitator tidak valid atau telah berakhir', 401)

            elif path == '/api/export':
                if not check_admin_token(self.headers):
                    return self.send_error_json('Akses ditolak: Hanya Fasilitator yang berwenang.', 403)
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow(['Peringkat', 'Nama Tim', 'Nilai Portofolio', 'Return Kumulatif (%)', 'Max Drawdown (%)', 'Tahap 1 Alloc', 'Tahap 2 Alloc', 'Tahap 3 Alloc'])
                curr_stage, lb, alloc_map = engine.get_export_snapshot()

                def fmt_alloc(t):
                    return (
                        f"S:{t.get('sukuk', 0)}/Sh:{t.get('saham', 0)}/"
                        f"U:{t.get('rdpu', 0)}/E:{t.get('emas', 0)}/C:{t.get('campuran', 0)}"
                    )

                for p in lb:
                    allocs = alloc_map.get(p['code'], {})
                    return_pct = round((p['current_value'] / engine.config['initial_capital'] - 1) * 100, 2)
                    mdd_pct = round(p.get('max_drawdown', 0.0) * 100, 2)
                    writer.writerow([
                        p['current_rank'],
                        sanitize_csv_cell(p['name']),
                        round(p['current_value']),
                        f"{return_pct}%",
                        f"{mdd_pct}%",
                        *(fmt_alloc(allocs.get(s, {}) if curr_stage >= s else {}) for s in (1, 2, 3)),
                    ])
                csv_data = output.getvalue().encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/csv; charset=utf-8')
                self.send_header('Content-Disposition', 'attachment; filename="danarakca_leaderboard.csv"')
                self.send_header('Content-Length', str(len(csv_data)))
                self.end_headers()
                self.wfile.write(csv_data)
                return

            self._rewrite_static_alias(path)
            return super().do_GET()
        except Exception as e:
            return self.send_error_json(str(e), 500)

    def do_POST(self):
        try:
            parsed = self.get_effective_path()
            path = parsed.path
            client_ip = self._client_ip()

            if path.startswith('/api/') and not path.startswith('/api/admin/'):
                is_write = path in (
                    '/api/state/sync',
                    '/api/player/sync',
                    '/api/facilitator/draw-card',
                    '/api/facilitator/toggle-input',
                    '/api/facilitator/next-stage',
                    '/api/facilitator/set-mode',
                    '/api/facilitator/reset',
                    '/api/facilitator/seed-mock-users',
                    '/api/participant/submit',
                    '/api/participant/register'
                )
                engine.refresh_state(force=is_write)

            body = self.parse_json_body()

            is_admin = check_admin_token(self.headers)
            p_token = extract_participant_token(self.headers, body)
            client_sync = body.get('client_sync') if is_admin else None
            raw_p_sync = body.get('participant_sync') if isinstance(body.get('participant_sync'), dict) else None
            verified_p_sync = None
            if raw_p_sync and p_token:
                token_code = str(p_token.get('c', '')).upper()
                req_name = engine.sanitize_name(raw_p_sync.get('name', ''))
                req_code = engine.make_participant_code(req_name) if req_name else str(raw_p_sync.get('code', '')).upper()
                if token_code and req_code == token_code:
                    verified_p_sync = dict(raw_p_sync)
                    verified_p_sync['_token_nonce'] = p_token.get('k', '')
                    verified_p_sync['_token_session_id'] = int(p_token.get('sid', 0) or 0)
                    verified_p_sync['_token_joined_at'] = int(p_token.get('j', 0) or 0)
                    verified_p_sync['_token_name'] = p_token.get('n', req_name)

            if path.startswith('/api/') and not path.startswith('/api/admin/') and path != '/api/facilitator/reset' and (client_sync or verified_p_sync):
                engine.sync_state(client_sync=client_sync, participant_sync=verified_p_sync)

            if path == '/api/admin/login':
                if not rate_limiter.allow((client_ip, 'admin_login'), max_hits=10, window_sec=60.0):
                    return self.send_error_json('Terlalu banyak percobaan login. Coba lagi sebentar.', 429)
                expected_u, expected_secret, _ = get_admin_credentials()
                if expected_secret is None:
                    return self.send_error_json('Kredensial admin belum dikonfigurasi di server.', 503)
                user_ok = _same_username(body.get('username') or '', expected_u)
                pass_ok = verify_admin_password(str(body.get('password') or '').strip())
                if user_ok and pass_ok:
                    token = make_admin_token(expected_u)
                    return self.send_json({'success': True, 'token': token, 'message': 'Login Fasilitator Berhasil!'})
                return self.send_error_json('ID atau Password Fasilitator salah!', 401)

            elif path == '/api/state/sync':
                if not rate_limiter.allow((client_ip, 'state_sync'), max_hits=120, window_sec=60.0):
                    return self.send_error_json('Batas sinkronisasi tercapai. Coba lagi sebentar.', 429)
                return self.send_json({'success': True, 'data': engine.get_public_state()})

            elif path == '/api/player/sync':
                p_info = body.get('participant_sync') if isinstance(body.get('participant_sync'), dict) else {}
                name = ''
                code = ''
                token_sid = 0
                token_nonce = ''
                if p_token:
                    name = engine.sanitize_name(p_token.get('n') or p_info.get('name') or body.get('name') or '')
                    code = str(p_token.get('c') or '').upper()
                    token_sid = int(p_token.get('sid', 0) or 0)
                    token_nonce = str(p_token.get('k', '') or '')
                if not p_token or not name or engine.is_participant_session_expired(name, token_sid, token_nonce=token_nonce):
                    return self.send_json({
                        'success': True,
                        'data': {
                            'state': engine.get_public_state(),
                            'participant': None,
                            'session_expired': True
                        }
                    })
                p = engine.register_participant(
                    name=name,
                    code=code,
                    token_payload=p_token,
                    allow_existing=True
                )
                pub_state = engine.get_public_state()
                refreshed_token = None
                cur_sess = int(pub_state.get('session_id', 1))
                if p and token_sid != cur_sess:
                    refreshed_token = make_participant_token(
                        cur_sess, p['code'], p['name'], p.get('joined_at', 0), engine.get_participant_nonce(p['code'])
                    )
                resp_data = {
                    'state': pub_state,
                    'participant': p
                }
                if refreshed_token:
                    resp_data['participant_token'] = refreshed_token
                return self.send_json({'success': True, 'data': resp_data})

            elif path == '/api/participant/register':
                if not rate_limiter.allow((client_ip, 'participant_register'), max_hits=30, window_sec=60.0):
                    return self.send_error_json('Terlalu banyak permintaan pendaftaran. Coba lagi sebentar.', 429)
                name = engine.sanitize_name(body.get('name') or '')
                if not name:
                    return self.send_error_json('Nama peserta / tim tidak boleh kosong', 400)
                try:
                    p = engine.register_participant(name=name, token_payload=p_token)
                except PermissionError as pe:
                    return self.send_error_json(str(pe), 409)
                pub_state = engine.get_public_state()
                token = make_participant_token(
                    pub_state['session_id'],
                    p['code'],
                    p['name'],
                    p.get('joined_at', 0),
                    engine.get_participant_nonce(p['code'])
                )
                return self.send_json({
                    'success': True,
                    'data': p,
                    'participant_token': token,
                    'state': pub_state
                })

            elif path == '/api/participant/submit':
                if not p_token and not is_admin:
                    return self.send_json({
                        'success': False,
                        'session_expired': True,
                        'error': 'Sesi peserta tidak valid atau telah berakhir. Silakan daftar ulang.'
                    }, status=401)
                if p_token:
                    name = engine.sanitize_name(p_token.get('n') or body.get('name') or '')
                    code_or_name = str(p_token.get('c') or '')
                    token_sid = int(p_token.get('sid', 0) or 0)
                    token_nonce = str(p_token.get('k', '') or '')
                    if not name or engine.is_participant_session_expired(name, token_sid, token_nonce=token_nonce):
                        return self.send_json({
                            'success': False,
                            'session_expired': True,
                            'error': 'Permainan baru telah dimulai. Silakan daftar ulang.'
                        }, status=409)
                    req_name = engine.sanitize_name(body.get('name') or '')
                    req_code = str(body.get('code') or '').upper()
                    if (req_name and engine.make_participant_code(req_name) != code_or_name) or (req_code and req_code != code_or_name):
                        return self.send_error_json('Token peserta tidak sesuai dengan tim tujuan.', 403)
                else:
                    code_or_name = body.get('code') or body.get('name')
                    name = body.get('name')

                stage = body.get('stage')
                allocation = body.get('allocation')
                alloc = engine.submit_allocation(
                    code_or_name,
                    stage,
                    allocation,
                    name=name,
                    token_payload=p_token,
                    allow_auto_register=bool(p_token)
                )
                p = engine.get_participant_snapshot(code_or_name or name)
                return self.send_json({
                    'success': True,
                    'data': alloc,
                    'participant': p,
                    'state': engine.get_public_state(),
                    'message': 'Alokasi berhasil disimpan!'
                })

            elif path.startswith('/api/facilitator/'):
                if not is_admin:
                    return self.send_error_json('Akses ditolak: Hanya Fasilitator yang berwenang. Silakan login terlebih dahulu.', 403)

                if path == '/api/facilitator/draw-card':
                    card_id = body.get('card_id')
                    drawn = engine.draw_card(card_id)
                    return self.send_json({'success': True, 'data': drawn, 'state': engine.get_public_state()})

                elif path == '/api/facilitator/toggle-input':
                    status = body.get('open')
                    is_open = engine.toggle_stage_input(status)
                    pub_state = engine.get_public_state()
                    return self.send_json({
                        'success': True,
                        'stage_input_open': is_open,
                        'state': pub_state,
                        'message': pub_state['message']
                    })

                elif path == '/api/facilitator/next-stage':
                    new_stage = engine.next_stage()
                    return self.send_json({'success': True, 'current_stage': new_stage, 'state': engine.get_public_state()})

                elif path == '/api/facilitator/set-mode':
                    total_stages = body.get('total_stages', 3)
                    engine.set_game_mode(total_stages)
                    pub_state = engine.get_public_state()
                    return self.send_json({'success': True, 'state': pub_state, 'message': pub_state['message']})

                elif path == '/api/facilitator/reset':
                    preserve = body.get('preserve_participants', False)
                    if preserve and body.get('client_sync'):
                        engine.sync_state(client_sync=body.get('client_sync'))
                    total_stages = body.get('total_stages')
                    engine.reset_game(preserve_participants=preserve, total_stages=total_stages)
                    return self.send_json({'success': True, 'message': 'Permainan berhasil di-reset!', 'state': engine.get_public_state()})

                elif path == '/api/facilitator/seed-mock-users':
                    count = int(body.get('count', 200))
                    total = engine.seed_mock_participants(count)
                    return self.send_json({'success': True, 'total_seeded': total, 'state': engine.get_public_state()})

                else:
                    return self.send_error_json(f"Endpoint {path} tidak ditemukan", 404)

            else:
                return self.send_error_json(f"Endpoint {path} tidak ditemukan", 404)

        except Exception as e:
            return self.send_error_json(str(e), 400)


class ReusableThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 512


def run(port=PORT):
    server_address = ('', port)
    httpd = ReusableThreadingServer(server_address, DanarakcaRequestHandler)
    print(f"Server Game Danarakca berjalan di http://localhost:{port}")
    print(f"   - Tampilan Utama / Pilihan: http://localhost:{port}/")
    print(f"   - Layar Broadcast Proyektor: http://localhost:{port}/broadcast")
    print(f"   - Layar Fasilitator (Admin): http://localhost:{port}/facilitator.html")
    print(f"   - Layar Peserta (Mobile HP): http://localhost:{port}/player.html")
    print(f"   - Login Admin: http://localhost:{port}/admin")
    if is_using_ephemeral_dev_password():
        admin_u, admin_p, _ = get_admin_credentials()
        print(f"   - [DEV] Kredensial sesi lokal sementara: ID='{admin_u}', Password='{admin_p}'")
        print("   - [DEV] Set DANARAKCA_ADMIN_USER, DANARAKCA_ADMIN_PASSWORD, dan DANARAKCA_ADMIN_SECRET untuk kredensial tetap.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer dihentikan.")
        httpd.server_close()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', sys.argv[1] if len(sys.argv) > 1 else PORT))
    run(port)
