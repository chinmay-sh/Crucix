// Telegram — public channel intelligence from conflict zones and OSINT analysts
// Primary mode: Bot API with TELEGRAM_BOT_TOKEN (getUpdates, getChat)
// Fallback mode: Scrape public channel web previews at https://t.me/s/{channel}
// Monitors conflict zones (Ukraine, Middle East), geopolitics, and OSINT channels.

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Curated list of well-known public OSINT / conflict / geopolitics channels
// All verified to have public web previews enabled at https://t.me/s/{id}
// Override with TELEGRAM_CHANNELS env var (comma-separated channel IDs)
const DEFAULT_CHANNELS = [
  // === Conflict: Ukraine/Russia ===
  { id: 'intelslava',        label: 'Intel Slava Z',       topic: 'conflict',    note: 'Conflict updates, pro-Russian perspective' },
  { id: 'legitimniy',        label: 'Legitimniy',          topic: 'conflict',    note: 'Ukrainian politics & conflict analysis' },
  { id: 'wartranslated',     label: 'War Translated',      topic: 'conflict',    note: 'Conflict translations & OSINT' },
  { id: 'ukraine_frontline', label: 'Ukraine Frontline',   topic: 'conflict',    note: 'Frontline situation updates' },
  { id: 'mod_russia',        label: 'Russian MoD',         topic: 'conflict',    note: 'Russian Ministry of Defense official' },
  { id: 'CIG_telegram',      label: 'Conflict Intel Team', topic: 'osint',       note: 'Conflict Intelligence Team analysis' },
  { id: 'RVvoenkor',         label: 'Voenkor RV',          topic: 'conflict',    note: 'Russian military correspondent' },
  { id: 'readovkanews',      label: 'Readovka',            topic: 'conflict',    note: 'Russian conflict news aggregator' },
  { id: 'DeepStateUA',       label: 'DeepState Ukraine',   topic: 'conflict',    note: 'Ukrainian frontline maps & analysis' },
  { id: 'operativnoZSU',     label: 'ZSU Operative',       topic: 'conflict',    note: 'Ukrainian armed forces updates' },
  { id: 'GeneralStaffZSU',   label: 'General Staff ZSU',   topic: 'conflict',    note: 'Ukrainian General Staff official' },
  // === Middle East ===
  { id: 'middleeastosint',   label: 'Middle East OSINT',   topic: 'osint',       note: 'Middle East open source intel' },
  { id: 'inikiforv',         label: 'Nikiforov OSINT',     topic: 'osint',       note: 'Cross-regional OSINT analyst' },
  // === Geopolitics & Analysis ===
  { id: 'geaborning',        label: 'Geo A. Borning',      topic: 'geopolitics', note: 'Geopolitical analysis and forecasting' },
  { id: 'TheIntelligencer',  label: 'The Intelligencer',   topic: 'osint',       note: 'Intelligence community news' },
  // === Markets & Finance ===
  { id: 'WallStreetSilver',  label: 'Wall St Silver',      topic: 'finance',     note: 'Commodities and macro commentary' },
  { id: 'unusual_whales',    label: 'Unusual Whales',      topic: 'finance',     note: 'Market flow and options analysis' },
];

function parseEnvList(raw) {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isNumericChannelId(id) {
  return /^-?\d+$/.test(id || '');
}

// Allow user to add custom channels via env var
function loadChannels() {
  const customIds = parseEnvList(process.env.TELEGRAM_CHANNELS);
  if (customIds.length === 0) return DEFAULT_CHANNELS;

  const existing = new Set(DEFAULT_CHANNELS.map(c => c.id.toLowerCase()));

  const extras = customIds
    .map(id => id.replace(/^@+/, ''))
    .filter(id => !existing.has(id.toLowerCase()))
    .map(id => ({ id, label: id, topic: 'custom', note: 'User-added channel' }));

  return [...DEFAULT_CHANNELS, ...extras];
}

async function resolveChannelsForScrape(channels, token) {
  if (!token) return channels;

  const resolved = await Promise.all(channels.map(async (ch) => {
    if (!isNumericChannelId(ch.id)) return ch;

    try {
      const chat = await getChat(ch.id);
      const username = chat?.result?.username;
      if (username) {
        return { ...ch, id: username.replace(/^@+/, '') };
      }
    } catch {
      // keep original id if lookup fails
    }

    return ch;
  }));

  const seen = new Set();
  return resolved.filter(ch => {
    const key = ch.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Urgent keywords that flag high-priority posts
// Organized by domain for maintainability
const DEFAULT_URGENT_KEYWORDS = [
  // Breaking / meta urgency
  'breaking', 'urgent', 'alert', 'confirmed', 'just in', 'flash',
  // Military / kinetic
  'missile', 'strike', 'explosion', 'airstrike', 'drone', 'bombardment',
  'shelling', 'intercept', 'ICBM', 'hypersonic', 'F-16', 'ATACMS', 'HIMARS',
  // Escalation / de-escalation
  'nuclear', 'chemical', 'biological', 'ceasefire', 'escalation', 'invasion',
  'offensive', 'retreat', 'advance', 'mobilization', 'martial law',
  // Geopolitical
  'nato', 'coup', 'assassination', 'sanctions', 'embargo', 'blockade',
  'summit', 'ultimatum', 'declaration of war', 'peace deal',
  // Casualty / humanitarian
  'casualties', 'killed', 'wounded', 'evacuation', 'refugee', 'humanitarian',
  // Infrastructure / cyber
  'blackout', 'sabotage', 'cyberattack', 'pipeline', 'dam', 'nuclear plant',
  // Financial crisis
  'default', 'bank run', 'circuit breaker', 'flash crash', 'emergency rate',
];

function loadUrgentKeywords() {
  const extraKeywords = parseEnvList(process.env.TELEGRAM_EXTRA_KEYWORDS);
  const set = new Set(DEFAULT_URGENT_KEYWORDS.map(k => k.toLowerCase()));
  for (const kw of extraKeywords) {
    const normalized = kw.toLowerCase();
    if (normalized) set.add(normalized);
  }
  return [...set];
}

// ─── Bot API mode ───────────────────────────────────────────────────────────

const botBase = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;


export async function getUpdates(opts = {}) {
  const { limit = 100, offset = 0 } = opts;
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return safeFetch(`${botBase()}/getUpdates?${params}`);
}

// Get info about a chat/channel by username
export async function getChat(chatId) {
  const params = new URLSearchParams({ chat_id: chatId.startsWith('@') ? chatId : `@${chatId}` });
  return safeFetch(`${botBase()}/getChat?${params}`);
}

// Compact a Bot API message for briefing output
function compactBotMessage(msg) {
  const channel = msg.chat?.username || msg.chat?.title || 'unknown';
  const postId = msg.chat?.username && msg.message_id ? `${msg.chat.username}/${msg.message_id}` : null;
  const url = msg.link || (postId ? `https://t.me/${postId}` : undefined);
  return {
    text: msg.text || msg.caption || '',
    date: msg.date ? new Date(msg.date * 1000).toISOString() : null,
    chat: msg.chat?.title || msg.chat?.username || 'unknown',
    channel,
    views: msg.views || 0,
    hasMedia: !!(msg.photo || msg.video || msg.document),
    postId,
    url,
  };
}

// Fetch updates via Bot API and organize by channel
async function fetchBotUpdates() {
  const result = await getUpdates({ limit: 100 });
  if (!result?.ok || !Array.isArray(result.result)) {
    return { error: result?.description || 'Bot API request failed' };
  }

  const messages = result.result
    .map(u => u.message || u.channel_post || u.edited_channel_post)
    .filter(Boolean)
    .map(compactBotMessage);

  return { messages, count: messages.length };
}

// ─── Web preview scraping fallback ──────────────────────────────────────────

// Fetch raw HTML from a URL (safeFetch truncates non-JSON to 500 chars, too short)
async function fetchHTML(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

function decodeTelegramText(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function seemsTruncatedText(text = '') {
  const trimmed = text.trim();
  return trimmed.endsWith('...') || trimmed.endsWith('…');
}

function extractMessageText(html) {
  const textMatch = html?.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  return textMatch ? decodeTelegramText(textMatch[1]) : '';
}

async function hydrateFullPostText(post) {
  if (!post?.url || !seemsTruncatedText(post.text)) return post;

  const html = await fetchHTML(post.url);
  if (!html) return post;

  const fullText = extractMessageText(html);
  if (!fullText || fullText.length <= (post.text || '').length) return post;

  return {
    ...post,
    text: fullText,
  };
}

async function hydrateTruncatedPosts(posts, limit = 6) {
  const indices = [];
  for (let i = 0; i < posts.length && indices.length < limit; i++) {
    if (seemsTruncatedText(posts[i]?.text)) indices.push(i);
  }
  if (indices.length === 0) return posts;

  const hydrated = [...posts];
  const replacements = await Promise.all(indices.map(i => hydrateFullPostText(posts[i])));
  indices.forEach((idx, replacementIndex) => {
    hydrated[idx] = replacements[replacementIndex];
  });
  return hydrated;
}

// Parse messages from Telegram web preview HTML (https://t.me/s/channel)
// The HTML contains <div class="tgme_widget_message_wrap"> blocks with message content.
function parseWebPreview(html, channelId) {
  if (!html) return [];

  const messages = [];

  // Each message sits inside a tgme_widget_message_wrap div
  // We extract using the data-post attribute which has the format "channel/msgId"
  const msgBlockRegex = /class="tgme_widget_message_wrap[^"]*"[\s\S]*?data-post="([^"]*)"([\s\S]*?)(?=class="tgme_widget_message_wrap|$)/gi;
  // Simpler: split on message boundaries using data-post
  const postRegex = /data-post="([^"]+)"([\s\S]*?)(?=data-post="|$)/gi;

  let match;
  while ((match = postRegex.exec(html)) !== null && messages.length < 20) {
    const postId = match[1]; // e.g. "intelslava/12345"
    const block = match[2];

    // Extract message text from tgme_widget_message_text
    const text = extractMessageText(block);

    // Extract view count
    const viewsMatch = block.match(/class="tgme_widget_message_views"[^>]*>([\s\S]*?)<\/span>/i);
    let views = 0;
    if (viewsMatch) {
      const raw = viewsMatch[1].trim();
      if (raw.endsWith('K')) views = parseFloat(raw) * 1000;
      else if (raw.endsWith('M')) views = parseFloat(raw) * 1000000;
      else views = parseInt(raw, 10) || 0;
    }

    // Extract datetime
    const timeMatch = block.match(/datetime="([^"]+)"/i);
    const date = timeMatch ? timeMatch[1] : null;

    // Check for media (photos, videos)
    const hasMedia = /tgme_widget_message_photo|tgme_widget_message_video/i.test(block);

    const url = postId ? `https://t.me/${postId}` : undefined;

    if (text || hasMedia) {
      messages.push({
        postId,
        text,
        date,
        views,
        hasMedia,
        channel: channelId,
        url,
      });
    }
  }

  return messages;
}

// Scrape a single channel's web preview
async function scrapeChannel(channelId) {
  const url = `https://t.me/s/${channelId}`;
  const html = await fetchHTML(url);
  if (!html) return { channel: channelId, error: 'Failed to fetch', posts: [] };

  // Extract channel title from page
  const titleMatch = html.match(/class="tgme_channel_info_header_title[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    || html.match(/<title>(.*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
    : channelId;

  const parsedPosts = parseWebPreview(html, channelId);
  const posts = await hydrateTruncatedPosts(parsedPosts);

  return { channel: channelId, title, posts, postCount: posts.length };
}

// ─── Analysis helpers ───────────────────────────────────────────────────────

// Flag urgent/high-priority posts
function flagUrgent(post, urgentKeywords) {
  const lower = (post.text || '').toLowerCase();
  const matched = urgentKeywords.filter(k => lower.includes(k));
  return matched.length > 0 ? matched : null;
}

// Score a post's significance (views + urgency + length)
function significanceScore(post, urgentKeywords) {
  let score = 0;
  score += Math.min(post.views / 1000, 50);              // views weight (capped)
  const urgentFlags = flagUrgent(post, urgentKeywords);
  if (urgentFlags) score += urgentFlags.length * 10;       // urgency weight
  if (post.text?.length > 100) score += 5;                 // substantive text bonus
  if (post.hasMedia) score += 3;                           // media bonus
  return score;
}

// Group posts by topic based on the channel config
function groupByTopic(allPosts, channelMeta) {
  const groups = {};
  for (const post of allPosts) {
    const meta = channelMeta.find(c => c.id === post.channel);
    const topic = meta?.topic || 'other';
    if (!groups[topic]) groups[topic] = [];
    groups[topic].push(post);
  }
  return groups;
}

// ─── Briefing ───────────────────────────────────────────────────────────────

export async function briefing() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const configuredChannels = loadChannels();
  const channels = await resolveChannelsForScrape(configuredChannels, token);
  const unresolvedNumericChannels = configuredChannels.filter(ch => {
    if (!isNumericChannelId(ch.id)) return false;
    return channels.some(resolved => resolved.id === ch.id);
  });
  const urgentKeywords = loadUrgentKeywords();

  const botPosts = [];
  let botError = null;
  let botMessageCount = 0;

  // Bot API is additive now; we still scrape configured channels.
  if (token) {
    try {
      const botData = await fetchBotUpdates();
      if (!botData.error && botData.count > 0) {
      const enriched = botData.messages.map(m => ({
          ...m,
          urgentFlags: flagUrgent(m, urgentKeywords),
          score: significanceScore(m, urgentKeywords),
        }));
        const hydratedBotPosts = await hydrateTruncatedPosts(enriched, 4);
        botPosts.push(...hydratedBotPosts);
        botMessageCount = botData.count;
      } else if (botData.error) {
        botError = botData.error;
      }
    } catch (err) {
      botError = err?.message || 'Bot API request failed';
    }
  }

  // Scrape configured channels (including TELEGRAM_CHANNELS extras)
  const results = [];
  const errors = [];

  for (let i = 0; i < channels.length; i += 3) {
    const batch = channels.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map(ch => scrapeChannel(ch.id))
    );
    results.push(...batchResults);

    if (i + 3 < channels.length) await delay(1500);
  }

  const allPosts = [];
  const channelSummaries = [];

  for (const r of results) {
    const meta = channels.find(c => c.id === r.channel);
    if (r.error) {
      errors.push({ channel: r.channel, error: r.error });
    }
    const enriched = (r.posts || []).map(p => ({
      ...p,
      urgentFlags: flagUrgent(p, urgentKeywords),
      score: significanceScore(p, urgentKeywords),
    }));
    allPosts.push(...enriched);

    channelSummaries.push({
      channel: r.channel,
      title: r.title || meta?.label || r.channel,
      topic: meta?.topic || 'other',
      postCount: r.postCount || 0,
      reachable: !r.error,
    });
  }

  if (botPosts.length > 0) {
    allPosts.push(...botPosts);
  }

  const seen = new Set();
  const dedupedPosts = [];
  for (const post of allPosts) {
    const key = `${post.channel || post.chat || 'unknown'}|${post.date || ''}|${(post.text || '').slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedPosts.push(post);
  }

  dedupedPosts.sort((a, b) => b.score - a.score);

  const urgentPosts = dedupedPosts.filter(p => p.urgentFlags).slice(0, 15);

  const byTopic = groupByTopic(dedupedPosts, channels);
  const topicSummary = {};
  for (const [topic, posts] of Object.entries(byTopic)) {
    topicSummary[topic] = {
      totalPosts: posts.length,
      urgentCount: posts.filter(p => p.urgentFlags).length,
      topPosts: posts.sort((a, b) => b.score - a.score).slice(0, 5),
    };
  }

  let status = 'web_scrape';
  if (token && botPosts.length > 0) status = 'bot_api_plus_web_scrape';
  else if (token && botError) status = 'bot_api_error_fallback_scrape';
  else if (token) status = 'bot_api_empty_fallback_scrape';

  return {
    source: 'Telegram',
    timestamp: new Date().toISOString(),
    status,
    method: 'Public channel web preview scraping + optional Bot API merge',
    channelsMonitored: channelSummaries.length,
    channelsReachable: channelSummaries.filter(c => c.reachable).length,
    totalPosts: dedupedPosts.length,
    urgentPosts,
    byTopic: topicSummary,
    channels: channelSummaries,
    errors: errors.length > 0 ? errors : undefined,
    topPosts: dedupedPosts.slice(0, 15),
    botMessages: botMessageCount,
    botError: botError || undefined,
    unresolvedNumericChannels: unresolvedNumericChannels.length > 0
      ? unresolvedNumericChannels.map(c => c.id)
      : undefined,
    hint: token
      ? undefined
      : 'Set TELEGRAM_BOT_TOKEN in .env for Bot API access. Create a bot via @BotFather on Telegram.',
  };
}

// ─── CLI runner ─────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('telegram.mjs')) {
  console.log('Telegram OSINT — fetching public channel intelligence...\n');
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
