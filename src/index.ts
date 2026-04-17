import { Agent, getAgentByName } from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { FiberRecoveryContext } from "agents";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";

export { Sandbox } from "@cloudflare/sandbox";

// --- Constants ---

// Each runner gets a different "style" system prompt so the LLM produces
// genuinely different Python for the same task. Three parallel approaches,
// one winning runtime.
const RUNNERS = [
  {
    id: "runner-a",
    style: "minimal",
    systemPrompt:
      "You write the shortest correct Python possible. Single function. Standard library only. No comments, no type hints.",
  },
  {
    id: "runner-b",
    style: "idiomatic",
    systemPrompt:
      "You write clean, idiomatic Python. Use generators, comprehensions, and stdlib tools (itertools, functools, collections) where appropriate.",
  },
  {
    id: "runner-c",
    style: "algorithmic",
    systemPrompt:
      "You write Python that optimizes for speed. Prefer lower time complexity over readability. Use efficient data structures.",
  },
] as const;

type Runner = (typeof RUNNERS)[number];
type RunnerId = Runner["id"];

const MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
const MAX_TASK_LENGTH = 500;

// --- Types ---

interface Env {
  Orchestrator: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  AI: Ai;
  API_SECRET: string;
}

interface ExperimentResult {
  runner: RunnerId;
  style: string;
  script: string;      // the Python the LLM generated
  stdout: string;
  stderr: string;
  duration_ms: number; // wall-clock runtime inside the sandbox
  status: "done" | "error";
}

interface SweepSnapshot {
  task: string;
  completed: ExperimentResult[];
  pending: RunnerId[];
  status: "running" | "done" | "error";
}

// --- LLM code generation ---

const BASE_SYSTEM = `You are a Python code generator. Given a task, you output ONLY runnable Python code — no markdown fences, no prose, no explanation. The code must:
- be a complete, self-contained program
- use only the Python standard library
- print meaningful results to stdout (runtime, final value, summary)
- time itself and print "runtime_ms: <number>" on the last line
- finish in under 30 seconds`;

async function generatePython(ai: Ai, task: string, runner: Runner): Promise<string> {
  const systemPrompt = `${BASE_SYSTEM}\n\nStyle: ${runner.systemPrompt}`;
  const response = (await ai.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: task },
    ],
    max_tokens: 1024,
  })) as { response?: string };

  let code = (response.response ?? "").trim();
  // Strip markdown fences if the model added them despite instructions.
  code = code.replace(/^```(?:python)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  return code.trim();
}

// --- Experiment Runner (sub-agent) ---

export class ExperimentRunner extends Agent<Env> {
  async runExperiment(runnerId: RunnerId, task: string): Promise<ExperimentResult> {
    const runner = RUNNERS.find((r) => r.id === runnerId);
    if (!runner) return errorResult(runnerId, "unknown", "", "unknown runner");

    let script = "";
    try {
      script = await generatePython(this.env.AI, task, runner);
    } catch (e) {
      return errorResult(runnerId, runner.style, "", `codegen failed: ${errString(e)}`);
    }
    if (!script) return errorResult(runnerId, runner.style, "", "LLM returned empty code");

    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${runnerId}`);
    await sandbox.writeFile("/workspace/experiment.py", script);

    const startedAt = Date.now();
    const result = await sandbox.exec("python3 /workspace/experiment.py", { timeout: 60_000 });
    const duration_ms = Date.now() - startedAt;

    if (!result.success) {
      return {
        runner: runnerId,
        style: runner.style,
        script,
        stdout: result.stdout?.trim() ?? "",
        stderr: (result.stderr || "execution failed").slice(0, 2000),
        duration_ms,
        status: "error",
      };
    }

    return {
      runner: runnerId,
      style: runner.style,
      script,
      stdout: result.stdout.trim().slice(0, 4000),
      stderr: "",
      duration_ms,
      status: "done",
    };
  }
}

function errorResult(runner: RunnerId, style: string, script: string, err: string): ExperimentResult {
  return { runner, style, script, stdout: "", stderr: err, duration_ms: 0, status: "error" };
}

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- Orchestrator ---

export class Orchestrator extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
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
    if (!body.task) return Response.json({ error: "missing task" }, { status: 400 });

    const results = await this.runSweep(body.task);
    return Response.json({ sweepId: this.name, task: body.task, results });
  }

  async runSweep(task: string): Promise<ExperimentResult[]> {
    const runnerIds: RunnerId[] = RUNNERS.map((r) => r.id);

    return this.runFiber("sweep", async (ctx) => {
      this.persistSnapshot({ task, completed: [], pending: runnerIds, status: "running" });
      ctx.stash({ task, completed: [], pending: runnerIds, status: "running" } satisfies SweepSnapshot);

      const results = await Promise.all(
        runnerIds.map(async (id) => {
          const stub = await this.subAgent(ExperimentRunner, id);
          return stub.runExperiment(id, task);
        }),
      );

      const finalSnapshot: SweepSnapshot = { task, completed: results, pending: [], status: "done" };
      this.persistSnapshot(finalSnapshot);
      ctx.stash(finalSnapshot);
      return results;
    });
  }

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

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "sweep") return;
    const snapshot = ctx.snapshot as SweepSnapshot | null;
    if (!snapshot || snapshot.pending.length === 0 || snapshot.status !== "running") return;

    void this.runFiber("sweep", async (fiberCtx) => {
      const results = [...snapshot.completed];
      const remaining = await Promise.all(
        snapshot.pending.map(async (id) => {
          const stub = await this.subAgent(ExperimentRunner, id);
          return stub.runExperiment(id, snapshot.task);
        }),
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

// --- Worker entry point (Hono) ---

const app = new Hono<{ Bindings: Env }>();

// Fail closed before auth: if API_SECRET isn't set, refuse every request.
app.use("*", async (c, next) => {
  if (!c.env.API_SECRET) {
    return c.json(
      { error: "server not configured", fix: "set API_SECRET via `wrangler secret put API_SECRET`" },
      503,
    );
  }
  return next();
});

// Bearer auth on everything.
app.use("*", (c, next) => bearerAuth({ token: c.env.API_SECRET })(c, next));

app.get("/", (c) =>
  c.json({
    name: "prism",
    description:
      "Parallel Python execution on Cloudflare. The orchestrator generates different Python approaches via Workers AI and runs each in its own sandbox.",
    usage: {
      start: 'POST / with { "task": "<description in English>" }',
      poll: "GET /sweeps/<sweepId>",
    },
    runners: RUNNERS.map((r) => ({ id: r.id, style: r.style })),
  }),
);

app.post("/", async (c) => {
  let body: { task?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }

  if (typeof body.task !== "string" || body.task.length === 0) {
    throw new HTTPException(400, { message: "missing 'task' in request body" });
  }
  if (body.task.length > MAX_TASK_LENGTH) {
    throw new HTTPException(400, {
      message: `task must be under ${MAX_TASK_LENGTH} characters`,
    });
  }

  const task = body.task.replace(/[\x00-\x1f\x7f]/g, "");
  const sweepId = crypto.randomUUID();
  const stub = await getAgentByName(c.env.Orchestrator, sweepId);

  return stub.fetch(
    new Request(new URL(c.req.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
    }),
  );
});

app.get("/sweeps/:id{[0-9a-f-]{36}}", async (c) => {
  const id = c.req.param("id");
  const stub = await getAgentByName(c.env.Orchestrator, id);
  return stub.fetch(new Request(new URL(c.req.url).toString(), { method: "GET" }));
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  return c.json({ error: errString(err) }, 500);
});

export default app;
