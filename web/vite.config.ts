import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // API はプロキシ経由にして、開発時の CORS を考えなくて済むようにする
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
