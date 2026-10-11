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
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def end_headers(self):
        # Enable CORS for convenience
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token, Authorization')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
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

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # API Routes
        if path == '/api/state':
            return self.send_json({'success': True, 'data': engine.get_public_state()})

        elif path == '/api/leaderboard':
            raw_limit = query.get('limit', ['100'])
            limit = int(raw_limit[0]) if raw_limit and raw_limit[0].isdigit() else 100
            lb = engine.get_leaderboard(limit=limit)
            return self.send_json({'success': True, 'data': lb})

        elif path.startswith('/api/participant/'):
            code = path.split('/')[-1].upper()
            p = engine.state['participants'].get(code)
            if not p:
                return self.send_error_json(f"Peserta dengan kode {code} tidak ditemukan", 404)
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
            writer.writerow(['Peringkat', 'Kode', 'Nama', 'Nilai Portofolio', 'Return Kumulatif (%)', 'Max Drawdown (%)', 'Tahap 1 Alloc', 'Tahap 2 Alloc', 'Tahap 3 Alloc'])
            lb = engine.get_leaderboard()
            for p in lb:
                t1 = p.get('allocations', {}).get('1', {})
                t2 = p.get('allocations', {}).get('2', {})
                t3 = p.get('allocations', {}).get('3', {})
                return_pct = round((p['current_value'] / engine.config['initial_capital'] - 1) * 100, 2)
                mdd_pct = round(p.get('max_drawdown', 0.0) * 100, 2)
                writer.writerow([
                    p['current_rank'],
                    p['code'],
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

        # Fallback to serving static files
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            body = self.parse_json_body()

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

            elif path == '/api/participant/register':
                code = body.get('code')
                name = body.get('name')
                p = engine.register_participant(code, name)
                return self.send_json({'success': True, 'data': p})

            elif path == '/api/participant/submit':
                code = body.get('code')
                stage = body.get('stage')
                allocation = body.get('allocation')
                alloc = engine.submit_allocation(code, stage, allocation)
                return self.send_json({'success': True, 'data': alloc, 'message': 'Alokasi berhasil disimpan!'})

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
                    return self.send_json({'success': True, 'stage_input_open': is_open, 'message': engine.state['message']})

                elif path == '/api/facilitator/next-stage':
                    new_stage = engine.next_stage()
                    return self.send_json({'success': True, 'current_stage': new_stage, 'state': engine.get_public_state()})

                elif path == '/api/facilitator/reset':
                    preserve = body.get('preserve_participants', False)
                    engine.reset_game(preserve_participants=preserve)
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

def run(port=PORT):
    server_address = ('', port)
    httpd = socketserver.ThreadingTCPServer(server_address, DanarakcaRequestHandler)
    print(f"🚀 Server Game Danarakca berjalan di http://localhost:{port}")
    print(f"   - Tampilan Utama / Pilihan: http://localhost:{port}/")
    print(f"   - Layar Fasilitator / Proyektor: http://localhost:{port}/facilitator.html")
    print(f"   - Layar Peserta (Mobile HP): http://localhost:{port}/player.html")
    print(f"   - Login Admin: http://localhost:{port}/admin")
    print(f"   - Kredensial Fasilitator: ID='admin', Password='danarakca2026'")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer dihentikan.")
        httpd.server_close()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run(port)
