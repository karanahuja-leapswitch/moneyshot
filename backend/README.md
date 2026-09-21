# MoneyShot — Hermes web-chat backend

Runs the [Hermes agent](https://github.com/nousresearch/hermes-agent) in Docker
and exposes an **authenticated, OpenAI-compatible SSE chat endpoint** for a web
chat UI (the UI itself is built in a separate project). Deployed under
`https://ultron.lsnw.io/moneyshot/` on the Leapswitch box `45.64.107.159`.

## Architecture

```
browser (Google sign-in @leapswitch)
  │  https://ultron.lsnw.io/moneyshot/
  ▼
Cloudflare → edge nginx (deploy-web-1)  ── /moneyshot/ ──►  moneyshot-web
                                                              ├─ /moneyshot/        SPA (built elsewhere)
                                                              └─ /moneyshot/api/ ─► moneyshot-bff  [msnet]
                                                                    • verify Google ID token + domain gate
                                                                    • inject internal Hermes key
                                                                    • stream SSE through
                                                                        │
                                                                        ▼
                                                                  moneyshot-hermes  [msnet, not published]
                                                                  OpenAI API server :8642
                                                                        │
                                                                        ▼
                                                                  your custom OpenAI-compatible model endpoint
```

Only `web` is on the shared `deploy_default` edge network. `bff` and `hermes`
live on the private `msnet` and are never published to the host or the internet.

## Endpoint contract (for the web-UI project)

Base URL: `https://ultron.lsnw.io/moneyshot/api`  ·  OpenAI-compatible.

| Method | Path | Notes |
|--------|------|-------|
| POST | `/v1/chat/completions` | `stream:true` → `text/event-stream` (SSE), else JSON |
| POST | `/v1/responses` | OpenAI Responses API (stateful via `previous_response_id`) |
| GET  | `/v1/models` | advertises the configured model |
| GET  | `/v1/capabilities` | machine-readable capabilities |
| GET  | `/health` | bridge liveness (no auth) |

**Auth:** every `/v1/*` call must send `Authorization: Bearer <google-id-token>`
— the Google Identity Services ID token from sign-in (client id in `bff.env`).
The bridge verifies it (Google JWKS, audience, issuer, exp) and rejects any
address outside `ALLOWED_DOMAINS` (401/403). The browser never sees the Hermes
key. Optional headers passed through for session continuity / memory scoping:
`X-Hermes-Session-Id`, `X-Hermes-Session-Key`.

Example:
```
POST /moneyshot/api/v1/chat/completions
Authorization: Bearer <google-id-token>
Content-Type: application/json

{"model":"hermes-agent","stream":true,
 "messages":[{"role":"user","content":"hello"}]}
```

## First-time deploy (on 45.64.107.159, in /opt/moneyshot)

```bash
# 1. Build the Hermes image from the cloned repo (once, or when it updates):
docker build -t hermes-agent:latest /opt/hermes-agent

# 2. Fill in config + secrets (all gitignored, server-only):
cp hermes/data/config.yaml.example hermes/data/config.yaml   # set base_url + model + api_key
cp hermes/hermes.env.example hermes/hermes.env               # set API_SERVER_KEY
cp bff/bff.env.example bff/bff.env                           # set matching HERMES_API_KEY
#    generate the shared secret: openssl rand -hex 32  (same value in both files)

# 3. Make the data dir writable by the container user (HERMES_UID/GID, default 10000):
mkdir -p hermes/data && chown -R 10000:10000 hermes/data

# 4. Bring it up (joins the existing deploy_default edge network):
docker compose up -d --build
```

The edge nginx already routes `/moneyshot/` to this stack — no edge change needed.

## Verify

```bash
docker compose ps
docker compose logs -f hermes        # API server should log listening on :8642
# from inside the private net (no public exposure):
docker compose exec bff sh -c 'wget -qO- http://hermes:8642/health'
# bridge rejects unauthenticated calls:
curl -si https://ultron.lsnw.io/moneyshot/api/v1/models | head -1   # → 401
```
