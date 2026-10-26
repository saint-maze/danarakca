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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from game_engine import GameEngine

PORT = 8080
STATIC_DIR = os.path.join(os.path.dirname(__file__), 'static')
DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')

engine = GameEngine(DATA_DIR)

ADMIN_SALT = "danarakca_salt_2026"

def make_admin_token(u, p):
    return hashlib.sha256(f"{u}:{p}:{ADMIN_SALT}".encode()).hexdigest()

def check_admin_token(headers):
    token = headers.get('X-Admin-Token', '')
    if not token:
        auth = headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            token = auth[7:]
    admin_cfg = engine.config.get('admin', {})
    expected_u = admin_cfg.get('username', 'admin')
    expected_p = admin_cfg.get('password', 'danarakca2026')
    return token == make_admin_token(expected_u, expected_p)

class DanarakcaRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        try:
            super().__init__(*args, directory=STATIC_DIR, **kwargs)
        except TypeError:
            super().__init__(*args, **kwargs)

    def get_effective_path(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ('/api', '/api/', '/api/index.py'):
            fwd = self.headers.get('x-forwarded-uri') or self.headers.get('x-real-path')
            if fwd:
                return urllib.parse.urlparse(fwd)
        return parsed

    def end_headers(self):
        # Enable CORS for convenience
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token, Authorization')
        # Smart caching: cache images/fonts, keep API fresh
        if hasattr(self, 'path') and self.path:
            lower_path = self.path.lower()
            if any(lower_path.endswith(ext) for ext in ('.png', '.svg', '.jpg', '.jpeg', '.webp', '.ico', '.woff2', '.ttf')):
                self.send_header('Cache-Control', 'public, max-age=86400')
            elif any(lower_path.endswith(ext) for ext in ('.css', '.js', '.html')):
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.send_header('Pragma', 'no-cache')
                self.send_header('Expires', '0')
            elif lower_path.startswith('/api/'):
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

    def parse_json_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        raw_body = self.rfile.read(content_length).decode('utf-8')
        return json.loads(raw_body)

    def do_HEAD(self):
        parsed = self.get_effective_path()
        if parsed.path in ('/admin', '/admin/'):
            self.path = '/admin-login.html'
        elif parsed.path in ('/broadcast', '/broadcast/', '/screen', '/screen/'):
            self.path = '/broadcast.html'
        return super().do_HEAD()

    def do_GET(self):
        parsed = self.get_effective_path()
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path.startswith('/api/'):
            engine.refresh_state(force=('bust' in query))

        # API Routes
        if path == '/api/state':
            return self.send_json({'success': True, 'data': engine.get_public_state()})

        elif path == '/api/leaderboard':
            raw_limit = query.get('limit', ['100'])
            limit = int(raw_limit[0]) if raw_limit and raw_limit[0].isdigit() else 100
            lb = engine.get_leaderboard(limit=limit)
            return self.send_json({'success': True, 'data': lb})

        elif path.startswith('/api/participant/'):
            identifier = path.split('/')[-1]
            decoded = urllib.parse.unquote(identifier).strip()
            p = engine.state['participants'].get(decoded.upper())
            if not p:
                for part in engine.state['participants'].values():
                    if part['name'].strip().lower() == decoded.lower() or part['code'].lower() == decoded.lower():
                        p = part
                        break
            if not p:
                name_param = (query.get('name', [''])[0] or '').strip()
                fallback_name = name_param or (decoded if not (len(decoded) <= 4 and decoded.upper().startswith('P') and decoded[1:].isdigit()) else '')
                if fallback_name:
                    p = engine.register_participant(name=fallback_name)
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
            # Export CSV
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(['Peringkat', 'Nama Tim', 'Nilai Portofolio', 'Return Kumulatif (%)', 'Max Drawdown (%)', 'Tahap 1 Alloc', 'Tahap 2 Alloc', 'Tahap 3 Alloc'])
            lb = engine.get_leaderboard()
            for p in lb:
                t1 = p.get('allocations', {}).get('1', {})
                t2 = p.get('allocations', {}).get('2', {})
                t3 = p.get('allocations', {}).get('3', {})
                return_pct = round((p['current_value'] / engine.config['initial_capital'] - 1) * 100, 2)
                mdd_pct = round(p.get('max_drawdown', 0.0) * 100, 2)
                writer.writerow([
                    p['current_rank'],
                    p['name'],
                    round(p['current_value']),
                    f"{return_pct}%",
                    f"{mdd_pct}%",
                    f"S:{t1.get('sukuk', 0)}/Sh:{t1.get('saham', 0)}/U:{t1.get('rdpu', 0)}/E:{t1.get('emas', 0)}/C:{t1.get('campuran', 0)}",
                    f"S:{t2.get('sukuk', 0)}/Sh:{t2.get('saham', 0)}/U:{t2.get('rdpu', 0)}/E:{t2.get('emas', 0)}/C:{t2.get('campuran', 0)}",
                    f"S:{t3.get('sukuk', 0)}/Sh:{t3.get('saham', 0)}/U:{t3.get('rdpu', 0)}/E:{t3.get('emas', 0)}/C:{t3.get('campuran', 0)}"
                ])
            csv_data = output.getvalue().encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/csv; charset=utf-8')
            self.send_header('Content-Disposition', 'attachment; filename="danarakca_leaderboard.csv"')
            self.send_header('Content-Length', str(len(csv_data)))
            self.end_headers()
            self.wfile.write(csv_data)
            return

        if path in ('/admin', '/admin/'):
            self.path = '/admin-login.html'
        elif path in ('/broadcast', '/broadcast/', '/screen', '/screen/'):
            self.path = '/broadcast.html'

        # Fallback to serving static files
        return super().do_GET()

    def do_POST(self):
        parsed = self.get_effective_path()
        path = parsed.path

        if path.startswith('/api/'):
            is_write = path in (
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

        try:
            body = self.parse_json_body()

            is_admin = check_admin_token(self.headers)
            client_sync = body.get('client_sync') if is_admin else None
            participant_sync = body.get('participant_sync')

            if path.startswith('/api/') and path != '/api/facilitator/reset':
                if client_sync or participant_sync:
                    engine.sync_state(
                        client_sync=client_sync,
                        participant_sync=participant_sync
                    )

            # Admin Authentication Route
            if path == '/api/admin/login':
                u = body.get('username', '').strip()
                p = body.get('password', '').strip()
                admin_cfg = engine.config.get('admin', {})
                expected_u = admin_cfg.get('username', 'admin')
                expected_p = admin_cfg.get('password', 'danarakca2026')
                if u == expected_u and p == expected_p:
                    token = make_admin_token(u, p)
                    return self.send_json({'success': True, 'token': token, 'message': 'Login Fasilitator Berhasil!'})
                return self.send_error_json('ID atau Password Fasilitator salah!', 401)

            elif path == '/api/state/sync':
                return self.send_json({'success': True, 'data': engine.get_public_state()})

            elif path == '/api/player/sync':
                p_info = body.get('participant_sync') or {}
                name = (p_info.get('name') or body.get('name') or '').strip()
                code = (p_info.get('code') or body.get('code') or '').strip()
                if name and engine.is_participant_session_expired(name, p_info.get('session_id')):
                    return self.send_json({
                        'success': True,
                        'data': {
                            'state': engine.get_public_state(),
                            'participant': None,
                            'session_expired': True
                        }
                    })
                p = None
                if name:
                    p = engine.register_participant(name=name, code=code)
                elif code:
                    p = engine.state['participants'].get(code.upper())
                return self.send_json({
                    'success': True,
                    'data': {
                        'state': engine.get_public_state(),
                        'participant': p
                    }
                })

            elif path == '/api/participant/register':
                name = (body.get('name') or body.get('code') or '').strip()
                code = body.get('code') if body.get('name') else None
                p = engine.register_participant(name=name, code=code)
                return self.send_json({'success': True, 'data': p, 'state': engine.get_public_state()})

            elif path == '/api/participant/submit':
                code_or_name = body.get('code') or body.get('name')
                name = body.get('name')
                p_sess = (body.get('participant_sync') or {}).get('session_id')
                if name and engine.is_participant_session_expired(name, p_sess):
                    return self.send_json({
                        'success': False,
                        'session_expired': True,
                        'error': 'Permainan baru telah dimulai. Silakan daftar ulang.'
                    }, status=409)
                stage = body.get('stage')
                allocation = body.get('allocation')
                alloc = engine.submit_allocation(code_or_name, stage, allocation, name=name)
                det_code = engine.make_participant_code(name) if name else str(code_or_name).upper()
                p = engine.state['participants'].get(det_code)
                return self.send_json({
                    'success': True,
                    'data': alloc,
                    'participant': p,
                    'state': engine.get_public_state(),
                    'message': 'Alokasi berhasil disimpan!'
                })

            # Protected Facilitator Routes: require valid Admin token
            elif path.startswith('/api/facilitator/'):
                if not check_admin_token(self.headers):
                    return self.send_error_json('Akses ditolak: Hanya Fasilitator yang berwenang. Silakan login terlebih dahulu.', 403)

                if path == '/api/facilitator/draw-card':
                    card_id = body.get('card_id')
                    drawn = engine.draw_card(card_id)
                    return self.send_json({'success': True, 'data': drawn, 'state': engine.get_public_state()})

                elif path == '/api/facilitator/toggle-input':
                    status = body.get('open')
                    is_open = engine.toggle_stage_input(status)
                    return self.send_json({
                        'success': True,
                        'stage_input_open': is_open,
                        'state': engine.get_public_state(),
                        'message': engine.state['message']
                    })

                elif path == '/api/facilitator/next-stage':
                    new_stage = engine.next_stage()
                    return self.send_json({'success': True, 'current_stage': new_stage, 'state': engine.get_public_state()})

                elif path == '/api/facilitator/set-mode':
                    total_stages = body.get('total_stages', 3)
                    engine.set_game_mode(total_stages)
                    return self.send_json({'success': True, 'state': engine.get_public_state(), 'message': engine.state['message']})

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
    print(f"   - Kredensial Fasilitator: ID='admin', Password='danarakca2026'")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer dihentikan.")
        httpd.server_close()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', sys.argv[1] if len(sys.argv) > 1 else PORT))
    run(port)
