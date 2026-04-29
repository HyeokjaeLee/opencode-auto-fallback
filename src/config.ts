import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  FallbackConfig,
  FallbackEntry,
  FallbackModel,
  FallbackModelConfig,
  ModelReference,
  ResolvedModel,
  AgentFallbackMap,
} from "./types";

export type {
  FallbackConfig,
  FallbackEntry,
  FallbackModel,
  FallbackModelConfig,
  ModelReference,
  ResolvedModel,
  AgentFallbackMap,
};

interface RawConfig {
  enabled?: boolean;
  defaultFallback?: ModelReference | FallbackEntry[];
  agentFallbacks?: Record<string, ModelReference | FallbackEntry[]>;
  cooldownMs?: number;
  maxRetries?: number;
  logging?: boolean;
  largeContextFallback?: { agents: string[]; model: string };
}

const DEFAULT_CONFIG: FallbackConfig = {
  enabled: true,
  defaultFallback: ["openai/gpt-5.4"],
  agentFallbacks: {},
  cooldownMs: 60_000,
  maxRetries: 2,
  logging: false,
};

const CONFIG_FILENAME = "fallback.json";
const SEARCH_SUBDIRS = ["config", "plugins", "plugin"];
const SCHEMA_URL =
  "https://raw.githubusercontent.com/HyeokjaeLee/opencode-auto-fallback/main/docs/fallback.schema.json";

function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

function findConfigFile(): string | null {
  const configDir = getConfigDir();

  const rootPath = join(configDir, CONFIG_FILENAME);
  if (existsSync(rootPath)) {
    return rootPath;
  }

  for (const subdir of SEARCH_SUBDIRS) {
    const subdirPath = join(configDir, subdir, CONFIG_FILENAME);
    if (existsSync(subdirPath)) {
      return subdirPath;
    }
  }

  return null;
}

export function parseModel(model: ModelReference): ResolvedModel {
  if (typeof model === "object") {
    return model;
  }
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    return { providerID: model, modelID: model };
  }
  return {
    providerID: model.substring(0, slashIndex),
    modelID: model.substring(slashIndex + 1),
  };
}

function normalizeFallbackEntry(entry: string | FallbackEntry): FallbackModel {
  if (typeof entry === "string") {
    const parsed = parseModel(entry)
    return { providerID: parsed.providerID, modelID: parsed.modelID }
  }
  return entryToFallbackModel(entry)
}

function entryToFallbackModel(entry: FallbackModel | FallbackModelConfig): FallbackModel {
  if ("model" in entry) {
    const parsed = parseModel(entry.model)
    const { model: _m, variant, reasoningEffort, temperature, topP, maxTokens, thinking } = entry
    const result: FallbackModel = { providerID: parsed.providerID, modelID: parsed.modelID }
    if (variant !== undefined) result.variant = variant
    if (reasoningEffort !== undefined) result.reasoningEffort = reasoningEffort
    if (temperature !== undefined) result.temperature = temperature
    if (topP !== undefined) result.topP = topP
    if (maxTokens !== undefined) result.maxTokens = maxTokens
    if (thinking !== undefined) result.thinking = thinking
    return result
  }
  return entry
}

function normalizeChain(
  raw: ModelReference | FallbackEntry[] | undefined,
): FallbackEntry[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [typeof raw === "string" ? raw : raw];
}

function normalizeAgentMap(
  raw: Record<string, ModelReference | FallbackEntry[]> | undefined,
): AgentFallbackMap {
  if (!raw) return {};
  const result: AgentFallbackMap = {};
  for (const [agent, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      result[agent] = value;
    } else {
      result[agent] = [typeof value === "string" ? value : value];
    }
  }
  return result;
}

function writeDefaultConfig(configDir: string): string | null {
  try {
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, CONFIG_FILENAME)
    const content = JSON.stringify(
      {
        $schema: SCHEMA_URL,
        enabled: DEFAULT_CONFIG.enabled,
        defaultFallback: DEFAULT_CONFIG.defaultFallback,
        agentFallbacks: DEFAULT_CONFIG.agentFallbacks,
        cooldownMs: DEFAULT_CONFIG.cooldownMs,
        maxRetries: DEFAULT_CONFIG.maxRetries,
        logging: DEFAULT_CONFIG.logging,
      },
      null,
      2,
    )
    writeFileSync(configPath, content + "\n", "utf-8")
    return configPath
  } catch {
    return null
  }
}

export function loadConfig(): FallbackConfig {
  const configPath = findConfigFile();

  if (!configPath) {
    writeDefaultConfig(getConfigDir())
    return DEFAULT_CONFIG
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(content) as RawConfig;

    return {
      enabled: userConfig.enabled ?? DEFAULT_CONFIG.enabled,
      defaultFallback:
        normalizeChain(userConfig.defaultFallback) ?? DEFAULT_CONFIG.defaultFallback,
      agentFallbacks: normalizeAgentMap(userConfig.agentFallbacks),
      cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
      maxRetries: userConfig.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      logging: userConfig.logging ?? DEFAULT_CONFIG.logging,
      largeContextFallback: userConfig.largeContextFallback,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getFallbackChain(
  config: FallbackConfig,
  agent: string | undefined,
): FallbackModel[] {
  const chain = agent && config.agentFallbacks[agent]
    ? config.agentFallbacks[agent]
    : config.defaultFallback

  const models: FallbackModel[] = []

  for (const entry of chain) {
    if (typeof entry === "string") {
      const parsed = parseModel(entry)
      models.push({ providerID: parsed.providerID, modelID: parsed.modelID })
    } else if ("model" in entry) {
      models.push(entryToFallbackModel(entry))
    } else {
      models.push(entry)
    }
  }

  return models
}
