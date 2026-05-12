#!/bin/bash
clear
echo "============================================"
echo "   PUSULA HUNTER - Kurulum"
echo "============================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js bulunamadi. Yukleniyor..."
  if command -v brew &> /dev/null; then
    brew install node
  else
    echo ""
    echo "Homebrew bulunamadi. Once Homebrew yukleyin:"
    echo '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    echo ""
    echo "Sonra tekrar bu scripti calistirin."
    exit 1
  fi
fi

echo "Node.js: $(node -v)"
echo ""

# Install backend
echo "[1/4] Backend bagimliliklari yukleniyor..."
cd "$(dirname "$0")/backend"
npm install --silent 2>&1 | tail -1
echo "      Tamam"

# Install Playwright browser
echo "[2/4] Tarayici yukleniyor (ilk seferde ~90MB)..."
npx playwright install chromium 2>&1 | tail -1
echo "      Tamam"

# Install frontend
echo "[3/4] Frontend bagimliliklari yukleniyor..."
cd ../frontend
npm install --silent 2>&1 | tail -1
echo "      Tamam"

# Build frontend
echo "[4/4] Frontend derleniyor..."
npm run build --silent 2>&1 | tail -1
echo "      Tamam"

echo ""
echo "============================================"
echo "   KURULUM TAMAMLANDI!"
echo "============================================"
echo ""
echo "Baslatmak icin:"
echo "  ./start.sh"
echo ""
echo "Tarayicinizda acilacak adres:"
echo "  http://localhost:3001"
echo ""
