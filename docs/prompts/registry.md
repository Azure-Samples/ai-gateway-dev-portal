# Registry Page Prompt

> **Prompt file:** [`.github/prompts/registry.prompt.md`](../../.github/prompts/registry.prompt.md)

Build an API Registry page powered by Azure API Center that lets users browse, filter, and inspect all API assets registered in the API Center instance linked to their Azure API Management service.

## Prerequisites

Before running this prompt, ensure:

1. **Azure API Center** — You have an API Center resource in the same resource group as your APIM instance
2. **Resource link** — The API Center is linked to your APIM instance via an Azure resource link. The portal detects this automatically and stores the API Center name in `config.apiCenterName`
3. **RBAC** — The signed-in user has at least **Reader** on the API Center resource

If no API Center is linked, the page will show an empty state guiding the user to set one up.

## What the prompt builds

### Page location

- **Sidebar**: Appears after **Subscriptions** with a divider separator
- **Route**: `/registry`
- **Icon**: `BookOpen` from lucide-react

### Main table

| Column | Description |
|---|---|
| Title | Display name of the API |
| Type | API kind (REST, GraphQL, gRPC, SOAP, Webhook, WebSocket) with icon badge |
| Lifecycle | Stage badge — Design, Development, Testing, Preview, Production, Deprecated, Retired |
| Summary | Truncated description |

The table supports:
- **Search** by API name or title
- **Type filter** dropdown (All types, REST, GraphQL, gRPC, etc.)
- **Lifecycle filter** dropdown (All stages, Design, Development, Production, etc.)
- **Pagination** with page navigation controls

### Detail panel (click any row)

Opens a slide-over panel with three tabs:

**Overview tab** — Full metadata:
- Name, title, type, lifecycle stage
- Summary and description
- Contacts and license information
- External documentation links
- Custom properties (key-value display)

**Versions tab** — Table of API versions:
- Title, name, lifecycle stage

**Deployments tab** — Table of deployments:
- Title, state, runtime URIs

The panel header includes an **Azure Portal** link (azure.svg icon) that opens the API directly in the Azure portal.

## How to run it

### VS Code with GitHub Copilot

1. Open Copilot Chat and type:
   ```
   /create-registry-page
   ```
3. Copilot will read the prompt, analyze the codebase patterns from `AGENTS.md`, and generate all required files

### Other coding agents

Point the agent at the prompt file and the `AGENTS.md` in the repo root:

```
Read .github/prompts/registry.prompt.md and AGENTS.md, then implement the feature described in the prompt following the conventions in AGENTS.md.
```

### Manual approach

If you prefer to implement it yourself, the prompt expects these changes:

1. **Types** (`src/types.ts`) — Add interfaces for `ApiCenterApi`, `ApiCenterApiVersion`, and `ApiCenterDeployment`
2. **Service calls** (`src/services/azure.ts`) — Add functions to call the [API Center REST API](https://learn.microsoft.com/en-us/rest/api/resource-manager/apicenter/apis/get?view=rest-resource-manager-apicenter-2024-03-01):
   - `listApiCenterApis` — List APIs (paginated via `nextLink`)
   - `listApiCenterVersions` — List versions for an API
   - `listApiCenterDeployments` — List deployments for an API
3. **Page** (`src/pages/Registry.tsx`) — Create the page component following the toolbar → table → detail panel pattern
4. **Route** (`src/App.tsx`) — Add `<Route path="registry" element={<Registry />} />`
5. **Sidebar** (`src/components/Sidebar.tsx`) — Add entry after Subscriptions with a divider
6. **Styles** (`src/index.css`) — Add styles with the `reg-` prefix

## API reference

The page uses the Azure API Center REST API (`2024-03-01`):

| Operation | Endpoint |
|---|---|
| List APIs | `GET /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ApiCenter/services/{name}/workspaces/default/apis` |
| List versions | `GET .../apis/{apiName}/versions` |
| List deployments | `GET .../apis/{apiName}/deployments` |

All calls use the ARM bearer token already available via `credential.getToken('https://management.azure.com/.default')`.

## Verifying the result

After the agent completes:

```bash
npx tsc --noEmit     # Type-check
npm run lint         # ESLint
npm run dev          # Start dev server and navigate to /registry
```

The page should display a loading spinner, then either show the API list (if an API Center is linked) or the "No API Center linked" empty state.
