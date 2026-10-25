import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

// Fake gateway MCP endpoint, stateless like the real one, with one tool: records every request and tool call,
// and answers each call with what the test last set.
export async function fakeMcpGateway() {
  const requests: { url?: string; authorization?: string; method?: string }[] = [];
  const calls: unknown[] = [];
  let reply: CallToolResult = { content: [{ type: "text", text: "{}" }] };
  const server = createServer(async (req, res) => {
    // As the gateway: no stream for the client to open.
    if (req.method !== "POST") return void res.writeHead(405).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, authorization: req.headers.authorization, method: body.method });
    const mcp = new McpServer({ name: "fake-gateway", version: "0" });
    mcp.registerTool(
      "list_pods",
      {
        description: "List the pods in a namespace.",
        inputSchema: z.strictObject({ namespace: z.string(), labelSelector: z.string().optional() }),
      },
      async (args) => {
        calls.push(args);
        return reply;
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => mcp.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    calls,
    answer(result: CallToolResult) {
      reply = result;
    },
    // closeAllConnections: the client's keep-alive sockets would hold close() open.
    close: () => new Promise<void>((resolve) => server.close(() => resolve()).closeAllConnections()),
  };
}

export type GatewayRequest = { method?: string; url?: string; contentType?: string; body?: unknown };

// Fake gateway ops endpoint: records every request and answers with what the test last set.
export async function fakeGateway() {
  const requests: GatewayRequest[] = [];
  const reply = { status: 200, body: JSON.stringify({ ok: true, data: null }) };
  let held: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, contentType: req.headers["content-type"], body: JSON.parse(raw) });
    await held;
    res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    answer(status: number, body: unknown) {
      reply.status = status;
      reply.body = typeof body === "string" ? body : JSON.stringify(body);
    },
    // Holds every reply until the returned function is called, so a test can look at a run mid-flight.
    hold() {
      let release!: () => void;
      held = new Promise((resolve) => (release = resolve));
      return () => {
        held = undefined;
        release();
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
