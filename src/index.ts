import { Agent, getAgentByName } from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { FiberRecoveryContext } from "agents";

export { Sandbox } from "@cloudflare/sandbox";

// --- Constants ---

const RUNNERS = ["runner-a", "runner-b", "runner-c"] as const;
type Runner = (typeof RUNNERS)[number];

const MAX_TASK_LENGTH = 500;

// --- Types ---

interface Env {
  Orchestrator: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  API_SECRET: string; // set via `wrangler secret put API_SECRET`
}

interface ExperimentResult {
  runner: string;
  output: string;
  status: "done" | "error";
}

interface SweepSnapshot {
  task: string;
  completed: ExperimentResult[];
  pending: Runner[];
  status: "running" | "done" | "error";
}

// --- Experiment Runner (sub-agent) ---

export class ExperimentRunner extends Agent<Env> {
  async runExperiment(runner: Runner, task: string): Promise<ExperimentResult> {
    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${runner}`);

    await sandbox.writeFile("/workspace/task.txt", task);
    await sandbox.writeFile("/workspace/experiment.py", experimentScript(runner));

    const result = await sandbox.exec("python3 /workspace/experiment.py", {
      timeout: 120_000,
    });

    if (!result.success) {
      return { runner, output: result.stderr || "experiment failed", status: "error" };
    }

    return { runner, output: result.stdout.trim(), status: "done" };
  }
}

// --- Orchestrator ---

export class Orchestrator extends Agent<Env> {
  // Routed via `routeAgentRequest` — the agents SDK sets `this.name` for us.
  async onRequest(request: Request): Promise<Response> {
    // GET /agents/orchestrator/<id> — return current snapshot (for polling/resumption)
    if (request.method === "GET") {
      const snapshot = await this.getSnapshot();
      return snapshot
        ? Response.json(snapshot)
        : Response.json({ error: "no sweep started" }, { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("POST required", { status: 405 });
    }

    const body = (await request.json()) as { task?: string };
    if (!body.task) {
      return Response.json({ error: "missing task" }, { status: 400 });
    }

    const results = await this.runSweep(body.task);
    return Response.json({ sweepId: this.name, results });
  }

  async runSweep(task: string): Promise<ExperimentResult[]> {
    const runners: Runner[] = [...RUNNERS];

    return this.runFiber("sweep", async (ctx) => {
      // Persist snapshot to our own table — survives fiber completion (runFiber deletes
      // its row from cf_agents_runs on exit, so we can't rely on that for polling).
      this.persistSnapshot({ task, completed: [], pending: runners, status: "running" });
      ctx.stash({ task, completed: [], pending: runners, status: "running" } satisfies SweepSnapshot);

      const results = await Promise.all(
        runners.map(async (runner) => {
          const stub = await this.subAgent(ExperimentRunner, runner);
          return stub.runExperiment(runner, task);
        })
      );

      const finalSnapshot: SweepSnapshot = { task, completed: results, pending: [], status: "done" };
      this.persistSnapshot(finalSnapshot);
      ctx.stash(finalSnapshot);
      return results;
    });
  }

  // Return the latest persisted snapshot (used by GET for polling/resume after DO restart)
  async getSnapshot(): Promise<SweepSnapshot | null> {
    this.ensureSnapshotTable();
    const rows = this.sql`SELECT data FROM prism_snapshot WHERE id = 1`;
    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].data as string) as SweepSnapshot;
    } catch {
      return null;
    }
  }

  private persistSnapshot(snapshot: SweepSnapshot): void {
    this.ensureSnapshotTable();
    const json = JSON.stringify(snapshot);
    this.sql`INSERT OR REPLACE INTO prism_snapshot (id, data) VALUES (1, ${json})`;
  }

  private ensureSnapshotTable(): void {
    this.sql`CREATE TABLE IF NOT EXISTS prism_snapshot (id INTEGER PRIMARY KEY, data TEXT NOT NULL)`;
  }

  // On DO eviction mid-sweep, resume pending experiments. Result is persisted so
  // GET /sweeps/<id> returns the updated snapshot even though the original HTTP
  // caller's request has already timed out.
  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "sweep") return;

    const snapshot = ctx.snapshot as SweepSnapshot | null;
    if (!snapshot || snapshot.pending.length === 0 || snapshot.status !== "running") return;

    void this.runFiber("sweep", async (fiberCtx) => {
      const results = [...snapshot.completed];

      const remaining = await Promise.all(
        snapshot.pending.map(async (runner) => {
          const stub = await this.subAgent(ExperimentRunner, runner);
          return stub.runExperiment(runner, snapshot.task);
        })
      );

      results.push(...remaining);
      const finalSnapshot: SweepSnapshot = {
        task: snapshot.task,
        completed: results,
        pending: [],
        status: "done",
      };
      this.persistSnapshot(finalSnapshot);
      fiberCtx.stash(finalSnapshot);
    });
  }
}

// --- Worker entry point ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Fail closed: if API_SECRET isn't configured, refuse every request.
    // Set it before first deploy:
    //   echo -n "$(openssl rand -base64 32)" | npx wrangler secret put API_SECRET
    if (!env.API_SECRET) {
      return Response.json(
        {
          error: "server not configured",
          fix: "set API_SECRET via `wrangler secret put API_SECRET`",
        },
        { status: 503 },
      );
    }

    // Auth check (bearer token). Runs before any routing.
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.API_SECRET}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // GET / → landing page
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        name: "prism",
        description: "Parallel experiment runner on Cloudflare agents + sandboxes",
        usage: {
          start: "POST / with { \"task\": \"<description>\" }",
          poll: "GET /sweeps/<sweepId>",
        },
      });
    }

    // GET /sweeps/<id> → poll an existing sweep
    const pollMatch = url.pathname.match(/^\/sweeps\/([0-9a-f-]{36})$/);
    if (pollMatch && request.method === "GET") {
      const stub = await getAgentByName(env.Orchestrator, pollMatch[1]);
      return stub.fetch(new Request(url.toString(), { method: "GET" }));
    }

    // POST / → start a new sweep
    if (url.pathname === "/" && request.method === "POST") {
      let body: { task?: unknown };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }

      if (typeof body.task !== "string" || body.task.length === 0) {
        return Response.json({ error: "missing 'task' in request body" }, { status: 400 });
      }
      if (body.task.length > MAX_TASK_LENGTH) {
        return Response.json(
          { error: `task must be under ${MAX_TASK_LENGTH} characters` },
          { status: 400 },
        );
      }

      const task = body.task.replace(/[\x00-\x1f\x7f]/g, "");
      const sweepId = crypto.randomUUID();
      const stub = await getAgentByName(env.Orchestrator, sweepId);

      return stub.fetch(new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      }));
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// --- Simulated experiment scripts ---
// These are pure-Python simulations, not real ML frameworks. The demo is about the
// pattern (parallel agents → sandboxes → aggregated results), not the training code.
// To run real training: increase Sandbox instance_type in wrangler.toml, add real
// pip installs, and swap these scripts for real model code.

function experimentScript(runner: Runner): string {
  const scripts: Record<Runner, string> = {
    "runner-a": `
import json, random, math

random.seed(42)
task = open("/workspace/task.txt").read()

best_lr, best_loss = None, float("inf")
for lr in [0.1, 0.01, 0.001, 0.0001]:
    loss = 2.3
    for step in range(200):
        grad = random.gauss(0, 1) * math.exp(-step * lr * 0.5)
        loss -= lr * grad
        loss = max(loss, 0.01)
    loss += random.gauss(0, 0.05)
    if loss < best_loss:
        best_lr, best_loss = lr, loss

print(json.dumps({"task": task, "best_lr": best_lr, "best_loss": round(best_loss, 6)}))
`,
    "runner-b": `
import json, random

random.seed(7)
task = open("/workspace/task.txt").read()

best_lr, best_loss = None, float("inf")
for lr in [0.1, 0.01, 0.001, 0.0001]:
    loss = 2.3 * (1 - lr * 10) ** 20 + random.gauss(0, 0.01)
    if loss < best_loss:
        best_lr, best_loss = lr, loss

print(json.dumps({"task": task, "best_lr": best_lr, "best_loss": round(best_loss, 6)}))
`,
    "runner-c": `
import json, random

random.seed(99)
task = open("/workspace/task.txt").read()

best_lr, best_loss = None, float("inf")
for lr in [0.1, 0.01, 0.001, 0.0001]:
    loss = 2.3 * (1 - lr * 8) ** 15 + random.gauss(0, 0.02)
    if loss < best_loss:
        best_lr, best_loss = lr, loss

print(json.dumps({"task": task, "best_lr": best_lr, "best_loss": round(best_loss, 6)}))
`,
  };

  return scripts[runner];
}
