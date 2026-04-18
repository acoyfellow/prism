import { Agent, getAgentByName } from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { FiberRecoveryContext } from "agents";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";

export { Sandbox } from "@cloudflare/sandbox";

// --- Constants ---

// Deliberately curated: each language here has to meet TWO bars:
//   (a) the LLM writes it reliably (qwen2.5-coder-32b is strong on mainstream)
//   (b) the runtime is small enough to bake into the sandbox image
//
// NOT included (intentionally):
//   - Rust / Java / Scala / Kotlin — need compile step, huge toolchain
//   - Swift / C# — licensing, installer friction
//   - Zig / Nim / Crystal / Dart / Julia — not in Debian apt; would need
//     manual tarball downloads, and LLM output quality is weaker
//   - Haskell / OCaml / Erlang / Elixir — runtime footprint + LLM weaker
const LANGUAGES = {
  python:     { ext: "py", command: "python3", displayName: "Python" },
  javascript: { ext: "js", command: "node",    displayName: "JavaScript" },
  bun:        { ext: "ts", command: "bun run", displayName: "Bun (TypeScript)" },
  bash:       { ext: "sh", command: "bash",    displayName: "Bash" },
  ruby:       { ext: "rb", command: "ruby",    displayName: "Ruby" },
  perl:       { ext: "pl", command: "perl",    displayName: "Perl" },
  php:        { ext: "php", command: "php",    displayName: "PHP" },
  go:         { ext: "go", command: "go run",  displayName: "Go" },
  lua:        { ext: "lua", command: "lua5.4", displayName: "Lua" },
} as const;

type Language = keyof typeof LANGUAGES;

const SUPPORTED_LANGUAGES: Language[] = [
  "python", "javascript", "bun", "bash", "ruby", "perl", "php", "go", "lua",
];
const DEFAULT_LANGUAGE: Language = "python";

// Each runner picks a style from this list (cycled if more runners than styles).
// Styles are language-neutral — they describe coding approach, not syntax.
const STYLES = [
  { name: "minimal", prompt: "Write the shortest correct solution possible. Single function. No comments, no extras." },
  { name: "idiomatic", prompt: "Write clean, idiomatic code. Use the language's preferred constructs and standard library." },
  { name: "algorithmic", prompt: "Optimize for speed. Prefer lower time complexity over readability. Use efficient data structures." },
  { name: "functional", prompt: "Use a functional style. Prefer immutability, map/filter/reduce, and higher-order functions where the language supports them." },
  { name: "verbose", prompt: "Write thoroughly commented, defensively coded solutions. Include input validation and error handling." },
  { name: "one-liner", prompt: "If possible, express the solution as a single expression or line. Prioritize density over readability." },
  { name: "recursive", prompt: "Solve this using recursion where reasonable. Avoid iterative loops when a recursive approach works." },
  { name: "object-oriented", prompt: "Model the problem with at least one class or struct. Use encapsulation and clear method boundaries." },
  { name: "brute-force", prompt: "Use the simplest, most direct approach — even if it's not optimal. Readability over cleverness." },
  { name: "clever", prompt: "Use a clever trick or non-obvious insight. Show off." },
] as const;

const MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
const MAX_TASK_LENGTH = 500;
const MIN_RUNNERS = 1;
const MAX_RUNNERS = 10;
const DEFAULT_RUNNERS = 3;

// --- Types ---

interface Env {
  Orchestrator: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  AI: Ai;
  API_SECRET: string;
}

interface RunnerSpec {
  id: string;      // runner-1, runner-2, ...
  style: string;   // one of STYLES[i].name
}

interface ExperimentResult {
  runner: string;
  style: string;
  language: Language;
  script: string;
  stdout: string;
  stderr: string;
  duration_ms: number;
  status: "done" | "error";
}

interface SweepSnapshot {
  task: string;
  language: Language;
  runners: RunnerSpec[];
  completed: ExperimentResult[];
  pending: string[]; // runner ids still to run
  status: "running" | "done" | "error";
}

// --- Helpers ---

function buildRunners(count: number): RunnerSpec[] {
  const out: RunnerSpec[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `runner-${i + 1}`,
      style: STYLES[i % STYLES.length].name,
    });
  }
  return out;
}

function stylePrompt(name: string): string {
  return STYLES.find((s) => s.name === name)?.prompt ?? STYLES[0].prompt;
}

// --- LLM code generation ---

function systemPrompt(language: Language, styleName: string): string {
  const lang = LANGUAGES[language];
  return `You are a ${lang.displayName} code generator. Given a task, you output ONLY runnable ${lang.displayName} code — no markdown fences, no prose, no explanation. The code must:
- be a complete, self-contained program in ${lang.displayName}
- use only the standard library / built-ins
- print meaningful results to stdout (result value, summary)
- time itself and print "runtime_ms: <number>" on the last line
- finish in under 30 seconds

Style: ${stylePrompt(styleName)}`;
}

async function generateCode(
  ai: Ai,
  task: string,
  language: Language,
  styleName: string,
): Promise<string> {
  const response = (await ai.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt(language, styleName) },
      { role: "user", content: task },
    ],
    max_tokens: 1024,
  })) as { response?: string };

  let code = (response.response ?? "").trim();
  // Strip markdown fences if the model added them despite instructions.
  code = code.replace(/^```(?:\w+)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  return code.trim();
}

// --- Experiment Runner (sub-agent) ---

export class ExperimentRunner extends Agent<Env> {
  async runExperiment(
    runnerId: string,
    styleName: string,
    task: string,
    language: Language,
  ): Promise<ExperimentResult> {
    const lang = LANGUAGES[language];

    let script = "";
    try {
      script = await generateCode(this.env.AI, task, language, styleName);
    } catch (e) {
      return err(runnerId, styleName, language, "", `codegen failed: ${errString(e)}`);
    }
    if (!script) return err(runnerId, styleName, language, "", "LLM returned empty code");

    // Sandbox ID includes a version tag so bumping SANDBOX_VERSION forces
    // every runner to spin up a fresh container — picking up a newly-built
    // image with new language runtimes. Without this, sandboxes persist
    // their filesystem across deploys and won't have newly-installed apt
    // packages.
    const SANDBOX_VERSION = "v2";
    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${SANDBOX_VERSION}-${runnerId}`);
    const filename = `/workspace/experiment.${lang.ext}`;
    await sandbox.writeFile(filename, script);

    const startedAt = Date.now();
    const result = await sandbox.exec(`${lang.command} ${filename}`, { timeout: 60_000 });
    const duration_ms = Date.now() - startedAt;

    if (!result.success) {
      return {
        runner: runnerId,
        style: styleName,
        language,
        script,
        stdout: result.stdout?.trim() ?? "",
        stderr: (result.stderr || "execution failed").slice(0, 2000),
        duration_ms,
        status: "error",
      };
    }

    return {
      runner: runnerId,
      style: styleName,
      language,
      script,
      stdout: result.stdout.trim().slice(0, 4000),
      stderr: "",
      duration_ms,
      status: "done",
    };
  }
}

function err(
  runner: string,
  style: string,
  language: Language,
  script: string,
  error: string,
): ExperimentResult {
  return { runner, style, language, script, stdout: "", stderr: error, duration_ms: 0, status: "error" };
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

    const body = (await request.json()) as {
      task?: string;
      language?: Language;
      runners?: RunnerSpec[];
    };

    if (!body.task || !body.language || !body.runners) {
      return Response.json({ error: "missing task/language/runners" }, { status: 400 });
    }

    const results = await this.runSweep(body.task, body.language, body.runners);
    return Response.json({
      sweepId: this.name,
      task: body.task,
      language: body.language,
      results,
    });
  }

  async runSweep(
    task: string,
    language: Language,
    runners: RunnerSpec[],
  ): Promise<ExperimentResult[]> {
    return this.runFiber("sweep", async (ctx) => {
      const initial: SweepSnapshot = {
        task,
        language,
        runners,
        completed: [],
        pending: runners.map((r) => r.id),
        status: "running",
      };
      this.persistSnapshot(initial);
      ctx.stash(initial);

      const results = await Promise.all(
        runners.map(async (r) => {
          const stub = await this.subAgent(ExperimentRunner, r.id);
          return stub.runExperiment(r.id, r.style, task, language);
        }),
      );

      const final: SweepSnapshot = {
        task,
        language,
        runners,
        completed: results,
        pending: [],
        status: "done",
      };
      this.persistSnapshot(final);
      ctx.stash(final);
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
    const snap = ctx.snapshot as SweepSnapshot | null;
    if (!snap || snap.pending.length === 0 || snap.status !== "running") return;

    void this.runFiber("sweep", async (fiberCtx) => {
      const results = [...snap.completed];
      const pendingRunners = snap.runners.filter((r) => snap.pending.includes(r.id));
      const remaining = await Promise.all(
        pendingRunners.map(async (r) => {
          const stub = await this.subAgent(ExperimentRunner, r.id);
          return stub.runExperiment(r.id, r.style, snap.task, snap.language);
        }),
      );
      results.push(...remaining);
      const final: SweepSnapshot = { ...snap, completed: results, pending: [], status: "done" };
      this.persistSnapshot(final);
      fiberCtx.stash(final);
    });
  }
}

// --- Worker entry point (Hono) ---

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  if (!c.env.API_SECRET) {
    return c.json(
      { error: "server not configured", fix: "set API_SECRET via `wrangler secret put API_SECRET`" },
      503,
    );
  }
  return next();
});

app.use("*", (c, next) => bearerAuth({ token: c.env.API_SECRET })(c, next));

app.get("/", (c) =>
  c.json({
    name: "prism",
    description:
      "Parallel code execution on Cloudflare. The orchestrator generates different approaches via Workers AI in your chosen language, and runs each in its own sandbox.",
    usage: {
      start: 'POST / with { "task": "...", "language"?: "python"|"javascript"|"bash", "runners"?: 1-10 }',
      poll: "GET /sweeps/<sweepId>",
    },
    languages: SUPPORTED_LANGUAGES.map((l) => ({
      id: l,
      displayName: LANGUAGES[l].displayName,
      command: LANGUAGES[l].command,
    })),
    runners: { min: MIN_RUNNERS, max: MAX_RUNNERS, default: DEFAULT_RUNNERS },
    styles: STYLES.map((s) => s.name),
  }),
);

app.post("/", async (c) => {
  let body: { task?: unknown; language?: unknown; runners?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }

  // Validate task
  if (typeof body.task !== "string" || body.task.length === 0) {
    throw new HTTPException(400, { message: "missing 'task' in request body" });
  }
  if (body.task.length > MAX_TASK_LENGTH) {
    throw new HTTPException(400, {
      message: `task must be under ${MAX_TASK_LENGTH} characters`,
    });
  }
  const task = body.task.replace(/[\x00-\x1f\x7f]/g, "");

  // Validate language
  const language: Language =
    body.language == null ? DEFAULT_LANGUAGE : (body.language as Language);
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new HTTPException(400, {
      message: `unsupported language: ${String(body.language)}. supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
    });
  }

  // Validate runner count
  const runnerCount =
    body.runners == null
      ? DEFAULT_RUNNERS
      : typeof body.runners === "number"
      ? body.runners
      : NaN;
  if (!Number.isInteger(runnerCount) || runnerCount < MIN_RUNNERS || runnerCount > MAX_RUNNERS) {
    throw new HTTPException(400, {
      message: `runners must be an integer between ${MIN_RUNNERS} and ${MAX_RUNNERS}`,
    });
  }

  const runners = buildRunners(runnerCount);
  const sweepId = crypto.randomUUID();
  const stub = await getAgentByName(c.env.Orchestrator, sweepId);

  return stub.fetch(
    new Request(new URL(c.req.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, language, runners }),
    }),
  );
});

app.get("/sweeps/:id{[0-9a-f-]{36}}", async (c) => {
  const id = c.req.param("id");
  const stub = await getAgentByName(c.env.Orchestrator, id);
  return stub.fetch(new Request(new URL(c.req.url).toString(), { method: "GET" }));
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((e, c) => {
  if (e instanceof HTTPException) return e.getResponse();
  return c.json({ error: errString(e) }, 500);
});

export default app;
