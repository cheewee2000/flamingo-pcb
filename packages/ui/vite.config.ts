import { defineConfig } from 'vite';

/**
 * Dev server proxies same-origin API/WS/MCP paths to the Flamingo server
 * (packages/server, default port 4242) so `src/*.ts` never hardcodes a host
 * or port -- the same fetch('/api/...') / new WebSocket('/ws') calls work
 * unchanged in `vite dev` and in the production build served by the server.
 */
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:4242',
      '/ws': { target: 'ws://localhost:4242', ws: true },
      '/mcp': 'http://localhost:4242',
    },
  },
  build: {
    outDir: 'dist',
  },
});
