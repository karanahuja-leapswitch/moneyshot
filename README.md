# MoneyShot

Web chat UI (front end) for the Hermes agent, plus its backend.

Live: https://ultron.lsnw.io/moneyshot/

## Layout
- `frontend/` — the chat UI. Vendored fork of pi-web-ui; the MoneyShot app is
  `frontend/packages/web-ui/example/` (Google sign-in gate, Hermes OpenAI-compatible
  provider at `/moneyshot/api/v1`, glass theme, session persistence).
- `backend/` — Hermes + auth/SSE bridge (placeholder for now).

## Build the frontend
```bash
cd frontend
npm install
# build the workspace packages the app needs, then the app:
(cd packages/tui && npm run build) && (cd packages/ai && npm run build) \
  && (cd packages/agent && npm run build) && (cd packages/web-ui && npm run build)
cd packages/web-ui/example && npm run build   # base=/moneyshot/, output in dist/
```
Deploy `frontend/packages/web-ui/example/dist/` to the web root.
