# FundsCheckers Telegram bot

[@Fundscheckersbot](https://t.me/Fundscheckersbot): send it an Ethereum or Solana address, or an ENS
name, and it answers with a button that opens fundscheckers.com inside Telegram (a Mini App) with the
check already running. The bot runs no check itself and stores nothing: the site does all the work,
in the user's own Telegram, exactly as in a browser.

| In Telegram | What happens |
| --- | --- |
| Menu button "Check" | Opens the site as a Mini App |
| `/start` | The site's banner with the welcome text and a button to the site |
| `/help`, `/about`, `/guides` | Texts, with a button to the site |
| `/claim`, or the "How to claim" button under a reply | The steps to follow once something is found |
| An address or a name, `/check 0x…`, `t.me/Fundscheckersbot?start=0x…` | A "Check this address" button → `/?address=…` |
| A check opened from the bot ends | The bot writes the summary in the chat: total, what was found, "How to claim" |
| A transaction hash, anything else | A short explanation |
| Groups | Commands only; plain links (Telegram has no Mini App buttons in groups) |
| `@Fundscheckersbot 0x…` in any chat (inline mode) | Posts a link to the check. Needs `/setinline` in @BotFather |

The summary: when a check ends inside Telegram, the site posts the amounts found (never the address) to
`api/result.js` with Telegram's signed launch data; `lib/result.js` verifies the signature, which names the
user, and builds the message. Nothing is logged, and only anonymous totals are kept (see Statistics). The bot's address is `telegramApi` in
`src/config/site.ts`.

`lib/bot.js` is the whole behaviour as a pure function (update in, Bot API calls out), `api/webhook.js`
is the Vercel function Telegram calls. No dependencies.

## Deploy (once)

The site is a static export, so the bot is its own small Vercel project made from this folder.

1. Vercel → **Add New → Project** → import this repository again → **Root Directory: `bot`**,
   Framework Preset: Other.
2. In that project's **Environment Variables**, add:
   - `TELEGRAM_BOT_TOKEN`: the token from @BotFather
   - `TELEGRAM_WEBHOOK_SECRET`: a random string (`openssl rand -hex 32`)
3. Deploy, then tell Telegram where the bot lives (from this folder, on your computer):

   ```bash
   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/setup.mjs https://<bot-project>.vercel.app
   ```

   It also sets the command list, the descriptions and the menu button. Run it again after changing
   them in `lib/bot.js`.

Optional, in @BotFather: `/setinline` (inline mode), `/setuserpic`, and **Bot Settings → Configure
Mini App** with `https://www.fundscheckers.com/` to get an "Open" button on the bot's profile and
`t.me/Fundscheckersbot?startapp=0x…` links.

The token is a password: it lives in Vercel's environment variables only, never in the repository.
If it leaks, `/revoke` in @BotFather gives a new one.

## Statistics for the owner (`/stats`)

Optional. `/stats` shows the number of users (total, today, 7 and 30 days) and what they did. Only the
owner sees it.

1. Vercel → the bot's project → **Storage** → **Create Database** → **Upstash for Redis** (free plan) →
   connect it to the project. It adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` by itself.
2. Send `/id` to the bot, and add what it answers as `ADMIN_ID` in the project's Environment Variables.
3. Redeploy (Deployments → ⋯ → Redeploy).

Users are counted with HyperLogLog: the database holds an estimate of how many distinct users there
were, never the list of who they are, and no address or message. Counting starts when the database is
connected; without it the bot works the same and counts nothing (`lib/stats.js`).

## Test

```bash
npm test
```

## What the site does for Telegram

- `src/components/TelegramMiniApp.tsx`: inside Telegram only, loads Telegram's script, takes the full
  height and gives Telegram's bars the page's background.
- `src/components/Checker.tsx`: `tgWebAppStartParam` runs the check like `?address=`.
- `vercel.json`: the site may be framed by `web.telegram.org` (Telegram Web shows Mini Apps in a
  frame), and by nobody else.
