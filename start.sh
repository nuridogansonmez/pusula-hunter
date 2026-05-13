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

while true; do
  node server.js
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "  Guncelleme tamamlandi, yeniden baslatiliyor..."
    echo ""
    sleep 2
  else
    echo ""
    echo "  Sunucu kapandi (kod: $EXIT_CODE). Yeniden baslatmak icin: bash start.sh"
    break
  fi
done
