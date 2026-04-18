# Prism

One task in, split into parallel beams, aggregated results out.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jcoeyman/prism)

Prism is a parallel experiment runner on Cloudflare. One orchestrator fans out sub-agents that each generate and execute code — in Python, JavaScript, or Bash — inside isolated Linux containers. Every runner uses a different coding style (minimal, idiomatic, algorithmic, functional, and more). Every step checkpoints to SQLite. If the Durable Object is evicted mid-sweep, the work resumes on the next activation.

Built on [the Agent class](https://developers.cloudflare.com/agents/api-reference/think/), [sub-agents](https://developers.cloudflare.com/agents/api-reference/sub-agents/), [durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/), and [Sandbox](https://developers.cloudflare.com/sandbox/).

---

## Tutorial

> *Learning-oriented. Follow these steps to get a running instance and see results.*

### 1. Clone and install

```sh
git clone https://github.com/jcoeyman/prism.git
cd prism
npm install
```

### 2. Set the auth secret and deploy

```sh
# Set the API bearer token BEFORE deploying.
# Without this, the Worker returns 503 for every request — fail closed.
echo -n "$(openssl rand -base64 32)" | npx wrangler secret put API_SECRET

# Deploy
npx wrangler deploy
```

Save the secret — you'll need it on every request. For belt-and-suspenders, add Cloudflare Access on the route afterwards: Dashboard → Workers & Pages → prism → Settings → Domains & Routes → Enable Cloudflare Access.

### 3. Start a sweep

```sh
curl -X POST https://prism.<your-subdomain>.workers.dev \
  -H "Authorization: Bearer <your-secret>" \
  -H "Content-Type: application/json" \
  -d '{"task": "print the 1000th prime number"}'
```

`language` defaults to `python` and `runners` defaults to `3`. Pass them explicitly to override:

```sh
curl -X POST https://prism.<your-subdomain>.workers.dev \
  -H "Authorization: Bearer <your-secret>" \
  -H "Content-Type: application/json" \
  -d '{"task": "fibonacci sequence up to 100", "language": "javascript", "runners": 5}'
```

Response:
```json
{
  "sweepId": "b5e...a91",
  "task": "print the 1000th prime number",
  "language": "python",
  "results": [
    {
      "runner": "runner-1", "style": "minimal", "language": "python",
      "script": "...", "stdout": "7919\nruntime_ms: 12", "stderr": "",
      "duration_ms": 95, "status": "done"
    },
    {
      "runner": "runner-2", "style": "idiomatic", "language": "python",
      "script": "...", "stdout": "7919\nruntime_ms: 14", "stderr": "",
      "duration_ms": 101, "status": "done"
    },
    {
      "runner": "runner-3", "style": "algorithmic", "language": "python",
      "script": "...", "stdout": "7919\nruntime_ms: 8", "stderr": "",
      "duration_ms": 88, "status": "done"
    }
  ]
}
```

### 4. Poll or resume a sweep

```sh
curl https://prism.<your-subdomain>.workers.dev/sweeps/<sweepId> \
  -H "Authorization: Bearer <your-secret>"
```

If the Orchestrator was evicted mid-sweep, `onFiberRecovered` picks up the remaining runners and the final snapshot is persisted — so a later GET returns completed results even if the original POST timed out.

---

## How-to guides

> *Task-oriented. Solve a specific problem.*

### Choose a language

Pass `"language"` in the POST body. Supported values:

| Value | Runtime | Default? |
|---|---|---|
| `python` | `python3` | ✓ |
| `javascript` | `node` | |
| `bash` | `bash` | |

```sh
-d '{"task": "...", "language": "javascript"}'
```

### Control the number of runners

Pass `"runners"` (integer 1–10) to set how many parallel runners spin up. Defaults to `3`.

```sh
-d '{"task": "...", "runners": 7}'
```

Each runner is assigned a different coding style from the ten built-in styles: `minimal`, `idiomatic`, `algorithmic`, `functional`, `verbose`, `one-liner`, `recursive`, `object-oriented`, `brute-force`, `clever`. Styles cycle if you run more than 10 runners.

### Swap in a real framework

The included runners are pure-Python simulations so the demo works on the smallest Sandbox instance. For real training:

1. Increase the Sandbox `instance_type` in `wrangler.json` (e.g. `"standard"` or larger).
2. In `ExperimentRunner.runExperiment`, add a `sandbox.exec("pip install <your-packages>")` step before writing the script.
3. Replace the body of `experimentScript` with real model code.

```ts
// Example: a real PyTorch runner
await sandbox.exec("pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu");
await sandbox.writeFile("/workspace/experiment.py", myRealTrainingScript);
```

### Add another runner

Pass a higher `runners` value in the POST body — no code changes needed. Runners are built dynamically (1–10), and each one gets a distinct style automatically.

```sh
-d '{"task": "...", "runners": 5}'
```

### Change the base container image

Edit `Dockerfile` or switch the `FROM` line to any Cloudflare Sandbox variant. The current image is `cloudflare/sandbox:0.8.11` with `python3` and `nodejs` installed on top (bash is always present).

### Add R2 checkpointing for large artifacts

Bind an R2 bucket in `wrangler.json`:

```json
"r2_buckets": [{ "binding": "R2", "bucket_name": "prism-artifacts" }]
```

Then use `sandbox.createBackup()` / `sandbox.restoreBackup()` to snapshot the filesystem between runs. See the [Sandbox backup/restore docs](https://developers.cloudflare.com/sandbox/guides/backup-restore/).

### Run the test suite

```sh
PRISM_URL=https://prism.<your-subdomain>.workers.dev \
  PRISM_TOKEN=<your-secret> \
  npm test
```

The test suite hits the real endpoint — no mocks. It verifies validation, auth, a full sweep, and the `/sweeps/<id>` polling endpoint.

### Run locally

```sh
npx wrangler dev
```

The Worker + Orchestrator + sub-agents run locally. Sandbox containers require Docker.

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
                   /    /    |    \    \
              sub  sub  sub  sub  sub  ...  (1–10 runners, dynamic)
               |    |    |    |    |
           Sandbox  Sandbox  Sandbox  ...
           (py/js/sh) ...
```

### Components

| Component | Cloudflare primitive | Role |
|---|---|---|
| `Orchestrator` | `Agent` + `runFiber()` | Receives task, fans out to sub-agents, checkpoints via `stash()`, persists final snapshot |
| `ExperimentRunner` | `Agent` (sub-agent facet) | Runs a single experiment in a Sandbox. Isolated SQLite per instance |
| Sandbox | `@cloudflare/sandbox` via `getSandbox()` | Persistent Linux container. `exec()`, `writeFile()`, `readFile()` |
| Durable execution | `runFiber()` + `stash()` + `onFiberRecovered()` | Survives DO eviction. Writes snapshot synchronously. Recovery hook fires on activation |
| Sub-agent RPC | `this.subAgent(Class, name)` | Zero-latency typed RPC. Child gets its own SQLite. One DO binding for parent covers all children |

### API

**`GET /`** — returns a JSON landing document describing usage, supported languages, runner range, and available styles.

**`POST /`** — starts a new sweep.

Request:
```json
{
  "task": "<description, max 500 chars>",
  "language": "python",
  "runners": 3
}
```

`language` is optional (default `python`; supported: `python`, `javascript`, `bash`).
`runners` is optional (default `3`; range `1`–`10`).

Response:
```json
{
  "sweepId": "<uuid>",
  "task": "...",
  "language": "python",
  "results": [
    {
      "runner": "runner-1",
      "style": "minimal",
      "language": "python",
      "script": "...",
      "stdout": "...",
      "stderr": "",
      "duration_ms": 95,
      "status": "done"
    },
    {
      "runner": "runner-2",
      "style": "idiomatic",
      "language": "python",
      "script": "...",
      "stdout": "...",
      "stderr": "",
      "duration_ms": 101,
      "status": "done"
    }
  ]
}
```

**`GET /sweeps/<sweepId>`** — returns the latest persisted snapshot for a sweep. Useful for polling or observing a recovered sweep.

Response:
```json
{
  "task": "...",
  "completed": [ ... ],
  "pending": [],
  "status": "done"
}
```

### Auth

If `API_SECRET` is set, every request requires `Authorization: Bearer <secret>`. If unset, the endpoint is open (useful for local `wrangler dev`, dangerous in production — see [deployment notes](#deployment-notes)).

### File structure

```
prism/
  src/index.ts           # Orchestrator + ExperimentRunner + fetch handler
  test/e2e.test.ts       # Real-endpoint tests (no mocks)
  wrangler.json          # Bindings: DO, Sandbox, containers
  Dockerfile             # Sandbox container image (Python 3 + Node.js)
  package.json           # 2 runtime dependencies
  tsconfig.json
  .dev.vars.example      # Local secret template
  .gitignore
  README.md
```

---

## Explanation

> *Understanding-oriented. Why this works and why it is built this way.*

### How the pieces fit together

The standard pattern for parallel agent work on Cloudflare is: one Agent orchestrates, sub-agents do isolated work, Sandboxes run untrusted code, and fibers make the whole thing crash-resistant.

| Concern | Primitive | What it gives you |
|---|---|---|
| Orchestration | `Agent` class (Durable Object) | Single-threaded, globally addressable, survives restarts |
| Parallel workers | `this.subAgent(Class, name)` | Facets: co-located DOs with isolated SQLite, in-process RPC |
| Code execution | `getSandbox(env.Sandbox, id)` | Full Linux container. `exec()`, file I/O, persistent across calls |
| Per-agent storage | Built-in `this.sql` | Every Agent and sub-agent gets its own SQLite database |
| Crash recovery | `runFiber()` + `stash()` | Writes snapshot synchronously. `onFiberRecovered()` fires on activation |
| Large artifacts | `createBackup()` / `restoreBackup()` | R2-backed filesystem snapshots |
| Idle cost | Active-CPU billing | $0 when nothing is running |

### Why sub-agents instead of separate Durable Objects

Sub-agents (facets) are co-located on the same machine as the parent. RPC between parent and child is an in-process call, not a network hop. Each child still gets fully isolated SQLite — you can't accidentally corrupt parent state. And you only need one DO binding in `wrangler.json` for the parent; children are discovered via the parent's runtime.

### Why `runFiber` instead of Workflows

Workflows are a separate engine for multi-step pipelines with per-step retries. Fibers are for work that is *part of an agent's own execution* — like the orchestrator's sweep loop here. If the DO is evicted mid-fiber, `onFiberRecovered()` fires on the next activation with the last `stash()` snapshot. No external workflow engine, no extra bindings.

### Why the final snapshot is persisted separately

`runFiber` writes snapshots to an internal table (`cf_agents_runs`) that's cleaned up when the fiber completes. That's fine for recovery — but if you want a client to poll for results *after* the sweep finishes, you need your own table. Prism writes each snapshot to a `prism_snapshot` table that survives fiber completion. The `GET /sweeps/<id>` endpoint reads from there.

### Why Sandbox instead of Workers AI

Prism's default demo doesn't need a GPU — the experiments are CPU-only simulations. Sandbox gives each sub-agent a full Linux environment where it can `pip install` arbitrary packages and run arbitrary code. For real training, add a Workers AI binding for inference or call out to a GPU provider from inside the Sandbox.

### Cost

A sweep that takes ~10 seconds of wall time across 3 Sandboxes costs fractions of a cent. When idle, every component (DO, Sandbox, sub-agents) hibernates. There is no baseline cost.

---

## Deployment notes

- **Auth-first deploy:** set `API_SECRET` *before* running `wrangler deploy`. If you deploy code without a secret, the endpoint is open until you set one.
- **Cloudflare Access:** for belt-and-suspenders protection, enable Access on the `workers.dev` route after deploy (Workers & Pages → your worker → Settings → Domains & Routes → Enable Cloudflare Access).
- **Deploy button:** the `Deploy to Cloudflare` badge in this README clones the repo into the user's account and runs `wrangler deploy`. Users must set `API_SECRET` manually via the dashboard or wrangler after the initial deploy.
