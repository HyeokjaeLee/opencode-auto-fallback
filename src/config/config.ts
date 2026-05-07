import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MIN_CONTEXT_RATIO } from "./constants";
import type {
  AgentConfig,
  FallbackConfig,
  FallbackEntry,
  FallbackModel,
  ResolvedModel,
} from "./types";

interface RawAgentConfig {
  fallback?: FallbackEntry[];
  largeContextModel?: string | false;
  minContextRatio?: number;
}

interface RawConfig {
  enabled?: boolean;
  autoUpdate?: boolean;
  defaultFallback?: FallbackEntry[];
  defaultLargeContextModel?: string | false;
  defaultMinContextRatio?: number;
  agents?: Record<string, RawAgentConfig>;
  cooldownMs?: number;
  maxRetries?: number;
  logging?: boolean;
}

const DEFAULT_CONFIG: FallbackConfig = {
  enabled: false,
  autoUpdate: false,
  defaultFallback: [],
  defaultLargeContextModel: false,
  defaultMinContextRatio: DEFAULT_MIN_CONTEXT_RATIO,
  agents: {},
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

export function parseModel(model: string | ResolvedModel): ResolvedModel {
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

function writeDefaultConfig(configDir: string): string | null {
  try {
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, CONFIG_FILENAME);
    const content = JSON.stringify(
      {
        $schema: SCHEMA_URL,
        enabled: DEFAULT_CONFIG.enabled,
        autoUpdate: DEFAULT_CONFIG.autoUpdate,
        defaultFallback: DEFAULT_CONFIG.defaultFallback,
        defaultLargeContextModel: DEFAULT_CONFIG.defaultLargeContextModel,
        defaultMinContextRatio: DEFAULT_CONFIG.defaultMinContextRatio,
        agents: DEFAULT_CONFIG.agents,
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
    const raw = JSON.parse(content) as RawConfig;

    const agents: Record<string, AgentConfig> = {};
    if (raw.agents) {
      for (const [name, ac] of Object.entries(raw.agents)) {
        agents[name] = {
          fallback: ac.fallback,
          largeContextModel: ac.largeContextModel,
          minContextRatio: ac.minContextRatio,
        };
      }
    }

    return {
      enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
      autoUpdate: raw.autoUpdate ?? DEFAULT_CONFIG.autoUpdate,
      defaultFallback: raw.defaultFallback ?? DEFAULT_CONFIG.defaultFallback,
      defaultLargeContextModel: raw.defaultLargeContextModel ?? DEFAULT_CONFIG.defaultLargeContextModel,
      defaultMinContextRatio: raw.defaultMinContextRatio ?? DEFAULT_CONFIG.defaultMinContextRatio,
      agents,
      cooldownMs: raw.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
      maxRetries: raw.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      logging: raw.logging ?? DEFAULT_CONFIG.logging,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function getAgentKey(
  agents: Record<string, AgentConfig>,
  agent: string | undefined,
): string | undefined {
  if (!agent) return undefined;
  const normalizedAgent = normalizeAgentName(agent);
  return Object.keys(agents).find(
    (configuredAgent) => normalizeAgentName(configuredAgent) === normalizedAgent,
  );
}

function resolveEntry(entry: FallbackEntry): FallbackModel {
  if (typeof entry === "string") {
    const parsed = parseModel(entry);
    return { providerID: parsed.providerID, modelID: parsed.modelID };
  }
  return entry;
}

export function getFallbackChain(
  config: FallbackConfig,
  agent: string | undefined,
): FallbackModel[] {
  const agentKey = getAgentKey(config.agents, agent);
  const raw = agentKey
    ? config.agents[agentKey].fallback ?? config.defaultFallback
    : config.defaultFallback;

  if (!raw) return [];

  return raw.map(resolveEntry);
}

export function getAgentLargeContextModel(
  config: FallbackConfig,
  agent: string | undefined,
): ResolvedModel | null {
  if (agent) {
    const agentKey = getAgentKey(config.agents, agent);
    if (agentKey) {
      const lcm = config.agents[agentKey].largeContextModel;
      if (lcm === false) return null;
      if (lcm !== undefined) return parseModel(lcm);
    }
  }

  if (config.defaultLargeContextModel) {
    return parseModel(config.defaultLargeContextModel);
  }

  return null;
}

export function getAgentMinContextRatio(
  config: FallbackConfig,
  agent: string | undefined,
): number {
  if (agent) {
    const agentKey = getAgentKey(config.agents, agent);
    if (agentKey && config.agents[agentKey].minContextRatio !== undefined) {
      return config.agents[agentKey].minContextRatio!;
    }
  }
  return config.defaultMinContextRatio;
}

export function getRegisteredAgentNames(config: FallbackConfig): string[] {
  return Object.entries(config.agents)
    .filter(([_, ac]) => {
      if (ac.largeContextModel === false) return false;
      return ac.largeContextModel !== undefined || config.defaultLargeContextModel !== undefined;
    })
    .map(([name]) => normalizeAgentName(name));
}
