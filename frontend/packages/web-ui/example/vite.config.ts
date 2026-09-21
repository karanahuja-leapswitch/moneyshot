import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// MoneyShot chat SPA. Served behind nginx at https://ultron.lsnw.io/moneyshot/,
// and it calls the same-origin bridge at /moneyshot/api/v1 (OpenAI-compatible).
export default defineConfig({
	base: "/moneyshot/",
	plugins: [tailwindcss()],
	server: {
		// Local dev only: proxy the same-origin API path to the local SSE mock
		// (mock/server.mjs). In production nginx routes /moneyshot/api/ to the bff.
		proxy: {
			"/moneyshot/api": {
				target: "http://127.0.0.1:8799",
				changeOrigin: true,
				rewrite: (p) => p.replace(/^\/moneyshot\/api/, ""),
			},
		},
	},
});
