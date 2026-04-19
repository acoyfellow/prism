import { Agent, getAgentByName } from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
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
  python:     { ext: "py",  command: "python3", displayName: "Python" },
  javascript: { ext: "js",  command: "node",    displayName: "JavaScript" },
  bun:        { ext: "ts",  command: "bun run", displayName: "Bun (TypeScript)" },
  bash:       { ext: "sh",  command: "bash",    displayName: "Bash" },
  ruby:       { ext: "rb",  command: "ruby",    displayName: "Ruby" },
  perl:       { ext: "pl",  command: "perl",    displayName: "Perl" },
  php:        { ext: "php", command: "php",     displayName: "PHP" },
  go:         { ext: "go",  command: "go run",  displayName: "Go" },
  lua:        { ext: "lua", command: "lua5.4",  displayName: "Lua" },
} as const;

type Language = keyof typeof LANGUAGES;

const SUPPORTED_LANGUAGES: Language[] = [
  "python", "javascript", "bun", "bash", "ruby", "perl", "php", "go", "lua",
];
const DEFAULT_LANGUAGE: Language = "python";

// Each runner picks a style from this list (cycled if the client didn't
// pick one explicitly). Styles are language-neutral — they describe
// coding approach, not syntax.
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

const STYLE_NAMES: string[] = STYLES.map((s) => s.name);

const MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
const MAX_TASK_LENGTH = 500;
const MIN_RUNNERS = 1;
const MAX_RUNNERS = 10;
const DEFAULT_RUNNERS = 3;
const SANDBOX_VERSION = "v2";

// --- Types ---

interface Env {
  Orchestrator: DurableObjectNamespace<Orchestrator>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  AI: Ai;
  API_SECRET: string;
}

// Fully-resolved runner: id + style + language all concrete.
// The Orchestrator and ExperimentRunner always see this shape.
interface RunnerSpec {
  id: string;        // runner-1, runner-2, ...
  language: Language;
  style: string;     // one of STYLE_NAMES
}

// What clients can send for a single runner. Language is optional (falls
// back to top-level `language`). Style is optional (auto-cycled).
interface RunnerInput {
  language?: Language;
  style?: string;
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
  runners: RunnerSpec[];
  completed: ExperimentResult[];
}

// --- Helpers ---

/**
 * Resolve the `runners` input field from a POST body into concrete specs.
 * Accepts three shapes:
 *   (a) number          → N runners, each in `defaultLanguage`, styles cycled
 *   (b) RunnerInput[]   → one entry per runner, gaps filled with defaults
 *   (c) undefined       → DEFAULT_RUNNERS runners with defaults
 *
 * Throws HTTPException(400) if the input is malformed or out of bounds.
 */
function resolveRunners(
  raw: unknown,
  defaultLanguage: Language,
): RunnerSpec[] {
  // Shape (c): nothing provided → default count
  if (raw == null) {
    return buildRunnersFromCount(DEFAULT_RUNNERS, defaultLanguage);
  }

  // Shape (a): plain integer
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < MIN_RUNNERS || raw > MAX_RUNNERS) {
      throw new HTTPException(400, {
        message: `runners must be an integer between ${MIN_RUNNERS} and ${MAX_RUNNERS}`,
      });
    }
    return buildRunnersFromCount(raw, defaultLanguage);
  }

  // Shape (b): array of per-runner specs
  if (Array.isArray(raw)) {
    if (raw.length < MIN_RUNNERS || raw.length > MAX_RUNNERS) {
      throw new HTTPException(400, {
        message: `runners array must have ${MIN_RUNNERS}-${MAX_RUNNERS} entries`,
      });
    }
    return raw.map((entry, i) => resolveOneRunner(entry, i, defaultLanguage));
  }

  throw new HTTPException(400, {
    message: "runners must be an integer or an array of { language?, style? }",
  });
}

function buildRunnersFromCount(count: number, language: Language): RunnerSpec[] {
  const out: RunnerSpec[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `runner-${i + 1}`,
      language,
      style: STYLES[i % STYLES.length].name,
    });
  }
  return out;
}

function resolveOneRunner(
  raw: unknown,
  index: number,
  defaultLanguage: Language,
): RunnerSpec {
  if (raw == null || typeof raw !== "object") {
    throw new HTTPException(400, {
      message: `runners[${index}] must be an object`,
    });
  }
  const entry = raw as RunnerInput;

  const language: Language =
    entry.language == null ? defaultLanguage : (entry.language as Language);
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new HTTPException(400, {
      message: `runners[${index}].language "${String(entry.language)}" is not supported. supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
    });
  }

  const style =
    entry.style == null
      ? STYLES[index % STYLES.length].name
      : String(entry.style);
  if (!STYLE_NAMES.includes(style)) {
    throw new HTTPException(400, {
      message: `runners[${index}].style "${style}" is not supported. supported: ${STYLE_NAMES.join(", ")}`,
    });
  }

  return { id: `runner-${index + 1}`, language, style };
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

    // Sandbox ID includes the version tag + language so:
    //   - bumping SANDBOX_VERSION forces a fresh container on deploy (picks
    //     up newly-installed apt runtimes)
    //   - sandboxes are partitioned per-language so filesystem state from
    //     one language doesn't bleed into another
    const sandbox = getSandbox(
      this.env.Sandbox,
      `sandbox-${SANDBOX_VERSION}-${language}-${runnerId}`,
    );
    const filename = `/workspace/experiment.${lang.ext}`;
    const startedAt = Date.now();

    // Hard outer timeout. Cloudflare Durable Objects cap any single
    // subrequest at ~30s — if we let sandbox.exec hang past that, the
    // whole DO gets reset with "Internal error in Durable Object storage
    // caused object to be reset" and the client sees HTTP 500.
    //
    // We cap at 25s (with 5s headroom for JSON serialization and the
    // parent Promise.all overhead) and return a structured timeout result
    // so the sweep can still report partial successes from other runners.
    //
    // First-time sandbox cold starts can take 2-3 minutes to pull the
    // container image. Those requests will always time out; subsequent
    // requests to the same sandbox ID hit a warm container and finish
    // in hundreds of ms. See SANDBOX_VERSION comment above.
    const RUNNER_TIMEOUT_MS = 25_000;

    try {
      const result = await Promise.race([
        (async () => {
          await sandbox.writeFile(filename, script);
          return await sandbox.exec(`${lang.command} ${filename}`, { timeout: 60_000 });
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`runner timed out after ${RUNNER_TIMEOUT_MS}ms`)),
            RUNNER_TIMEOUT_MS,
          ),
        ),
      ]);
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
    } catch (e) {
      const duration_ms = Date.now() - startedAt;
      const msg = errString(e);
      return {
        runner: runnerId,
        style: styleName,
        language,
        script,
        stdout: "",
        stderr: msg.includes("timed out")
          ? `${msg} — sandbox may still be cold-starting; subsequent sweeps will be faster`
          : msg,
        duration_ms,
        status: "error",
      };
    }
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
    if (request.method !== "POST") {
      return new Response("POST required", { status: 405 });
    }

    const body = (await request.json()) as {
      task?: string;
      runners?: RunnerSpec[];
    };

    if (!body.task || !body.runners) {
      return Response.json({ error: "missing task/runners" }, { status: 400 });
    }

    const results = await this.runSweep(body.task, body.runners);
    return Response.json({
      sweepId: this.name,
      task: body.task,
      runners: body.runners,
      results,
    });
  }

  async runSweep(task: string, runners: RunnerSpec[]): Promise<ExperimentResult[]> {
    // runFiber wraps the sweep so the runtime has a clean checkpoint
    // boundary. We stash the initial + final snapshot for observability
    // during the fiber's life. Recovery is NOT handled here on purpose —
    // a separate repo (see `kindle` sketch / ironalarm) owns that story.
    return this.runFiber("sweep", async (ctx) => {
      ctx.stash({ task, runners, completed: [] } satisfies SweepSnapshot);

      const results = await Promise.all(
        runners.map(async (r) => {
          const stub = await this.subAgent(ExperimentRunner, r.id);
          return stub.runExperiment(r.id, r.style, task, r.language);
        }),
      );

      ctx.stash({ task, runners, completed: results } satisfies SweepSnapshot);
      return results;
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
      "Parallel code execution on Cloudflare. The orchestrator generates different approaches via Workers AI and runs each in its own sandbox. Each runner can pick its own language and style.",
    usage: {
      start: 'POST / with { "task": "...", "language"?: "<default>", "runners"?: N | [{ language?, style? }, ...] }',
    },
    examples: [
      { body: { task: "sum 1..100", runners: 3 }, note: "3 runners, default language, styles cycled" },
      { body: { task: "sum 1..100", language: "ruby", runners: 2 }, note: "2 runners, both Ruby" },
      {
        body: {
          task: "sum 1..100",
          runners: [
            { language: "python" },
            { language: "javascript" },
            { language: "bash", style: "minimal" },
          ],
        },
        note: "mixed languages per runner",
      },
    ],
    languages: SUPPORTED_LANGUAGES.map((l) => ({
      id: l,
      displayName: LANGUAGES[l].displayName,
      command: LANGUAGES[l].command,
    })),
    runners: { min: MIN_RUNNERS, max: MAX_RUNNERS, default: DEFAULT_RUNNERS },
    styles: STYLE_NAMES,
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

  // Validate top-level language (the default for runners that don't
  // specify their own)
  const language: Language =
    body.language == null ? DEFAULT_LANGUAGE : (body.language as Language);
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new HTTPException(400, {
      message: `unsupported language: ${String(body.language)}. supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
    });
  }

  // Resolve runners — accepts number | RunnerInput[] | undefined
  const runners = resolveRunners(body.runners, language);

  const sweepId = crypto.randomUUID();
  const stub = await getAgentByName(c.env.Orchestrator, sweepId);

  return stub.fetch(
    new Request(new URL(c.req.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, runners }),
    }),
  );
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((e, c) => {
  if (e instanceof HTTPException) return e.getResponse();
  return c.json({ error: errString(e) }, 500);
});

export default app;
