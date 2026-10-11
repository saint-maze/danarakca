export const CONFIG = {
  "title": "Game Investasi Danarakca",
  "subtitle": "Kelola Portofolio, Hadapi Skenario",
  "public_url": "",
  "initial_capital": 100000000,
  "total_rounds": 30,
  "rounds_per_stage": 10,
  "total_stages": 3,
  "max_drawdown_award": 0.1,
  "assets": [
    {
      "id": "sukuk",
      "name": "Sukuk / SBN",
      "color": "#0ea5e9",
      "base_return": 0.0175,
      "desc": "Kupon 7% per tahun (1,75% per kuartal), aman & dijamin negara."
    },
    {
      "id": "saham",
      "name": "Saham",
      "color": "#f43f5e",
      "base_return": 0.0,
      "desc": "Hasil murni dari kartu skenario. Potensi gain tinggi, volatilitas tinggi."
    },
    {
      "id": "rdpu",
      "name": "RD Pasar Uang",
      "color": "#10b981",
      "base_return": 0.011,
      "desc": "Instrumen pasar uang/deposito ~4,5% per tahun, likuid & sangat stabil."
    },
    {
      "id": "emas",
      "name": "Emas",
      "color": "#eab308",
      "base_return": 0.002,
      "desc": "Lindung nilai (hedging). Naik pesat saat krisis & ketidakpastian."
    },
    {
      "id": "campuran",
      "name": "RD Campuran",
      "color": "#8b5cf6",
      "base_return": 0.0074,
      "desc": "Kombinasi saham, obligasi & pasar uang dengan risiko moderat."
    }
  ],
  "admin": {
    "username": "admin",
    "password": "danarakca2026"
  }
};
