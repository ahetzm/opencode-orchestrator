import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"

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
   * By default the minion is denied the `task` tool so it cannot spawn further
   * subagents. Set this to `true` to allow nested delegation.
   */
  allowMinionDelegation?: boolean
}

type MutableAgentConfig = Record<string, unknown>
type PermissionConfig = Record<string, unknown> | string | undefined

const SERVICE = "opencode-orchestrator"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readOverrides(value: unknown): AgentOverrides {
  return isRecord(value) ? (value as AgentOverrides) : {}
}

/**
 * Builds the agent config we want to contribute.
 *
 * Precedence, lowest to highest:
 *   1. built-in defaults from this plugin
 *   2. plugin options from `opencode.json`
 *   3. an explicit `agent.<name>` block in `opencode.json`
 *
 * Undefined values are never written, so opencode's own defaults stay intact.
 */
function buildAgent(args: {
  existing: unknown
  overrides: AgentOverrides
  mode: "primary" | "subagent"
  description: string
  prompt: string
}): MutableAgentConfig {
  const { existing, overrides, mode, description, prompt } = args

  const basePrompt = overrides.prompt ?? prompt
  const resolvedPrompt = overrides.appendPrompt
    ? `${basePrompt}\n${overrides.appendPrompt}`
    : basePrompt

  const defaults: MutableAgentConfig = {
    description: overrides.description ?? description,
    mode,
    prompt: resolvedPrompt,
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

function denySubagents(permission: PermissionConfig) {
  if (!permission || typeof permission === "string") return { task: "deny" as const }
  return { ...permission, task: "deny" as const }
}

const plugin: Plugin = async (input: PluginInput, options?: PluginOptions) => {
  const opts = (options ?? {}) as OrchestratorOptions
  const orchestratorOverrides = readOverrides(opts.orchestrator)
  const minionOverrides = readOverrides(opts.minion)

  const log = (level: "debug" | "warn", message: string, extra?: Record<string, unknown>) =>
    input.client.app
      .log({ body: { service: SERVICE, level, message, extra } })
      .catch(() => {})

  return {
    config: async (config) => {
      const agents = (config.agent ??= {}) as Record<string, unknown>

      if (orchestratorOverrides.disable) {
        await log("debug", "orchestrator agent disabled via plugin options")
      } else {
        agents.orchestrator = buildAgent({
          existing: agents.orchestrator,
          overrides: orchestratorOverrides,
          mode: "primary",
          description: orchestratorDescription,
          prompt: orchestratorPrompt,
        })
      }

      if (minionOverrides.disable) {
        await log("warn", "minion agent disabled via plugin options; orchestrator has nothing to delegate to")
        return
      }

      const minion = buildAgent({
        existing: agents.minion,
        overrides: minionOverrides,
        mode: "subagent",
        description: minionDescription,
        prompt: minionPrompt,
      })

      if (!opts.allowMinionDelegation) {
        minion.permission = denySubagents(minion.permission as PermissionConfig)
      }

      agents.minion = minion
    },
  }
}

export default plugin
