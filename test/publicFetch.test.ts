import assert from "node:assert/strict";
import dns from "node:dns";
import { once } from "node:events";
import { createServer, type AddressInfo, type LookupFunction } from "node:net";
import { test } from "node:test";
import { publicFetch, publicLookup, publicUrlProblem } from "../src/agent/publicFetch.ts";

test("a public https address or any hostname passes the URL check", () => {
  for (const url of [
    "https://8.8.8.8/mcp",
    "https://8.8.8.8:8443/mcp?team=a",
    "https://[2001:4860:4860::8888]/mcp",
    "https://[::ffff:8.8.8.8]/mcp",
    "https://mcp.example.com/mcp",
    // Hostnames are judged by what they resolve to, in publicLookup.
    "https://localhost/",
  ]) {
    assert.equal(publicUrlProblem(url), null, url);
  }
});

test("anything but plain https is refused", () => {
  for (const [url, problem] of [
    ["not a url", /not valid/],
    ["", /not valid/],
    ["http://8.8.8.8/mcp", /https/],
    ["ftp://8.8.8.8/mcp", /https/],
    ["https://user:secret@8.8.8.8/mcp", /username or password/],
    ["https://user@8.8.8.8/mcp", /username or password/],
  ] as const) {
    assert.match(publicUrlProblem(url) ?? "passed", problem, url);
  }
});

test("non-public IPs are refused, however they're written", () => {
  for (const url of [
    "https://0.0.0.0/",
    "https://10.0.0.1/",
    "https://100.64.0.1/",
    "https://127.0.0.1/",
    "https://169.254.169.254/opc/v2/instance/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://224.0.0.1/",
    "https://[::]/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://[ff02::1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://[::ffff:169.254.169.254]/",
    "https://[64:ff9b::a00:1]/",
    "https://[2002:a00:1::]/",
    "https://127.1/",
    "https://2130706433/",
    "https://0x7f.0.0.1/",
  ]) {
    assert.match(publicUrlProblem(url) ?? "passed", /not a public address/, url);
  }
});

// Calls publicLookup and gives back what it answered.
const lookup = (all: boolean) =>
  new Promise<Parameters<Parameters<LookupFunction>[2]>>((resolve) => {
    publicLookup("mcp.example.com", { all }, (...answer) => resolve(answer));
  });

test("a host passes only if every address it resolves to is public", async (t) => {
  const answer = (...addresses: string[]) => {
    t.mock.restoreAll();
    t.mock.method(dns, "lookup", (_host: string, _options: object, callback: (err: null, addresses: object[]) => void) =>
      callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))),
    );
  };

  answer("8.8.8.8", "2001:4860:4860::8888");
  assert.deepEqual(await lookup(true), [null, [{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }]]);
  assert.deepEqual(await lookup(false), [null, "8.8.8.8", 4]);

  for (const addresses of [["8.8.8.8", "10.0.0.1"], ["8.8.8.8", "::1"], ["::ffff:169.254.169.254"]]) {
    answer(...addresses);
    const [err] = await lookup(true);
    assert.match(err?.message ?? "passed", /mcp\.example\.com is not a public address/, addresses.join());
    // The private address is not repeated: this message can reach the model.
    assert.doesNotMatch(err!.message, /10\.0\.0\.1|::1|169\.254/);
  }
});

test("a host that doesn't resolve gives the DNS error", async (t) => {
  t.mock.method(dns, "lookup", (_host: string, _options: object, callback: (err: Error) => void) => callback(new Error("getaddrinfo ENOTFOUND")));
  const [err] = await lookup(true);
  assert.match(err?.message ?? "passed", /ENOTFOUND/);
});

test("publicFetch opens no connection to a non-public address", async (t) => {
  const server = createServer((socket) => socket.destroy()).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;
  let connections = 0;
  server.on("connection", () => connections++);

  await assert.rejects(publicFetch(`http://127.0.0.1:${port}/`), /must use https/);
  await assert.rejects(publicFetch(`https://127.0.0.1:${port}/`), /127\.0\.0\.1 is not a public address/);
  await assert.rejects(publicFetch(`https://[::ffff:7f00:1]:${port}/`), /not a public address/);
  await assert.rejects(publicFetch(`https://localhost:${port}/`), (err: Error) => {
    assert.match((err.cause as Error).message, /localhost is not a public address/);
    return true;
  });
  assert.equal(connections, 0);
});
