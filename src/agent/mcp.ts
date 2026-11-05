import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "langchain";
import pkg from "../../package.json" with { type: "json" };
import { publicFetch } from "./publicFetch.ts";

export type McpServer = { name: string; url: string; token: string };

const TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 20_000;
const MAX_REASON_CHARS = 300;
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

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

const resultText = (result: CallToolResult) => capped(result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n"));

async function openClient(url: URL, token: string, fetchFn?: FetchLike): Promise<Client> {
  const client = new Client({ name: "argus-agent-service", version: pkg.version });
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: fetchFn,
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

function open(gatewayUrl: string, token: string, tenantId: string, cluster: string): Promise<Client> {
  const path = `/mcp/tenants/${encodeURIComponent(tenantId)}/clusters/${encodeURIComponent(cluster)}`;
  return openClient(new URL(path, gatewayUrl), token);
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
      return resultText(result);
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

async function connectMcpServer({ name: server, url, token }: McpServer, fetchFn: FetchLike) {
  const client = await openClient(new URL(url), token, fetchFn);
  try {
    const { tools: listed, nextCursor } = await client.listTools(undefined, { timeout: TIMEOUT_MS });
    const seen = new Set<string>();
    const usable = listed.filter((t) => {
      const name = `${server}_${t.name}`;
      if (!VALID_TOOL_NAME.test(name) || seen.has(name)) return false;
      seen.add(name);
      return true;
    });

    const call = async (name: string, args: Record<string, unknown>) => {
      try {
        const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS })) as CallToolResult;
        return result.isError ? `Error MCP_TOOL_ERROR: ${resultText(result)}` : resultText(result);
      } catch (err) {
        return `Error MCP_SERVER_ERROR: ${reason(err)}`.slice(0, MAX_RESULT_CHARS);
      }
    };

    // Not strict: Anthropic allows few optional parameters across strict tools, and third-party schemas can have dozens.
    const tools = usable.map((t) =>
      tool((args) => call(t.name, args as Record<string, unknown>), {
        name: `${server}_${t.name}`,
        description: t.description ?? "",
        schema: t.inputSchema,
        verboseParsingErrors: true,
      }),
    );

    const problems = [
      ...(usable.length < listed.length ? [`${listed.length - usable.length} of its tools have names that can't be used`] : []),
      ...(nextCursor ? ["it has more tools than were read"] : []),
    ];
    return { client, tools, problems };
  } catch (err) {
    await client.close();
    throw err;
  }
}

// A server that fails is left out and listed in `failed`, so it never fails the run.
export async function connectMcpServers(servers: McpServer[], fetchFn: FetchLike = publicFetch) {
  const connected = await Promise.allSettled(servers.map((server) => connectMcpServer(server, fetchFn)));
  const reached = connected.flatMap((c) => (c.status === "fulfilled" ? [c.value] : []));
  const failed = connected.flatMap((c, i) => {
    const name = servers[i]!.name;
    if (c.status === "rejected") return [{ name, reason: reason(c.reason).slice(0, MAX_REASON_CHARS) }];
    return c.value.problems.map((problem) => ({ name, reason: problem }));
  });
  return {
    tools: reached.flatMap((r) => r.tools),
    failed,
    close: async () => {
      await Promise.allSettled(reached.map((r) => r.client.close()));
    },
  };
}
