# Digital Resilience Assessment (DRA)

This file is read by AI coding assistants (opencode, Claude Code, etc.) to understand the project before making changes.

## Project Overview

**Digital Resilience Assessment (DRA)** is a web application that conducts structured security maturity assessments across an enterprise. It interviews staff from different roles about the cybersecurity services their organisation runs, then scores the organisation against a Zero Trust framework.

The app is deployed as a **Node.js backend + single-file HTML frontend** on an Ubuntu server. There are two environments: production (port 3000, branch `main`) and dev/test (port 3001, branch `dev`).

---

## Repository Structure

```
dra-app/
├── CLAUDE.md                  ← AI assistant instructions
├── .gitignore
├── README.md
├── public/
│   └── index.html             ← Entire frontend (single file, ~2700 lines)
├── server/
│   ├── server.js              ← Express backend (~408 lines)
│   ├── package.json
│   ├── .env.example           ← Config template
│   └── data/                  ← Auto-created at runtime (gitignored)
│       ├── _users.json        ← User accounts (bcrypt passwords)
│       ├── _sessions.json     ← Active session tokens
│       └── DRA_<COMPANY>.json ← One file per assessed company
└── scripts/
    ├── bootstrap.sh           ← One-shot server setup
    ├── deploy-prod.sh         ← Pull + restart production
    ├── deploy-dev.sh          ← Pull + restart dev
    ├── dra-prod.service       ← systemd unit (production)
    └── dra-dev.service        ← systemd unit (dev)
```

---

## Architecture

### Frontend (`public/index.html`)
A single self-contained HTML file (~2731 lines). No build step, no framework. All JavaScript is inline. It contains:

- **Embedded data** — the entire question bank and scoring metadata (see "Data" section below) are embedded as JS constants in the file. Do NOT move these to separate files without updating all references.
- **Four user-facing screens** (shown/hidden with `active` CSS class):
  1. `#screen-auth` — Login / Register
  2. `#screen-onboard` — Role selection + prior assessment detection
  3. `#screen-interview` — Conversational chat interface (AI-powered)
  4. `#screen-results` — Scoring dashboard with radar chart
- **Admin screen**: `#screen-admin` — SSE live dashboard, respondent list, user management
- **Design**: Dark theme, IBM Plex Sans/Mono fonts, cyan (`#00d4ff`) accent. Grid background via CSS `::before`.

### Backend (`server/server.js`)
Express.js server v2.0. All data stored as flat JSON files in `server/data/`. No database.

Key design decisions:
- **No database** — each company's data is one JSON file. Easy to back up, inspect, edit.
- **Sessions** stored in `_sessions.json`, TTL = 8 hours
- **SSE** (`/api/admin/live`) pushes live updates to admin dashboards
- **AI proxy** — `/api/claude` proxies to Anthropic (or a local proxy via `ANTHROPIC_BASE_URL`) so the API key never reaches the browser

---

## User & Auth System

### Registration
Collects: Full Name, Username, Password, Company. Role is NOT set at registration — it is chosen fresh at the start of each session on the onboarding screen.

### User Roles
- `standard` — default for all registered users
- `admin` — grants access to `#screen-admin`. **First admin must be set manually** by editing `server/data/_users.json` and changing `"role": "standard"` to `"role": "admin"`.

### Session Auth
All authenticated API calls include header: `X-Auth-Token: <uuid-token>`
Admin SSE endpoint (`/api/admin/live`) also accepts token as query param `?token=` because EventSource cannot set headers.

### User Storage Schema (`_users.json`)
```json
{
  "username": {
    "username": "string (lowercase)",
    "displayName": "string",
    "password": "bcrypt hash",
    "role": "standard | admin",
    "profile": { "name": "string", "company": "string", "role": "string" },
    "created_at": "ISO8601",
    "last_login": "ISO8601 | null"
  }
}
```

---

## Assessment Data

### Question Bank
- **34 security services** (e.g. "Identity Management", "Access Management", "SOC Management")
- **992 questions** total across all services
- **4 pillars** per service: `Service and Processes`, `Strategy and Policy`, `Technology`, `People and Skill`
- **3 maturity tiers** per pillar: `Service Exists and in good condition`, `Service Needs Enhancement`, `Not in Place`
- Questions are embedded in `public/index.html` as `const QUESTIONS_DATA`

### Role-to-Service Mapping
- **47 roles** (e.g. "SOC Lead", "Enterprise Security Architect", "CISO")
- Each role maps to a prioritised subset of services
- Embedded in `public/index.html` as `const ROLE_SERVICES_MAP`
- Role-question relevance embedded as `const QUESTION_ROLE_MAP`

### Zero Trust Scoring (`SCORING_MAP`)
- **317 capabilities** mapped from questions to Zero Trust pillars
- Weight per capability: `0.3333` (low) / `0.6667` (medium) / `1.0` (high)
- Formula: `score = (weighted_actual / weighted_max) × 5` → produces 0–5 CMMI-style score
- Service max scores stored in `SERVICE_META`
- Pillars: `Service and Processes`, `Strategy and Policy`, `Technology`, `People and Skill`

### Interview Flow
1. User selects role on onboard screen
2. App loads services relevant to that role (from `ROLE_SERVICES_MAP`)
3. For each service, loads questions filtered to that role (from `QUESTION_ROLE_MAP`)
4. Questions sorted by maturity tier priority (existence checks first, then enhancement)
5. AI moderator (Claude via `/api/claude`) asks questions conversationally
6. User responses are grouped by: `service → pillar → maturity tier`
7. On completion, answers are saved to server + scored locally

---

## API Endpoints

All endpoints are prefixed `/api`. Auth token passed as header `X-Auth-Token`.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | none | Server status, user counts, config |
| POST | `/api/auth/register` | none | Create account |
| POST | `/api/auth/login` | none | Login, returns token + profile |
| POST | `/api/auth/logout` | none | Invalidate token |
| GET | `/api/auth/me` | standard | Get current user info |
| GET | `/api/auth/check-username/:u` | none | Username availability check |
| GET | `/api/admin/users` | admin | List all users |
| PATCH | `/api/admin/users/:u/role` | admin | Promote/demote user |
| DELETE | `/api/admin/users/:u` | admin | Delete user |
| GET | `/api/admin/live` | admin | SSE live dashboard stream |
| GET | `/api/admin/snapshot` | admin | REST snapshot of all companies |
| GET | `/api/companies` | standard | List all assessed companies |
| GET | `/api/company/:company` | standard | Load company assessment record |
| POST | `/api/company/:company` | standard | Save/merge respondent data |
| GET | `/api/company/:company/respondents` | standard | List respondents |
| DELETE | `/api/company/:company/respondent` | standard | Remove respondent |
| POST | `/api/claude` | standard | Proxy to Anthropic API |

---

## Company Data Schema (`data/DRA_<COMPANY>.json`)

```json
{
  "company": "CompanyName",
  "last_updated": "ISO8601",
  "scores": {
    "ServiceName": {
      "overall": 3.4,
      "pillars": {
        "Service and Processes": 4.1,
        "Strategy and Policy": 2.8,
        "Technology": 3.9,
        "People and Skill": 2.5
      }
    }
  },
  "score_changelog": [
    { "timestamp": "ISO8601", "respondent": "name", "service": "ServiceName", "score": 3.4 }
  ],
  "respondents": {
    "Name | Role | SESSION-KEY": {
      "name": "string",
      "role": "string",
      "session": "SESSION-KEY",
      "services": {
        "ServiceName": {
          "PillarName": {
            "MaturityTier": [
              { "question": "string", "answer": "string" }
            ]
          }
        }
      }
    }
  }
}
```

---

## Environment Variables

Set in `server/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ANTHROPIC_API_KEY` | — | Required for AI interview. Key for Anthropic API or local proxy |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Override for local proxy (e.g. Copilot/LiteLLM) |
| `DRA_API_KEY` | (blank) | Optional shared secret header guard (`X-API-Key`) |
| `ALLOWED_ORIGIN` | `*` | CORS origin |

---

## Deployment — Two Environments

| | Production | Dev/Test |
|-|------------|----------|
| Directory | `/opt/dra/prod/` | `/opt/dra/dev/` |
| Git branch | `main` | `dev` |
| Port | `3000` | `3001` |
| systemd | `dra-prod` | `dra-dev` |
| Deploy script | `scripts/deploy-prod.sh` | `scripts/deploy-dev.sh` |

### Common Operations

```bash
# Deploy production
bash /opt/dra/prod/scripts/deploy-prod.sh

# Deploy dev
bash /opt/dra/dev/scripts/deploy-dev.sh

# View logs
journalctl -u dra-prod -f
journalctl -u dra-dev -f

# Check health
curl http://localhost:3000/api/health
curl http://localhost:3001/api/health

# Promote first admin (replace USERNAME)
nano /opt/dra/prod/server/data/_users.json
# Change "role": "standard" → "role": "admin" for your user
```

---

## Key Functions in `public/index.html`

| Function | Purpose |
|----------|---------|
| `populateOnboardProfile()` | Fills profile strip on onboard screen, resets role dropdown |
| `onRoleChange()` | Fired when role dropdown changes; checks server for prior assessment |
| `startAssessment()` | Reads role, initialises question queue, switches to interview screen |
| `viewPriorResults()` | Loads prior company data, calls `renderResultsFromData()` |
| `renderResultsFromData(data)` | Renders radar chart + score breakdown from company data object |
| `finishAssessment()` | Saves data to server, then calls `renderResultsFromData()` |
| `newAssessment()` | Resets state, calls `populateOnboardProfile()` |
| `checkServerHealth()` | Pings `/api/health`, shows green/red indicator |
| `callClaude(messages)` | POSTs to `/api/claude`, returns AI response text |
| `scoreAssessment()` | Computes weighted ZT scores from collected answers |

---

## AI Model Configuration

The Claude call in `callClaude()` uses `model: ''` (empty string). This is intentional — the server's Anthropic proxy (or local Copilot proxy) selects the model based on its own routing. If you need to specify a model, set `model: 'claude-sonnet-4-20250514'` or the appropriate model string in the fetch body inside `callClaude()`.

---

## Known Issues / Tech Debt

1. **No real-time answer sync** — Multi-respondent data is merged on save (POST), not live. Two users answering simultaneously won't see each other's progress until one saves.
2. **File-based storage** — Works well up to ~50 concurrent companies. For larger scale, swap `readCompany`/`writeCompany` functions in `server.js` for a database.
3. **Session storage** — `_sessions.json` is read/written on every request. High concurrency could cause race conditions. Consider Redis for sessions at scale.
4. **First admin** — Must be set manually in `_users.json`. Could add a seed script or first-run wizard.
5. **QUESTIONS_DATA size** — The embedded question bank adds ~200KB to the HTML file. Could be lazy-loaded from the server instead.

---

## Development Workflow

```bash
# On the server, switch to dev environment
cd /opt/dra/dev
git pull origin dev
cd server && npm install
npm run dev   # Node --watch auto-restarts on file changes

# Test your change
curl http://localhost:3001/api/health

# When satisfied, merge dev → main and deploy prod
bash scripts/deploy-prod.sh
```

---

## AI Assistant Guidance

When making changes:
- **Backend changes** → edit `server/server.js`, test on dev port 3001 first
- **Frontend changes** → edit `public/index.html` — remember it's a single file, no build step
- **Data structure changes** → update both the schema in this file and the relevant JS constants
- **Always** run `curl http://localhost:3000/api/health` after a prod deploy to confirm server is up
- **Never** commit `.env` files or `server/data/` contents to git
- The `QUESTIONS_DATA`, `QUESTION_ROLE_MAP`, `ROLE_SERVICES_MAP`, and `SCORING_MAP` constants in `index.html` are derived from Excel source files (not in this repo). Do not modify them without regenerating from source.
