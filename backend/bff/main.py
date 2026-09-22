"""MoneyShot auth + SSE bridge for the Hermes agent.

The Hermes gateway exposes an OpenAI-compatible API server that "dispatches
terminal-capable agent execution" — so it must never be reachable without
per-user auth. This bridge sits between the (separately built) web chat UI and
the Hermes container on the private `msnet` network:

  1. Verifies the caller's Google ID token (Google JWKS, audience=client_id,
     issuer, exp) and enforces the trusted-domain gate.
  2. Injects the internal Hermes API_SERVER_KEY (never seen by the browser).
  3. Proxies the OpenAI-compatible calls to Hermes, streaming SSE straight
     through for `stream: true` chat completions.

Public surface (mounted by the edge under /moneyshot/api/):
  POST /v1/chat/completions   (stream + non-stream)
  POST /v1/responses          (OpenAI Responses API)
  GET  /v1/models
  GET  /v1/capabilities
  GET  /health                (bridge liveness — no auth)
"""
import os

import os as _os
import re

import asyncpg
import httpx
import jwt
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from jwt import PyJWKClient

GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
ALLOWED_DOMAINS = {
    d.strip().lower()
    for d in os.environ.get("ALLOWED_DOMAINS", "").split(",")
    if d.strip()
}
# Upstream Hermes OpenAI-compatible API server (private network).
HERMES_URL = os.environ.get("HERMES_URL", "http://hermes:8642").rstrip("/")
HERMES_API_KEY = os.environ["HERMES_API_KEY"]
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "600"))

GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}

# Headers we let the browser pass through to Hermes for session continuity /
# long-term memory scoping (see gateway/platforms/api_server.py).
PASSTHROUGH_REQ_HEADERS = ("x-hermes-session-id", "x-hermes-session-key")
# Hop-by-hop / auth headers we must not copy back to the client.
STRIP_RESP_HEADERS = {
    "content-encoding", "content-length", "transfer-encoding", "connection",
}

app = FastAPI(title="moneyshot-hermes-bridge")
_jwks = PyJWKClient(GOOGLE_JWKS)

# Revenue-recovery Postgres — read-only here (WhatsApp disconnect stats). Lazily
# created so the bridge still starts if the DB is briefly down.
DATABASE_URL = os.environ.get("DATABASE_URL", "")
_pg_pool: "asyncpg.Pool | None" = None


async def _pg() -> "asyncpg.Pool":
    global _pg_pool
    if _pg_pool is None:
        if not DATABASE_URL:
            raise HTTPException(status_code=503, detail="db not configured")
        _pg_pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=3)
    return _pg_pool


def _require_user(authorization: str) -> dict:
    """Verify the Google ID token in the Authorization header, gate by domain."""
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        key = _jwks.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=GOOGLE_CLIENT_ID,
            options={"verify_exp": True},
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"invalid google token: {exc}") from exc
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise HTTPException(status_code=401, detail="untrusted issuer")
    if not claims.get("email_verified"):
        raise HTTPException(status_code=401, detail="email not verified")
    email = (claims.get("email") or "").lower()
    domain = email.split("@")[-1] if "@" in email else ""
    if ALLOWED_DOMAINS and domain not in ALLOWED_DOMAINS:
        raise HTTPException(status_code=403, detail="email domain not allowed")
    return claims


def _upstream_headers(request: Request, email: str) -> dict:
    headers = {
        "Authorization": f"Bearer {HERMES_API_KEY}",
        "Content-Type": request.headers.get("content-type", "application/json"),
        # Identify the end user to Hermes (multi-user session/memory scoping).
        "X-Hermes-User": email,
    }
    for h in PASSTHROUGH_REQ_HEADERS:
        v = request.headers.get(h)
        if v:
            headers[h] = v
    return headers


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# --- WhatsApp QR images -----------------------------------------------------
# The whatsapp-web skill (in the hermes container) writes QR PNGs to the shared
# `waqr` volume; we serve them here so the chat can show the QR as a normal
# <img>. No bearer auth (an <img> tag can't send one) — access is gated by the
# unguessable 32-hex token in the filename, and a QR is only useful for ~60s and
# still requires the target phone to scan it.
QR_DIR = _os.environ.get("WA_QR_DIR", "/waqr")
_QR_NAME = re.compile(r"^[0-9a-f]{32}\.png$")

# WhatsApp control service (wa.js `serve`), reached over the private network.
WA_SVC_URL = _os.environ.get("WA_SVC_URL", "http://wa:8100").rstrip("/")


@app.get("/qr/{name}")
async def qr(name: str) -> FileResponse:
    if not _QR_NAME.match(name):
        raise HTTPException(status_code=404, detail="not found")
    path = _os.path.join(QR_DIR, name)
    if not _os.path.isfile(path):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


async def _proxy(request: Request, path: str, authorization: str) -> Response:
    """Verify the user, then proxy `path` to Hermes, streaming SSE if requested."""
    claims = _require_user(authorization)
    body = await request.body()
    headers = _upstream_headers(request, claims.get("email", ""))
    url = f"{HERMES_URL}{path}"
    method = request.method

    client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT)
    req = client.build_request(method, url, content=body or None, headers=headers)
    upstream = await client.send(req, stream=True)

    ct = upstream.headers.get("content-type", "")
    if "text/event-stream" in ct:
        async def event_stream():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()

        resp_headers = {
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # belt-and-suspenders vs. proxy buffering
        }
        return StreamingResponse(
            event_stream(),
            status_code=upstream.status_code,
            media_type="text/event-stream",
            headers=resp_headers,
        )

    # Non-streaming: read fully, pass body + status through.
    content = await upstream.aread()
    await upstream.aclose()
    await client.aclose()
    passthrough = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in STRIP_RESP_HEADERS
    }
    return Response(
        content=content,
        status_code=upstream.status_code,
        media_type=ct or "application/json",
        headers=passthrough,
    )


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: str = Header(default="")):
    return await _proxy(request, "/v1/chat/completions", authorization)


@app.post("/v1/responses")
async def responses(request: Request, authorization: str = Header(default="")):
    return await _proxy(request, "/v1/responses", authorization)


@app.get("/v1/models")
async def models(request: Request, authorization: str = Header(default="")):
    return await _proxy(request, "/v1/models", authorization)


@app.get("/v1/capabilities")
async def capabilities(request: Request, authorization: str = Header(default="")):
    return await _proxy(request, "/v1/capabilities", authorization)


# --- WhatsApp connect (dedicated screen, not via chat) ----------------------
# Each signed-in user links their OWN WhatsApp; the session is keyed by their
# verified Google email so the connect screen and the chat agent share one link.
async def _wa_proxy(method: str, path: str, user: str) -> Response:
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            r = await client.request(method, f"{WA_SVC_URL}{path}", params={"user": user})
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"ok": False, "error": "wa_unreachable", "message": str(exc)}, status_code=502)
    try:
        return JSONResponse(r.json(), status_code=r.status_code)
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad_upstream"}, status_code=502)


@app.get("/wa/status")
async def wa_status(authorization: str = Header(default="")):
    """Connection status for the status dot: {connected, number, state, qrUrl?}."""
    claims = _require_user(authorization)
    return await _wa_proxy("GET", "/status", claims.get("email", ""))


@app.post("/wa/connect")
async def wa_connect(authorization: str = Header(default="")):
    """Start (or refresh) QR pairing for this user; returns {state, qrUrl}."""
    claims = _require_user(authorization)
    return await _wa_proxy("POST", "/login", claims.get("email", ""))


@app.post("/wa/logout")
async def wa_logout(authorization: str = Header(default="")):
    """Disconnect this user's WhatsApp (unlink + wipe local session)."""
    claims = _require_user(authorization)
    return await _wa_proxy("POST", "/logout", claims.get("email", ""))


@app.get("/wa/disconnect-stats")
async def wa_disconnect_stats(authorization: str = Header(default="")):
    """Last 5 IST days of "WhatsApp was disconnected while a message was due"
    dispatcher ticks. Shown to the user right after they log in. Zero-filled,
    newest day first: {"days":[{"day","ticks"}...], "totalTicks":N}."""
    _require_user(authorization)
    try:
        pool = await _pg()
        rows = await pool.fetch(
            """
            SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
                   COALESCE(t.disconnected_ticks, 0) AS ticks
            FROM generate_series(
                   (now() AT TIME ZONE 'Asia/Kolkata')::date - interval '4 days',
                   (now() AT TIME ZONE 'Asia/Kolkata')::date,
                   interval '1 day') d
            LEFT JOIN disconnected_whatsapp_ticks_daily t ON t.day = d::date
            ORDER BY day DESC
            """
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "db_unreachable", "message": str(exc)}, status_code=502)
    days = [{"day": r["day"], "ticks": int(r["ticks"])} for r in rows]
    return {"ok": True, "days": days, "totalTicks": sum(d["ticks"] for d in days)}
