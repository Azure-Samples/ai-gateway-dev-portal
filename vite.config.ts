import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'

/**
 * Vite plugin that proxies /gateway-proxy/* requests to the APIM gateway
 * specified by the X-Gateway-Base request header. This avoids browser CORS
 * issues during local development.
 */
function gatewayProxy(): Plugin {
  return {
    name: 'gateway-proxy',
    configureServer(server) {
      server.middlewares.use('/gateway-proxy', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const base = (req.headers['x-gateway-base'] as string | undefined)?.replace(/\/$/, '');
        if (!base) { next(); return; }

        let targetUrl: URL;
        try {
          targetUrl = new URL(req.url ?? '/', base);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad gateway target URL');
          return;
        }

        // Pick http or https transport
        const transport = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;

        // Forward headers, stripping internal/browser-only ones
        // Node lowercases all incoming header names; APIM requires original casing for its subscription key header.
        const HEADER_CASING: Record<string, string> = {
          'ocp-apim-subscription-key': 'Ocp-Apim-Subscription-Key',
          'ocp-apim-trace': 'Ocp-Apim-Trace',
          'apim-debug-authorization': 'Apim-Debug-Authorization',
          'content-type': 'Content-Type',
        };
        const fwdHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!v || k === 'x-gateway-base' || k === 'host' || k === 'origin' || k === 'referer' || k === 'connection') continue;
          fwdHeaders[HEADER_CASING[k] ?? k] = v;
        }
        fwdHeaders['Host'] = targetUrl.host;

        const proxyReq = transport(targetUrl, {
          method: req.method,
          headers: fwdHeaders,
        }, (proxyRes) => {
          // Forward status + headers back to the browser
          const resHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (v != null) resHeaders[k] = v;
          }
          // Ensure SSE streams are not buffered
          resHeaders['x-accel-buffering'] = 'no';
          res.writeHead(proxyRes.statusCode ?? 502, resHeaders);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          console.error('Gateway proxy error:', err.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          res.end('Gateway proxy error: ' + err.message);
        });

        // Pipe the incoming request body to the proxy request
        req.pipe(proxyReq);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), gatewayProxy()],
  build: {
    chunkSizeWarningLimit: 600,
  },
})
