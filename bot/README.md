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
| A transaction hash, anything else | A short explanation |
| Groups | Commands only; plain links (Telegram has no Mini App buttons in groups) |
| `@Fundscheckersbot 0x…` in any chat (inline mode) | Posts a link to the check. Needs `/setinline` in @BotFather |

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
