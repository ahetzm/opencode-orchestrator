import type { Plugin as PluginV1, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Plugin as PluginV2 } from "@opencode/plugin"

import {
  minionDescription,
  minionPrompt,
  orchestratorDescription,
  orchestratorPrompt,
} from "./prompts"

/**
 * Per-agent overrides that a user can supply through plugin options.
 *
 * Every field is optional. Anything left unset is simply not written to the
 * agent config, which means opencode falls back to its own defaults (including
 * the default model).
 */
export interface AgentOverrides {
  /** Model id in `provider/model` form, e.g. `anthropic/claude-sonnet-4-5`. */
  model?: string
  /** Model variant, e.g. a reasoning-effort preset exposed by the provider. */
  variant?: string
  temperature?: number
  top_p?: number
  /** Replace the built-in system prompt entirely. */
  prompt?: string
  /** Append extra instructions to the built-in system prompt. */
  appendPrompt?: string
  /** Override the agent description shown in the agent picker. */
  description?: string
  /** TUI color for the agent. */
  color?: string
  /** Do not register this agent at all. */
  disable?: boolean
}

export interface OrchestratorOptions extends PluginOptions {
  orchestrator?: AgentOverrides
  minion?: AgentOverrides
  /**
   * By default the minion is denied the delegation tool (`task` in opencode v1,
   * `subagent` in v2) so it cannot spawn further subagents. Set this to `true`
   * to allow nested delegation.
   */
  allowMinionDelegation?: boolean
}

export const PLUGIN_ID = "opencode-orchestrator"

type MutableAgentConfig = Record<string, unknown>
type PermissionConfig = Record<string, unknown> | string | undefined

interface AgentSpec {
  id: "orchestrator" | "minion"
  mode: "primary" | "subagent"
  description: string
  prompt: string
}

const ORCHESTRATOR: AgentSpec = {
  id: "orchestrator",
  mode: "primary",
  description: orchestratorDescription,
  prompt: orchestratorPrompt,
}

const MINION: AgentSpec = {
  id: "minion",
  mode: "subagent",
  description: minionDescription,
  prompt: minionPrompt,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readOverrides(value: unknown): AgentOverrides {
  return isRecord(value) ? (value as AgentOverrides) : {}
}

function readOptions(options: unknown): {
  orchestrator: AgentOverrides
  minion: AgentOverrides
  allowMinionDelegation: boolean
} {
  const opts = isRecord(options) ? (options as OrchestratorOptions) : {}
  return {
    orchestrator: readOverrides(opts.orchestrator),
    minion: readOverrides(opts.minion),
    allowMinionDelegation: opts.allowMinionDelegation === true,
  }
}

function resolvePrompt(spec: AgentSpec, overrides: AgentOverrides): string {
  const base = overrides.prompt ?? spec.prompt
  return overrides.appendPrompt ? `${base}\n${overrides.appendPrompt}` : base
}

/**
 * Splits a `provider/model` string (optionally `provider/model#variant`) into
 * the structured model reference used by opencode v2. Returns `undefined` for
 * values that cannot be parsed so a typo does not break agent registration.
 */
export function parseModelRef(
  model: string,
): { providerID: string; id: string; variant?: string } | undefined {
  const slash = model.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = model.slice(0, slash)
  const rest = model.slice(slash + 1)
  if (!rest) return undefined
  const hash = rest.indexOf("#")
  if (hash < 0) return { providerID, id: rest }
  const id = rest.slice(0, hash)
  const variant = rest.slice(hash + 1)
  if (!id) return undefined
  return variant ? { providerID, id, variant } : { providerID, id }
}

// ---------------------------------------------------------------------------
// opencode v1 (`config` hook)
// ---------------------------------------------------------------------------

/**
 * Builds the v1 agent config we want to contribute.
 *
 * Precedence, lowest to highest:
 *   1. built-in defaults from this plugin
 *   2. plugin options from `opencode.json`
 *   3. an explicit `agent.<name>` block in `opencode.json`
 *
 * Undefined values are never written, so opencode's own defaults stay intact.
 */
function buildAgentV1(spec: AgentSpec, overrides: AgentOverrides, existing: unknown): MutableAgentConfig {
  const defaults: MutableAgentConfig = {
    description: overrides.description ?? spec.description,
    mode: spec.mode,
    prompt: resolvePrompt(spec, overrides),
  }

  if (overrides.model !== undefined) defaults.model = overrides.model
  if (overrides.variant !== undefined) defaults.variant = overrides.variant
  if (overrides.temperature !== undefined) defaults.temperature = overrides.temperature
  if (overrides.top_p !== undefined) defaults.top_p = overrides.top_p
  if (overrides.color !== undefined) defaults.color = overrides.color

  return {
    ...defaults,
    ...(isRecord(existing) ? existing : {}),
  }
}

function denySubagentsV1(permission: PermissionConfig) {
  if (!permission || typeof permission === "string") return { task: "deny" as const }
  return { ...permission, task: "deny" as const }
}

/** opencode v1 entrypoint (`server` in the object form, or the legacy function form). */
export const server: PluginV1 = async (input: PluginInput, options?: PluginOptions) => {
  const opts = readOptions(options)

  const log = (level: "debug" | "warn", message: string) =>
    input.client.app
      .log({ body: { service: PLUGIN_ID, level, message } })
      .catch(() => {})

  return {
    config: async (config) => {
      const agents = (config.agent ??= {}) as Record<string, unknown>

      if (opts.orchestrator.disable) {
        await log("debug", "orchestrator agent disabled via plugin options")
      } else {
        agents.orchestrator = buildAgentV1(ORCHESTRATOR, opts.orchestrator, agents.orchestrator)
      }

      if (opts.minion.disable) {
        await log("warn", "minion agent disabled via plugin options; orchestrator has nothing to delegate to")
        return
      }

      const minion = buildAgentV1(MINION, opts.minion, agents.minion)

      if (!opts.allowMinionDelegation) {
        minion.permission = denySubagentsV1(minion.permission as PermissionConfig)
      }

      agents.minion = minion
    },
  }
}

// ---------------------------------------------------------------------------
// opencode v2 (`agent.transform`)
// ---------------------------------------------------------------------------

type AgentEditorV2 = Parameters<Parameters<PluginV2.Context["agent"]["transform"]>[0]>[0]
type AgentInfoV2 = NonNullable<ReturnType<AgentEditorV2["get"]>>

/**
 * `Agent.Info.model` uses branded ids (`Model.ID`, `Provider.ID`, ...). At
 * runtime they are plain strings; this view lets us assign parsed strings
 * without dragging the schema library into the plugin.
 */
interface PlainModelRef {
  providerID: string
  id: string
  variant?: string
}
type AgentWithPlainModel = Omit<AgentInfoV2, "model"> & { model?: PlainModelRef }

/** Delegation tool name in opencode v2 (v1's `task` is migrated to this by opencode itself). */
const SUBAGENT_ACTION = "subagent"

/**
 * Applies our defaults and the plugin options to a v2 agent.
 *
 * In v2 plugin transforms run *after* the user's `agents.<name>` config has
 * already been applied, so precedence is enforced by only filling fields that
 * the user has not already set (`existing` is the pre-transform snapshot).
 */
function applyAgentV2(
  editor: AgentEditorV2,
  spec: AgentSpec,
  overrides: AgentOverrides,
  extra?: (agent: AgentInfoV2, existing: AgentInfoV2 | undefined) => void,
) {
  const existing = editor.get(spec.id)
  const fresh = existing === undefined

  editor.update(spec.id, (item) => {
    const agent = item as unknown as AgentWithPlainModel
    // `mode` is always populated in v2 (defaults to "primary"), so we cannot
    // detect whether the user set it. The primary/subagent split is the whole
    // point of this plugin, so it is always owned by us.
    agent.mode = spec.mode
    if (fresh || agent.description === undefined) agent.description = overrides.description ?? spec.description
    if (fresh || agent.system === undefined) agent.system = resolvePrompt(spec, overrides)

    if (agent.model === undefined && overrides.model !== undefined) {
      const ref = parseModelRef(overrides.model)
      if (ref) agent.model = ref
    }
    if (agent.model !== undefined && agent.model.variant === undefined && overrides.variant !== undefined) {
      agent.model.variant = overrides.variant
    }

    if (overrides.temperature !== undefined && agent.request.body.temperature === undefined) {
      agent.request.body.temperature = overrides.temperature
    }
    if (overrides.top_p !== undefined && agent.request.body.top_p === undefined) {
      agent.request.body.top_p = overrides.top_p
    }
    if (overrides.color !== undefined && agent.color === undefined) agent.color = overrides.color

    extra?.(item, existing)
  })
}

function denySubagentsV2(agent: AgentInfoV2) {
  // Rules are evaluated last-match-wins, so appending is enough to override any
  // earlier `*` allow while keeping every other permission untouched.
  const last = agent.permissions.findLast((rule) => rule.action === SUBAGENT_ACTION && rule.resource === "*")
  if (last?.effect === "deny") return
  agent.permissions.push({ action: SUBAGENT_ACTION, resource: "*", effect: "deny" })
}

/** opencode v2 entrypoint. */
export async function setup(ctx: PluginV2.Context) {
  const opts = readOptions(ctx.options)

  if (opts.minion.disable) {
    console.warn(`[${PLUGIN_ID}] minion agent disabled via plugin options; orchestrator has nothing to delegate to`)
  }

  await ctx.agent.transform((editor) => {
    if (!opts.orchestrator.disable) {
      applyAgentV2(editor, ORCHESTRATOR, opts.orchestrator)
    }

    if (!opts.minion.disable) {
      applyAgentV2(editor, MINION, opts.minion, (agent) => {
        if (!opts.allowMinionDelegation) denySubagentsV2(agent)
      })
    }
  })
}

/**
 * Default export understood by both opencode generations:
 *   - v2 reads `id` + `setup`
 *   - v1 (>= 1.18.29) reads `server`
 */
const plugin = {
  id: PLUGIN_ID,
  setup,
  server,
} satisfies PluginV2.Plugin & { server: PluginV1 }

export default plugin
