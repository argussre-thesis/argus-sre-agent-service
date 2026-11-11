import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "langchain";
import pkg from "../../package.json" with { type: "json" };
import { log } from "../log.ts";
import { publicFetch } from "./publicFetch.ts";

export type McpServer = { name: string; url: string } & ({ token: string } | { headers: Record<string, string> });

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

async function openClient(url: URL, headers: Record<string, string>, fetchFn?: FetchLike): Promise<Client> {
  const client = new Client({ name: "argus-agent-service", version: pkg.version });
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: fetchFn,
    requestInit: { headers },
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
  return openClient(new URL(path, gatewayUrl), { authorization: `Bearer ${token}` });
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
  const clash = listed.tools.find((t) => t.inputSchema.properties && "cluster" in t.inputSchema.properties);
  if (clash) {
    await close();
    throw new Error(`the gateway's ${clash.name} tool has a "cluster" argument of its own`);
  }

  // clusters[0] unless the model names a cluster.
  const call = async (name: string, { cluster = clusters[0], ...args }: Record<string, unknown>) => {
    try {
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

async function connectMcpServer(mcpServer: McpServer, fetchFn: FetchLike) {
  const { name: server, url } = mcpServer;
  const headers = "headers" in mcpServer ? mcpServer.headers : { authorization: `Bearer ${mcpServer.token}` };
  const client = await openClient(new URL(url), headers, fetchFn);
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

// Everything one run can use. Nothing fails the run: what can't be reached is listed in `failed`. With no clusters the gateway isn't contacted.
export async function connectTools(
  gatewayUrl: string,
  token: string,
  tenantId: string,
  clusters: string[],
  mcpServers: McpServer[],
  fetchFn: FetchLike = publicFetch,
) {
  const mcp = await connectMcpServers(mcpServers, fetchFn);
  let gateway: Awaited<ReturnType<typeof connectGateway>> = { tools: [], close: async () => {} };
  const gatewayFailed = [];
  if (clusters.length > 0) {
    try {
      gateway = await connectGateway(gatewayUrl, token, tenantId, clusters);
    } catch (err) {
      gatewayFailed.push({ name: "gateway", reason: reason(err).slice(0, MAX_REASON_CHARS) });
    }
  }

  const taken = new Set(gateway.tools.map((t) => t.name));
  const clashing = mcp.tools.filter((t) => taken.has(t.name));
  const failed = [
    ...gatewayFailed,
    ...mcp.failed,
    ...clashing.map((t) => ({ name: t.name.split("_")[0]!, reason: `its tool ${t.name} has the same name as a built-in tool` })),
  ];
  if (failed.length > 0) log("warn", "some MCP servers or tools can't be used", { tenantId, failed });

  return {
    tools: [...gateway.tools, ...mcp.tools.filter((t) => !taken.has(t.name))],
    failed,
    close: async () => {
      await Promise.all([gateway.close(), mcp.close()]);
    },
  };
}
