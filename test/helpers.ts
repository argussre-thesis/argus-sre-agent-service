import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type GatewayRequest = { method?: string; url?: string; contentType?: string; body?: unknown };

// Fake gateway ops endpoint: records every request and answers with what the test last set.
export async function fakeGateway() {
  const requests: GatewayRequest[] = [];
  const reply = { status: 200, body: JSON.stringify({ ok: true, data: null }) };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, contentType: req.headers["content-type"], body: JSON.parse(raw) });
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
