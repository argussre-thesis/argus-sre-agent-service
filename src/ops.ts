export type OpsContext = { tenantId: string; cluster: string };

type OpResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

// The gateway gives up after ~12s; this only catches a hung gateway.
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

// Runs one op on the context's cluster through the gateway. Never throws: every outcome is text for the model.
export async function callOp(opsUrl: string, ctx: OpsContext, op: string, args: object): Promise<string> {
  const path = `/internal/tenants/${encodeURIComponent(ctx.tenantId)}/clusters/${encodeURIComponent(ctx.cluster)}/ops`;
  try {
    const res = await fetch(new URL(path, opsUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const result = (await res.json()) as OpResult | null;
    if (result?.ok === true) return capped(JSON.stringify(result.data ?? null));
    if (result?.ok === false && result.error) return `Error ${result.error.code}: ${result.error.message}`;
    throw new Error(`unexpected gateway response (HTTP ${res.status})`);
  } catch (err) {
    // fetch says only "fetch failed"; the reason (e.g. ECONNREFUSED) is in its cause.
    const cause = (err as Error).cause as Error | undefined;
    return `Error GATEWAY_ERROR: ${(err as Error).message}${cause?.message ? `: ${cause.message}` : ""}`;
  }
}
