import { expect, test } from "bun:test"

import plugin, { type OrchestratorOptions } from "../src/index.ts"

type AgentEntry = Record<string, unknown>
type Agents = Record<string, AgentEntry | undefined>

const logged: unknown[] = []

const input = {
  client: { app: { log: async (body: unknown) => void logged.push(body) } },
} as never

async function run(options?: OrchestratorOptions, existing: Record<string, unknown> = {}): Promise<Agents> {
  const hooks = await plugin(input, options)
  const config: Record<string, unknown> = { agent: existing }
  await hooks.config!(config as never)
  return config.agent as Agents
}

/** Reads a registered agent, failing loudly if the plugin did not register it. */
function pick(agents: Agents, name: string): AgentEntry {
  const found = agents[name]
  if (!found) throw new Error(`expected agent "${name}" to be registered`)
  return found
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
