import { describe, expect, test } from "bun:test"

import plugin, { parseModelRef, PLUGIN_ID, type OrchestratorOptions } from "../src/index.ts"

/** Reads a registered agent, failing loudly if the plugin did not register it. */
function pick<T>(agents: Record<string, T | undefined>, name: string): T {
  const found = agents[name]
  if (!found) throw new Error(`expected agent "${name}" to be registered`)
  return found
}

describe("default export", () => {
  test("is a dual v1 + v2 entrypoint", () => {
    expect(plugin.id).toBe(PLUGIN_ID)
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
  })
})

describe("parseModelRef", () => {
  test("splits provider/model and optional #variant", () => {
    expect(parseModelRef("anthropic/claude-opus-4")).toEqual({ providerID: "anthropic", id: "claude-opus-4" })
    expect(parseModelRef("openai/gpt-5#high")).toEqual({ providerID: "openai", id: "gpt-5", variant: "high" })
    expect(parseModelRef("a/b/c")).toEqual({ providerID: "a", id: "b/c" })
  })

  test("rejects malformed values", () => {
    expect(parseModelRef("nope")).toBeUndefined()
    expect(parseModelRef("/model")).toBeUndefined()
    expect(parseModelRef("provider/")).toBeUndefined()
    expect(parseModelRef("provider/#high")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// opencode v1 (`server` -> `config` hook)
// ---------------------------------------------------------------------------

describe("v1", () => {
  type AgentEntry = Record<string, unknown>
  type Agents = Record<string, AgentEntry | undefined>

  const logged: unknown[] = []

  const input = {
    client: { app: { log: async (body: unknown) => void logged.push(body) } },
  } as never

  async function run(options?: OrchestratorOptions, existing: Record<string, unknown> = {}): Promise<Agents> {
    const hooks = await plugin.server(input, options)
    const config: Record<string, unknown> = { agent: existing }
    await hooks.config!(config as never)
    return config.agent as Agents
  }

  test("registers both agents with no model when unconfigured", async () => {
    const agents = await run()
    expect(Object.keys(agents).sort()).toEqual(["minion", "orchestrator"])

    const orchestrator = pick(agents, "orchestrator")
    const minion = pick(agents, "minion")

    expect(orchestrator.mode).toBe("primary")
    expect(minion.mode).toBe("subagent")
    expect("model" in orchestrator).toBe(false)
    expect("model" in minion).toBe(false)
    expect(minion.permission).toEqual({ task: "deny" })
    expect(orchestrator.prompt).toContain("You are Orchestrator")
    expect(minion.prompt).toContain("You are minion")
  })

  test("applies model + tuning overrides from plugin options", async () => {
    const agents = await run({
      orchestrator: { model: "anthropic/claude-opus-4", temperature: 0.1 },
      minion: { model: "openai/gpt-5", variant: "high", top_p: 0.9, color: "blue" },
    })

    const orchestrator = pick(agents, "orchestrator")
    const minion = pick(agents, "minion")

    expect(orchestrator.model).toBe("anthropic/claude-opus-4")
    expect(orchestrator.temperature).toBe(0.1)
    expect(minion.model).toBe("openai/gpt-5")
    expect(minion.variant).toBe("high")
    expect(minion.top_p).toBe(0.9)
    expect(minion.color).toBe("blue")
  })

  test("user agent config in opencode.json wins over plugin options", async () => {
    const minion = pick(
      await run({ minion: { model: "openai/gpt-5" } }, { minion: { model: "user/override", description: "mine" } }),
      "minion",
    )
    expect(minion.model).toBe("user/override")
    expect(minion.description).toBe("mine")
    expect(minion.mode).toBe("subagent")
  })

  test("prompt replacement and appending", async () => {
    const replaced = pick(await run({ minion: { prompt: "custom" } }), "minion")
    expect(replaced.prompt).toBe("custom")

    const appended = pick(await run({ minion: { appendPrompt: "extra rule" } }), "minion")
    expect(appended.prompt).toContain("You are minion")
    expect(String(appended.prompt).endsWith("\nextra rule")).toBe(true)
  })

  test("allowMinionDelegation removes the task deny", async () => {
    const minion = pick(await run({ allowMinionDelegation: true }), "minion")
    expect(minion.permission).toBeUndefined()
  })

  test("existing string permission is upgraded to an object with task deny", async () => {
    const minion = pick(await run({}, { minion: { permission: "allow" } }), "minion")
    expect(minion.permission).toEqual({ task: "deny" })
  })

  test("existing object permission keeps other keys", async () => {
    const minion = pick(await run({}, { minion: { permission: { bash: "ask" } } }), "minion")
    expect(minion.permission).toEqual({ bash: "ask", task: "deny" })
  })

  test("disable flags skip registration", async () => {
    const agents = await run({ orchestrator: { disable: true }, minion: { disable: true } })
    expect(agents.orchestrator).toBeUndefined()
    expect(agents.minion).toBeUndefined()
  })

  test("tolerates garbage option values", async () => {
    const agents = await run({ minion: "nope", orchestrator: 42 } as never)
    expect(pick(agents, "minion").mode).toBe("subagent")
    expect(pick(agents, "orchestrator").mode).toBe("primary")
  })
})

// ---------------------------------------------------------------------------
// opencode v2 (`setup` -> `agent.transform`)
// ---------------------------------------------------------------------------

describe("v2", () => {
  interface Rule {
    action: string
    resource: string
    effect: "allow" | "deny" | "ask"
  }

  interface Agent {
    id: string
    name: string
    model?: { providerID: string; id: string; variant?: string }
    request: { settings: Record<string, unknown>; headers: Record<string, string>; body: Record<string, unknown> }
    system?: string
    description?: string
    mode: "subagent" | "primary" | "all"
    hidden: boolean
    color?: string
    permissions: Rule[]
  }

  const baseline: Rule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
  ]

  /** Mirrors `Agent.Info.default(id)` in opencode v2. */
  function fresh(id: string): Agent {
    return {
      id,
      name: id,
      request: { settings: {}, headers: {}, body: {} },
      mode: "primary",
      hidden: false,
      permissions: baseline.map((rule) => ({ ...rule })),
    }
  }

  /** Minimal replica of the v2 AgentEditor with the real upsert semantics. */
  function makeEditor(seed: Record<string, Partial<Agent>> = {}) {
    const agents = new Map<string, Agent>()
    for (const [id, partial] of Object.entries(seed)) agents.set(id, { ...fresh(id), ...partial })
    return {
      agents,
      list: () => [...agents.values()],
      get: (id: string) => agents.get(id),
      default: (_id: string | undefined) => {},
      update(id: string, fn: (agent: Agent) => void) {
        const current = agents.get(id) ?? fresh(id)
        agents.set(id, current)
        fn(current)
        current.id = id
      },
      remove: (id: string) => void agents.delete(id),
    }
  }

  /** Last-match-wins, like `Permission.evaluate` in opencode v2 (without wildcard globbing). */
  function effectOf(agent: Agent, action: string): Rule["effect"] {
    return (
      agent.permissions.findLast((rule) => (rule.action === "*" || rule.action === action) && rule.resource === "*")
        ?.effect ?? "ask"
    )
  }

  async function run(options?: OrchestratorOptions, seed: Record<string, Partial<Agent>> = {}) {
    const editor = makeEditor(seed)
    const transforms: Array<(editor: ReturnType<typeof makeEditor>) => void> = []
    const ctx = {
      options: options ?? {},
      agent: {
        transform: async (callback: (editor: ReturnType<typeof makeEditor>) => void) => {
          transforms.push(callback)
          return { dispose: async () => {} }
        },
      },
    }
    await plugin.setup(ctx as never)
    // The runtime replays every transform when rebuilding; do it twice to make
    // sure ours is idempotent.
    for (const transform of transforms) transform(editor)
    for (const transform of transforms) transform(editor)
    return Object.fromEntries(editor.agents) as Record<string, Agent | undefined>
  }

  test("registers both agents with no model when unconfigured", async () => {
    const agents = await run()
    expect(Object.keys(agents).sort()).toEqual(["minion", "orchestrator"])

    const orchestrator = pick(agents, "orchestrator")
    const minion = pick(agents, "minion")

    expect(orchestrator.mode).toBe("primary")
    expect(minion.mode).toBe("subagent")
    expect(orchestrator.model).toBeUndefined()
    expect(minion.model).toBeUndefined()
    expect(orchestrator.system).toContain("You are Orchestrator")
    expect(minion.system).toContain("You are minion")
    expect(orchestrator.description).toBeString()
    expect(minion.description).toBeString()
  })

  test("minion cannot delegate by default; baseline permissions are kept", async () => {
    const minion = pick(await run(), "minion")
    expect(effectOf(minion, "subagent")).toBe("deny")
    expect(effectOf(minion, "shell")).toBe("allow")
    expect(minion.permissions.slice(0, baseline.length)).toEqual(baseline)
    // idempotent across replays
    expect(minion.permissions.filter((rule) => rule.action === "subagent")).toHaveLength(1)

    const orchestrator = pick(await run(), "orchestrator")
    expect(effectOf(orchestrator, "subagent")).toBe("allow")
  })

  test("allowMinionDelegation leaves permissions alone", async () => {
    const minion = pick(await run({ allowMinionDelegation: true }), "minion")
    expect(minion.permissions).toEqual(baseline)
  })

  test("applies model + tuning overrides from plugin options", async () => {
    const agents = await run({
      orchestrator: { model: "anthropic/claude-opus-4", temperature: 0.1 },
      minion: { model: "openai/gpt-5", variant: "high", top_p: 0.9, color: "blue" },
    })

    const orchestrator = pick(agents, "orchestrator")
    const minion = pick(agents, "minion")

    expect(orchestrator.model).toEqual({ providerID: "anthropic", id: "claude-opus-4" })
    expect(orchestrator.request.body).toEqual({ temperature: 0.1 })
    expect(minion.model).toEqual({ providerID: "openai", id: "gpt-5", variant: "high" })
    expect(minion.request.body).toEqual({ top_p: 0.9 })
    expect(minion.color).toBe("blue")
  })

  test("variant in the model string and variant option both work", async () => {
    const fromString = pick(await run({ minion: { model: "openai/gpt-5#low" } }), "minion")
    expect(fromString.model).toEqual({ providerID: "openai", id: "gpt-5", variant: "low" })

    // explicit variant option does not override one already in the string
    const both = pick(await run({ minion: { model: "openai/gpt-5#low", variant: "high" } }), "minion")
    expect(both.model?.variant).toBe("low")
  })

  test("malformed model string is ignored instead of breaking registration", async () => {
    const minion = pick(await run({ minion: { model: "gpt-5" } }), "minion")
    expect(minion.model).toBeUndefined()
    expect(minion.mode).toBe("subagent")
  })

  test("user agents.* config (applied before the plugin) wins over plugin options", async () => {
    const minion = pick(
      await run(
        { minion: { model: "openai/gpt-5", temperature: 0.5, color: "blue", description: "from options" } },
        {
          minion: {
            model: { providerID: "user", id: "override" },
            description: "mine",
            color: "red",
            request: { settings: {}, headers: {}, body: { temperature: 0.9 } },
          },
        },
      ),
      "minion",
    )
    expect(minion.model).toEqual({ providerID: "user", id: "override" })
    expect(minion.description).toBe("mine")
    expect(minion.color).toBe("red")
    expect(minion.request.body.temperature).toBe(0.9)
    // user did not set these, so the plugin fills them in
    expect(minion.mode).toBe("subagent")
    expect(minion.system).toContain("You are minion")
    expect(effectOf(minion, "subagent")).toBe("deny")
  })

  test("user-supplied system prompt is preserved", async () => {
    const minion = pick(await run({ minion: { appendPrompt: "extra" } }, { minion: { system: "theirs" } }), "minion")
    expect(minion.system).toBe("theirs")
  })

  test("prompt replacement and appending", async () => {
    const replaced = pick(await run({ minion: { prompt: "custom" } }), "minion")
    expect(replaced.system).toBe("custom")

    const appended = pick(await run({ minion: { appendPrompt: "extra rule" } }), "minion")
    expect(appended.system).toContain("You are minion")
    expect(String(appended.system).endsWith("\nextra rule")).toBe(true)
  })

  test("existing subagent deny is not duplicated; existing allow is overridden", async () => {
    const denied = pick(
      await run({}, { minion: { permissions: [...baseline, { action: "subagent", resource: "*", effect: "deny" }] } }),
      "minion",
    )
    expect(denied.permissions.filter((rule) => rule.action === "subagent")).toHaveLength(1)

    const allowed = pick(
      await run({}, { minion: { permissions: [...baseline, { action: "subagent", resource: "*", effect: "allow" }] } }),
      "minion",
    )
    expect(effectOf(allowed, "subagent")).toBe("deny")
  })

  test("disable flags skip registration", async () => {
    const agents = await run({ orchestrator: { disable: true }, minion: { disable: true } })
    expect(agents.orchestrator).toBeUndefined()
    expect(agents.minion).toBeUndefined()
  })

  test("tolerates garbage option values", async () => {
    const agents = await run({ minion: "nope", orchestrator: 42 } as never)
    expect(pick(agents, "minion").mode).toBe("subagent")
    expect(pick(agents, "orchestrator").mode).toBe("primary")
  })
})
