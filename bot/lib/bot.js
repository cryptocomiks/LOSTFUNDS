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

/** A wallet with a small unclaimed balance (Maker SCD vault, 2019), to show what a result looks like. */
export const DEMO_ADDRESS = "0x302bdfc4c45454a0d8544e7395a6cba8cd7a0c23";

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
      `👋 <b>Welcome to ${name}!</b>\n\n` +
      `💰 <b>Is money still waiting for you?</b>\n` +
      `Over $180 million sits forgotten in old Ethereum apps alone. Some of it may be yours.\n\n` +
      `I look for:\n` +
      `🌉 bridge withdrawals you never finished\n` +
      `🪂 airdrops you never claimed\n` +
      `🎁 rewards and staking payouts\n` +
      `🏦 deposits left in old apps\n\n` +
      `💡 <b>Example:</b> a wallet that opened a Maker vault in 2019 still has ~0.016 ETH waiting there. ` +
      `Its owner probably has no idea.\n\n` +
      `👇 <b>Your turn:</b> paste an Ethereum or Solana address, or an ENS name like <code>vitalik.eth</code>.\n\n` +
      `⚡️ 100+ sources, about a minute\n` +
      `🔒 Free, read-only, no wallet connection, never a seed phrase`,
    demo:
      `✨ <b>Example wallet</b> (a stranger's, picked from public data)\n<code>${DEMO_ADDRESS}</code>\n\n` +
      `Tap the button to see what a result looks like. Then paste your own address 👇`,
    askAddress: "✍️ Send me an Ethereum or Solana address, or an ENS name (for example <code>vitalik.eth</code>).",
    notAddress:
      "🤔 That doesn't look like a wallet address.\n\nSend an Ethereum address (<code>0x…</code>), " +
      "a Solana address or an ENS name.",
    txHash: "⚠️ That's a transaction hash, not a wallet address. Send the address of the wallet instead.",
    target: (label, value) =>
      `🔎 <b>${label}</b>\n<code>${esc(value)}</code>\n\n` +
      `1️⃣ Tap <b>Check this address</b>. 100+ sources are checked, it takes about a minute.\n` +
      `2️⃣ When it's done, I'll send you the summary right here, with the steps to claim.`,
    help:
      `ℹ️ <b>How it works</b>\n\n` +
      `1️⃣ Send a wallet address or an ENS name.\n` +
      `2️⃣ Tap <b>Check this address</b>: ${name} opens here in Telegram and checks 100+ sources.\n` +
      `3️⃣ When the check ends, I send the summary in this chat. Each result says where to claim, on the project's own site.\n\n` +
      `<b>Commands</b>\n` +
      `🔍 /check <code>address</code> – check an address\n` +
      `✅ /claim – what to do when something is found\n` +
      `📚 /guides – step-by-step claim guides\n` +
      `🛡 /about – what this is, and how it stays safe\n` +
      `ℹ️ /help – this message`,
    claim:
      `✅ <b>Found something? Here is what to do</b>\n\n` +
      `1️⃣ <b>Open the result.</b> Each one shows the amount, where it is waiting and a "where to claim" link.\n\n` +
      `2️⃣ <b>Go to the official site.</b> Use the link in the result, or type the project's address yourself. ` +
      `Never follow a link sent by a stranger.\n\n` +
      `3️⃣ <b>Connect the wallet that owns the funds</b>, there and only there. ${name} itself never asks you to connect.\n\n` +
      `4️⃣ <b>Confirm the claim.</b> It is an ordinary transaction: you pay the network fee ` +
      `(cents on most networks, more on Ethereum) and the funds arrive at your own address.\n\n` +
      `5️⃣ <b>Check again</b> a few minutes later: the result should be gone.\n\n` +
      `📚 No official site left for an old app? The guides explain how to claim straight from the contract.\n\n` +
      `🚨 <b>Never</b> share a seed phrase or a private key, and never pay a "recovery fee". ` +
      `Nobody from ${name} will message you first.`,
    guides:
      `📚 <b>Claim guides</b>\n\n` +
      `Each result comes with its claim steps. The site also has step-by-step guides for 20+ bridges ` +
      `and protocols that can't be checked automatically.`,
    about:
      `🛡 <b>${name}</b> is a free, read-only checker.\n\n` +
      `👀 It only reads public blockchain data for the address you give it.\n` +
      `🔌 It never connects to a wallet and never asks you to sign anything.\n` +
      `🗑 This bot stores nothing. When a check opened from here ends, the app sends me the amounts found ` +
      `(never the address) so I can sum them up in this chat.\n` +
      `✅ Claims are made by you, on each project's official site.\n\n` +
      `🚨 <b>Stay safe:</b> nobody from ${name} will ever message you first, ask for a seed phrase, ` +
      `a private key or a "recovery fee". Anyone who does is a scammer.`,
    share: `💸 Check whether crypto is still waiting for you somewhere. Free, read-only, no wallet connection.`,
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
    text: "📣 Share with a friend",
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

const claimButton = { text: "✅ How to claim", callback_data: "claim" };
const guidesButton = (cfg, isPrivate) => openButton("📚 Open the guides", `${cfg.siteUrl}/#guides`, isPrivate);

/** The welcome: the site's banner with the text as its caption. */
function welcome(cfg, chatId, keyboard) {
  return {
    method: "sendPhoto",
    params: {
      chat_id: chatId,
      photo: `${cfg.siteUrl}/og.png`,
      caption: texts(cfg).welcome,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    },
  };
}

function targetReply(cfg, chatId, target, isPrivate) {
  const T = texts(cfg);
  if (!target) return send(chatId, T.notAddress);
  if (target.kind === "tx") return send(chatId, T.txHash);
  const label = target.kind === "solana" ? "Solana address" : target.kind === "name" ? "Name" : "Address";
  return send(chatId, T.target(label, target.value), [
    [openButton("🔍 Check this address", checkUrl(cfg, target.value), isPrivate)],
    [claimButton, shareButton(cfg)],
  ]);
}

function onMessage(cfg, msg) {
  const chatId = msg.chat?.id;
  const text = msg.text;
  if (chatId === undefined || typeof text !== "string") return [];
  const isPrivate = msg.chat.type === "private";
  const T = texts(cfg);
  const home = [[openButton(`🚀 Open ${cfg.siteName}`, `${cfg.siteUrl}/`, isPrivate)], [claimButton, shareButton(cfg)]];
  const start = [[{ text: "✨ Try with an example", callback_data: "demo" }], ...home];

  const m = text.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
  if (m) {
    const [, command, mention, rest = ""] = m;
    // In a group, a command addressed to another bot isn't ours.
    if (mention && mention.toLowerCase() !== cfg.botUsername.toLowerCase()) return [];
    const arg = rest.trim();
    switch (command.toLowerCase()) {
      case "start":
        // Deep links: t.me/<bot>?start=<address>
        return arg ? [targetReply(cfg, chatId, parseTarget(arg), isPrivate)] : [welcome(cfg, chatId, start)];
      case "check":
        return arg ? [targetReply(cfg, chatId, parseTarget(arg), isPrivate)] : [send(chatId, T.askAddress)];
      case "help":
        return [send(chatId, T.help, home)];
      case "claim":
        return [send(chatId, T.claim, [[guidesButton(cfg, isPrivate)]])];
      case "guides":
        return [send(chatId, T.guides, [[guidesButton(cfg, isPrivate)]])];
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

/** The "How to claim" button under a reply: the steps, as a new message. */
function onCallback(cfg, q) {
  const calls = [{ method: "answerCallbackQuery", params: { callback_query_id: q.id } }];
  const chat = q.message?.chat;
  if (q.data === "demo" && chat)
    calls.push(
      send(chat.id, texts(cfg).demo, [[openButton("🔍 See the example result", checkUrl(cfg, DEMO_ADDRESS), chat.type === "private")], [claimButton]]),
    );
  if (q.data === "claim" && chat) calls.push(send(chat.id, texts(cfg).claim, [[guidesButton(cfg, chat.type === "private")]]));
  return calls;
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
  if (update?.callback_query) return onCallback(cfg, update.callback_query);
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
          { command: "start", description: "Welcome" },
          { command: "check", description: "Check an address: /check 0x…" },
          { command: "claim", description: "What to do when something is found" },
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
          "💸 Find the crypto you forgot to claim:\n" +
          "🌉 unfinished bridge withdrawals\n🪂 unclaimed airdrops\n🎁 rewards\n🏦 old deposits\n\n" +
          "Send an Ethereum or Solana address, or an ENS name.\n\n🔒 Free, read-only, no wallet connection.",
      },
    },
    {
      method: "setMyShortDescription",
      params: { short_description: "💸 Find the crypto you forgot to claim. Free, read-only, no wallet connection. fundscheckers.com" },
    },
    {
      method: "setChatMenuButton",
      params: { menu_button: { type: "web_app", text: "🔍 Check", web_app: { url: `${cfg.siteUrl}/` } } },
    },
  ];
}
