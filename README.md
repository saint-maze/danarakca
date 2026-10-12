# Danarakca

Aplikasi simulasi portofolio investasi makroekonomi berbasis web untuk edukasi finansial DJPPR Kementerian Keuangan.

---

## Spesifikasi Teknis

- **Backend**: Python 3.8+ (pustaka standar: `http.server`, `socketserver`, `json`, `csv`, `threading`).
- **Frontend**: HTML5, Vanilla JavaScript, CSS3 (Tailwind CSS CDN, Chart.js).
- **Penyimpanan Status**: Berbasis berkas JSON (`danarakca/data/state.json`).
- **Kompatibilitas Layar**:
  - Layar Fasilitator: Responsif untuk layar proyektor laptop hingga smartphone operator.
  - Layar Peserta: Mobile-first dengan slider persentase alokasi dan umpan balik haptik.

---

## Struktur Direktori

```text
Game Danarakca/
├── danarakca/
│   ├── data/
│   │   ├── cards.json         # Basis data 100 kartu skenario makroekonomi
│   │   ├── config.json        # Nilai dasar aset, modal awal, dan kredensial admin
│   │   └── state.json         # Status permainan berjalan dan riwayat peserta
│   ├── static/
│   │   ├── facilitator.html   # Tampilan kendali fasilitator dan proyektor
│   │   ├── facilitator.js     # Logika leaderboard, kontrol putaran, dan grafik
│   │   ├── player.html        # Antarmuka input peserta (smartphone)
│   │   ├── player.js          # Logika alokasi portofolio peserta
│   │   ├── admin-login.html   # Autentikasi fasilitator
│   │   ├── index.html         # Portal pemilihan peran
│   │   ├── style.css          # Desain visual, background GPU-accelerated
│   │   └── img/               # Asset logo dan ikon
│   ├── game_engine.py         # Perhitungan portofolio, scoring, dan leaderboard
│   └── server.py              # HTTP server dan REST API
├── Dockerfile                 # Konfigurasi container Docker
├── Procfile                   # Konfigurasi proses Render / Heroku
├── wrangler.toml              # Konfigurasi Cloudflare Pages
├── start_server_v2.bat        # Skrip inisialisasi Windows
├── start_server_v2.sh         # Skrip inisialisasi Linux / macOS
└── README.md
```

---

## Menjalankan di Komputer Lokal

### Prasyarat
Python 3.8 atau versi lebih baru terpasang di sistem.

### Windows
Jalankan berkas:
```cmd
start_server_v2.bat
```

### Linux / macOS
```bash
bash start_server_v2.sh
```
Atau jalankan perintah langsung:
```bash
python3 danarakca/server.py 8080
```

### URL Akses Lokal
- Portal Utama: `http://localhost:8080/`
- Layar Fasilitator: `http://localhost:8080/facilitator.html`
- Layar Peserta: `http://localhost:8080/player.html`
- Login Admin: `http://localhost:8080/admin`



## Alur Permainan

1. **Registrasi**:
   - Fasilitator menampilkan QR Code pada `facilitator.html`.
   - Peserta membuka `player.html` dari smartphone dan memasukkan ID peserta (`P01` s/d `P200`).
2. **Tahap 1 (Alokasi Modal Awal)**:
   - Peserta membagi alokasi modal 100% ke 5 instrumen: Sukuk Negara, Saham Blue Chip, RDPU, Emas, Reksa Dana Campuran.
3. **Putaran 1–10**:
   - Fasilitator menutup input alokasi dan mengocok kartu skenario (`K001`–`K100`).
   - Dampak ekonomi kartu diterapkan pada nilai aset tiap peserta.
   - Leaderboard diperbarui secara real-time.
4. **Rebalancing (Awal Tahap 2 & Tahap 3)**:
   - Setelah putaran 10 dan 20, fasilitator membuka sesi rebalancing untuk menyusun ulang komposisi portofolio.
5. **Evaluasi Akhir (Putaran 30)**:
   - Pengumuman pemenang akumulasi aset tertinggi.
   - Penghargaan **Investor Tangguh** untuk peserta dengan nilai drawdown terendah.
   - Ekspor rekap data ke CSV melalui tombol di layar fasilitator.
