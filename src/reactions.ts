/**
 * Strip [react:emoji] directives from a Claude response and return the first one
 * found. Used by adapter implementations (telegram, discord, slack) so Claude can
 * react to user messages instead of (or in addition to) replying.
 *
 * `reactionEmoji` is the raw captured value — adapters normalize platform-specific
 * formatting (e.g. Slack's `:thumbsup:` colons) at the call site.
 */
export function extractReactionDirective(text: string): {
  cleanedText: string;
  reactionEmoji: string | null;
} {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}
