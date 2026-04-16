import { Agent } from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { FiberRecoveryContext } from "agents";

export { Sandbox } from "@cloudflare/sandbox";

// --- Constants ---

const FRAMEWORKS = ["pytorch", "jax", "tensorflow"] as const;
type Framework = (typeof FRAMEWORKS)[number];

// All experiments use pure-Python simulation — no heavy framework installs.
// For real training, swap in actual pip packages and upgrade to a larger instance type.
const PACKAGES: Record<Framework, string | null> = {
  pytorch: null,
  jax: null,
  tensorflow: null,
};

const MAX_TASK_LENGTH = 500;

// --- Types ---

interface Env {
  Orchestrator: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  API_SECRET: string; // set via `wrangler secret put API_SECRET`
}

interface ExperimentConfig {
  framework: Framework;
  task: string;
}

interface ExperimentResult {
  framework: string;
  output: string;
  status: "done" | "error";
}

interface SweepSnapshot {
  task: string;
  completed: ExperimentResult[];
  pending: Framework[];
}

// --- Experiment Runner (sub-agent) ---

export class ExperimentRunner extends Agent<Env> {
  async runExperiment(config: ExperimentConfig): Promise<ExperimentResult> {
    const sandbox = getSandbox(this.env.Sandbox, `runner-${config.framework}`);

    if (!(config.framework in PACKAGES)) {
      return { framework: config.framework, output: "unsupported framework", status: "error" };
    }

    const pkg = PACKAGES[config.framework];
    if (pkg) {
      await sandbox.exec(`pip install ${pkg}`);
    }

    await sandbox.writeFile("/workspace/task.txt", config.task);
    await sandbox.writeFile("/workspace/experiment.py", experimentScript(config.framework));

    const result = await sandbox.exec("python3 /workspace/experiment.py", {
      timeout: 120_000,
    });

    if (!result.success) {
      return { framework: config.framework, output: result.stderr || "experiment failed", status: "error" };
    }

    return { framework: config.framework, output: result.stdout.trim(), status: "done" };
  }
}

// --- Orchestrator ---

export class Orchestrator extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("POST required", { status: 405 });
    }

    const body = (await request.json()) as { task?: string };
    if (!body.task) {
      return Response.json({ error: "missing task" }, { status: 400 });
    }

    const results = await this.runSweep(body.task);
    return Response.json({ results });
  }

  async runSweep(task: string): Promise<ExperimentResult[]> {
    const frameworks: Framework[] = [...FRAMEWORKS];

    return this.runFiber("sweep", async (ctx) => {
      ctx.stash({ task, completed: [], pending: frameworks } satisfies SweepSnapshot);

      const results = await Promise.all(
        frameworks.map(async (framework) => {
          const runner = await this.subAgent(ExperimentRunner, framework);
          return runner.runExperiment({ framework, task });
        })
      );

      ctx.stash({ task, completed: results, pending: [] } satisfies SweepSnapshot);
      return results;
    });
  }

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "sweep") return;

    const snapshot = ctx.snapshot as SweepSnapshot | null;
    if (!snapshot || snapshot.pending.length === 0) return;

    void this.runFiber("sweep", async (fiberCtx) => {
      const results = [...snapshot.completed];

      const remaining = await Promise.all(
        snapshot.pending.map(async (framework) => {
          const runner = await this.subAgent(ExperimentRunner, framework);
          return runner.runExperiment({ framework, task: snapshot.task });
        })
      );

      results.push(...remaining);
      fiberCtx.stash({ task: snapshot.task, completed: results, pending: [] });
    });
  }
}

// --- Worker entry point ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.API_SECRET) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.API_SECRET}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    if (request.method !== "POST") {
      return new Response("POST a JSON body with {\"task\": \"...\"}", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

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
      return Response.json({ error: `task must be under ${MAX_TASK_LENGTH} characters` }, { status: 400 });
    }

    const task = body.task.replace(/[\x00-\x1f\x7f]/g, "");

    const sweepId = crypto.randomUUID();
    const id = env.Orchestrator.idFromName(sweepId);
    const stub = env.Orchestrator.get(id);

    const nameUrl = new URL(request.url);
    nameUrl.pathname = "/cdn-cgi/partyserver/set-name/";
    await stub.fetch(new Request(nameUrl.toString(), {
      headers: { "x-partykit-room": sweepId },
    }));

    return stub.fetch(new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-partykit-room": sweepId },
      body: JSON.stringify({ task }),
    }));
  },
} satisfies ExportedHandler<Env>;

// --- Experiment scripts ---
// Task is read from /workspace/task.txt — never interpolated into code.

function experimentScript(framework: Framework): string {
  const scripts: Record<Framework, string> = {
    pytorch: `
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
    jax: `
import json, random

random.seed(42)
task = open("/workspace/task.txt").read()

best_lr, best_loss = None, float("inf")
for lr in [0.1, 0.01, 0.001, 0.0001]:
    loss = 2.3 * (1 - lr * 10) ** 20 + random.gauss(0, 0.01)
    if loss < best_loss:
        best_lr, best_loss = lr, loss

print(json.dumps({"task": task, "best_lr": best_lr, "best_loss": round(best_loss, 6)}))
`,
    tensorflow: `
import json, random

random.seed(42)
task = open("/workspace/task.txt").read()

best_lr, best_loss = None, float("inf")
for lr in [0.1, 0.01, 0.001, 0.0001]:
    loss = 2.3 * (1 - lr * 8) ** 15 + random.gauss(0, 0.02)
    if loss < best_loss:
        best_lr, best_loss = lr, loss

print(json.dumps({"task": task, "best_lr": best_lr, "best_loss": round(best_loss, 6)}))
`,
  };

  return scripts[framework];
}
