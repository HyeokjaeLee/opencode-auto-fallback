import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  FallbackConfig,
  ModelReference,
  ResolvedModel,
  AgentFallbackMap,
} from "./types";

export type { FallbackConfig, ModelReference, ResolvedModel, AgentFallbackMap };

interface RawConfig {
  enabled?: boolean;
  defaultFallback?: ModelReference;
  agentFallbacks?: AgentFallbackMap;
  cooldownMs?: number;
  patterns?: string[];
  logging?: boolean;
}

const DEFAULT_PATTERNS = [
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "overloaded",
];

const DEFAULT_CONFIG: FallbackConfig = {
  enabled: true,
  defaultFallback: "openai/gpt-5.4",
  agentFallbacks: {},
  cooldownMs: 60_000,
  patterns: DEFAULT_PATTERNS,
  logging: false,
};

const CONFIG_FILENAME = "fallback.json";
const SEARCH_SUBDIRS = ["config", "plugins", "plugin"];

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

export function loadConfig(): FallbackConfig {
  const configPath = findConfigFile();

  if (!configPath) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(content) as RawConfig;

    return {
      enabled: userConfig.enabled ?? DEFAULT_CONFIG.enabled,
      defaultFallback:
        userConfig.defaultFallback ?? DEFAULT_CONFIG.defaultFallback,
      agentFallbacks:
        userConfig.agentFallbacks ?? DEFAULT_CONFIG.agentFallbacks,
      cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
      patterns: userConfig.patterns ?? DEFAULT_CONFIG.patterns,
      logging: userConfig.logging ?? DEFAULT_CONFIG.logging,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getFallbackForAgent(
  config: FallbackConfig,
  agent: string | undefined,
): ResolvedModel {
  if (agent && config.agentFallbacks[agent]) {
    return parseModel(config.agentFallbacks[agent]);
  }
  return parseModel(config.defaultFallback);
}
