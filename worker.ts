/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
}

// JRC's GHSL tile server (jeodpp.jrc.ec.europa.eu) has no CORS headers, so
// the population analysis layer's 2025 epoch tiles (see
// src/gtfs/population.worker.ts) can't be fetched directly from the
// browser. This re-serves them same-origin. Path is restricted to the exact
// tile-name shape so this can't be used as an open proxy.
const GHSL_TILE_PATH = /^\/api\/ghsl-tile\/2025\/(R\d{1,2}_C\d{1,2})\.zip$/;

function ghslTileUpstream(tile: string): string {
  return (
    'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/' +
    `GHS_POP_E2025_GLOBE_R2023A_4326_3ss/V1-0/tiles/GHS_POP_E2025_GLOBE_R2023A_4326_3ss_V1_0_${tile}.zip`
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const tileMatch = GHSL_TILE_PATH.exec(url.pathname);
    if (tileMatch) {
      const upstream = await fetch(ghslTileUpstream(tileMatch[1]), {
        cf: { cacheTtl: 31536000, cacheEverything: true },
      });
      const headers = new Headers();
      headers.set('Content-Type', 'application/zip');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    // Required for SharedArrayBuffer (DuckDB-WASM uses it internally)
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
