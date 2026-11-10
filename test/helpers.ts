import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fakeModel } from "langchain";
import * as z from "zod";

// A level a test doesn't ask for: its model has no replies, so using it fails the run.
export const unused = (level: string) => ({ chatModel: fakeModel(), model: `fake:${level}`, effort: level, webSearch: fakeWebSearch });
export const fakeWebSearch = { type: "web_search" };

// Fake gateway MCP endpoint, stateless like the real one, with one tool: records every request and tool call,
// and answers each call with what the test last set.
export async function fakeMcpGateway(inputSchema: z.ZodObject = z.strictObject({ namespace: z.string(), labelSelector: z.string().optional() })) {
  const requests: { url?: string; authorization?: string; apiKey?: string | string[]; method?: string }[] = [];
  const calls: unknown[] = [];
  let reply: CallToolResult = { content: [{ type: "text", text: "{}" }] };
  let held: Promise<void> | undefined;
  let failing = 0;
  const server = createServer(async (req, res) => {
    // As the gateway: no stream for the client to open.
    if (req.method !== "POST") return void res.writeHead(405).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, authorization: req.headers.authorization, apiKey: req.headers["api-key"], method: body.method });
    if (failing > 0 && failing--) return void res.writeHead(503).end("down");
    await held;
    const mcp = new McpServer({ name: "fake-gateway", version: "0" });
    mcp.registerTool(
      "list_pods",
      {
        description: "List the pods in a namespace.",
        inputSchema,
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
    // The next `n` requests get a 503.
    fail(n: number) {
      failing = n;
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
    // closeAllConnections: the client's keep-alive sockets would hold close() open.
    close: () => new Promise<void>((resolve) => server.close(() => resolve()).closeAllConnections()),
  };
}
