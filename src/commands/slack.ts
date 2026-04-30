import { extname, join } from "path";
import { mkdir } from "fs/promises";
import { compactCurrentSession, ensureProjectClaudeMd, runUserMessage, streamUserMessage } from "../runner";
import { peekSession, resetSession } from "../sessions";
import { getSettings, loadSettings } from "../config";
import { transcribeAudioToText } from "../whisper";
import { extractReactionDirective } from "../reactions";
import { buildProgressBar, readContextUsage } from "../contextUsage";
import type { StateData } from "../statusline";

// --- Slack API constants ---

const SLACK_API = "https://slack.com/api";

// --- Type interfaces ---

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
}

interface SlackEvent {
  type: string;
  channel?: string;
  channel_type?: string; // "channel", "im", "mpim", "group"
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
  reaction?: string;
  item?: { type: string; channel?: string; ts?: string };
}

interface SlackSocketPayload {
  type: string;         // "events_api", "slash_commands", "disconnect", "hello"
  envelope_id?: string;
  payload?: {
    type?: string;
    event?: SlackEvent;
    // slash_commands payload fields
    command?: string;
    text?: string;
    channel_id?: string;
    user_id?: string;
    [key: string]: unknown;
  };
  reason?: string;      // for "disconnect" at top level
  num_connections?: number;
}

interface SlackSlashCommand {
  command: string;
  text: string;
  channelId: string;
  userId: string;
}

interface SlackAssistantThreadEvent {
  type: string;
  channel_id: string;
  thread_ts: string;
  context?: { channel_id?: string };
}

interface SlackAppHomeOpenedEvent {
  type: string;
  user: string;
  tab: string;
}

// --- Gateway state ---

let ws: WebSocket | null = null;
let running = true;
let generation = 0; // incremented on stopGateway to invalidate stale reconnect timers
let slackDebug = false;

// Bot identity (populated from auth.test on connect)
let botUserId: string | null = null;
let botUsername: string | null = null;

// Assistant surface state — composite key "channelId:threadTs"
const assistantThreads = new Set<string>();
const assistantContexts = new Map<string, string>(); // key → context channel_id

// --- Debug ---

function debugLog(message: string): void {
  if (!slackDebug) return;
  console.log(`[Slack][debug] ${message}`);
}

// --- REST API helper (bot token) ---

async function slackApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack API ${method}: ${res.status} ${res.statusText} ${text}`);
  }

  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack API ${method}: ${data.error ?? "unknown error"}`);
  }
  // Strip envelope fields (ok, error) so callers only receive T-shaped payload
  const { ok: _ok, error: _error, ...payload } = data;
  return payload as unknown as T;
}

// --- Markdown → Slack mrkdwn conversion ---

function markdownToSlackMrkdwn(text: string): string {
  if (!text) return "";

  // 1. Extract and protect code blocks (remove language specifier)
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Links [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // 4. Protect bold **text** / __text__ before handling single-asterisk italic
  const boldParts: string[] = [];
  text = text.replace(/\*\*(.+?)\*\*/gs, (_m, inner) => {
    boldParts.push(inner);
    return `\x00BOLD${boldParts.length - 1}\x00`;
  });
  text = text.replace(/__(.+?)__/gs, (_m, inner) => {
    boldParts.push(inner);
    return `\x00BOLD${boldParts.length - 1}\x00`;
  });

  // 5. Italic *text* → _text_ (safe now that ** was extracted)
  text = text.replace(/\*(.+?)\*/gs, "_$1_");

  // 6. Restore bold as Slack mrkdwn bold (*text*)
  for (let i = 0; i < boldParts.length; i++) {
    text = text.replaceAll(`\x00BOLD${i}\x00`, `*${boldParts[i]}*`);
  }

  // 7. Strikethrough ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/gs, "~$1~");

  // 8. Markdown headers → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // 9. Restore inline code (Slack mrkdwn uses backticks too)
  for (let i = 0; i < inlineCodes.length; i++) {
    text = text.replaceAll(`\x00IC${i}\x00`, `\`${inlineCodes[i]}\``);
  }

  // 10. Restore code blocks (triple backtick, no language specifier)
  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replaceAll(`\x00CB${i}\x00`, `\`\`\`\n${codeBlocks[i].trim()}\n\`\`\``);
  }

  return text;
}

// --- Attachment handling ---

function isImageFile(file: SlackFile): boolean {
  return Boolean(file.mimetype?.startsWith("image/"));
}

function isAudioFile(file: SlackFile): boolean {
  return Boolean(file.mimetype?.startsWith("audio/"));
}

function isTextFile(file: SlackFile): boolean {
  if (!file.mimetype) return false;
  if (isImageFile(file) || isAudioFile(file)) return false;
  if (file.mimetype.startsWith("text/")) return true;
  // Common doc MIME types Slack reports
  return new Set([
    "application/pdf",
    "application/json",
    "application/xml",
    "application/x-yaml",
    "application/yaml",
  ]).has(file.mimetype);
}

function extensionFromMimeType(mimeType?: string): string {
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "image/bmp": return ".bmp";
    case "audio/mpeg": return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a": return ".m4a";
    case "audio/ogg": return ".ogg";
    case "audio/wav":
    case "audio/x-wav": return ".wav";
    case "audio/webm": return ".webm";
    default: return "";
  }
}

async function downloadSlackFile(
  botToken: string,
  file: SlackFile,
  channelId: string,
  ts: string,
): Promise<string | null> {
  if (!file.url_private) return null;

  const response = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Slack file download failed: ${response.status} ${response.statusText}`);
  }

  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "slack");
  await mkdir(dir, { recursive: true });

  const nameExt = extname(file.name ?? "");
  const mimeExt = extensionFromMimeType(file.mimetype);
  const ext = nameExt || mimeExt || ".bin";
  const filename = `${channelId}-${ts.replaceAll(".", "")}-${file.id}${ext}`;
  const localPath = join(dir, filename);

  await Bun.write(localPath, response);
  debugLog(`File downloaded: ${localPath} (${file.mimetype ?? "?"})`);
  return localPath;
}

// Slack emoji codes use leading/trailing colons (`:thumbsup:`); strip before reactions.add.
function normalizeSlackEmoji(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/:/g, "").trim();
  return stripped || null;
}

async function addReaction(
  botToken: string,
  channel: string,
  ts: string,
  name: string,
): Promise<void> {
  await slackApi(botToken, "reactions.add", { channel, timestamp: ts, name }).catch((err) =>
    debugLog(`reactions.add failed: ${err}`),
  );
}

function isSlackDmChannelId(channelId: string): boolean {
  return channelId.startsWith("D");
}

// Reactions Claude shouldn't be woken up for — pure acknowledgments.
const SILENT_REACTIONS = new Set(["thumbsup", "+1", "eyes", "white_check_mark", "heavy_check_mark", "ok_hand"]);

// --- Message sending ---

async function sendMessage(
  botToken: string,
  channelId: string,
  text: string,
  threadTs?: string,
  useMarkdownBlock = false,
  updateTs?: string,
): Promise<void> {
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) {
    if (updateTs) {
      await slackApi(botToken, "chat.update", {
        channel: channelId,
        ts: updateTs,
        text: "_(empty response)_",
      }).catch(() => {});
    }
    return;
  }
  const MAX_LEN = 3000;
  // Chunk by normalized length so mrkdwn and markdown blocks stay in sync
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    const chunk = normalized.slice(i, i + MAX_LEN);
    const mrkdwn = markdownToSlackMrkdwn(chunk);
    // markdown block (AI Apps only) renders full CommonMark; mrkdwn is the fallback.
    // Only used when the caller knows the channel is on the assistant surface.
    const blocks = useMarkdownBlock ? { blocks: [{ type: "markdown", text: chunk }] } : {};
    if (i === 0 && updateTs) {
      // Replace the "thinking" placeholder with the first chunk
      await slackApi(botToken, "chat.update", {
        channel: channelId,
        ts: updateTs,
        text: mrkdwn,
        ...blocks,
      });
    } else {
      await slackApi(botToken, "chat.postMessage", {
        channel: channelId,
        text: mrkdwn,
        ...blocks,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }
}

export async function sendMessageToUser(
  botToken: string,
  userId: string,
  text: string,
): Promise<void> {
  const result = await slackApi<{ channel: { id: string } }>(
    botToken,
    "conversations.open",
    { users: userId },
  );
  await sendMessage(botToken, result.channel.id, text);
}

async function postPlaceholderMessage(
  botToken: string,
  channelId: string,
  threadTs: string | undefined,
): Promise<string | null> {
  // Slack has no public API for triggering the native typing indicator from a bot
  // in regular DMs/channels — only assistant.threads.setStatus works (and only on the
  // AI Apps surface). The placeholder-update pattern is the alternative: post a
  // "thinking" message immediately, then chat.update it once Claude responds.
  try {
    const res = await slackApi<{ ts: string }>(botToken, "chat.postMessage", {
      channel: channelId,
      text: "_Thinking…_",
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return res.ts;
  } catch {
    return null;
  }
}

// --- Assistant thread surface ---

function handleAssistantThreadStarted(event: SlackAssistantThreadEvent): void {
  const key = `${event.channel_id}:${event.thread_ts}`;
  // Evict the oldest entry when the ceiling is reached so the collections
  // don't grow without bound on long-running daemons with active workspaces.
  const MAX_ASSISTANT_THREADS = 10_000;
  if (assistantThreads.size >= MAX_ASSISTANT_THREADS) {
    const oldest = assistantThreads.values().next().value!;
    assistantThreads.delete(oldest);
    assistantContexts.delete(oldest);
  }
  assistantThreads.add(key);
  if (event.context?.channel_id) {
    assistantContexts.set(key, event.context.channel_id);
  }
  debugLog(`Assistant thread started: ${key}, context: ${event.context?.channel_id ?? "none"}`);
}

function handleAssistantThreadContextChanged(event: SlackAssistantThreadEvent): void {
  const key = `${event.channel_id}:${event.thread_ts}`;
  if (event.context?.channel_id) {
    assistantContexts.set(key, event.context.channel_id);
    debugLog(`Assistant thread context changed: ${key}, context: ${event.context.channel_id}`);
  }
}

// --- App Home tab ---

function buildHomeBlocks(state: StateData): unknown[] {
  const started = new Date(state.startedAt).toLocaleString();
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "ClaudeClaw Status" } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Started:* ${started}` },
        { type: "mrkdwn", text: `*Security:* ${state.security}` },
        { type: "mrkdwn", text: `*Telegram:* ${state.telegram ? "✓ connected" : "—"}` },
        { type: "mrkdwn", text: `*Discord:* ${state.discord ? "✓ connected" : "—"}` },
        { type: "mrkdwn", text: `*Slack:* ${state.slack ? "✓ connected" : "—"}` },
        {
          type: "mrkdwn",
          text: `*Web:* ${state.web?.enabled ? `✓ ${state.web.host}:${state.web.port}` : "—"}`,
        },
      ],
    },
  ];
  if (state.jobs.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Scheduled jobs:* ${state.jobs.map((j) => j.name).join(", ")}`,
      },
    });
  }
  return blocks;
}

async function handleAppHomeOpened(botToken: string, userId: string): Promise<void> {
  const stateFile = join(process.cwd(), ".claude", "claudeclaw", "state.json");
  let blocks: unknown[];
  try {
    const stateText = await Bun.file(stateFile).text();
    const parsed = JSON.parse(stateText);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
      throw new Error("Unexpected state.json shape");
    }
    blocks = buildHomeBlocks(parsed as StateData);
  } catch {
    blocks = [{ type: "section", text: { type: "mrkdwn", text: "Daemon status unavailable." } }];
  }
  await slackApi(botToken, "views.publish", {
    user_id: userId,
    view: { type: "home", blocks },
  }).catch((err) => console.error(`[Slack] Failed to publish app home: ${err}`));
}

// --- Streaming response ---

// Returns { delivered, reactionEmoji } — delivered=false means streaming unavailable (caller falls back).
async function streamSlackMessage(
  botToken: string,
  channelId: string,
  prompt: string,
  replyThreadTs: string | undefined,
  sessionThreadId: string | undefined,
): Promise<{ delivered: boolean; reactionEmoji: string | null }> {
  let streamChannel: string;
  let streamMessageTs: string;
  try {
    const res = await slackApi<{ channel: string; message_ts: string }>(
      botToken,
      "chat.startStream",
      {
        channel: channelId,
        ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
      },
    );
    streamChannel = res.channel;
    streamMessageTs = res.message_ts;
  } catch {
    // Streaming unavailable (feature not enabled, wrong scope, etc.) — caller falls back
    return { delivered: false, reactionEmoji: null };
  }

  // Accumulate chunks and flush every FLUSH_INTERVAL_MS or FLUSH_MIN_CHARS, whichever first,
  // to stay within the appendStream Tier 4 rate limit (~100/min).
  const FLUSH_INTERVAL_MS = 500;
  const FLUSH_MIN_CHARS = 300;
  let pendingChunks = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let fullText = "";

  const flush = async () => {
    if (!pendingChunks) return;
    const payload = pendingChunks;
    pendingChunks = "";
    await slackApi(botToken, "chat.appendStream", {
      channel: streamChannel,
      message_ts: streamMessageTs,
      content: payload,
    }).catch(() => {});
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flush();
    }, FLUSH_INTERVAL_MS);
  };

  try {
    await streamUserMessage(
      "slack",
      prompt,
      (chunk) => {
        fullText += chunk;
        pendingChunks += chunk;
        if (pendingChunks.length >= FLUSH_MIN_CHARS) {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          flush().catch(() => {});
        } else {
          scheduleFlush();
        }
      },
      () => {},
      sessionThreadId,
    );

    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

    const { cleanedText: normalized, reactionEmoji: rawEmoji } = extractReactionDirective(fullText);
    const reactionEmoji = normalizeSlackEmoji(rawEmoji);
    const finalMrkdwn = markdownToSlackMrkdwn(normalized);
    await slackApi(botToken, "chat.stopStream", {
      channel: streamChannel,
      message_ts: streamMessageTs,
      final_message: {
        text: finalMrkdwn,
        blocks: [{ type: "markdown", text: normalized }],
      },
    });
    return { delivered: true, reactionEmoji };
  } catch (err) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await slackApi(botToken, "chat.stopStream", {
      channel: streamChannel,
      message_ts: streamMessageTs,
      final_message: { text: "An internal error occurred. Check the daemon logs." },
    }).catch(() => {});
    throw err;
  }
}

// --- Socket Mode connection ---

async function openSocketModeConnection(appToken: string): Promise<string> {
  const res = await fetch(`${SLACK_API}/apps.connections.open`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`apps.connections.open: ${res.status} ${res.statusText} ${text}`);
  }
  const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!data.ok || !data.url) {
    throw new Error(`apps.connections.open: ${data.error ?? "no url returned"}`);
  }
  return data.url;
}

// --- Message handler ---

async function handleMessage(botToken: string, event: SlackEvent): Promise<void> {
  const config = getSettings().slack;

  // Filter bot messages (bot_id is present on all messages from bots)
  if (event.bot_id || event.subtype === "bot_message") return;

  const channelId = event.channel;
  const userId = event.user;
  const text = event.text ?? "";
  const ts = event.ts;
  const threadTs = event.thread_ts;

  if (!channelId || !userId || !ts) return;
  const isDM = isSlackDmChannelId(channelId);
  if (!text.trim() && !event.files?.length) return;

  // Check if this message arrived via the assistant surface (sidebar AI panel).
  // Assistant surface threads are DMs with a thread_ts set by assistant_thread_started.
  const threadKey = `${channelId}:${threadTs ?? ts}`;
  const isAssistantThread = isDM && assistantThreads.has(threadKey);

  // Determine if we should respond
  const isListenChannel = config.listenChannels.includes(channelId);
  const isMentioned = botUserId ? text.includes(`<@${botUserId}>`) : false;

  if (!isDM && !isListenChannel && !isMentioned) {
    debugLog(`Skip: channel=${channelId} isDM=false not in listenChannels, not mentioned`);
    return;
  }

  // Authorization check — empty allowedUserIds means the bot is open to all workspace members
  if (config.allowedUserIds.length === 0 || !config.allowedUserIds.includes(userId)) {
    if (config.allowedUserIds.length > 0) {
      // Explicitly restricted: reject the user
      if (isDM) {
        await sendMessage(botToken, channelId, "Unauthorized.");
      } else {
        debugLog(`Skip: unauthorized user ${userId}`);
      }
      return;
    }
    // allowedUserIds is empty — allow all (personal/single-user workspace)
  }

  // Strip bot mention from text
  let cleanText = text;
  if (botUserId) {
    cleanText = cleanText.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }

  const files = event.files ?? [];
  const imageFile = files.find(isImageFile) ?? null;
  const voiceFile = files.find(isAudioFile) ?? null;
  const textFile = files.find(isTextFile) ?? null;
  const hasImage = Boolean(imageFile);
  const hasVoice = Boolean(voiceFile);
  const hasText = Boolean(textFile);

  if (!cleanText.trim() && !hasImage && !hasVoice && !hasText) return;

  // Inject assistant surface context (channel the user had open when starting the thread)
  const contextChannelId = assistantContexts.get(threadKey);
  if (contextChannelId) {
    cleanText = `[User context: viewing <#${contextChannelId}>]\n${cleanText}`;
  }

  const label = userId;
  const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : "", hasText ? "text" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` (+${mediaParts.join(", ")})` : "";
  console.log(`[${new Date().toLocaleTimeString()}] Slack ${label}: message received (${cleanText.length} chars${mediaSuffix})`);

  // Determine reply thread_ts:
  // - Regular DM: no threading (flat conversation)
  // - Assistant surface DM: thread replies (threadTs from assistant_thread_started)
  // - Existing thread reply: stay in the same thread
  // - Top-level listenChannel message: start a new thread (reply to ts)
  const replyThreadTs = (isDM && !isAssistantThread) ? undefined : (threadTs ?? ts);

  // Session key: stable per conversation thread
  const sessionThreadId = replyThreadTs ? `slack:${channelId}:${replyThreadTs}` : undefined;

  // Status indicator setup.
  // - Assistant surface threads: streamSlackMessage posts its own streaming message,
  //   and assistant.threads.setStatus shows a "thinking" indicator under the bot avatar.
  // - Regular DMs/channels: post a "_Thinking…_" placeholder that we chat.update with
  //   the final response (Slack has no bot-typing API for this surface).
  let placeholderTs: string | null = null;

  if (isAssistantThread && replyThreadTs) {
    await slackApi(botToken, "assistant.threads.setStatus", {
      channel_id: channelId,
      thread_ts: replyThreadTs,
      status: "is thinking...",
    }).catch(() => {});
  } else if (config.thinkingPlaceholder) {
    placeholderTs = await postPlaceholderMessage(botToken, channelId, replyThreadTs);
  }

  try {
    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;
    let textPath: string | null = null;
    let textOriginalName: string | null = null;

    if (imageFile) {
      try {
        imagePath = await downloadSlackFile(botToken, imageFile, channelId, ts);
      } catch (err) {
        console.error(`[Slack] Failed to download image for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (voiceFile) {
      try {
        voicePath = await downloadSlackFile(botToken, voiceFile, channelId, ts);
      } catch (err) {
        console.error(`[Slack] Failed to download voice for ${label}: ${err instanceof Error ? err.message : err}`);
      }
      if (voicePath) {
        try {
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: slackDebug,
            log: (m) => debugLog(m),
          });
        } catch (err) {
          console.error(`[Slack] Failed to transcribe voice for ${label}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    if (textFile) {
      try {
        textPath = await downloadSlackFile(botToken, textFile, channelId, ts);
        textOriginalName = textFile.name ?? null;
      } catch (err) {
        console.error(`[Slack] Failed to download document for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const promptParts = [`[Slack from ${label}]`];
    if (cleanText.trim()) {
      promptParts.push(`Message: ${cleanText}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (hasVoice) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip.");
    }
    if (textPath) {
      promptParts.push(`Document path: ${textPath}`);
      if (textOriginalName) promptParts.push(`Original filename: ${textOriginalName}`);
      promptParts.push("The user attached a document. Read and process this file directly.");
    } else if (hasText) {
      promptParts.push("The user attached a document, but downloading it failed. Respond and ask them to resend.");
    }
    const prompt = promptParts.join("\n");

    let delivered = false;
    if (isAssistantThread) {
      const streamResult = await streamSlackMessage(botToken, channelId, prompt, replyThreadTs, sessionThreadId);
      delivered = streamResult.delivered;
      if (streamResult.delivered && streamResult.reactionEmoji) {
        await addReaction(botToken, channelId, ts, streamResult.reactionEmoji);
      }
    }

    if (!delivered) {
      const result = await runUserMessage("slack", prompt, sessionThreadId);
      if (result.exitCode !== 0) {
        console.error(`[Slack] Claude error for ${label} (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
        await sendMessage(
          botToken,
          channelId,
          `Something went wrong (exit ${result.exitCode}). Check the daemon logs for details.`,
          replyThreadTs,
          false,
          placeholderTs ?? undefined,
        );
      } else {
        const { cleanedText, reactionEmoji: rawEmoji } = extractReactionDirective(result.stdout || "(empty response)");
        const reactionEmoji = normalizeSlackEmoji(rawEmoji);
        const responseText = cleanedText || "(empty response)";

        if (reactionEmoji) {
          await addReaction(botToken, channelId, ts, reactionEmoji);
        }

        await sendMessage(
          botToken,
          channelId,
          responseText,
          replyThreadTs,
          isAssistantThread,
          placeholderTs ?? undefined,
        );
      }
      placeholderTs = null;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] Error for ${label}: ${errMsg}`);
    await sendMessage(
      botToken,
      channelId,
      "An internal error occurred. Check the daemon logs.",
      replyThreadTs,
      false,
      placeholderTs ?? undefined,
    );
    placeholderTs = null;
  } finally {
    // Clear assistant thread status — it persists until explicitly cleared
    if (isAssistantThread && replyThreadTs) {
      await slackApi(botToken, "assistant.threads.setStatus", {
        channel_id: channelId,
        thread_ts: replyThreadTs,
        status: "",
      }).catch(() => {});
    }
    // Safety net: if the placeholder was never consumed (e.g., delivery threw before
    // any sendMessage call), delete it so the channel doesn't show a stuck "Thinking…".
    if (placeholderTs) {
      await slackApi(botToken, "chat.delete", {
        channel: channelId,
        ts: placeholderTs,
      }).catch(() => {});
    }
  }
}

const SLASH_HELP =
  "*ClaudeClaw* — `/cc <subcommand>`\n" +
  "• `start` (or `help`) — show this welcome message\n" +
  "• `reset` — reset the global session (next message starts fresh)\n" +
  "• `compact` — compact the current session to free context\n" +
  "• `status` — show session info, model, security level\n" +
  "• `context` — show context window usage with a progress bar";

async function handleSlashCommand(botToken: string, cmd: SlackSlashCommand): Promise<void> {
  const config = getSettings().slack;
  const { command, text, channelId, userId } = cmd;

  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    await sendMessage(botToken, channelId, "Unauthorized.");
    return;
  }

  if (command !== "/cc") {
    await sendMessage(botToken, channelId, `Unknown command: \`${command}\`. Use \`/cc help\` for usage.`);
    return;
  }

  const subcommand = (text.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();

  switch (subcommand) {
    case "":
    case "help":
    case "start":
      await sendMessage(botToken, channelId, SLASH_HELP);
      return;

    case "reset":
      await resetSession();
      await sendMessage(botToken, channelId, "Global session reset. Next message starts fresh.");
      return;

    case "compact": {
      await sendMessage(botToken, channelId, "⏳ Compacting session...");
      const result = await compactCurrentSession();
      await sendMessage(botToken, channelId, result.message);
      return;
    }

    case "status": {
      const session = await peekSession();
      const settings = getSettings();
      if (!session) {
        await sendMessage(botToken, channelId, "📊 No active session.");
        return;
      }
      const lines = [
        "*📊 Session Status*",
        `Session: \`${session.sessionId.slice(0, 8)}\``,
        `Turns: ${session.turnCount ?? 0}`,
        `Model: ${settings.model || "default"}`,
        `Security: ${settings.security.level}`,
        `Created: ${session.createdAt}`,
        `Last used: ${session.lastUsedAt}`,
      ];
      await sendMessage(botToken, channelId, lines.join("\n"));
      return;
    }

    case "context": {
      const session = await peekSession();
      if (!session) {
        await sendMessage(botToken, channelId, "No active session.");
        return;
      }
      try {
        const usage = await readContextUsage(session.sessionId);
        if (!usage) {
          await sendMessage(botToken, channelId, "No usage data found.");
          return;
        }
        const pct = ((usage.totalContextTokens / usage.maxContext) * 100).toFixed(1);
        const bar = buildProgressBar(usage.totalContextTokens, usage.maxContext);
        const msg = [
          "*📐 Context Window*",
          `${bar} ${pct}%`,
          ``,
          `Total: \`${usage.totalContextTokens.toLocaleString()}\` / \`${usage.maxContext.toLocaleString()}\` tokens`,
          `├ Input: \`${usage.inputTokens.toLocaleString()}\``,
          `├ Cache creation: \`${usage.cacheCreationTokens.toLocaleString()}\``,
          `├ Cache read: \`${usage.cacheReadTokens.toLocaleString()}\``,
          `└ Output (cumulative): \`${usage.outputTokensCumulative.toLocaleString()}\``,
          ``,
          `Turns: ${session.turnCount ?? 0}`,
        ];
        await sendMessage(botToken, channelId, msg.join("\n"));
      } catch (err) {
        await sendMessage(botToken, channelId, `Failed to read context: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    default:
      await sendMessage(botToken, channelId, `Unknown subcommand: \`${subcommand}\`. Use \`/cc help\` for usage.`);
  }
}

async function handleReaction(botToken: string, event: SlackEvent): Promise<void> {
  const config = getSettings().slack;
  const userId = event.user;
  const reaction = event.reaction;
  const channelId = event.item?.channel;
  const itemTs = event.item?.ts;

  if (!userId || !reaction || !channelId || !itemTs) return;
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) return;

  const isDM = isSlackDmChannelId(channelId);
  const isListenChannel = config.listenChannels.includes(channelId);
  if (!isDM && !isListenChannel) return;
  if (SILENT_REACTIONS.has(reaction)) return;

  console.log(`[${new Date().toLocaleTimeString()}] Slack ${userId}: reaction :${reaction}:`);

  const sessionThreadId = `slack:${channelId}:${itemTs}`;
  const prompt = `[Slack reaction from ${userId}]\nReaction: :${reaction}: on your message`;

  const result = await runUserMessage("slack", prompt, sessionThreadId);
  if (result.exitCode !== 0 || !result.stdout) return;

  const { cleanedText, reactionEmoji: rawEmoji } = extractReactionDirective(result.stdout);
  const reactionEmoji = normalizeSlackEmoji(rawEmoji);

  if (reactionEmoji) {
    await addReaction(botToken, channelId, itemTs, reactionEmoji);
  }

  if (cleanedText.trim()) {
    await sendMessage(botToken, channelId, cleanedText);
  }
}

// --- Socket Mode WebSocket ---

function sendAck(socket: WebSocket, envelopeId: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ envelope_id: envelopeId, payload: {} }));
  }
}

function connectSocketMode(botToken: string, appToken: string): void {
  const myGeneration = generation;
  (async () => {
    let wsUrl: string;
    try {
      wsUrl = await openSocketModeConnection(appToken);
      debugLog("Socket Mode URL obtained");
    } catch (err) {
      console.error(`[Slack] Failed to get Socket Mode URL: ${err}`);
      if (running && generation === myGeneration) {
        setTimeout(() => connectSocketMode(botToken, appToken), 5000 + Math.random() * 5000);
      }
      return;
    }

    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.onopen = () => {
      debugLog("Socket Mode WebSocket opened");
    };

    socket.onmessage = (event) => {
      let payload: SlackSocketPayload;
      try {
        payload = JSON.parse(String(event.data)) as SlackSocketPayload;
      } catch (err) {
        console.error(`[Slack] Failed to parse payload: ${err}`);
        return;
      }

      // ACK immediately — Slack redelivers un-ACK'd events within seconds
      if (payload.envelope_id) {
        sendAck(socket, payload.envelope_id);
      }

      debugLog(`Received: type=${payload.type}`);

      if (payload.type === "hello") {
        console.log(`[Slack] Socket Mode connected (connections: ${payload.num_connections ?? "?"})`);
        // Fetch bot identity
        slackApi<{ user_id: string; user: string }>(botToken, "auth.test")
          .then((r) => {
            botUserId = r.user_id;
            botUsername = r.user;
            const config = getSettings().slack;
            console.log(`[Slack] Ready as ${botUsername} (${botUserId})`);
            console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
            if (config.allowedUserIds.length === 0) {
              console.warn("[Slack] WARNING: allowedUserIds is empty — all workspace members can send commands");
            }
            const { security } = getSettings();
            console.log(`  Security level: ${security.level}`);
            if (config.listenChannels.length > 0) {
              console.log(`  Listen channels: ${config.listenChannels.join(", ")}`);
            }
          })
          .catch((err) => console.error(`[Slack] auth.test failed: ${err}`));
        return;
      }

      if (payload.type === "disconnect") {
        debugLog(`Disconnect requested: ${payload.reason ?? "unknown"}`);
        socket.close(1000, "Disconnect requested");
        return;
      }

      if (payload.type === "events_api" && payload.payload?.event) {
        const slackEvent = payload.payload.event as SlackEvent & SlackAssistantThreadEvent & SlackAppHomeOpenedEvent;
        if (slackEvent.type === "message") {
          handleMessage(botToken, slackEvent).catch((err) =>
            console.error(`[Slack] Unhandled message error: ${err}`),
          );
        } else if (slackEvent.type === "reaction_added") {
          handleReaction(botToken, slackEvent).catch((err) =>
            console.error(`[Slack] Unhandled reaction error: ${err}`),
          );
        } else if (slackEvent.type === "assistant_thread_started") {
          handleAssistantThreadStarted(slackEvent);
        } else if (slackEvent.type === "assistant_thread_context_changed") {
          handleAssistantThreadContextChanged(slackEvent);
        } else if (slackEvent.type === "app_home_opened" && slackEvent.tab === "home") {
          handleAppHomeOpened(botToken, slackEvent.user).catch((err) =>
            console.error(`[Slack] app_home_opened error: ${err}`),
          );
        }
      }

      if (payload.type === "slash_commands" && payload.payload?.command) {
        const cmd: SlackSlashCommand = {
          command: payload.payload.command,
          text: payload.payload.text ?? "",
          channelId: payload.payload.channel_id ?? "",
          userId: payload.payload.user_id ?? "",
        };
        if (cmd.channelId && cmd.userId) {
          handleSlashCommand(botToken, cmd).catch((err) =>
            console.error(`[Slack] Unhandled slash command error: ${err}`),
          );
        }
      }
    };

    socket.onclose = (event) => {
      debugLog(`Socket Mode closed: code=${event.code} reason=${event.reason}`);
      if (ws === socket) ws = null;
      if (!running || generation !== myGeneration) return;
      // Socket Mode URLs are ephemeral; must call apps.connections.open again on reconnect
      const delay = 3000 + Math.random() * 4000;
      debugLog(`Reconnecting in ${Math.round(delay / 1000)}s...`);
      setTimeout(() => connectSocketMode(botToken, appToken), delay);
    };

    socket.onerror = () => {
      // onclose fires after onerror; reconnection is handled there
    };
  })();
}

// --- Exports ---

export { sendMessage };

export function stopGateway(): void {
  generation++; // invalidates all pending reconnect timers from the previous connection
  running = false;
  if (ws) {
    try {
      ws.close(1000, "Gateway stop requested");
    } catch {
      // best-effort
    }
    ws = null;
  }
  botUserId = null;
  botUsername = null;
  assistantThreads.clear();
  assistantContexts.clear();
}

process.on("SIGTERM", () => {
  stopGateway();
});
process.on("SIGINT", () => {
  stopGateway();
});

export function startGateway(debug = false): void {
  slackDebug = debug;
  // Tokens are read from getSettings() here rather than passed as arguments so that
  // hot-reload in start.ts can call startGateway after reloadSettings() updates the cache.
  const config = getSettings().slack;
  if (ws) stopGateway();
  running = true;
  console.log("Slack bot started (socket mode)");

  (async () => {
    await ensureProjectClaudeMd();
    connectSocketMode(config.botToken, config.appToken);
  })().catch((err) => {
    console.error(`[Slack] Fatal: ${err}`);
  });
}

export async function slack() {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().slack;

  if (!config.botToken || !config.appToken) {
    console.error(
      "Slack tokens not configured. Set slack.botToken and slack.appToken in .claude/claudeclaw/settings.json",
    );
    process.exit(1);
  }

  console.log("Slack bot started (socket mode, standalone)");
  connectSocketMode(config.botToken, config.appToken);
  // Keep process alive
  await new Promise(() => {});
}
