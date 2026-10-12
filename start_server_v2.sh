#!/usr/bin/env bash
echo 
echo "   Memulai Server Game Danarakca"
echo 
cd "$(dirname "$0")"

PORT=8080
if [ ! -z "$1" ]; then
  PORT=$1
fi

TARGET_SCRIPT=""
if [ -f "danarakca/server.py" ]; then
  TARGET_SCRIPT="danarakca/server.py"
elif [ -f "server.py" ]; then
  TARGET_SCRIPT="server.py"
elif [ -f "web_v2/server.py" ]; then
  TARGET_SCRIPT="web_v2/server.py"
else
  echo "[ERROR] File server.py tidak ditemukan di folder proyek!"
  exit 1
fi

echo "Membuka server dari $TARGET_SCRIPT di port $PORT..."
echo ""
echo "Akses URL:"
echo "  - Beranda Utama    : http://localhost:$PORT/"
echo "  - Login Admin      : http://localhost:$PORT/admin"
echo "  - Layar Fasilitator: http://localhost:$PORT/facilitator.html"
echo "  - Layar Peserta    : http://localhost:$PORT/player.html"
echo ""
echo "Tekan Ctrl+C untuk menghentikan server."
echo 
python3 "$TARGET_SCRIPT" $PORT
