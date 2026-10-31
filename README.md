# nodez2ai

**Z.AI (chat.z.ai) GLM OpenAI-compatible Gateway in Node.js**

Native Windows / macOS / Linux deployment with **zero Docker requirement**.

---

## Features

- **OpenAI-compatible Endpoints**:
  - `POST /v1/chat/completions` (Streaming SSE & non-streaming)
  - `GET /v1/models`, `GET /models`
  - `GET /status`, `GET /healthz`
  - Web Dashboard at `http://localhost:8080/`
- **Native Windows Execution**:
  - Run with double-click on `start.bat`.
  - No containers, no WSL, no Linux VM required.
- **Auto DeviceToken Pool**:
  - Built-in background worker automatically monitors SQLite token pool and replenishes tokens using Playwright stealth automation.
- **Thinking / Chain of Thought Support**:
  - GLM-5.3 thinking mode captured and forwarded natively as OpenAI `reasoning_content`.
- **Tool Calling (Function Calling)**:
  - Supports function calling for OpenCode / Cline / Continue / Cherry Studio.

---

## Quick Start (Windows)

### Option 1: One-Click Run
Just double-click `start.bat`. It will automatically:
1. Verify Node.js is installed.
2. Create `.env` from `.env.example` if not present.
3. Install dependencies (`npm install`).
4. Start the server.


### Option 2: Command Line
```powershell
cd nodez2ai

# 1. Install dependencies
npm install

# 2. (First time only) Install Playwright Chromium browser
npx playwright install chromium

# 3. Create .env file
copy .env.example .env

# 4. Start in development (auto-reload) mode
npm run dev
```

---

## Configuration (`.env`)

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port | `8080` |
| `HOST` | HTTP server host | `0.0.0.0` |
| `AUTH_TOKEN` | Client Bearer token authentication key | `d3vin` |
| `ZAI_TOKEN` | Optional Z.AI JWT token to unlock `glm-5.3` and `glm-5.2` (guest has `glm-5.3-flash`) | *empty* |
| `DB_PATH` | SQLite database file for tokens | `tokens.sqlite` |
| `TOKEN_BATCH` | Number of tokens to harvest per batch | `150` |
| `TOKEN_TARGET` | Target token pool size | `750` |
| `TOKEN_LOWWATER` | Low-water mark to trigger replenishment | `50` |
| `LOG_LEVEL` | Log level (`info` or `debug`) | `info` |
| `HTTP_PROXY` | Optional HTTP proxy | *empty* |
| `HTTPS_PROXY` | Optional HTTPS/SOCKS5 proxy (e.g. `socks5://127.0.0.1:1080`) | *empty* |

---

## Usage Examples

### List Models
```bash
curl http://localhost:8080/v1/models -H "Authorization: Bearer d3vin"
```

### Chat Completions (Streaming)
```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer d3vin" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

### Manual Token Harvesting
To manually collect tokens into your database:
```bash
npm run collect -- --count 150
```

### Run Tests
```bash
npm test
```
