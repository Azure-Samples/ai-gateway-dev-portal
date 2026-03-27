# Model Evals Page Prompt

> **Prompt file:** [`.github/prompts/evals.prompt.md`](../../.github/prompts/evals.prompt.md)

Build a Model Evals page that runs promptfoo-style model-graded evaluations against your inference APIs, using real log data as evaluation inputs.

## Prerequisites

Before running this prompt, ensure:

1. **Log Analytics workspace** — A Log Analytics workspace is linked to your APIM instance (the portal detects this via Azure Monitor diagnostic settings)
2. **Inference APIs** — At least one inference API is configured in your APIM instance for use as the evaluation endpoint
3. **Subscriptions** — At least one subscription with an API key to authenticate evaluation requests
4. **LLM logs** — The `ApiManagementGatewayLlmLog` table has data (inference requests must have been made through the gateway)

## What the prompt builds

### Page location

- **Sidebar**: Appears after the **Logs** page
- **Route**: `/evals`
- **Icon**: Agent chooses an appropriate lucide-react icon

### Data flow

The page reuses the Logs infrastructure:

1. **Sample selection** — Queries `ApiManagementGatewayLlmLog` to pull recent input prompts as evaluation candidates
2. **Configuration** — User selects an Inference API endpoint, a subscription for authentication, and the model to evaluate against
3. **Evaluation** — Sends each sample through the selected Inference API and applies model-graded metrics (relevance, coherence, etc.)
4. **Results** — Displays scores per sample with a summary view

### Configuration toolbar

| Control | Description |
|---|---|
| Inference API | Dropdown to select which API endpoint to evaluate against |
| Subscription | Dropdown to select which API key to use for authentication |
| Model | The model to use for evaluation |
| Metrics | Multi-select of model-graded metrics (relevance, coherence, fluency, etc.) |
| Start / Cancel | Controls to begin or abort an evaluation run |

### Results display

- Real-time progress indicator during evaluation
- Per-sample results table with scores for each selected metric
- Summary view with aggregate scores when evaluation completes

## How to run it

### VS Code with GitHub Copilot

1. Open Copilot Chat and type:
   ```
   /create-evals-page
   ```
3. Copilot will read the prompt and the codebase patterns from `AGENTS.md`, then generate all required files

### Other coding agents

Point the agent at the prompt file and the `AGENTS.md` in the repo root:

```
Read .github/prompts/evals.prompt.md and AGENTS.md, then implement the feature described in the prompt following the conventions in AGENTS.md.
```

### Manual approach

If you prefer to implement it yourself, the prompt expects these changes:

1. **Page** (`src/pages/Evals.tsx`) — Create the evaluation page component with:
   - A configuration toolbar that reuses patterns from the Logs/Analytics toolbar
   - A logs table (reusing the Logs page pattern) to show evaluation input samples
   - Evaluation runner logic that sends requests to the selected Inference API
   - Results display with per-metric scores
2. **Service calls** (`src/services/azure.ts`) — Add any needed functions for running evaluations through the APIM gateway
3. **Route** (`src/App.tsx`) — Add `<Route path="evals" element={<Evals />} />`
4. **Sidebar** (`src/components/Sidebar.tsx`) — Add entry after Logs
5. **Styles** (`src/index.css`) — Add styles with an appropriate prefix (e.g., `eval-`)

## Key integration points

### Reusing Logs data

The page should query `ApiManagementGatewayLlmLog` from the linked Log Analytics workspace using the same `queryLogAnalytics` function in `src/services/azure.ts`. The [KQL skill](./../skills/apim-kql/SKILL.md) provides table schemas and query patterns.

### Inference API calls

Evaluation requests go through the APIM gateway proxy (`/gateway-proxy/*`) to avoid CORS issues. The gateway URL comes from `config.apimService.gatewayUrl`, and authentication uses the selected subscription's API key.

### promptfoo model-graded metrics

The evaluation approach follows [promptfoo](https://github.com/promptfoo/promptfoo)'s model-graded evaluation pattern — using an LLM to grade the quality of another LLM's responses against defined criteria.

## Verifying the result

After the agent completes:

```bash
npx tsc --noEmit     # Type-check
npm run lint         # ESLint
npm run dev          # Start dev server and navigate to /evals
```

The page should display the configuration toolbar, load sample logs from the linked Log Analytics workspace, and allow running evaluations against a selected inference API.
