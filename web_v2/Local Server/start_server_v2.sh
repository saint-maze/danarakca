#!/usr/bin/env bash
echo 
echo "   Memulai Server Game Danarakca (Hyperstudio / DESIGN.md Edition)       "
echo 
cd "$(dirname "$0")"

PORT=8080
if [ ! -z "$1" ]; then
  PORT=$1
fi

echo "Membuka server di port $PORT..."
echo ""
echo "Akses URL:"
echo "  - Beranda Utama    : http://localhost:$PORT/"
echo "  - Login Admin      : http://localhost:$PORT/admin"
echo "  - Layar Fasilitator: http://localhost:$PORT/facilitator.html"
echo "  - Layar Peserta    : http://localhost:$PORT/player.html"
echo ""
echo "Tekan Ctrl+C untuk menghentikan server."
echo 
python3 web_v2/server.py $PORT
