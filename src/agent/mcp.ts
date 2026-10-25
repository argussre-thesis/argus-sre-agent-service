import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "langchain";
import pkg from "../../package.json" with { type: "json" };

export type OpsContext = { tenantId: string; cluster: string };

// The gateway gives up on the runner after ~12s; this only catches a hung gateway.
const TIMEOUT_MS = 30_000;
// ~50 pods. Every later model call resends a result, so a bigger one should be a narrower query.
const MAX_RESULT_CHARS = 20_000;

function capped(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  // Don't keep half of a surrogate pair (an emoji): jsonb rejects it.
  const end = /[\uD800-\uDBFF]/.test(text[MAX_RESULT_CHARS - 1]!) ? MAX_RESULT_CHARS - 1 : MAX_RESULT_CHARS;
  const [total, kept] = [text.length, end].map((n) => n.toLocaleString("en"));
  return `${text.slice(0, end)}\n[Cut: this result is ${total} characters, only the first ${kept} are shown. Narrow the query to see the rest.]`;
}

// fetch says only "fetch failed"; the reason (e.g. ECONNREFUSED) is in its cause.
function reason(err: unknown): string {
  const cause = (err as Error).cause as Error | undefined;
  return `${(err as Error).message}${cause?.message ? `: ${cause.message}` : ""}`;
}

// One MCP client on the gateway's endpoint for one tenant and cluster, and its tools as LangChain tools.
// The tools have no tenant or cluster argument: the URL decides, so the model can't leave the org.
export async function connectGateway(gatewayUrl: string, token: string, ctx: OpsContext) {
  const path = `/mcp/tenants/${encodeURIComponent(ctx.tenantId)}/clusters/${encodeURIComponent(ctx.cluster)}`;
  const client = new Client({ name: "argus-agent-service", version: pkg.version });
  const transport = new StreamableHTTPClientTransport(new URL(path, gatewayUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  let listed;
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    listed = await client.listTools(undefined, { timeout: TIMEOUT_MS });
  } catch (err) {
    await client.close();
    throw new Error(`cannot reach the gateway: ${reason(err)}`);
  }

  // Never throws: every outcome is text for the model.
  const call = async (name: string, args: Record<string, unknown>) => {
    try {
      const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS })) as CallToolResult;
      return capped(result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n"));
    } catch (err) {
      return `Error GATEWAY_ERROR: ${reason(err)}`;
    }
  };

  const tools = listed.tools.map((t) =>
    // LangChain has checked args against the schema, an object.
    tool((args) => call(t.name, args as Record<string, unknown>), {
      name: t.name,
      description: t.description ?? "",
      schema: t.inputSchema,
      extras: { strict: true },
      // Without it a bad arg is only "did not match expected schema", with nothing the model can fix.
      verboseParsingErrors: true,
    }),
  );
  return { tools, close: () => client.close() };
}
