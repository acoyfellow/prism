# Prism

One task in, split into parallel beams, best result out.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jcoeyman/prism)

Prism is a parallel hyperparameter search agent running entirely on Cloudflare. One orchestrator fans out sub-agents that run experiments in sandboxed Linux containers. Everything checkpoints. Everything resumes on crash. No GPUs, no external services, no idle costs.

Built on [Think](https://developers.cloudflare.com/agents/api-reference/think/), [sub-agents](https://developers.cloudflare.com/agents/api-reference/sub-agents/), [durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/), and [Sandbox](https://developers.cloudflare.com/sandbox/).

---

## Tutorial

> *Learning-oriented. Follow these steps to get a running instance and see results.*

### 1. Clone and install

```sh
git clone https://github.com/jcoeyman/prism.git
cd prism
npm install
```

### 2. Deploy

```sh
npx wrangler deploy
```

Wrangler will print your worker URL. Copy it.

### 3. Run a sweep

```sh
curl -X POST https://prism.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"task": "best learning rate for a tiny ResNet on CIFAR-10"}'
```

You will get back a JSON response with results from three parallel experiment runners (PyTorch, JAX, TensorFlow) — each executed in its own isolated Sandbox container.

### 4. Observe durability

Kill the worker mid-sweep (redeploy, or wait for Durable Object eviction). Re-send the same request. The orchestrator recovers from its last `stash()` checkpoint and resumes where it left off. No work is lost.

---

## How-to guides

> *Task-oriented. Solve a specific problem.*

### Add a new experiment framework

Export a new `Agent` subclass from `src/index.ts` and spawn it from the orchestrator:

```ts
export class MyNewRunner extends Agent<Env> {
  async runExperiment(task: string, config: { framework: string }) {
    const sandbox = getSandbox(this.env.Sandbox, `runner-${config.framework}`);
    await sandbox.exec("pip install my-framework");
    // ... your experiment logic
  }
}
```

Then add it to the fan-out array in `Orchestrator.runSweep()`.

### Change the base container image

Edit the Sandbox configuration in `wrangler.toml` under `[containers]`. The default image includes Python 3.12. You can swap it for any image supported by [Cloudflare Containers](https://developers.cloudflare.com/containers/).

### Add R2 checkpointing for large artifacts

Bind an R2 bucket in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "R2"
bucket_name = "prism-artifacts"
```

Then use `sandbox.createBackup()` / `sandbox.restoreBackup()` to snapshot the full filesystem between runs. See the [Sandbox backup/restore docs](https://developers.cloudflare.com/sandbox/guides/backup-restore/).

### Run locally

```sh
npx wrangler dev
```

Fibers, SQLite state, and Sandbox containers all work in local dev. Kill the process and restart to test crash recovery.

---

## Reference

> *Information-oriented. Exact description of the machinery.*

### Architecture

```
                         POST /
                           |
                    +--------------+
                    | Orchestrator |  (Agent + runFiber + stash)
                    +--------------+
                     /      |      \
              subAgent  subAgent  subAgent
                /          |          \
  +----------+  +--------+  +------------+
  | PyTorch  |  |  JAX   |  | TensorFlow |
  | Runner   |  | Runner |  |   Runner   |
  +----------+  +--------+  +------------+
       |            |              |
   Sandbox      Sandbox        Sandbox
   (exec)       (exec)         (exec)
```

### Components

| Component | Cloudflare primitive | Role |
|---|---|---|
| `Orchestrator` | `Agent` + `runFiber()` | Receives task, fans out to sub-agents, checkpoints via `stash()`, aggregates results |
| `ExperimentRunner` | `Agent` (sub-agent facet) | Runs a single experiment in a Sandbox. Isolated SQLite per instance |
| Sandbox | `@cloudflare/sandbox` via `getSandbox()` | Persistent Linux container. Executes `pip install`, Python scripts, captures stdout |
| Durable execution | `runFiber()` + `stash()` + `onFiberRecovered()` | Survives DO eviction. Checkpoints to SQLite. Resumes on next activation |
| Sub-agent RPC | `this.subAgent(Class, "name")` | Zero-latency typed RPC. Child gets its own SQLite. Parent only needs a DO binding |

### API

**`POST /`** — Start a parameter sweep.

Request body:
```json
{ "task": "best learning rate for a tiny ResNet on CIFAR-10" }
```

Response:
```json
{
  "results": [
    { "framework": "pytorch",    "output": "...", "status": "done" },
    { "framework": "jax",        "output": "...", "status": "done" },
    { "framework": "tensorflow", "output": "...", "status": "done" }
  ]
}
```

### File structure

```
prism/
  src/index.ts      # Orchestrator + ExperimentRunner + fetch handler
  wrangler.toml     # Bindings: DO, Sandbox, containers
  Dockerfile        # Sandbox container image (Python 3)
  package.json      # 2 runtime dependencies
  tsconfig.json     # TypeScript config
  .gitignore
  README.md         # You are here
```

---

## Explanation

> *Understanding-oriented. Why this works and why it is built this way.*

### How the pieces fit together

The standard pattern for parallel agent work on Cloudflare is: one Agent orchestrates, sub-agents do isolated work, Sandboxes run untrusted code, and fibers make the whole thing crash-proof.

| Concern | Primitive | What it gives you |
|---|---|---|
| Orchestration | `Agent` class (Durable Object) | Single-threaded, globally addressable, survives restarts |
| Parallel workers | `this.subAgent(Class, name)` | Facets: co-located DOs with isolated SQLite, zero-copy RPC |
| Code execution | `getSandbox(env.Sandbox, id)` | Full Linux, `exec()`, file I/O, persistent across calls |
| Per-agent storage | Built-in `this.sql` | Every Agent and sub-agent gets its own SQLite database |
| Crash recovery | `runFiber()` + `stash()` | Writes to SQLite synchronously. `onFiberRecovered()` fires on restart |
| Large artifacts | `createBackup()` / `restoreBackup()` | R2-backed. Instant resume without re-running `pip install` |
| Idle cost | Active-CPU billing | $0 when nothing is running |

### Why sub-agents instead of separate Durable Objects

Sub-agents (facets) are co-located on the same machine as the parent. RPC between parent and child is an in-process function call, not a network hop. Each child still gets fully isolated SQLite — you cannot accidentally corrupt the parent's state. And you only need one DO binding in `wrangler.toml` for the parent; children are discovered via `ctx.exports`.

### Why runFiber instead of Workflows

Workflows are for multi-step pipelines with per-step retries that run independently of any agent. Fibers are for work that is *part of the agent's own execution* — the orchestrator's sweep loop, for example. If the DO is evicted mid-loop, `onFiberRecovered()` fires on the next activation with the last `stash()` snapshot, and you pick up where you left off. No external workflow engine, no extra bindings.

### Why Sandbox instead of Workers AI

Prism does not need a GPU. The experiments are CPU-only Python scripts that sweep learning rates on small models. Sandbox gives each sub-agent a full Linux environment where it can `pip install` arbitrary packages and run arbitrary code — exactly what a real hyperparameter search needs. For production ML training, you would add a Workers AI binding or call out to a GPU provider from inside the Sandbox.

### Cost

A sweep that takes 30 seconds of wall time across 3 Sandboxes costs fractions of a cent. When idle, every component (DO, Sandbox, sub-agents) hibernates. There is no baseline cost.
