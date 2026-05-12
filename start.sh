#!/bin/bash
echo ""
echo "  PUSULA HUNTER baslatiliyor..."
echo ""

cd "$(dirname "$0")/backend"

if [ ! -d "node_modules" ]; then
  echo "Ilk calistirma - kurulum yapiliyor..."
  cd ..
  bash install.sh
  cd backend
fi

if [ ! -d "../frontend/dist" ]; then
  cd ../frontend
  npm run build --silent
  cd ../backend
fi

echo "  Pusula Hunter hazir!"
echo "  http://localhost:3001"
echo ""
echo "  Durdurmak icin: Ctrl+C"
echo ""

node server.js
