// Minimal OpenAI-compatible SSE mock for local dev of the MoneyShot chat UI.
// Matches the contract the real Hermes bff will answer at /moneyshot/api/v1.
//   GET  /v1/models               -> model list
//   POST /v1/chat/completions      -> SSE (stream:true) or JSON
// Auth is NOT enforced here (the real bff verifies the Google ID token).
//   node mock/server.mjs   # listens on :8799
import http from "node:http";

const PORT = 8799;

function send(res, code, obj) {
	res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
	res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
	if (req.method === "GET" && url.pathname === "/v1/models") {
		return send(res, 200, {
			object: "list",
			data: [{ id: "hermes", object: "model", created: 0, owned_by: "hermes" }],
		});
	}
	if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let stream = false;
			let lastUser = "";
			try {
				const j = JSON.parse(body || "{}");
				stream = !!j.stream;
				const um = [...(j.messages || [])].reverse().find((m) => m.role === "user");
				lastUser = typeof um?.content === "string" ? um.content : JSON.stringify(um?.content ?? "");
			} catch {}
			const reply = `MoneyShot mock — Hermes will answer here.\n\nYou said: ${lastUser}`;
			if (!stream) {
				return send(res, 200, {
					id: "chatcmpl-mock",
					object: "chat.completion",
					created: 0,
					model: "hermes",
					choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
				});
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"access-control-allow-origin": "*",
			});
			const chunk = (delta, finish = null) =>
				`data: ${JSON.stringify({
					id: "chatcmpl-mock",
					object: "chat.completion.chunk",
					created: 0,
					model: "hermes",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			res.write(chunk({ role: "assistant" }));
			const words = reply.split(/(\s+)/);
			let i = 0;
			const timer = setInterval(() => {
				if (i < words.length) {
					res.write(chunk({ content: words[i++] }));
				} else {
					clearInterval(timer);
					res.write(chunk({}, "stop"));
					res.write("data: [DONE]\n\n");
					res.end();
				}
			}, 20);
		});
		return;
	}
	send(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock OpenAI-compatible server on http://127.0.0.1:${PORT}`));
