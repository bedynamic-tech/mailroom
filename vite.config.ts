import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ command }) => ({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      configPath: command === "serve" ? "./wrangler.dev.jsonc" : "./wrangler.jsonc",
    }),
  ],
}));
