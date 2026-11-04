import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "langchain";
import pkg from "../../package.json" with { type: "json" };

const TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 20_000;

function capped(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const end = /[\uD800-\uDBFF]/.test(text[MAX_RESULT_CHARS - 1]!) ? MAX_RESULT_CHARS - 1 : MAX_RESULT_CHARS;
  const [total, kept] = [text.length, end].map((n) => n.toLocaleString("en"));
  return `${text.slice(0, end)}\n[Cut: this result is ${total} characters, only the first ${kept} are shown. Narrow the query to see the rest.]`;
}

// fetch says only "fetch failed"; the reason (e.g. ECONNREFUSED) is in its cause.
export function reason(err: unknown): string {
  const cause = (err as Error).cause as Error | undefined;
  return `${(err as Error).message}${cause?.message ? `: ${cause.message}` : ""}`;
}

// An MCP client on the gateway's endpoint for one tenant and cluster: the URL decides both.
async function open(gatewayUrl: string, token: string, tenantId: string, cluster: string): Promise<Client> {
  const path = `/mcp/tenants/${encodeURIComponent(tenantId)}/clusters/${encodeURIComponent(cluster)}`;
  const client = new Client({ name: "argus-agent-service", version: pkg.version });
  const transport = new StreamableHTTPClientTransport(new URL(path, gatewayUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
  } catch (err) {
    await client.close();
    throw err;
  }
  return client;
}

export async function connectGateway(gatewayUrl: string, token: string, tenantId: string, clusters: string[]) {
  const clients = new Map<string, Promise<Client>>();
  const client = (cluster: string) => {
    let connected = clients.get(cluster);
    if (!connected) {
      connected = open(gatewayUrl, token, tenantId, cluster);
      clients.set(cluster, connected);
      connected.catch(() => clients.delete(cluster));
    }
    return connected;
  };
  const close = async () => {
    await Promise.allSettled([...clients.values()].map(async (c) => (await c).close()));
  };

  let listed;
  try {
    // Get tools from one cluster only
    listed = await (await client(clusters[0]!)).listTools(undefined, { timeout: TIMEOUT_MS });
  } catch (err) {
    await close();
    throw new Error(`cannot reach the gateway: ${reason(err)}`);
  }
  // Check 
  const clash = listed.tools.find((t) => t.inputSchema.properties && "cluster" in t.inputSchema.properties);
  if (clash) {
    await close();
    throw new Error(`the gateway's ${clash.name} tool has a "cluster" argument of its own`);
  }

  // by default cluster[0], tool can override it. 
  const call = async (name: string, { cluster = clusters[0], ...args }: Record<string, unknown>) => {
    try {            //call tool    // connect to cluster
      const result = (await (await client(cluster as string)).callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS })) as CallToolResult;
      return capped(result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n"));
    } catch (err) {
      return `Error GATEWAY_ERROR: ${reason(err)}`;
    }
  };

  const tools = listed.tools.map((t) =>
    tool((args) => call(t.name, args as Record<string, unknown>), {
      name: t.name,
      description: t.description ?? "",
      schema:
        clusters.length === 1
          ? t.inputSchema
          : {
              ...t.inputSchema,
              properties: { cluster: { type: "string", enum: clusters }, ...t.inputSchema.properties },
              required: ["cluster", ...(t.inputSchema.required ?? [])],
            },
      extras: { strict: true },
      verboseParsingErrors: true,
    }),
  );
  return { tools, close };
}
