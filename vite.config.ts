import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      // Dev-time equivalent of worker.ts's GHSL tile proxy — see
      // src/gtfs/population.worker.ts for why this is needed (JRC's tile
      // server has no CORS headers).
      '/api/ghsl-tile': {
        target: 'https://jeodpp.jrc.ec.europa.eu',
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(
            /^\/api\/ghsl-tile\/2025\/(R\d{1,2}_C\d{1,2})\.zip$/,
            '/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_3ss/V1-0/tiles/GHS_POP_E2025_GLOBE_R2023A_4326_3ss_V1_0_$1.zip',
          ),
      },
    },
  },
});
