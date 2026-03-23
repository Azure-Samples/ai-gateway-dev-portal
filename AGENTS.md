# AGENTS.md — Coding Agent Guide

## Project overview

React 19 + TypeScript 5.9 + Vite 8 single-page app for managing Azure API Management AI Gateway resources. Authenticates via MSAL (Entra ID) or token-based auth. All Azure ARM calls go through `src/services/azure.ts`. A Vite dev-server plugin (`/gateway-proxy/*`) proxies requests to APIM gateways to avoid CORS issues.

## Stack & key dependencies

| Layer | Tech |
| --- | --- |
| UI | React 19, react-router-dom 7, lucide-react icons, recharts |
| Azure SDK | @azure/arm-apimanagement, @azure/msal-browser, @azure/arm-monitor |
| MCP | @modelcontextprotocol/sdk (StreamableHTTPClientTransport) |
| Build | Vite 8, TypeScript ~5.9 |
| Lint | ESLint 9 with typescript-eslint (recommendedTypeChecked + stylisticTypeChecked), react-hooks, react-refresh |

## Project structure

```
src/
├── App.tsx                 # Router, auth gates, route table
├── main.tsx                # Entry point (MSAL + Theme + TokenAuth providers)
├── types.ts                # Shared TypeScript interfaces
├── index.css               # All styles (single CSS file, CSS custom properties)
├── config/msal.ts          # MSAL configuration
├── context/
│   ├── AzureContext.tsx     # Global state — tenant, subscription, APIM service, workspace selection; fetches & caches ARM data
│   ├── ThemeContext.tsx     # Light/dark theme
│   └── TokenAuthContext.tsx # Token-based auth (non-MSAL)
├── services/azure.ts       # ALL Azure ARM/REST calls (single file)
├── components/             # Shared UI — Layout, Sidebar, Header, modals, SearchBar, etc.
├── hooks/                  # Custom hooks (e.g. useLegendHighlight)
└── pages/                  # One file per route/page
```

## Conventions

### Adding a new page

1. Create `src/pages/YourPage.tsx` — default-export a React component.
2. Import it in `src/App.tsx` and add a `<Route>` inside `AuthenticatedRoutes`.
3. Add a sidebar entry in `src/components/Sidebar.tsx` using a `lucide-react` icon.
4. If the page needs APIM data, use the `useAzure()` context hook from `AzureContext`.

### Adding a new Azure service call

1. Add the function in `src/services/azure.ts`. Accept `credential` (from `createMsalCredential`), `subscriptionId`, `resourceGroup`, `serviceName`, plus any page-specific params.
2. Export the function and import it where needed. All ARM calls live in this one file.

### Styling

- All styles are in `src/index.css` — there are no CSS modules or styled-components.
- Use CSS custom properties defined at `:root` / `[data-theme="dark"]` for colors.
- Scope new styles with a page-specific prefix (e.g. `.mcp-pg-` for MCP Playground).

### TypeScript interfaces

- Shared interfaces go in `src/types.ts`.
- Page-local interfaces (e.g. `McpTool`, `HistoryEntry`) stay in the page file.

### Icons

- Use `lucide-react` for all icons. Import only the icons you use.

### Modals

- `TraceModal` — reusable gateway trace viewer (request/response + APIM trace sections).
- `CodeModal` — code generation modal (JS/Python/cURL).
- `ConfirmModal` — generic yes/no confirmation dialog.
- `LoadingModal` — loading spinner overlay.

## Lint & type-check

```bash
npm run lint          # ESLint (strict TS-checked rules)
npm run build         # tsc -b && vite build
npx tsc --noEmit      # Type-check only
```

ESLint enforces `recommendedTypeChecked` and `stylisticTypeChecked` — avoid `any`, unnecessary type assertions, and ensure all promises are handled.

## Dev server

```bash
npm run dev           # Starts Vite at localhost:5173
```

The built-in `gateway-proxy` Vite plugin forwards `/gateway-proxy/*` to the APIM gateway URL specified by the `X-Gateway-Base` request header. No external CORS config needed for local dev.

## Common pitfalls

- **Promise-returning onClick**: Wrap `navigate()` or async calls in `void` — e.g. `onClick={() => { void navigate('/path'); }}`.
- **Unused imports**: ESLint will flag them as errors, not warnings.
- **`unknown` in JSX**: Values typed `unknown` can't be rendered as ReactNode. Use `!= null` guards or cast via `as Record<string, unknown>` before interpolation.
- **JSON.parse**: Returns `any` — always cast the result (e.g. `as Record<string, unknown>` or `as unknown`).
- **Optional chaining**: ESLint prefers `obj?.prop` over `obj && obj.prop`.
