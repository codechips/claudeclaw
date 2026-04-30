---
description: Show Slack bot status and manage global session
---

Show the Slack bot integration status. Check the following:

1. **Configuration**: Read `.claude/claudeclaw/settings.json` and check if `slack.botToken` and `slack.appToken` are set (show masked tokens: first 5 chars + "..." for each). Show `allowedUserIds` (or "all workspace members" if empty), `listenChannels`, and `homeChannel` if set (or "(DM allowedUserIds)" if not).

2. **Global Session**: Read `.claude/claudeclaw/session.json` and show:
   - Session UUID (first 8 chars)
   - Created at
   - Last used at
   - Note: This session is shared across heartbeat, cron jobs, Telegram, Discord, and top-level Slack messages. Per-thread Slack conversations (channel threads and AI App assistant threads) use separate sessions keyed as `slack:<channelId>:<threadTs>`.

3. **If $ARGUMENTS contains "clear"**: Delete `.claude/claudeclaw/session.json` to reset the global session. Confirm to the user. The next run from any source (heartbeat, cron, Telegram, Discord, or Slack) will create a fresh session. Note: per-thread Slack sessions are not affected.

4. **Running**: Check if the daemon is running by reading `.claude/claudeclaw/daemon.pid`. The Slack bot runs in-process with the daemon when `slack.botToken` and `slack.appToken` are both configured.

5. **Slash commands** (declared in `docs/slack-app-manifest.yaml`):
   - `/start` — show welcome message
   - `/reset` — reset the global session (next message starts fresh)
   - `/compact` — compact the current session to free context
   - `/status` — show session info, model, and security level
   These work in any DM or channel where the bot is present, subject to `allowedUserIds`. If you've added or changed slash commands and the user reports "command not found," tell them to reinstall the app from the Slack app manifest page.

Format the output clearly for the user.
