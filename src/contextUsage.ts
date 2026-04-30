import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";

export interface ContextUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalContextTokens: number;
  outputTokensCumulative: number;
  maxContext: number;
}

// Claude's context window for current models. Hardcoded because the JSONL
// transcript doesn't carry the model's max context anywhere, and the daemon
// doesn't know which model variant Claude Code resolved to internally.
const MAX_CONTEXT_TOKENS = 200_000;

/**
 * Walk the Claude Code session transcript and total the latest usage record's
 * input + cache tokens (which together count against the context window) plus
 * cumulative output. Returns null if the file doesn't exist or has no usage
 * records yet.
 */
export async function readContextUsage(sessionId: string): Promise<ContextUsage | null> {
  const projectSlug = process.cwd().replace(/\//g, "-");
  const jsonlPath = `${homedir()}/.claude/projects/${projectSlug}/${sessionId}.jsonl`;
  if (!existsSync(jsonlPath)) return null;

  const raw = await readFile(jsonlPath, "utf8");
  let lastUsage: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null = null;
  let outputTokensCumulative = 0;

  for (const line of raw.trim().split("\n")) {
    try {
      const obj = JSON.parse(line);
      if (obj.message?.usage) lastUsage = obj.message.usage;
      if (obj.message?.usage?.output_tokens) outputTokensCumulative += obj.message.usage.output_tokens;
    } catch {
      // Skip malformed lines — Claude Code occasionally writes partial records
      // during shutdown, and we'd rather show stale-but-real usage than fail.
    }
  }

  if (!lastUsage) return null;

  const inputTokens = lastUsage.input_tokens ?? 0;
  const cacheCreationTokens = lastUsage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = lastUsage.cache_read_input_tokens ?? 0;

  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalContextTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
    outputTokensCumulative,
    maxContext: MAX_CONTEXT_TOKENS,
  };
}

export function buildProgressBar(current: number, max: number, width = 20): string {
  const ratio = Math.min(current / max, 1);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
