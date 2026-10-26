# Danarakca

Aplikasi web simulasi manajemen portofolio investasi makroekonomi untuk edukasi finansial DJPPR Kementerian Keuangan.

## Spesifikasi Teknis

- Backend: Python 3.8+ (`danarakca/server.py` untuk server HTTP multi-thread dan `api/index.py` untuk Vercel Serverless Functions).
- Mesin Simulasi: `danarakca/game_engine.py` untuk kalkulasi nilai portofolio, imbal hasil instrumen, efek kartu skenario, Max Drawdown, dan papan peringkat.
- Penyimpanan Status: Upstash Redis / Vercel KV melalui REST API pada lingkungan produksi dan berkas JSON (`danarakca/data/state.json`) sebagai penyimpanan lokal.
- Sinkronisasi Real-Time: Server-Sent Events (SSE) dan `BroadcastChannel` dengan cadangan polling adaptif.
- Frontend: HTML5, Vanilla JavaScript, Tailwind CSS, dan Chart.js.

## Variabel Lingkungan

| Variabel | Fungsi |
| :--- | :--- |
| `UPSTASH_REDIS_REST_URL` / `KV_REST_API_URL` | Endpoint REST Redis/KV untuk persistensi status permainan. |
| `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` | Token autentikasi REST Redis/KV. |
| `DANARAKCA_ADMIN_USER` | ID login admin (menimpa nilai bawaan `config.json`). |
| `DANARAKCA_ADMIN_PASSWORD` | Password admin (menimpa nilai bawaan `config.json`). |
| `DANARAKCA_ADMIN_SECRET` | Kunci HMAC-SHA256 untuk penandatanganan token sesi admin. |
| `PORT` | Port HTTP server (bawaan: `8080`). |
