# Argus SRE: Agent service

This is the AI part of **Argus SRE**, a platform that investigates Kubernetes incidents automatically. When an alert fires, an AI agent gathers telemetry from the cluster and writes a root cause analysis that engineers can then discuss in a chat.

This service runs that agent. The backend asks it to investigate an incident. The agent then calls tools (cluster reads through the gateway, plus any MCP servers the organization added, such as Grafana), writes an RCA report, and answers follow-up questions about it.

## Where it fits

```
Backend ──start investigation / chat──▶ Agent service ──MCP──▶ Gateway ──▶ Runner (in cluster)
   ▲                                       │    │
   └──────────investigation ended──────────┘    └──MCP──▶ Org's MCP servers (e.g. Grafana)
```

| Repo | Role |
| --- | --- |
| [argus-sre-frontend](https://github.com/argussre-thesis/argus-sre-frontend) | Web app |
| [argus-sre-backend](https://github.com/argussre-thesis/argus-sre-backend) | API, webhooks, database |
| **argus-sre-agent-service** | AI investigations and chat |
| [argus-sre-gateway](https://github.com/argussre-thesis/argus-sre-gateway) | Accepts runner connections |
| [argus-sre-runner](https://github.com/argussre-thesis/argus-sre-runner) | Runs inside the customer's cluster |

## How an investigation works

1. The backend posts an incident's alerts to `/api/v1/tenants/:tenantId/investigations`.
2. The agent connects its tools:
   - the incident's clusters, through the gateway (pods, logs, events, deployments, nodes)
   - the organization's own MCP servers
   A tool source that can't be reached is skipped and noted in the report; the run doesn't fail.
3. The agent runs a LangChain loop with a cap on model calls, then writes the report.
4. **Citation check:** every piece of evidence in the report must cite a tool call that actually ran. If one doesn't, the agent gets one chance to fix it, otherwise the run fails.
5. The report, the messages and the token usage are saved, and the backend is notified.

Follow-up questions go to `/api/v1/tenants/:tenantId/conversations/messages` and continue from the same investigation.

## Design notes

- **Model levels:** each request asks for `low`, `medium` or `high`, and each level maps to a model and an effort (Claude Haiku, Sonnet or Opus by default). OpenAI also works, set with `MODEL_PROVIDER`.
- **SSRF protection:** MCP servers that organizations add can only reach public addresses. The check runs on every connection after DNS resolution, so a hostname can't pass the check and then point at an internal IP.
- **Internal only:** every route requires the backend's service token. Nothing here is exposed to users directly.

## Tech stack

Node.js with native TypeScript, LangChain, Claude (or OpenAI), the MCP SDK, Express 5, Prisma 7 with PostgreSQL, Zod.

## Run locally

```bash
npm install
cp .env.example .env    # fill in the values
npm run setup-dev-db    # new local database only: applies migrations and generates the client
npm run dev
```

Tests: `npm test`. Type check: `npm run typecheck`.

The `dev/` scripts call the running service directly, without the backend. They need the gateway and a runner in a local cluster (minikube), and they use model tokens.
- `npm run investigate`: one investigation
- `npm run continue`: a follow-up question on it
- `npm run eval`: runs broken-workload scenarios (OOM, crash loop, bad image, failing readiness probe and so on) and prints each report next to its known root cause
