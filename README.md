# Game Investasi Danarakca (Web Edition) 

Aplikasi web simulasi portofolio investasi edukatif berbasis skenario ekonomi dan kartu acak, dirancang untuk **200+ peserta** secara interaktif tanpa ketergantungan pada Excel Online atau Microsoft Forms.

---

## Fitur Utama

1. **Dual Interface**:
   - **Layar Fasilitator / Proyektor (`/facilitator.html`)**:
     - Animasi kartu skenario (100 kartu skenario ekonomi `K001`–`K100`).
     - Tampilan narasi peristiwa & edukasi ekonomi (*Mengapa terjadi?*).
     - Rincian imbal hasil 5 kelas aset (Sukuk, Saham, RDPU, Emas, RD Campuran).
     - **Papan Peringkat Live (Top 10)** dengan indikator perubahan posisi ($\uparrow \downarrow$).
     - Penghargaan khusus **Investor Tangguh** (Aset tertinggi dengan *max drawdown* $\le 10\%$).
     - Grafik garis tren aset Top Peserta & grafik indeks benchmark 5 kelas aset.
     - Kontrol putaran & tahap (Buka/Tutup submit alokasi).
     - Fitur **"Simulasi 200 Peserta (Bot)"** dengan 1-klik untuk uji coba instan.
     - Unduh rekap hasil akhir dalam format **CSV**.
   - **Layar Peserta Mobile (`/player.html`)**:
     - Akses via smartphone (cukup buka browser / scan QR code).
     - Registrasi kode tim (`P01` s/d `P200`).
     - Slider alokasi 5 aset dengan validasi otomatis (wajib total 100%) dan tombol preset (*Rata*, *Konservatif*, *Agresif*).
     - Dashboard pribadi: nilai saldo portofolio, persentase return, posisi peringkat, dan *max drawdown*.
     - Notifikasi kartu skenario aktif di tiap putaran.

2. **Perhitungan Portofolio Presisi**:
   - Menggunakan formula perhitungan matematis yang identik dengan file Excel `Game Investasi Danarakca.xlsx`.
   - Mendukung 30 putaran (3 tahap $\times$ 10 kuartal) dengan sistem rebalancing modal baru di awal Tahap 2 dan Tahap 3.

---

## Cara Menjalankan

### Cara 1: Windows (Klik Ganda)
Cukup klik ganda file:
```
start_server.bat
```

### Cara 2: Linux / macOS / WSL
Jalankan di terminal:
```bash
./start_server.sh
# Atau langsung:
python3 web/server.py 8080
```

Setelah server aktif, buka browser:
- **Halaman Pilihan Peran**: [http://localhost:8080/](http://localhost:8080/)
- **Layar Fasilitator / Proyektor**: [http://localhost:8080/facilitator.html](http://localhost:8080/facilitator.html)
- **Layar Peserta (HP)**: [http://localhost:8080/player.html](http://localhost:8080/player.html)

### 🔐 Kredensial Login Fasilitator
Untuk masuk ke layar admin / fasilitator:
- **ID Fasilitator**: `admin`
- **Password**: `danarakca2026`

*(Kredensial ini dapat diubah sewaktu-waktu di file `web/data/config.json`)*

---

## Cara Menghubungkan 200 HP Peserta dalam Acara

Ada 3 opsi mudah agar 200 peserta dapat mengakses game dari smartphone masing-masing:

### Opsi A: Menggunakan Wi-Fi Lokal yang Sama (Paling Praktis)
1. Sambungkan laptop fasilitator dan smartphone peserta ke jaringan Wi-Fi acara / hotspot yang sama.
2. Cari IP laptop Anda (misal `192.168.1.50`).
3. Peserta cukup membuka: `http://192.168.1.50:8080/player.html` (atau scan QR code di layar proyektor).

### Opsi B: Menggunakan Cloudflare Tunnel / Ngrok (Online Publik Tanpa Biaya)
Jika peserta menggunakan paket data seluler masing-masing:
```bash
# Contoh menggunakan Cloudflare Tunnel gratis:
cloudflared tunnel --url http://localhost:8080
```
Tautan publik (misal `https://danarakca-demo.trycloudflare.com`) akan otomatis muncul dan dapat dibagikan ke peserta.

---

## Alur Permainan

1. **Persiapan**:
   - Fasilitator membuka layar proyektor (`facilitator.html`).
   - Tampilkan QR code peserta (`Tombol QR Peserta`).
   - Bagikan kode peserta (`P01` s/d `P200`).
2. **Tahap 1 (Alokasi Awal)**:
   - Peserta masuk ke `player.html`, masukkan kode & nama tim.
   - Peserta mengatur alokasi 5 aset (total 100%) dan klik **Simpan Alokasi**.
3. **Putaran 1 s/d 10**:
   - Fasilitator menutup input alokasi (`Input Alokasi: Ditutup`).
   - Fasilitator menekan tombol **"Kocok Kartu Putaran X"**.
   - Fasilitator membacakan narasi skenario dan dampak ekonominya.
   - Leaderboard dan nilai aset peserta di proyektor & HP otomatis ter-update!
4. **Pergantian Tahap (Tahap 2 setelah Putaran 10, Tahap 3 setelah Putaran 20)**:
   - Fasilitator menekan tombol **"Maju ke Tahap 2"**.
   - Sesi alokasi otomatis terbuka kembali bagi peserta untuk menyusun strategi baru (*rebalancing* modal).
5. **Penutupan (Putaran 30)**:
   - Pengumuman pemenang utama (Aset Tertinggi) dan penghargaan khusus **Investor Tangguh** (*Drawdown* terkecil).
   - Ekspor rekap nilai akhir ke file CSV.

---

## Struktur File

```
Game Danarakca/
├── web/
│   ├── server.py              # Backend REST API server (Python standar)
│   ├── game_engine.py         # Engine logika portofolio, kartu, & ranking
│   ├── data/
│   │   ├── cards.json         # 100 kartu skenario ekonomi lengkap
│   │   ├── config.json        # Pengaturan modal & return dasar aset
│   │   └── state.json         # Penyimpanan status game & data peserta
│   └── static/
│       ├── index.html         # Portal utama
│       ├── facilitator.html   # Layar proyektor fasilitator
│       ├── facilitator.js     # Logika proyektor, leaderboard, & chart
│       ├── player.html        # Antarmuka smartphone peserta
│       ├── player.js          # Logika slider alokasi & saldo pribadi
│       └── style.css          # Tema modern, glassmorphism, & animasi
├── start_server.sh            # Skrip jalankan server (Linux/WSL)
├── start_server.bat           # Skrip jalankan server (Windows)
├── Game Investasi Danarakca.xlsx
└── README.md
```
