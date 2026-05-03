import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AgentFallbackMap,
  FallbackConfig,
  FallbackEntry,
  FallbackModel,
  FallbackModelConfig,
  LargeContextFallbackConfig,
  ModelReference,
  ResolvedModel,
} from "./types";

interface RawConfig {
  enabled?: boolean;
  defaultFallback?: ModelReference | FallbackEntry[];
  agentFallbacks?: Record<string, ModelReference | FallbackEntry[]>;
  cooldownMs?: number;
  maxRetries?: number;
  logging?: boolean;
  largeContextFallback?: LargeContextFallbackConfig;
}

const DEFAULT_CONFIG: FallbackConfig = {
  enabled: true,
  defaultFallback: [],
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
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
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

export function normalizeAgentName(agent: string): string {
  return agent.replace(/[\s\u200B-\u200D\uFEFF]/g, "").toLowerCase();
}

function entryToFallbackModel(entry: FallbackModel | FallbackModelConfig): FallbackModel {
  if ("model" in entry) {
    const parsed = parseModel(entry.model);
    const { model: _m, variant, reasoningEffort, temperature, topP, maxTokens, thinking } = entry;
    const result: FallbackModel = { providerID: parsed.providerID, modelID: parsed.modelID };
    if (variant !== undefined) result.variant = variant;
    if (reasoningEffort !== undefined) result.reasoningEffort = reasoningEffort;
    if (temperature !== undefined) result.temperature = temperature;
    if (topP !== undefined) result.topP = topP;
    if (maxTokens !== undefined) result.maxTokens = maxTokens;
    if (thinking !== undefined) result.thinking = thinking;
    return result;
  }
  return entry;
}

function normalizeChain(raw: ModelReference | FallbackEntry[] | undefined): FallbackEntry[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
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
      result[agent] = [value];
    }
  }
  return result;
}

function writeDefaultConfig(configDir: string): string | null {
  try {
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, CONFIG_FILENAME);
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
    );
    writeFileSync(configPath, `${content}\n`, "utf-8");
    return configPath;
  } catch {
    /* non-critical: best-effort default config write */
    return null;
  }
}

export function loadConfig(): FallbackConfig {
  const configPath = findConfigFile();

  if (!configPath) {
    writeDefaultConfig(getConfigDir());
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(content) as RawConfig;

    return {
      enabled: userConfig.enabled ?? DEFAULT_CONFIG.enabled,
      defaultFallback: normalizeChain(userConfig.defaultFallback),
      agentFallbacks: normalizeAgentMap(userConfig.agentFallbacks),
      cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
      maxRetries: userConfig.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      logging: userConfig.logging ?? DEFAULT_CONFIG.logging,
      largeContextFallback: userConfig.largeContextFallback
        ? {
            ...userConfig.largeContextFallback,
            minContextRatio: userConfig.largeContextFallback.minContextRatio ?? 0.1,
          }
        : undefined,
    };
  } catch {
    /* non-critical: malformed config, use defaults */
    return DEFAULT_CONFIG;
  }
}

export function getFallbackChain(
  config: FallbackConfig,
  agent: string | undefined,
): FallbackModel[] {
  const fallbackAgent = getFallbackAgent(config.agentFallbacks, agent);
  const raw = fallbackAgent ? config.agentFallbacks[fallbackAgent] : config.defaultFallback;

  if (!raw) return [];

  const models: FallbackModel[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const parsed = parseModel(entry);
      models.push({ providerID: parsed.providerID, modelID: parsed.modelID });
    } else if ("model" in entry) {
      models.push(entryToFallbackModel(entry));
    } else {
      models.push(entry);
    }
  }

  return models;
}

function getFallbackAgent(
  agentFallbacks: AgentFallbackMap,
  agent: string | undefined,
): string | undefined {
  if (!agent) return undefined;
  const normalizedAgent = normalizeAgentName(agent);
  return Object.keys(agentFallbacks).find(
    (configuredAgent) => normalizeAgentName(configuredAgent) === normalizedAgent,
  );
}

export function getParsedLcfModel(config: FallbackConfig): ResolvedModel | null {
  const lcf = config.largeContextFallback;
  if (!lcf) return null;
  return parseModel(lcf.model);
}
