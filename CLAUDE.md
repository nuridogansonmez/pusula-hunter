# DataHunter - Google Maps Scraper

## Architecture
- **Backend:** Node.js + Express + WebSocket (port 3001)
- **Frontend:** React + Vite (served by backend from `frontend/dist`)
- **Database:** SQLite via better-sqlite3 (`backend/datahunter.db`)
- **Scraping:** Playwright with headless Chromium

## Commands
- Start: `cd backend && node server.js` or `./start.sh`
- Dev frontend: `cd frontend && npm run dev`
- Build frontend: `cd frontend && npm run build`

## Key Files
- `backend/server.js` - Express API + WebSocket server
- `backend/scraper.js` - Google Maps scraper logic
- `backend/database.js` - SQLite schema and connection
- `frontend/src/App.jsx` - Main React component (single-file app)

## API Endpoints
- `GET /api/campaigns` - List campaigns
- `POST /api/campaigns` - Create campaign
- `POST /api/campaigns/:id/start` - Start scraping
- `POST /api/campaigns/:id/pause|resume|cancel` - Control
- `GET /api/campaigns/:id/businesses` - Get scraped data
- `GET /api/campaigns/:id/export` - Download Excel
