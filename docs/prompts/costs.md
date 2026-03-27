# Costs Page Prompt

> **Prompt file:** [`.github/prompts/costs.prompt.md`](../../.github/prompts/costs.prompt.md)

Build a Costs page with FinOps financial metrics, budget tracking charts, and spending breakdowns using Azure Monitor custom tables populated by the FinOps Framework lab.

## Prerequisites

Before running this prompt, ensure:

1. **FinOps Framework lab** — Complete the [FinOps Framework lab](https://github.com/Azure-Samples/AI-Gateway/tree/main/labs/finops-framework) to set up the Azure Monitor custom tables that store cost data
2. **Log Analytics workspace** — A Log Analytics workspace is linked to your APIM instance, and the custom FinOps tables are populated with cost data
3. **RBAC** — The signed-in user has at least **Log Analytics Reader** on the workspace

The page will display a notice at the top clarifying this dependency, so users understand the setup requirement.

## What the prompt builds

### Page location

- **Sidebar**: Final entry in the navigation menu
- **Route**: `/costs`
- **Icon**: Agent chooses an appropriate lucide-react icon

### Toolbar

Reuses the same shared analytics toolbar component (`AnalyticsToolbar`) used on the Tokens page, providing:

- Time range presets (30m to 30d) and custom date range
- Auto-refresh interval
- Granularity selection
- Model and subscription multi-select filters

### Page sections

The prompt instructs the agent to build well-defined sections with:

| Section | Description |
|---|---|
| Dependency notice | Banner explaining the FinOps Framework lab requirement with a link to the lab repo |
| Financial metrics | Key cost KPIs (total spend, cost per request, cost per token, etc.) |
| Budget tracking | Interactive charts showing budget vs. actual spending |
| Subscription breakdown | Cost breakdown by subscription |
| Model breakdown | Cost breakdown by model |

All data comes from the FinOps custom tables in the linked Log Analytics workspace.

### Data source

The page queries the linked Log Analytics workspace using the `query` endpoint with API version `2020-08-01`. Results are returned in **PascalCase** format (important for field name mapping). The KQL queries use the FinOps framework section from the [KQL skill](../../.github/skills/apim-kql/SKILL.md).

## How to run it

### VS Code with GitHub Copilot

1. Open Copilot Chat and type:
   ```
   /create-costs-page
   ```
3. Copilot will read the prompt and the codebase patterns from `AGENTS.md`, then generate all required files

### Other coding agents

Point the agent at the prompt file and the `AGENTS.md` in the repo root:

```
Read .github/prompts/costs.prompt.md and AGENTS.md, then implement the feature described in the prompt following the conventions in AGENTS.md.
```

### Manual approach

If you prefer to implement it yourself, the prompt expects these changes:

1. **Page** (`src/pages/Costs.tsx`) — Create the costs page component with:
   - A dependency notice banner at the top with a link to the FinOps Framework lab
   - Shared analytics toolbar (reuse `AnalyticsToolbar` from `src/components/AnalyticsToolbar.tsx`)
   - Financial metric KPI tiles
   - Interactive Recharts charts for budget tracking and cost breakdowns
2. **Service calls** (`src/services/azure.ts`) — Use the existing `queryLogAnalytics` function, or add helpers for the FinOps custom table queries
3. **Route** (`src/App.tsx`) — Add `<Route path="costs" element={<Costs />} />`
4. **Sidebar** (`src/components/Sidebar.tsx`) — Add as the final navigation entry
5. **Styles** (`src/index.css`) — Add styles with an appropriate prefix (e.g., `costs-`)

## Key integration points

### AnalyticsToolbar reuse

The Costs page reuses the `SharedFiltersProvider` and `AnalyticsToolbar` component from `src/components/AnalyticsToolbar.tsx`, which provides time range, granularity, and filter controls out of the box. See how the Tokens page (`src/pages/Tokens.tsx`) uses it for a reference implementation.

### Log Analytics queries

Queries go through the existing `queryLogAnalytics` function in `src/services/azure.ts`. The query endpoint uses API version `2020-08-01`, and results come back in PascalCase column names — the agent should handle this when mapping results to display values.

### KQL skill

The coding agent should reference the [KQL skill](../../.github/skills/apim-kql/SKILL.md) for FinOps-specific table schemas and query patterns. If your agent supports skills, it will pick this up automatically when generating KQL queries.

### Recharts

Charts should use the Recharts library (already a project dependency) following the same patterns as the analytics pages (Requests, Tokens, Performance, Availability).

## Verifying the result

After the agent completes:

```bash
npx tsc --noEmit     # Type-check
npm run lint         # ESLint
npm run dev          # Start dev server and navigate to /costs
```

The page should display the FinOps dependency notice, the analytics toolbar, and either cost data (if the FinOps custom tables are populated) or empty states.
