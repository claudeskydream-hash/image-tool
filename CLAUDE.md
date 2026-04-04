# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Image Studio — a web-based AI image generation platform. Single-page frontend + Node.js API server + external image generation workers (e.g. Stable Diffusion WebUI). Chinese-language UI and comments throughout.

## Architecture

```
Browser ──▶ Nginx (:80) ──▶ Node.js (:8000) ──▶ SD WebUI (:7860)
              │                  │
              ├─ index.html      ├─ Auth / IP binding
              ├─ /api/* proxy    ├─ Queue management
              └─ /users/* proxy  ├─ SSE push notifications
                                 └─ Image storage (filesystem)
```

- **Frontend**: Single `index.html` file (no framework, vanilla JS). Login page + main studio app toggled via `display:none`.
- **Backend**: `server/server.js` (~850 lines). Pure Node.js native `http` module — no Express. All routes defined as flat if/else in the createServer handler.
- **Database**: MongoDB (`ai_image_studio` db) with three collections: `users`, `img_queue`, `config`. Auto-incrementing `queueId` via in-memory counter restored from DB on startup.
- **Authentication**: Token-based (64-char hex). Sessions stored in-memory Map — lost on restart. IP-to-username binding persisted in DB.
- **Real-time**: SSE (`GET /api/sse?token=xxx`) pushes `task_done`/`task_failed` events to clients. 30s heartbeat.
- **Worker protocol**: External workers poll `GET /api/getImgQueue` (atomic `findOneAndUpdate` to claim tasks) and submit results via `POST /api/setImgComp`.

## Commands

### Start services (order matters)

```bash
# 1. Nginx
cd /c/nginx && ./nginx.exe

# 2. Node.js backend
cd /c/NginxData/server && node server.js
# Or: start.bat  (kills existing process on port 8000 first)

# 3. SD WebUI (optional, without it generate tasks will fail)
```

### Stop services

```bash
# Node.js: Ctrl+C or
cd /c/NginxData/server && ./stop.bat

# Nginx
cd /c/nginx && ./nginx.exe -s quit

# Reload Nginx config
cd /c/nginx && ./nginx.exe -p /c/nginx -s reload
```

### Install dependencies

```bash
cd /c/NginxData/server && npm install
```

### Manual API testing (no automated test suite)

```bash
# Login
curl -X POST http://127.0.0.1:8000/api/login -H "Content-Type: application/json" -d '{"username":"test"}'

# Check session (use token from login response)
curl http://127.0.0.1:8000/api/check-session -H "Authorization: Bearer {token}"

# Submit generation task
curl -X POST http://127.0.0.1:8000/api/generate -H "Authorization: Bearer {token}" -H "Content-Type: application/json" -d '{"prompt":"a cat","width":512,"height":512,"num_images":1}'
```

## Key Configuration (in server.js)

```javascript
const PORT = 8000;
const MONGO_URL = 'mongodb://127.0.0.1:27017';
const MONGO_DB = 'ai_image_studio';
```

Queue limits are stored in MongoDB `config` collection with defaults:
- `maxUserQueue`: 3 (per-user concurrent tasks)
- `maxGlobalQueue`: 50 (system-wide)
- `maxImagesPerUser`: 20
- `defaultMoney`: 50 (virtual currency)

## Code Style

- camelCase for variables/functions, UPPER_SNAKE_CASE for constants
- Chinese comments for business logic, English for technical sections
- async/await throughout (no callback patterns)
- No linter or formatter configured

## Important Details

- **Path traversal protection**: Static file serving validates paths stay within `../users/` directory.
- **Username sanitization**: Allows Chinese chars, alphanumeric, `_`, `-`, spaces. Max 30 chars.
- **Image naming**: `img_{timestamp}_{index}.png` in `users/{username}/`
- **Logs**: Per-user log files in `server/logs/`, system errors prefixed `[init]` or `[ERROR]`
- **Nginx config**: Located at `C:\nginx\conf\nginx.conf`, proxies `/api/` and `/users/` to `127.0.0.1:8000`
