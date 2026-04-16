/**
 * End-to-end test against the deployed Prism endpoint.
 *
 * No mocks — hits the real Worker, real Durable Objects, real Sandboxes.
 *
 * Run: PRISM_URL=https://your-worker.workers.dev PRISM_TOKEN=xxx npx tsx test/e2e.test.ts
 *
 * Exits 0 on success, 1 on failure.
 */

const URL_ = process.env.PRISM_URL;
const TOKEN = process.env.PRISM_TOKEN;

if (!URL_) {
  console.error("PRISM_URL env var required (e.g. https://prism.your-sub.workers.dev)");
  process.exit(1);
}

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  FAIL ${name}: ${msg}`);
    failures.push(`${name}: ${msg}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const authHeaders: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function main() {
  console.log(`testing ${URL_}\n`);

  await check("GET / returns landing JSON", async () => {
    const r = await fetch(URL_!, { headers: authHeaders });
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const body = (await r.json()) as { name?: string; usage?: unknown };
    assert(body.name === "prism", "missing name");
    assert(body.usage, "missing usage");
  });

  await check("POST / without body returns 400", async () => {
    const r = await fetch(URL_!, { method: "POST", headers: authHeaders });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  await check("POST / with bad JSON returns 400", async () => {
    const r = await fetch(URL_!, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: "not json",
    });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  await check("POST / with missing task returns 400", async () => {
    const r = await fetch(URL_!, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  await check("POST / with oversized task returns 400", async () => {
    const r = await fetch(URL_!, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "a".repeat(501) }),
    });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  await check("unauthenticated requests are rejected (if API_SECRET set)", async () => {
    if (!TOKEN) {
      console.log("    (skipped: no PRISM_TOKEN)");
      return;
    }
    const r = await fetch(URL_!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "test" }),
    });
    assert(r.status === 401 || r.status === 302, `expected 401/302, got ${r.status}`);
  });

  let sweepId: string | null = null;
  await check("POST / runs a full sweep and returns results", async () => {
    const r = await fetch(URL_!, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "e2e test sweep" }),
    });
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const body = (await r.json()) as { sweepId?: string; results?: unknown };
    assert(body.sweepId && typeof body.sweepId === "string", "missing sweepId");
    assert(Array.isArray(body.results), "results not an array");
    assert(body.results!.length === 3, `expected 3 results, got ${body.results!.length}`);
    sweepId = body.sweepId!;

    for (const result of body.results as Array<{ runner: string; status: string; output: string }>) {
      assert(typeof result.runner === "string", "runner missing");
      assert(result.status === "done" || result.status === "error", `bad status: ${result.status}`);
    }
  });

  await check("GET /sweeps/<id> returns the snapshot", async () => {
    if (!sweepId) throw new Error("no sweepId from previous test");
    const r = await fetch(`${URL_}/sweeps/${sweepId}`, { headers: authHeaders });
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const body = (await r.json()) as { status?: string; completed?: unknown[] };
    assert(body.status === "done", `expected status=done, got ${body.status}`);
    assert(Array.isArray(body.completed) && body.completed.length === 3, "expected 3 completed");
  });

  await check("GET /sweeps/<nonexistent> returns 404", async () => {
    const r = await fetch(`${URL_}/sweeps/00000000-0000-0000-0000-000000000000`, { headers: authHeaders });
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  console.log();
  if (failures.length) {
    console.error(`${failures.length} test(s) failed`);
    process.exit(1);
  }
  console.log("all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
