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
  return agent
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
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
      defaultLargeContextModel:
        raw.defaultLargeContextModel ?? DEFAULT_CONFIG.defaultLargeContextModel,
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

export function getAgentKey(
  agents: Record<string, AgentConfig>,
  agent: string | undefined,
): string | undefined {
  if (!agent) return undefined;
  const normalizedAgent = normalizeAgentName(agent);
  return Object.keys(agents).find(
    (configuredAgent) => normalizeAgentName(configuredAgent) === normalizedAgent,
  );
}

export interface ConfigMismatch {
  orphanedConfigKeys: string[];
  uncoveredAgents: string[];
  invalidModels: string[];
}

interface ModelsCache {
  [providerID: string]: {
    models?: { [modelID: string]: unknown };
  };
}

function loadModelsCache(): ModelsCache | null {
  const xdgCache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const cachePath = join(xdgCache, "opencode", "models.json");
  try {
    if (!existsSync(cachePath)) return null;
    return JSON.parse(readFileSync(cachePath, "utf-8")) as ModelsCache;
  } catch {
    return null;
  }
}

function collectConfigModelStrings(config: FallbackConfig): string[] {
  const models = new Set<string>();

  function addEntry(entry: FallbackEntry): void {
    if (typeof entry === "string") {
      models.add(entry);
    } else {
      models.add(entry.model);
    }
  }

  if (config.defaultFallback) {
    for (const entry of config.defaultFallback) addEntry(entry);
  }
  if (typeof config.defaultLargeContextModel === "string") {
    models.add(config.defaultLargeContextModel);
  }

  for (const ac of Object.values(config.agents)) {
    if (ac.fallback) {
      for (const entry of ac.fallback) addEntry(entry);
    }
    if (typeof ac.largeContextModel === "string") {
      models.add(ac.largeContextModel);
    }
  }

  return [...models];
}

function validateModelString(model: string, cache: ModelsCache): boolean {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) return false;
  const providerID = model.substring(0, slashIndex);
  const modelID = model.substring(slashIndex + 1);
  if (!providerID || !modelID) return false;

  const provider = cache[providerID];
  if (!provider?.models) return false;
  return modelID in provider.models;
}

export function findConfigMismatches(
  config: FallbackConfig,
  opencodeAgents: string[],
): ConfigMismatch {
  const { orphanedConfigKeys, uncoveredAgents } = findAgentMismatches(config, opencodeAgents);

  const invalidModels: string[] = [];
  const cache = loadModelsCache();
  if (cache) {
    for (const model of collectConfigModelStrings(config)) {
      if (!validateModelString(model, cache)) {
        invalidModels.push(model);
      }
    }
  }

  return { orphanedConfigKeys, uncoveredAgents, invalidModels };
}

export function findAgentMismatches(
  config: FallbackConfig,
  opencodeAgents: string[],
): { orphanedConfigKeys: string[]; uncoveredAgents: string[] } {
  const configKeys = Object.keys(config.agents);
  const configKeysEmpty = configKeys.length === 0;
  const opencodeAgentsEmpty = opencodeAgents.length === 0;

  if (configKeysEmpty || opencodeAgentsEmpty) {
    return { orphanedConfigKeys: [], uncoveredAgents: [] };
  }

  const orphanedConfigKeys: string[] = [];
  const uncoveredAgents: string[] = [];

  for (const configKey of configKeys) {
    const normalizedConfig = normalizeAgentName(configKey);
    const hasMatch = opencodeAgents.some(
      (opencodeAgent) => normalizeAgentName(opencodeAgent) === normalizedConfig,
    );
    if (!hasMatch) {
      orphanedConfigKeys.push(configKey);
    }
  }

  for (const opencodeAgent of opencodeAgents) {
    const normalizedOpencode = normalizeAgentName(opencodeAgent);
    const hasMatch = configKeys.some(
      (configKey) => normalizeAgentName(configKey) === normalizedOpencode,
    );
    if (!hasMatch) {
      uncoveredAgents.push(opencodeAgent);
    }
  }

  return { orphanedConfigKeys, uncoveredAgents };
}

function resolveEntry(entry: FallbackEntry): FallbackModel {
  if (typeof entry === "string") {
    const parsed = parseModel(entry);
    return { providerID: parsed.providerID, modelID: parsed.modelID };
  }
  const parsed = parseModel(entry.model);
  const result: FallbackModel = { providerID: parsed.providerID, modelID: parsed.modelID };
  if (entry.variant !== undefined) result.variant = entry.variant;
  if (entry.reasoningEffort !== undefined) result.reasoningEffort = entry.reasoningEffort;
  if (entry.temperature !== undefined) result.temperature = entry.temperature;
  if (entry.topP !== undefined) result.topP = entry.topP;
  if (entry.maxTokens !== undefined) result.maxTokens = entry.maxTokens;
  if (entry.thinking !== undefined) result.thinking = entry.thinking;
  return result;
}

export function getFallbackChain(
  config: FallbackConfig,
  agent: string | undefined,
): FallbackModel[] {
  const agentKey = getAgentKey(config.agents, agent);
  const agentHasExplicitFallback = agentKey && config.agents[agentKey].fallback !== undefined;

  if (!agentHasExplicitFallback) {
    if (!config.defaultFallback?.length) return [];
    return config.defaultFallback.map(resolveEntry);
  }

  return config.agents[agentKey!].fallback!.map(resolveEntry);
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

export function getAgentMinContextRatio(config: FallbackConfig, agent: string | undefined): number {
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
      return ac.largeContextModel !== undefined || !!config.defaultLargeContextModel;
    })
    .map(([name]) => normalizeAgentName(name));
}
