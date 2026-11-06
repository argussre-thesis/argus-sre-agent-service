import dns from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

// The same list as the backend's src/utils/publicUrl.ts. Keep them in step.
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

const isNonPublic = (address: string, family: number) => NON_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4");

// A bare IP is checked here because Node never calls `lookup` for one. Hostnames are checked by publicLookup.
export function publicUrlProblem(raw: string): string | null {
  if (!URL.canParse(raw)) return "the URL is not valid";
  const url = new URL(raw);
  if (url.protocol !== "https:") return "the URL must use https";
  if (url.username || url.password) return "the URL must not contain a username or password";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  return family && isNonPublic(host, family) ? `${host} is not a public address` : null;
}

// Runs on each new connection, on the addresses it will use, so a host can't pass an earlier check and then resolve elsewhere.
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    if (addresses.some(({ address, family }) => isNonPublic(address, family))) {
      return callback(new Error(`${hostname} is not a public address`), "", 0);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

const dispatcher = new Agent({ connect: { lookup: publicLookup } });

// For servers an org chose. Redirects stay manual: a redirect to a bare IP would skip `lookup`, and the SDK follows same-origin ones back through here.
export async function publicFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const problem = publicUrlProblem(String(url));
  if (problem) throw new Error(problem);
  const response = await undiciFetch(url, { ...init, redirect: "manual", dispatcher } as UndiciRequestInit);
  return response as unknown as Response;
}
