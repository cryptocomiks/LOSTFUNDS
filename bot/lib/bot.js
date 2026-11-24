/**
 * The bot's whole behaviour, as a pure function: a Telegram update in, a list of Bot API calls out.
 * No network here, so it can be tested without Telegram (test/bot.test.js).
 *
 * The bot never runs a check itself and never stores anything: an address becomes a button that
 * opens the site, as a Mini App, with the check already started.
 */

export const DEFAULTS = {
  siteUrl: "https://www.fundscheckers.com",
  siteName: "FundsCheckers",
  botUsername: "Fundscheckersbot",
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Byte length of a base58 string, or -1 if it isn't base58. */
function base58Length(s) {
  const bytes = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return -1;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return bytes.length + zeros;
}

const isEvm = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
const isSolana = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58Length(s) === 32;
const isName = (s) => /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.[a-z]{2,}$/i.test(s) && s.length <= 255;
const isTxHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(s);

/**
 * What a piece of text holds: a wallet address or name the site can check, a transaction hash
 * (a common mistake), or nothing usable.
 * @returns {{ kind: "evm" | "solana" | "name", value: string } | { kind: "tx" } | null}
 */
export function parseTarget(text) {
  const words = String(text ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/^[<([{"'`]+|[>)\]}"'`.,;:!?]+$/g, ""))
    .filter(Boolean);
  for (const w of words) if (isEvm(w)) return { kind: "evm", value: w };
  for (const w of words) if (isSolana(w)) return { kind: "solana", value: w };
  // A name only counts when it is the whole message: "see you at 10.am" is not a wallet.
  if (words.length === 1 && isName(words[0])) return { kind: "name", value: words[0].toLowerCase() };
  for (const w of words) if (isTxHash(w)) return { kind: "tx" };
  return null;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a) => (a.length > 20 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function texts(cfg) {
  const name = cfg.siteName;
  return {
    welcome:
      `<b>${name}</b> finds the crypto you forgot to claim: unfinished bridge withdrawals, ` +
      `unclaimed airdrops, rewards and old deposits.\n\n` +
      `Send me an Ethereum or Solana address, or an ENS name, and I'll open the check for it.\n\n` +
      `Free and read-only. No wallet connection, and I will never ask for a seed phrase or a private key.`,
    askAddress: "Send me an Ethereum or Solana address, or an ENS name (for example <code>vitalik.eth</code>).",
    notAddress:
      "That doesn't look like a wallet address. Send an Ethereum address (<code>0x…</code>), " +
      "a Solana address or an ENS name.",
    txHash: "That's a transaction hash, not a wallet address. Send the address of the wallet instead.",
    help:
      `<b>How it works</b>\n` +
      `1. Send a wallet address or an ENS name.\n` +
      `2. Tap <b>Check this address</b>: ${name} opens here in Telegram and checks 100+ sources.\n` +
      `3. Each result says where to claim, on the project's own site.\n\n` +
      `<b>Commands</b>\n` +
      `/check <code>address</code> – check an address\n` +
      `/guides – step-by-step claim guides\n` +
      `/about – what this is, and how it stays safe\n` +
      `/help – this message`,
    guides:
      `Each result comes with its claim steps. The site also has step-by-step guides for 20+ bridges ` +
      `and protocols that can't be checked automatically.`,
    about:
      `<b>${name}</b> is a free, read-only checker.\n\n` +
      `• It only reads public blockchain data for the address you give it.\n` +
      `• It never connects to a wallet and never asks you to sign anything.\n` +
      `• This bot stores nothing: it only turns your address into a link to the site.\n` +
      `• Claims are made by you, on each project's official site.\n\n` +
      `<b>Stay safe:</b> nobody from ${name} will ever message you first, ask for a seed phrase, ` +
      `a private key or a "recovery fee". Anyone who does is a scammer.`,
    share: `Check whether crypto is still waiting for you somewhere. Free, read-only, no wallet connection.`,
  };
}

/** The site's address for one wallet: the check starts on load. */
export function checkUrl(cfg, value) {
  return `${cfg.siteUrl}/?address=${encodeURIComponent(value)}`;
}

/**
 * A button that opens a page of the site. Mini App buttons only exist in private chats, so groups
 * get a plain link.
 */
function openButton(text, url, isPrivate) {
  return isPrivate ? { text, web_app: { url } } : { text, url };
}

function shareButton(cfg) {
  const link = `https://t.me/${cfg.botUsername}`;
  return {
    text: "Share with a friend",
    url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(texts(cfg).share)}`,
  };
}

function send(chatId, text, keyboard) {
  return {
    method: "sendMessage",
    params: {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    },
  };
}

function targetReply(cfg, chatId, target, isPrivate) {
  const T = texts(cfg);
  if (!target) return send(chatId, T.notAddress);
  if (target.kind === "tx") return send(chatId, T.txHash);
  const label = target.kind === "solana" ? "Solana address" : target.kind === "name" ? "Name" : "Address";
  return send(chatId, `${label}: <code>${esc(target.value)}</code>\n\nTap the button to run the check. It takes about a minute.`, [
    [openButton("🔍 Check this address", checkUrl(cfg, target.value), isPrivate)],
    [shareButton(cfg)],
  ]);
}

function onMessage(cfg, msg) {
  const chatId = msg.chat?.id;
  const text = msg.text;
  if (chatId === undefined || typeof text !== "string") return [];
  const isPrivate = msg.chat.type === "private";
  const T = texts(cfg);
  const home = [[openButton(`Open ${cfg.siteName}`, `${cfg.siteUrl}/`, isPrivate)], [shareButton(cfg)]];

  const m = text.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
  if (m) {
    const [, command, mention, rest = ""] = m;
    // In a group, a command addressed to another bot isn't ours.
    if (mention && mention.toLowerCase() !== cfg.botUsername.toLowerCase()) return [];
    const arg = rest.trim();
    switch (command.toLowerCase()) {
      case "start":
        // Deep links: t.me/<bot>?start=<address>
        return arg ? [targetReply(cfg, chatId, parseTarget(arg), isPrivate)] : [send(chatId, T.welcome, home)];
      case "check":
        return arg ? [targetReply(cfg, chatId, parseTarget(arg), isPrivate)] : [send(chatId, T.askAddress)];
      case "help":
        return [send(chatId, T.help, home)];
      case "guides":
        return [send(chatId, T.guides, [[openButton("Open the guides", `${cfg.siteUrl}/#guides`, isPrivate)]])];
      case "about":
        return [send(chatId, T.about, home)];
      default:
        return isPrivate ? [send(chatId, T.help, home)] : [];
    }
  }

  // Free text: answered in private chats only, so the bot stays quiet in groups.
  if (!isPrivate) return [];
  return [targetReply(cfg, chatId, parseTarget(text), true)];
}

/** Inline mode: "@bot 0x…" in any chat posts a link to the check for that address. */
function onInlineQuery(cfg, q) {
  const T = texts(cfg);
  const target = parseTarget(q.query);
  const results = [];
  if (target && target.kind !== "tx") {
    const url = checkUrl(cfg, target.value);
    results.push({
      type: "article",
      id: "check",
      title: `Check ${short(target.value)}`,
      description: "Unclaimed airdrops, stuck bridge withdrawals, rewards and old deposits",
      input_message_content: {
        message_text: `Is crypto still waiting for <code>${esc(target.value)}</code>? Check it on ${cfg.siteName}: free and read-only.`,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
      reply_markup: { inline_keyboard: [[{ text: "🔍 Check this address", url }]] },
    });
  }
  results.push({
    type: "article",
    id: "site",
    title: `Share ${cfg.siteName}`,
    description: "Find the crypto you forgot to claim",
    input_message_content: { message_text: T.share, link_preview_options: { is_disabled: true } },
    reply_markup: { inline_keyboard: [[{ text: `Open ${cfg.siteName}`, url: `https://t.me/${cfg.botUsername}` }]] },
  });
  return [
    {
      method: "answerInlineQuery",
      // Results depend on the query only, so Telegram may cache them for everyone.
      params: { inline_query_id: q.id, results, cache_time: 300, is_personal: false },
    },
  ];
}

/**
 * @param {object} update A Telegram update.
 * @param {Partial<typeof DEFAULTS>} [config]
 * @returns {{ method: string, params: object }[]} Bot API calls to make, in order.
 */
export function handleUpdate(update, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  cfg.siteUrl = cfg.siteUrl.replace(/\/+$/, "");
  if (update?.message) return onMessage(cfg, update.message);
  if (update?.inline_query) return onInlineQuery(cfg, update.inline_query);
  return [];
}

/** What the bot shows in Telegram's own UI: command list, descriptions, menu button. */
export function profileCalls(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  cfg.siteUrl = cfg.siteUrl.replace(/\/+$/, "");
  return [
    {
      method: "setMyCommands",
      params: {
        commands: [
          { command: "start", description: "Open FundsCheckers" },
          { command: "check", description: "Check an address: /check 0x…" },
          { command: "guides", description: "Step-by-step claim guides" },
          { command: "about", description: "What this is, and how it stays safe" },
          { command: "help", description: "How to use the bot" },
        ],
      },
    },
    {
      method: "setMyDescription",
      params: {
        description:
          "Find the crypto you forgot to claim: unfinished bridge withdrawals, unclaimed airdrops, rewards and old deposits.\n\n" +
          "Send an Ethereum or Solana address, or an ENS name. Free, read-only, no wallet connection.",
      },
    },
    {
      method: "setMyShortDescription",
      params: { short_description: "Find the crypto you forgot to claim. Free, read-only, no wallet connection. fundscheckers.com" },
    },
    {
      method: "setChatMenuButton",
      params: { menu_button: { type: "web_app", text: "Check", web_app: { url: `${cfg.siteUrl}/` } } },
    },
  ];
}
