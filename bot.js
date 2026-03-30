// ╔══════════════════════════════════════════════════════════════════════════╗
// ║   🎓 STUDENT PROMPT HUB AI — bot.js v4.0                              ║
// ║   Hugging Face Docker Edition — MongoDB Persistent Cloud DB           ║
// ║   Self-Training & Auto-Moderation Edition                             ║
// ║   By Propeak Digital Academy | Founder: Peculiar                      ║
// ║   Engine: Groq AI (Llama 4 Scout + Whisper) + Telegraf v4            ║
// ╚══════════════════════════════════════════════════════════════════════════╝

'use strict';
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════
// § 1. IMPORTS & INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const { Telegraf, Markup, session } = require('telegraf');
const Groq                           = require('groq-sdk');
const db                             = require('./db');          // ← MongoDB helper
const fetch                          = require('node-fetch');
const axios                          = require('axios');
const fs                             = require('fs');
const path                           = require('path');
const { v4: uuidv4 }                 = require('uuid');
const gTTS                           = require('gtts');
const os                             = require('os');
const http                           = require('http');          // ← minimal health server

// ── Groq AI Client ────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODELS = {
  primary:  process.env.GROQ_MODEL          || 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
  fallback: process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant',
  vision:   process.env.GROQ_VISION_MODEL   || 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
  whisper:  process.env.GROQ_WHISPER_MODEL  || 'whisper-large-v3'
};

// ── Constants ─────────────────────────────────────────────────────────────────
const WA_CHANNEL     = 'https://whatsapp.com/channel/0029VbBUkLQLCoWzVkAHBg2D';
const WA_SUPPORT     = 'https://wa.me/2347042999216';
const WA_FEEDBACK    = 'https://wa.me/2347042999216?text=Feedback%3A%20';
const POLLINATIONS   = process.env.POLLINATIONS_URL || 'https://image.pollinations.ai/prompt';
const DAILY_LIMIT    = parseInt(process.env.DAILY_LIMIT || '100', 10);
const BOT_SHARE_LINK = 'https://t.me/StudentPromptHubAIBot';
const ADMIN_TG_ID    = process.env.ADMIN_TELEGRAM_ID || null;
const TMP_DIR        = process.env.TMPDIR || os.tmpdir();
const PORT           = parseInt(process.env.PORT || '7860', 10);

// ── Bot Init ──────────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
bot.use(session());
bot.use((ctx, next) => { if (!ctx.session) ctx.session = {}; return next(); });

// ═══════════════════════════════════════════════════════════════════════════
// § 2. MINIMAL HEALTH SERVER (Hugging Face Spaces requires open port)
// ═══════════════════════════════════════════════════════════════════════════

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('✅ Student Prompt Hub AI v4.0 is Online & Running...');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alive: true, version: '4.0.0', ts: new Date().toISOString() }));
  }
});
healthServer.listen(PORT, () => console.log(`[Health] ✅ Health server on port ${PORT}`));

// ═══════════════════════════════════════════════════════════════════════════
// § 3. CORE HELPER FUNCTIONS (pure, no DB calls)
// ═══════════════════════════════════════════════════════════════════════════

// Strip rogue backslashes — Telegram Markdown quirk
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\\([!._\-[\]()~`>#+=|{}])/g, '$1')
    .replace(/\\\*/g, '*')
    .trim();
}

// Safe send: try Markdown, fall back to plain text
async function safeSend(ctx, text, extra = {}) {
  const cleaned = cleanText(String(text || ''));
  try {
    return await ctx.replyWithMarkdown(cleaned, extra);
  } catch {
    try {
      return await ctx.reply(cleaned.replace(/[*_`[\]]/g, ''), extra);
    } catch (e) {
      console.error('[safeSend]', e.message);
    }
  }
}

// Safe edit an existing message
async function safeEdit(ctx, msgId, text) {
  const cleaned = cleanText(String(text || ''));
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, cleaned, { parse_mode: 'Markdown' });
  } catch (_) {
    try { await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, cleaned.replace(/[*_`[\]]/g, '')); } catch (__) {}
  }
}

// Visual progress bar
function usageBar(count, limit) {
  const filled = Math.round(Math.min(count / limit, 1) * 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${count}/${limit}`;
}

// Animated loading message (edit loop)
async function animateLoading(ctx, frames, delayMs = 800) {
  const msg = await ctx.reply(frames[0]);
  for (let i = 1; i < frames.length; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    await safeEdit(ctx, msg.message_id, frames[i]);
  }
  return msg;
}

// Split long text for Telegram's 4096-char limit
function splitMessage(text, limit = 3800) {
  const chunks = [];
  let i = 0;
  while (i < text.length) { chunks.push(text.slice(i, i + limit)); i += limit; }
  return chunks;
}

// Send possibly multi-part message
async function sendLong(ctx, text, extra = {}) {
  const chunks = splitMessage(cleanText(text));
  for (let i = 0; i < chunks.length; i++) {
    await safeSend(ctx, chunks[i], i === chunks.length - 1 ? extra : {});
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
  }
}

// Delete a temp file safely
function cleanupFile(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// § 4. AUTO-MODERATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

const BAD_WORDS = [
  'fuck','shit','bitch','bastard','asshole','ass','damn','crap','piss','dick',
  'cock','pussy','cunt','whore','slut','fag','faggot','retard','nigger','nigga',
  'kike','spic','chink','dyke','twat','wanker','jackass','moron','idiot',
  'stupid','dumbass','bullshit','motherfucker','fucker','hell',
  'wtf','stfu','gtfo','lmao','omfg','sh1t','a$$','b1tch','f**k','s**t',
  'kill yourself','kys','go die','i hate you','you suck','loser','trash',
  'bomb','terrorist','explosion','murder','rape','shoot','stab','weapon',
  'hack','hacker','exploit','crack','bypass','jailbreak','ddos'
];

function scoreToxicity(text) {
  const t       = text.toLowerCase();
  let score     = 0;
  const matched = [];

  for (const word of BAD_WORDS) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(t)) { score++; matched.push(word); }
  }

  if (/kill\s+yourself|go\s+die|i\s+will\s+kill/i.test(t)) score += 3;
  if (/bomb|terrorist|shoot\s+you|stab/i.test(t))           score += 4;
  if (/hack|exploit|ddos|inject|bypass/i.test(t))           score += 2;

  let severity = 'none';
  if (score >= 4)      severity = 'critical';
  else if (score >= 2) severity = 'high';
  else if (score === 1) severity = 'low';

  return { score, severity, matched };
}

async function groqToxicityCheck(text) {
  try {
    const result = await groq.chat.completions.create({
      model: MODELS.fallback,
      messages: [{ role: 'user', content: `Classify this student message for a school Telegram bot. Reply with ONLY one word: SAFE, WARNING, or BLOCK.\n\nMessage: "${text.substring(0, 300)}"` }],
      max_tokens: 10,
      temperature: 0
    });
    return result.choices[0].message.content?.trim().toUpperCase();
  } catch (_) { return 'SAFE'; }
}

async function notifyAdmin(message) {
  if (!ADMIN_TG_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_TG_ID, `🚨 *Moderation Alert*\n\n${message}`, { parse_mode: 'Markdown' });
  } catch (e) { await db.logError('notifyAdmin', e); }
}

async function moderateMessage(ctx, text) {
  const settings   = await db.getBotSettings();
  if (!settings.moderation_enabled) return { action: 'allow' };

  const userId   = String(ctx.from.id);
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const { score, severity, matched } = scoreToxicity(text);

  if (score === 1) {
    const verdict = await groqToxicityCheck(text);
    if (verdict === 'SAFE') return { action: 'allow' };
    if (verdict === 'BLOCK') {
      const warnCount = await db.logFlag(userId, username, text, 'high', matched);
      await notifyAdmin(`👤 User: ${username} (\`${userId}\`)\n⚠️ Severity: high\n💬 Message: \`${text.substring(0, 100)}\`\n📊 Total flags: ${warnCount}`);
      return { action: 'warn', severity: 'high' };
    }
  }

  if (severity === 'none') return { action: 'allow' };

  const warnCount     = await db.logFlag(userId, username, text, severity, matched);
  const warnThreshold = settings.warn_threshold || 2;
  const banThreshold  = settings.auto_ban_threshold || 5;

  await notifyAdmin(
    `🚨 *Flag Logged*\n\n👤 User: ${username} (\`${userId}\`)\n⚠️ Severity: *${severity}*\n🔍 Matched: \`${matched.join(', ')}\`\n💬 Message: \`${text.substring(0, 100)}\`\n📊 Total flags: *${warnCount}*\n🔧 Review: /review_flags`
  );

  if (warnCount >= banThreshold) {
    await db.autoBanUser(userId);
    return { action: 'ban', severity };
  }

  if (severity === 'low') return { action: 'silent_log' };

  if (warnCount >= warnThreshold || severity === 'critical') {
    return { action: 'warn', severity, warnCount };
  }

  return { action: 'silent_log' };
       }

// ═══════════════════════════════════════════════════════════════════════════
// § 5. AI ENGINE
// ═══════════════════════════════════════════════════════════════════════════

// Live system prompt — reads from MongoDB first
async function buildSystemPrompt(displayName, extraInstructions = '') {
  const settings  = await db.getBotSettings();
  const stored    = settings.system_prompt;
  const useCustom = stored && stored !== 'default' && stored.trim().length > 10;

  const base = useCustom ? stored : (
    `You are "Student Prompt Hub AI", a world-class academic tutor assistant on Telegram.\n` +
    `The student's name is: ${displayName}. ALWAYS address them by this name in every reply.\n\n` +
    `IDENTITY RULES (NON-NEGOTIABLE):\n` +
    `1. If asked about your model, API, code, or how you were built → Reply ONLY: "🤫 Top Secret! I'm your dedicated AI tutor. Let's focus on learning!"\n` +
    `2. If asked about your owner/creator → Reply: "🎓 Built by Peculiar, Founder of Propeak Digital Academy. Expert Video Editor, into graphics and bots creation and so many more wanna check out his bio 👇 Contact: wa.me/2347042999216"\n` +
    `3. REFUSE non-academic tasks → "⚠️ Out of Scope! I'm a Student Tutor. Let's focus on your studies! 📖"\n` +
    `4. End EVERY response with: "Does this help, ${displayName}? Need more detail? 😊" OR "Shall I go deeper on any part? 🎯"\n\n` +
    `FORMATTING:\n- Use Markdown: **bold**, *italic*, bullets, numbered lists\n- Be thorough, educational, student-friendly\n- Use emojis naturally\n- Structure long answers with clear headers`
  );

  const nameCtx = useCustom ? `\n\nIMPORTANT: The student's name is ${displayName}. Always address them by this name.` : '';
  return `${base}${nameCtx}\n\n${extraInstructions}`;
}

async function callGroq(messages, model = null) {
  const run = async (m) => {
    const res = await groq.chat.completions.create({ model: m, messages, max_tokens: 2048, temperature: 0.75 });
    return res.choices[0].message.content;
  };
  try       { return await run(model || MODELS.primary); }
  catch (e) {
    await db.logError('callGroq-primary', e);
    try       { return await run(MODELS.fallback); }
    catch (e2){ await db.logError('callGroq-fallback', e2); return null; }
  }
}

async function callGroqVision(prompt, imageBase64, mime = 'image/jpeg') {
  try {
    const res = await groq.chat.completions.create({
      model: MODELS.vision,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } }, { type: 'text', text: prompt }] }],
      max_tokens: 2048
    });
    return res.choices[0].message.content;
  } catch (e) { await db.logError('callGroqVision', e); return null; }
}

async function callGroqWhisper(audioBuffer, filename = 'audio.ogg') {
  try {
    const { toFile } = require('groq-sdk');
    const transcription = await groq.audio.transcriptions.create({
      file: await toFile(audioBuffer, filename, { type: 'audio/ogg' }),
      model: MODELS.whisper,
      response_format: 'text'
    });
    return transcription;
  } catch (e) { await db.logError('callGroqWhisper', e); return null; }
}

function buildLearningPrompt(intent, content, extraArg = '') {
  const map = {
    summarize:  `Create a comprehensive bullet-point summary of key concepts:\n\n${content}`,
    quiz:       `Create exactly 5 multiple-choice questions (A/B/C/D). Number each. Include a clearly marked **Answer Key** with brief explanations:\n\n${content}`,
    flashcards: `Generate 8–10 flashcard Q&A pairs:\n🃏 **Q:** [Question]\n💡 **A:** [Answer]\n\nContent:\n${content}`,
    eli5:       `Explain like I'm 5. Simple words, fun analogies, relatable examples:\n\n${content}`,
    debate:     `Argue the OPPOSITE viewpoint to the main argument. Be compelling:\n\n${content}`,
    translate:  `Translate into ${extraArg || 'French'}. Keep formatting:\n\n${content}`,
    solve:      `Step-by-step solution. Show ALL working. Explain each step:\n\n${content}`,
    notes:      `Convert to structured study notes with headers, bullets, highlight key terms:\n\n${content}`,
    explain:    `Thorough detailed explanation with real-world examples:\n\n${content}`
  };
  return map[intent] || `Help me understand: ${content}`;
}

function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(summar|key point|brief|overview|main point)\w*/.test(t))       return 'summarize';
  if (/\b(quiz|test me|mcq|multiple choice|question)\w*/.test(t))        return 'quiz';
  if (/\b(flashcard|flash card|q&a|revision card)\w*/.test(t))           return 'flashcards';
  if (/\b(eli5|like.{0,10}five|like.{0,10}kid|simplif|simple|easier)\w*/.test(t)) return 'eli5';
  if (/\b(debate|counter|opposite|argue|disagree)\w*/.test(t))           return 'debate';
  if (/\b(translat|in french|in spanish|in arabic|in yoruba|in igbo|in hausa)\w*/.test(t)) return 'translate';
  if (/\b(solv|calculat|step.by.step|equat|formula|math)\w*/.test(t))   return 'solve';
  if (/\b(note|study guide|write down|organis|organiz)\w*/.test(t))      return 'notes';
  if (/\b(explain|what is|what are|describe|tell me|how does|elaborate|detail|clarif)\w*/.test(t)) return 'explain';
  return null;
}

function generatePollinationsImage(prompt) {
  const encoded = encodeURIComponent(prompt.substring(0, 400));
  return `${POLLINATIONS}/flashcard+educational+${encoded},clean+design,colorful,modern,infographic,no+text?width=800&height=600&nologo=true`;
}

// ═══════════════════════════════════════════════════════════════════════════
// § 6. gTTS — REAL TEXT-TO-SPEECH
// ═══════════════════════════════════════════════════════════════════════════

const TTS_VOICES = {
  boy:  { lang: 'en', slow: false },
  girl: { lang: 'en', slow: false, tld: 'co.uk' }
};

function generateGTTS(text, voice = 'boy') {
  return new Promise((resolve, reject) => {
    const config  = TTS_VOICES[voice] || TTS_VOICES.boy;
    const outPath = path.join(TMP_DIR, `tts_${uuidv4()}.mp3`);
    const tts     = new gTTS(text.substring(0, 2000), config.lang, config.slow, config.tld || null);
    tts.save(outPath, (err) => { if (err) return reject(err); resolve(outPath); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// § 7. KEYBOARDS (dynamic reads from MongoDB)
// ═══════════════════════════════════════════════════════════════════════════

const startKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.url('🔗 Join WhatsApp Channel', WA_CHANNEL)],
  [Markup.button.callback('📂 Open Main Menu', 'main_menu')]
]);

async function mainMenuKeyboard() {
  const rows  = await db.getMenuButtons();
  const built = rows.map(row =>
    row.map(btn => btn.url ? Markup.button.url(btn.text, btn.url) : Markup.button.callback(btn.text, btn.callback_data))
  );
  return Markup.inlineKeyboard(built);
}

const actionKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('📋 Summarize',  'action_summarize'),  Markup.button.callback('📝 Quiz Me',    'action_quiz')],
  [Markup.button.callback('🗂 Flashcards', 'action_flashcards'), Markup.button.callback('💡 Explain',    'action_explain')],
  [Markup.button.callback('🧒 ELI5',       'action_eli5'),       Markup.button.callback('⚖️ Debate',    'action_debate')],
  [Markup.button.callback('🔢 Solve',       'action_solve'),      Markup.button.callback('📖 Notes',     'action_notes')]
]);

const adminKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('👥 Users',       'admin_users'),        Markup.button.callback('📊 Stats',       'admin_stats')],
  [Markup.button.callback('🚫 Ban List',    'admin_bans'),         Markup.button.callback('📢 Broadcast',   'admin_broadcast_menu')],
  [Markup.button.callback('🔧 Settings',   'admin_settings'),     Markup.button.callback('📋 Error Logs',  'admin_logs')],
  [Markup.button.callback('🛡️ Mod Flags', 'admin_review_flags'), Markup.button.callback('🧠 AI Prompt',   'admin_view_prompt')]
]);

function flagActionsKeyboard(flaggedUserId) {
  return Markup.inlineKeyboard([[
    Markup.button.callback('⚠️ Warn',   `flag_warn_${flaggedUserId}`),
    Markup.button.callback('🚫 Ban',    `flag_ban_${flaggedUserId}`),
    Markup.button.callback('✅ Ignore', `flag_ignore_${flaggedUserId}`)
  ]]);
}

const QUOTES = [
  '📖 *"The secret of getting ahead is getting started."* — Mark Twain',
  '🌟 *"Education is the most powerful weapon to change the world."* — Nelson Mandela',
  '🚀 *"The more you read, the more things you will know."* — Dr. Seuss',
  '💡 *"An investment in knowledge pays the best interest."* — Benjamin Franklin',
  '🎯 *"Success is the sum of small efforts, repeated day in and day out."* — Robert Collier',
  '📚 *"Intelligence plus character — that is the goal of true education."* — Martin Luther King Jr.',
  '⭐ *"The beautiful thing about learning is nobody can take it from you."* — B.B. King',
  '🔥 *"Believe you can and you are halfway there."* — Theodore Roosevelt',
  '🌍 *"Your education is a dress rehearsal for a life that is yours to lead."* — Nora Ephron',
  '✨ *"Study hard, dream big, achieve the impossible. You were born for greatness."*'
];
// ═══════════════════════════════════════════════════════════════════════════
// § 8. GLOBAL MIDDLEWARE: BAN + MAINTENANCE
// ═══════════════════════════════════════════════════════════════════════════

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const userId = String(ctx.from.id);

  try {
    // Ensure user record
    await db.ensureUser(ctx.from);

    // Ban check — silent drop
    if (await db.isBanned(userId)) return;

    // Maintenance mode
    const settings = await db.getBotSettings();
    if (settings.maintenance_mode && !ctx.session?.isAdmin) {
      const msgText = ctx.message?.text || '';
      if (!msgText.startsWith('/admin')) {
        await ctx.reply('🔧 *Maintenance Mode Active.* The bot is being updated. Try again shortly!', { parse_mode: 'Markdown' });
        return;
      }
    }
  } catch (e) {
    await db.logError('middleware', e);
  }

  return next();
});

// ═══════════════════════════════════════════════════════════════════════════
// § 9. /start — CELESTIAL WELCOME CARD
// ═══════════════════════════════════════════════════════════════════════════

bot.start(async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    ctx.session       = { ...ctx.session, mode: null, isAdmin: false };

    const settings     = await db.getBotSettings();
    const customWelcome = settings.welcome_msg;
    const msg = (customWelcome && customWelcome !== 'default')
      ? customWelcome.replace(/\{name\}/gi, displayName)
      : (
        `✦  ──────────── ✦ ⋅ ────────── ✦\n` +
        `      🎓 *S T U D E N T  P R O M P T  H U B*\n` +
        `         *By Peculiar* ✨\n` +
        `✦  ──────────── ✦ ⋅ ────────── ✦\n\n` +
        `👋 Welcome *${displayName}*\\! 🎓\n` +
        `I'm your personal *Student Prompt Hub AI*, making learning easy, fast & free\\!\n\n` +
        `💡 *Pro Tip:* Join our WhatsApp channel for daily study tips & resources\\!\n\n` +
        `📊 Daily Limit: *${settings.daily_limit || DAILY_LIMIT} queries/day* — Resets at midnight\n\n` +
        `👇 *Tap a button below to get started:*`
      );

    await safeSend(ctx, msg, startKeyboard());
  } catch (e) { await db.logError('start', e); }
});

// ═══════════════════════════════════════════════════════════════════════════
// § 10. MAIN MENU (DYNAMIC FROM MONGODB)
// ═══════════════════════════════════════════════════════════════════════════

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);

    await safeSend(ctx,
      `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n` +
      `     🚀  *Q U I C K   T O O L S*\n` +
      `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n` +
      `  📸  Upload Image  │  Analyze Diagrams\n` +
      `  📄  Upload PDF    │  Read Full Docs\n` +
      `  🎤  Voice Note    │  Speak Questions\n` +
      `  🎨  Flashcard     │  Create Visuals\n` +
      `  ❓  Quick Chat    │  Ask Anything\n\n` +
      `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n` +
      `  Select a tool, *${displayName}* ✦`,
      await mainMenuKeyboard()
    );
  } catch (e) { await db.logError('main_menu', e); }
});

// ═══════════════════════════════════════════════════════════════════════════
// § 11. MODE ACTIVATION CALLBACKS
// ═══════════════════════════════════════════════════════════════════════════

bot.action('mode_image', async (ctx) => {
  await ctx.answerCbQuery();
  await db.ensureUser(ctx.from);
  ctx.session.mode = 'image_count_pending';
  ctx.session.imageCount = 0;
  ctx.session.imagesReceived = [];
  await safeSend(ctx,
    `📸 *Image Mode Activated!* ✦\n\nHow many images are you sending? _(e\\.g\\. 3)_\n_I'll wait for all of them before analyzing._`
  );
});

bot.action('mode_pdf', async (ctx) => {
  await ctx.answerCbQuery();
  await db.ensureUser(ctx.from);
  ctx.session.mode = 'pdf_count_pending';
  ctx.session.pdfCount = 0;
  ctx.session.pdfsReceived = [];
  await safeSend(ctx,
    `📄 *PDF Mode Activated!* ✦\n\nHow many PDF files are you sending? _(e\\.g\\. 2)_\n_I'll wait for all of them before analyzing._`
  );
});

bot.action('mode_voice', async (ctx) => {
  await ctx.answerCbQuery();
  await db.ensureUser(ctx.from);
  ctx.session.mode = 'voice';
  await safeSend(ctx, `🎤 *Voice Mode Activated\\!* ✦\n\nSend me a voice note and I'll transcribe and analyze it!\n_Speak clearly for best results._`);
});

bot.action('mode_chat', async (ctx) => {
  await ctx.answerCbQuery();
  const userId      = await db.ensureUser(ctx.from);
  const displayName = await db.getDisplayName(userId, ctx.from);
  ctx.session.mode  = 'chat';
  await safeSend(ctx, `❓ *Quick Question Mode, ${displayName}\\!* ✦\n\nJust type your question below! 🧠`);
});

bot.action('back_start', async (ctx) => {
  await ctx.answerCbQuery();
  const userId      = await db.ensureUser(ctx.from);
  const displayName = await db.getDisplayName(userId, ctx.from);
  ctx.session.mode  = null;
  await safeSend(ctx,
    `✦ ─────────────────────── ✦\n\n👋 Welcome back, *${displayName}*! Ready to keep learning? 🎓\n\n✦ ─────────────────────── ✦`,
    startKeyboard()
  );
});

bot.action('view_commands', async (ctx) => { await ctx.answerCbQuery(); await sendCommandsList(ctx); });
bot.action('view_profile',  async (ctx) => { await ctx.answerCbQuery(); await sendProfile(ctx); });
bot.action('action_flashcard_gen', async (ctx) => {
  await ctx.answerCbQuery();
  const userId      = await db.ensureUser(ctx.from);
  const displayName = await db.getDisplayName(userId, ctx.from);
  await safeSend(ctx, `🎨 *Visual Flashcard Generator*\n\nType: \`/flashcard <topic>\`\nExample: \`/flashcard Photosynthesis\`\n\nI'll create a beautiful visual flashcard for you, ${displayName}! 🃏`);
});

// ═══════════════════════════════════════════════════════════════════════════
// § 12. POST-UPLOAD ACTION CALLBACKS
// ═══════════════════════════════════════════════════════════════════════════

async function handleActionCallback(ctx, intent, extraArg = '') {
  await ctx.answerCbQuery();
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const { allowed, count, limit } = await db.checkLimit(userId);

    if (!allowed) {
      return safeSend(ctx, `⏰ *Daily Limit Reached, ${displayName}!*\n\n${usageBar(count, limit)}\n\nResets at midnight. 🌙`);
    }

    const history = await db.getHistory(userId);
    const content = ctx.session?.lastAnalyzedContent
      || history.filter(m => m.role === 'user').slice(-1)[0]?.content;

    if (!content) {
      return safeSend(ctx, `⚠️ *No content to analyze!*\nUpload an image/PDF or type a question first, ${displayName}.`);
    }

    const loadMsg  = await ctx.reply(`⏳ Processing, ${displayName}...`);
    const prompt   = buildLearningPrompt(intent, content, extraArg);
    const sysPrompt = await buildSystemPrompt(displayName);
    const messages = [
      { role: 'system', content: sysPrompt },
      ...history.slice(-8),
      { role: 'user', content: prompt }
    ];

    const result = await callGroq(messages);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}

    if (!result) return safeSend(ctx, `⚠️ *AI is busy!* Please try again in a moment.`);

    await db.incrementUsage(userId);
    await db.logApiCall(userId, intent);
    await db.addToHistory(userId, 'user', prompt);
    await db.addToHistory(userId, 'assistant', result);
    await sendLong(ctx, result);
  } catch (e) { await db.logError(`action:${intent}`, e); }
}

bot.action('action_summarize',  (ctx) => handleActionCallback(ctx, 'summarize'));
bot.action('action_quiz',       (ctx) => handleActionCallback(ctx, 'quiz'));
bot.action('action_flashcards', (ctx) => handleActionCallback(ctx, 'flashcards'));
bot.action('action_explain',    (ctx) => handleActionCallback(ctx, 'explain'));
bot.action('action_eli5',       (ctx) => handleActionCallback(ctx, 'eli5'));
bot.action('action_debate',     (ctx) => handleActionCallback(ctx, 'debate'));
bot.action('action_solve',      (ctx) => handleActionCallback(ctx, 'solve'));
bot.action('action_notes',      (ctx) => handleActionCallback(ctx, 'notes'));
// ═══════════════════════════════════════════════════════════════════════════
// § 13. USER COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

bot.command('setname', async (ctx) => {
  try {
    const userId = await db.ensureUser(ctx.from);
    const name   = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!name) return safeSend(ctx, `❌ Usage: \`/setname YourName\``);
    await db.setUserField(userId, 'custom_name', name);
    await safeSend(ctx, `✅ *Name Set!* ✦\n\nHi *${name}*, welcome to your smart learning hub! I'll call you this name from now on. 🚀`);
  } catch (e) { await db.logError('setname', e); }
});

async function sendProfile(ctx) {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const u           = await db.getUser(userId);
    const settings    = await db.getBotSettings();
    const limit       = u?.custom_limit ?? settings.daily_limit ?? DAILY_LIMIT;

    await safeSend(ctx,
      `✦ ────────────────────── ✦\n` +
      `      ⚙️ *Y O U R   P R O F I L E*\n` +
      `✦ ────────────────────── ✦\n\n` +
      `👤 *Name:* ${displayName}\n` +
      `📅 *Member Since:* ${u?.joined_date || 'Unknown'}\n` +
      `🔢 *Total Queries:* ${u?.query_count || 0}\n` +
      `📊 *Today:* ${usageBar(u?.today_count || 0, limit)}\n` +
      `⚠️ *Warnings:* ${u?.warn_count || 0}\n` +
      `📛 *Telegram:* ${u?.username || 'Not set'}\n\n` +
      `_Use /setname YourName to update nickname\\._`
    );
  } catch (e) { await db.logError('profile', e); }
}
bot.command('profile', sendProfile);

bot.command('usage', async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const u           = await db.getUser(userId);
    const settings    = await db.getBotSettings();
    const limit       = u?.custom_limit ?? settings.daily_limit ?? DAILY_LIMIT;
    const count       = u?.today_count || 0;

    await safeSend(ctx,
      `📊 *Daily Usage — ${displayName}*\n\n` +
      `${usageBar(count, limit)}\n\n` +
      `✅ *Used:* ${count} | ⏳ *Left:* ${Math.max(0, limit - count)} | 🔄 *Resets:* Midnight`
    );
  } catch (e) { await db.logError('usage', e); }
});

bot.command('limit', async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const u           = await db.getUser(userId);
    const settings    = await db.getBotSettings();
    const limit       = u?.custom_limit ?? settings.daily_limit ?? DAILY_LIMIT;

    await safeSend(ctx, `⚡ *Daily Limit — ${displayName}*\n\n🔢 Your limit: *${limit} queries/day*\n📅 Resets at midnight automatically\n\n_Contact support to request an increase._`);
  } catch (e) { await db.logError('limit', e); }
});

async function sendCommandsList(ctx) {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const settings    = await db.getBotSettings();
    const customHelp  = settings.help_msg;

    if (customHelp && customHelp !== 'default') {
      return safeSend(ctx, customHelp.replace(/\{name\}/gi, displayName));
    }

    await safeSend(ctx,
      `✦ ══════════════════════════ ✦\n` +
      `    📜 *C O M M A N D   C E N T R E*\n` +
      `✦ ══════════════════════════ ✦\n\n` +
      `*👤 Profile & Info*\n` +
      `▸ /start — Welcome card\n` +
      `▸ /setname \\<name\\> — Set nickname\n` +
      `▸ /profile — View stats\n` +
      `▸ /usage — Daily usage bar\n` +
      `▸ /limit — Daily cap info\n\n` +
      `*🎓 Learning Tools*\n` +
      `▸ /summarize — Bullet summary\n` +
      `▸ /quiz — 5 MCQs \\+ answer key\n` +
      `▸ /flashcard \\<topic\\> — Visual flashcard\n` +
      `▸ /eli5 — Explain Like I'm 5\n` +
      `▸ /debate — Counter-argument\n` +
      `▸ /solve — Step-by-step solution\n` +
      `▸ /translate \\<lang\\> — Translate\n` +
      `▸ /notes — Structured study notes\n\n` +
      `*🔊 Media*\n` +
      `▸ /tts boy \\<text\\> — Male TTS voice\n` +
      `▸ /tts girl \\<text\\> — Female TTS voice\n\n` +
      `*🛠 Utilities*\n` +
      `▸ /help, /features, /about, /support\n` +
      `▸ /feedback, /share, /motivate\n` +
      `▸ /new\\_topic — Clear memory\n` +
      `▸ /timer — Pomodoro timer\n` +
      `▸ /terms, /privacy\n\n` +
      `✦ ──────────────────────────── ✦\n` +
      `_Tip: Type naturally! "explain this" works too, ${displayName}._`
    );
  } catch (e) { await db.logError('help', e); }
}
bot.command('help', sendCommandsList);

bot.command('features', async (ctx) => {
  await db.ensureUser(ctx.from);
  await safeSend(ctx,
    `✦ ══════════════════════════ ✦\n  🌟  *C A P A B I L I T I E S*\n✦ ══════════════════════════ ✦\n\n` +
    `▰ 📸 *Image OCR & Analysis* — Groq Vision AI\n` +
    `▰ 📄 *PDF Analysis* — pdf2pic \\+ Vision\n` +
    `▰ 🎤 *Voice Transcription* — Groq Whisper\n` +
    `▰ 🔊 *Real TTS* — gTTS \\(Boy & Girl voices\\)\n` +
    `▰ 🧠 *AI Summarization* — Key concepts\n` +
    `▰ 📝 *Quiz Generation* — MCQs \\+ answers\n` +
    `▰ 🃏 *Visual Flashcards* — Pollinations AI\n` +
    `▰ 💡 *ELI5 Mode* — Simplified explanations\n` +
    `▰ ⚖️ *Debate Mode* — Critical thinking\n` +
    `▰ 🌍 *50\\+ Languages* — Translation support\n` +
    `▰ 🔢 *Math Solver* — Step-by-step solutions\n` +
    `▰ 💬 *Smart Context* — Swipe-to-reply\n` +
    `▰ 🛡️ *Auto-Moderation* — Safety first\n` +
    `▰ 🧠 *Live Training* — Admin-controlled AI personality\n` +
    `▰ 🗄️ *Persistent Cloud DB* — MongoDB Atlas\n\n` +
    `✦ ──────────────────────────── ✦`
  );
});

bot.command('about', async (ctx) => {
  try {
    await db.ensureUser(ctx.from);
    const settings    = await db.getBotSettings();
    const customAbout = settings.about_msg;
    const msg = (customAbout && customAbout !== 'default')
      ? customAbout
      : (
        `✦ ════════════════════════ ✦\n      👑 *A B O U T   U S*\n✦ ════════════════════════ ✦\n\n` +
        `🎓 Built by *Peculiar*! \nFounder of *Propeak Digital Academy*\n\n` +
        `▸ 🎬 *Video Editor*\n▸ 💻 *Bot creator*\n▸ 🎨 *Graphics Creation*\n▸ 🚀 *Online Business Expert*\n\n` +
        `📱 WhatsApp: *07042999216*`
      );
    await safeSend(ctx, msg, Markup.inlineKeyboard([[Markup.button.url('💬 Contact Peculiar', WA_SUPPORT)]]));
  } catch (e) { await db.logError('about', e); }
});

bot.command('support',  async (ctx) => { await db.ensureUser(ctx.from); await safeSend(ctx, `💬 *Support*\n\nReach Peculiar on WhatsApp for any issues!`, Markup.inlineKeyboard([[Markup.button.url('💬 Chat with Peculiar', WA_SUPPORT)]])); });
bot.command('feedback', async (ctx) => { await db.ensureUser(ctx.from); await safeSend(ctx, `✍️ *Send Feedback!*\n\nWe love hearing from students!`, Markup.inlineKeyboard([[Markup.button.url('✍️ Send Feedback', WA_FEEDBACK)]])); });

bot.command('share', async (ctx) => {
  const userId      = await db.ensureUser(ctx.from);
  const displayName = await db.getDisplayName(userId, ctx.from);
  await safeSend(ctx, `🚀 *Share the Bot, ${displayName}!*\n\n📲 *${BOT_SHARE_LINK}*\n\n_Copy & send to anyone who needs an AI study buddy!_`);
});

bot.command('motivate', async (ctx) => {
  const userId      = await db.ensureUser(ctx.from);
  const displayName = await db.getDisplayName(userId, ctx.from);
  const q           = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  await safeSend(ctx, `✦ ─────────── ✦\n\n🌟 *Daily Motivation*\n\n${q}\n\n💪 *You got this, ${displayName}!* 🚀\n\n✦ ─────────── ✦`);
});

bot.command('new_topic', async (ctx) => {
  const userId = await db.ensureUser(ctx.from);
  await db.clearHistory(userId);
  ctx.session.lastAnalyzedContent = null;
  ctx.session.mode                = null;
  await safeSend(ctx, `🧹 *Context Cleared!* ✦\nReady for a new subject! What do you want to learn next? 📚`, await mainMenuKeyboard());
});

bot.command('timer', async (ctx) => {
  const userId      = await db.ensureUser(ctx.from);
  const displayName = await db.getDisplayName(userId, ctx.from);
  await safeSend(ctx,
    `✦ ─────────── ✦\n⏱ *Pomodoro Timer Started!*\n✦ ─────────── ✦\n\n` +
    `🔴 *25 minutes of focus begins NOW!*\n\n` +
    `▸ 📖 Study hard for 25 min\n▸ ☕ 5-min break\n▸ 🔁 After 4 rounds → 15–30 min break\n\n` +
    `_Focus, ${displayName}. I'll remind you when done! 💪_`
  );
  setTimeout(async () => {
    try {
      await ctx.replyWithMarkdown(`🔔 *Time's Up, ${displayName}!* ✦\n\n✅ 25-minute session complete!\n☕ *Take a 5-minute break now.* 🎉`);
    } catch (e) { await db.logError('timer-reminder', e); }
  }, 25 * 60 * 1000);
});

bot.command('terms', async (ctx) => {
  await db.ensureUser(ctx.from);
  const s = await db.getBotSettings();
  await safeSend(ctx,
    `✦ ══════════════════════════ ✦\n    📋 *T E R M S*\n✦ ══════════════════════════ ✦\n\n` +
    `▸ *1.* Educational use only\n▸ *2.* No reverse-engineering\n▸ *3.* You own your uploads\n` +
    `▸ *4.* Age 13+ required\n▸ *5.* ${s.daily_limit || DAILY_LIMIT} queries/day\n` +
    `▸ *6.* We may ban abusive users\n▸ *7.* Terms may change\n\n_By using this bot, you agree._`
  );
});

bot.command('privacy', async (ctx) => {
  await db.ensureUser(ctx.from);
  await safeSend(ctx,
    `✦ ══════════════════════════ ✦\n    🔒 *P R I V A C Y*\n✦ ══════════════════════════ ✦\n\n` +
    `▸ *Stored:* User ID, username, join date, query count\n▸ *Media:* NOT stored permanently\n` +
    `▸ *Sharing:* NEVER sold or shared\n▸ *Memory:* Last 5 messages for context\n▸ *Deletion:* Contact support anytime\n\n_Your privacy is our priority._`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// § 14. LEARNING COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

async function handleLearningCommand(ctx, intent, extraArg = '') {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const { allowed, count, limit } = await db.checkLimit(userId);

    if (!allowed) return safeSend(ctx, `⏰ *Daily Limit Reached, ${displayName}!*\n\n${usageBar(count, limit)}\n\nResets at midnight. 🌙`);

    const history = await db.getHistory(userId);
    const content = ctx.session?.lastAnalyzedContent
      || history.filter(m => m.role === 'user').slice(-1)[0]?.content;

    if (!content) return safeSend(ctx, `⚠️ *No content, ${displayName}!*\nUpload an image/PDF or type your notes first.`);

    const loadMsg   = await ctx.reply(`⏳ Working on it, ${displayName}...`);
    const prompt    = buildLearningPrompt(intent, content, extraArg);
    const sysPrompt = await buildSystemPrompt(displayName);
    const messages  = [
      { role: 'system', content: sysPrompt },
      ...history.slice(-8),
      { role: 'user', content: prompt }
    ];

    const result = await callGroq(messages);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}

    if (!result) return safeSend(ctx, `⚠️ *AI is busy!* Try again in a moment.`);

    await db.incrementUsage(userId);
    await db.logApiCall(userId, intent);
    await db.addToHistory(userId, 'user', prompt);
    await db.addToHistory(userId, 'assistant', result);
    await sendLong(ctx, result);
  } catch (e) { await db.logError(`learning:${intent}`, e); }
}

bot.command('summarize',  (ctx) => handleLearningCommand(ctx, 'summarize'));
bot.command('quiz',       (ctx) => handleLearningCommand(ctx, 'quiz'));
bot.command('eli5',       (ctx) => handleLearningCommand(ctx, 'eli5'));
bot.command('debate',     (ctx) => handleLearningCommand(ctx, 'debate'));
bot.command('solve',      (ctx) => handleLearningCommand(ctx, 'solve'));
bot.command('notes',      (ctx) => handleLearningCommand(ctx, 'notes'));
bot.command('translate',  async (ctx) => {
  const lang = ctx.message.text.split(' ').slice(1).join(' ').trim();
  await handleLearningCommand(ctx, 'translate', lang || 'French');
});

bot.command('flashcard', async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const { allowed } = await db.checkLimit(userId);
    if (!allowed) return safeSend(ctx, `⏰ *Daily limit reached!* Resets at midnight.`);

    const topic = ctx.message.text.split(' ').slice(1).join(' ').trim()
      || ctx.session?.lastAnalyzedContent?.substring(0, 100) || '';

    if (!topic) return safeSend(ctx, `❌ *Usage:* \`/flashcard Photosynthesis\``);

    const frames = [
      `🎨 *Designing flashcard...*`,
      `🎨 *Designing flashcard...*\n✍️ *Generating Q&A...*`,
      `🎨 *Designing flashcard...*\n✍️ *Generating Q&A...*\n🖼 *Creating visual...*`,
      `🎨 *Designing flashcard...*\n✍️ *Generating Q&A...*\n🖼 *Creating visual...*\n✅ *Finalizing...*`
    ];
    const loadMsg = await animateLoading(ctx, frames, 700);

    const sysPrompt = await buildSystemPrompt(displayName);
    const qaMessages = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: `Create one high-quality flashcard on "${topic}".\nFormat EXACTLY:\n**Topic:** [name]\n**Q:** [clear question]\n**A:** [2–4 sentence answer]\n**Key Fact:** [1 memorable fact]` }
    ];

    const qaResult = await callGroq(qaMessages);
    const imgUrl   = generatePollinationsImage(`educational flashcard ${topic} academic minimal colorful no people`);

    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}

    if (imgUrl) {
      try {
        await ctx.replyWithPhoto(imgUrl, {
          caption: `🃏 *Flashcard: ${topic}*\n\n${cleanText(qaResult || 'Could not generate content.')}`,
          parse_mode: 'Markdown'
        });
      } catch (_) { await sendLong(ctx, `🃏 *Flashcard: ${topic}*\n\n${qaResult || 'Could not generate content.'}`); }
    } else {
      await sendLong(ctx, `🃏 *Flashcard: ${topic}*\n\n${qaResult || 'Could not generate content.'}`);
    }

    await db.incrementUsage(userId);
    await db.logApiCall(userId, 'flashcard');
  } catch (e) { await db.logError('flashcard', e); }
});
// ═══════════════════════════════════════════════════════════════════════════
// § 15. /tts — REAL gTTS TEXT-TO-SPEECH
// ═══════════════════════════════════════════════════════════════════════════

bot.command('tts', async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const { allowed } = await db.checkLimit(userId);
    if (!allowed) return safeSend(ctx, `⏰ *Daily limit reached, ${displayName}!*`);

    const args   = ctx.message.text.split(' ').slice(1);
    const voice  = args[0]?.toLowerCase();
    const textIn = args.slice(1).join(' ').trim();

    if (!['boy', 'girl'].includes(voice) || !textIn) {
      return safeSend(ctx,
        `🔊 *TTS Usage:*\n\`/tts boy Your text here\`\n\`/tts girl Your text here\`\n\n_Example: \`/tts girl Explain photosynthesis\`_`
      );
    }

    let content = textIn;
    if (ctx.message.reply_to_message?.text) {
      content = `Context: ${ctx.message.reply_to_message.text.substring(0, 500)}\n\nExplain: ${textIn}`;
    }

    // TTS Animation
    const animMsg = await ctx.reply(`🔊 *Initializing voice mode...*`);
    await new Promise(r => setTimeout(r, 700));
    await safeEdit(ctx, animMsg.message_id, `🔊 *Initializing voice mode...*\n🎙 *Entering voice mode...*\n🔍 *Checking prompt...*`);
    await new Promise(r => setTimeout(r, 700));
    await safeEdit(ctx, animMsg.message_id, `🔊 *Initializing voice mode...*\n🎙 *Entering voice mode...*\n🔍 *Checking prompt...*\n\n*Progress:* \`0%\``);
    await new Promise(r => setTimeout(r, 500));
    await safeEdit(ctx, animMsg.message_id, `🔊 *Initializing voice mode...*\n🎙 *Entering voice mode...*\n🔍 *Checking prompt...*\n\n*Progress:* \`0% → 50%\``);
    await new Promise(r => setTimeout(r, 500));
    await safeEdit(ctx, animMsg.message_id, `🔊 *Initializing voice mode...*\n🎙 *Entering voice mode...*\n🔍 *Checking prompt...*\n\n*Progress:* \`0% → 50% → 100% ✅\``);
    await new Promise(r => setTimeout(r, 400));

    const voiceStyle = voice === 'girl'
      ? 'warm, enthusiastic, encouraging female teacher'
      : 'calm, authoritative, clear male professor';

    const messages = [
      { role: 'system', content: `You are a ${voiceStyle}. Explain conversationally, as if speaking aloud. Use natural speech patterns with "..." pauses. Max 300 words. Be engaging and educational.` },
      { role: 'user',   content }
    ];

    const speechText = await callGroq(messages);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, animMsg.message_id); } catch (_) {}

    if (!speechText) return safeSend(ctx, `⚠️ *TTS engine busy!* Try again in a moment.`);

    let ttsPath = null;
    try {
      ttsPath = await generateGTTS(speechText, voice);
      const voiceEmoji = voice === 'girl' ? '👩' : '👨';
      const voiceLabel = voice === 'girl' ? 'Female Voice (British)' : 'Male Voice (US)';

      await ctx.replyWithAudio(
        { source: fs.createReadStream(ttsPath), filename: `tts_${voice}.mp3` },
        { title: `${voiceEmoji} ${voiceLabel}`, performer: 'Student Prompt Hub AI', caption: `🔊 *${voiceLabel}*\n_"${textIn.substring(0, 50)}..."_\n\nBy Propeak Digital Academy`, parse_mode: 'Markdown' }
      );
      await safeSend(ctx, `📄 *Transcript:*\n\n_"${cleanText(speechText)}"_`);
    } catch (ttsErr) {
      await db.logError('gTTS', ttsErr);
      const voiceEmoji = voice === 'girl' ? '👩' : '👨';
      const voiceLabel = voice === 'girl' ? 'Female Voice' : 'Male Voice';
      await sendLong(ctx, `${voiceEmoji} *\\[${voiceLabel} Output\\]:*\n\n_"${speechText}"_`);
    } finally {
      cleanupFile(ttsPath);
    }

    await db.incrementUsage(userId);
    await db.logApiCall(userId, 'tts');
  } catch (e) { await db.logError('tts', e); }
});

// ═══════════════════════════════════════════════════════════════════════════
// § 16. ADMIN COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

bot.command('admin', async (ctx) => {
  try {
    const parts = ctx.message.text.split(' ');
    const pin   = parts[1];
    if (!pin || !(await db.checkAdminPin(pin))) return; // SILENT FAIL

    ctx.session.isAdmin = true;
    const allUsers      = await db.getAllUsers();
    const total         = allUsers.length;
    const banned        = allUsers.filter(u => u.is_banned).length;
    const adminDoc      = await db.getAdmin();
    const settings      = await db.getBotSettings();
    const pendingFlags  = await db.countFlags('pending');
    const promptStatus  = (settings.system_prompt && settings.system_prompt !== 'default') ? '🟢 Custom' : '⚪ Default';

    await safeSend(ctx,
      `✦ ════════════════════════ ✦\n` +
      `  🛡️ *A D M I N   D A S H B O A R D*\n` +
      `✦ ════════════════════════ ✦\n\n` +
      `👥 Total Users: *${total}*  🚫 Banned: *${banned}*\n` +
      `🔢 API Calls: *${adminDoc?.api_usage || 0}*  🛡️ Pending Flags: *${pendingFlags}*\n` +
      `🔧 Maintenance: *${settings.maintenance_mode ? 'ON 🔴' : 'OFF 🟢'}*\n` +
      `🧠 AI Prompt: *${promptStatus}*\n\n` +
      `_Select an action below:_`,
      adminKeyboard()
    );
  } catch (e) { await db.logError('admin', e); }
});

// Admin Dashboard Callbacks
bot.action('admin_users', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.isAdmin) return;
  try {
    const allUsers = await db.getAllUsers();
    const total    = allUsers.length;
    const banned   = allUsers.filter(u => u.is_banned).length;
    const recent   = allUsers.sort((a, b) => (b.joined_date || '').localeCompare(a.joined_date || '')).slice(0, 5);

    let msg = `✦ *User Overview*\n\n📊 Total: *${total}* | 🚫 Banned: *${banned}*\n\n*Recently Joined:*\n`;
    recent.forEach(u => { msg += `▸ ${u.username || u._id} — ${u.query_count || 0} queries — ${u.joined_date}\n`; });
    await safeSend(ctx, msg);
  } catch (e) { await db.logError('admin_users', e); }
});

bot.action('admin_stats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.isAdmin) return;
  try {
    const today     = new Date(); today.setHours(0,0,0,0);
    const todayCount = await db.countApiLogs({ sinceDate: today });
    const totalCount = await db.countApiLogs();
    const adminDoc   = await db.getAdmin();
    const allUsers   = await db.getAllUsers();

    await safeSend(ctx,
      `✦ *Bot Statistics*\n\n` +
      `🔢 Total API Calls: *${adminDoc?.api_usage || 0}*\n` +
      `📅 Today's Calls: *${todayCount}*\n` +
      `📋 Log Entries: *${totalCount}*\n` +
      `👥 Total Users: *${allUsers.length}*\n` +
      `📢 Total Broadcasts: *${adminDoc?.total_broadcasts || 0}*`
    );
  } catch (e) { await db.logError('admin_stats', e); }
});

bot.action('admin_bans', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.isAdmin) return;
  try {
    const allUsers = await db.getAllUsers();
    const banned   = allUsers.filter(u => u.is_banned);
    if (!banned.length) return safeSend(ctx, `✅ *No banned users currently.*`);
    let msg = `🚫 *Banned Users (${banned.length}):*\n\n`;
    banned.forEach(u => { msg += `▸ \`${u._id}\` — ${u.username || 'no username'}\n`; });
    await safeSend(ctx, msg);
  } catch (e) { await db.logError('admin_bans', e); }
});

bot.action('admin_broadcast_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.isAdmin) return;
  await safeSend(ctx, `📢 *Broadcast Options:*\n\n▸ Text: \`/broadcast <PIN> Your message\`\n▸ Image: \`/broadcast_img <PIN>\`\n▸ PDF: \`/broadcast_pdf <PIN>\``);
});

bot.action('admin_settings', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.isAdmin) return;
  try {
    const s = await db.getBotSettings();
    await safeSend(ctx,
      `🔧 *Bot Settings:*\n\n` +
      `▸ Maintenance: *${s.maintenance_mode ? 'ON 🔴' : 'OFF 🟢'}*\n` +
      `▸ Daily Limit: *${s.daily_limit || DAILY_LIMIT}*\n` +
      `▸ Moderation: *${s.moderation_enabled ? 'ON 🟢' : 'OFF 🔴'}*\n` +
      `▸ Warn Threshold: *${s.warn_threshold || 2}*\n` +
      `▸ Auto-Ban Threshold: *${s.auto_ban_threshold || 5}*\n\n` +
      `*Admin Commands Quick Ref:*\n` +
      `\`/maintenance <PIN> on/off\`\n\`/set_system_prompt <PIN> <prompt>\`\n` +
      `\`/set_welcome <PIN> <msg>\`\n\`/set_about <PIN> <msg>\`\n\`/set_help <PIN> <msg>\`\n` +
      `\`/set_mod <PIN> on/off\`\n\`/add_command <PIN> <n> <prompt>\`\n` +
      `\`/add_menu_button <PIN> "Label" "cb"\`\n\`/review_flags <PIN>\``
    );
  } catch (e) { await db.logError('admin_settings', e); }
});

bot.action('admin_logs', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.isAdmin) return;
  try {
    const logs = await db.getErrorLogs(10);
    if (!logs.length) return safeSend(ctx, `✅ *No errors logged.*`);
    let msg = `📋 *Last 10 Errors:*\n\n`;
    logs.forEach((l, i) => {
      msg += `*${i + 1}.* \`${l.context}\` — ${l.message?.substring(0, 60)}\n_${new Date(l.timestamp).toISOString().split('T')[0]}_\n\n`;
    });
    await safeSend(ctx, msg);
  } catch (e) { await db.logError('admin_logs', e); }
});

bot.action('admin_review_flags', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.isAdmin) return;
  try {
    const pending = await db.getFlags({ status: 'pending' });
    const total   = await db.countFlags();
    if (!pending.length) {
      return safeSend(ctx, `✦ *Moderation Review* ✦\n\n✅ *No pending flags!* All clean.\n\nTotal flags logged: *${total}*`);
    }
    await safeSend(ctx, `✦ *Moderation Review* ✦\n\n🛡️ *Pending Flags: ${pending.length}*\n\nReview each user below:`);
    for (const flag of pending.slice(0, 10)) {
      const lastIncident = flag.incidents?.[flag.incidents.length - 1];
      const msg =
        `✦ ─────────────────── ✦\n👤 *User:* ${flag.username}\n🆔 *ID:* \`${flag._id}\`\n` +
        `📊 *Total Flags:* ${flag.totalFlags}\n⚠️ *Last Severity:* ${lastIncident?.severity || 'unknown'}\n` +
        `🔍 *Matched:* \`${lastIncident?.matched?.join(', ') || 'N/A'}\`\n` +
        `💬 *Last Message:* _"${lastIncident?.message?.substring(0, 80) || 'N/A'}"_\n` +
        `🕐 *Last Seen:* ${flag.lastSeen?.split('T')[0]}\n✦ ─────────────────── ✦`;
      await safeSend(ctx, msg, flagActionsKeyboard(flag._id));
      await new Promise(r => setTimeout(r, 300));
    }
    if (pending.length > 10) await safeSend(ctx, `_...and ${pending.length - 10} more._`);
  } catch (e) { await db.logError('admin_review_flags', e); }
});

bot.action('admin_view_prompt', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.isAdmin) return;
  try {
    const settings  = await db.getBotSettings();
    const prompt    = settings.system_prompt;
    const isCustom  = prompt && prompt !== 'default';
    await safeSend(ctx,
      `🧠 *Current AI System Prompt:*\n\nStatus: *${isCustom ? '🟢 Custom (Live)' : '⚪ Default'}*\n\n` +
      `${isCustom ? `_"${prompt.substring(0, 300)}..."_` : '_Using default Propeak student tutor identity._'}\n\n` +
      `To update:\n\`/set_system_prompt <PIN> Your new instructions here\`\n\nTo reset:\n\`/set_system_prompt <PIN> default\``
    );
  } catch (e) { await db.logError('admin_view_prompt', e); }
});

// ── /review_flags ─────────────────────────────────────────────────────────────
bot.command('review_flags', async (ctx) => {
  try {
    const pin = ctx.message.text.split(' ')[1];
    if (!pin || !(await db.checkAdminPin(pin))) return;

    const pending = await db.getFlags({ status: 'pending' });
    const total   = await db.countFlags();

    if (!pending.length) {
      return safeSend(ctx, `✦ *Moderation Review* ✦\n\n✅ *No pending flags!* All clean.\n\nTotal flags logged: *${total}*`);
    }

    await safeSend(ctx, `✦ *Moderation Review* ✦\n\n🛡️ *Pending Flags: ${pending.length}*\n\nReview each user below:`);

    for (const flag of pending.slice(0, 10)) {
      const lastIncident = flag.incidents?.[flag.incidents.length - 1];
      const msg =
        `✦ ─────────────────── ✦\n👤 *User:* ${flag.username}\n🆔 *ID:* \`${flag._id}\`\n` +
        `📊 *Total Flags:* ${flag.totalFlags}\n⚠️ *Last Severity:* ${lastIncident?.severity || 'unknown'}\n` +
        `🔍 *Matched:* \`${lastIncident?.matched?.join(', ') || 'N/A'}\`\n` +
        `💬 *Last Message:* _"${lastIncident?.message?.substring(0, 80) || 'N/A'}"_\n` +
        `🕐 *Last Seen:* ${flag.lastSeen?.split('T')[0]}\n✦ ─────────────────── ✦`;
      await safeSend(ctx, msg, flagActionsKeyboard(flag._id));
      await new Promise(r => setTimeout(r, 300));
    }
    if (pending.length > 10) await safeSend(ctx, `_...and ${pending.length - 10} more\\._`);
  } catch (e) { await db.logError('review_flags', e); }
});

// Flag Action Callbacks
bot.action(/^flag_warn_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⚠️ Warning sent!');
  if (!ctx.session?.isAdmin) return;
  try {
    const flaggedUserId = ctx.match[1];
    const flags         = await db.getFlags();
    const entry         = flags.find(f => f._id === flaggedUserId);
    if (!entry) return safeSend(ctx, `❌ Flag entry not found.`);

    await db.setFlagStatus(flaggedUserId, 'warned');
    try {
      await bot.telegram.sendMessage(flaggedUserId,
        `⚠️ *Official Warning from Student Prompt Hub AI*\n\nYour recent message(s) were flagged for inappropriate content.\nPlease keep conversations academic and respectful.\n\n*Further violations may result in a ban.*`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}
    await safeSend(ctx, `✅ *Warning sent to ${entry.username || flaggedUserId}!*\n\nFlag status: ⚠️ Warned`);
  } catch (e) { await db.logError('flag_warn', e); }
});

bot.action(/^flag_ban_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🚫 User banned!');
  if (!ctx.session?.isAdmin) return;
  try {
    const flaggedUserId = ctx.match[1];
    await db.setBanned(flaggedUserId, true);
    await db.setFlagStatus(flaggedUserId, 'banned');
    await safeSend(ctx, `🚫 *User \`${flaggedUserId}\` has been BANNED!*\n\nFlag cleared\\.`);
  } catch (e) { await db.logError('flag_ban', e); }
});

bot.action(/^flag_ignore_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('✅ Ignored!');
  if (!ctx.session?.isAdmin) return;
  try {
    await db.setFlagStatus(ctx.match[1], 'ignored');
    await safeSend(ctx, `✅ *Flag for \`${ctx.match[1]}\` marked as Ignored.*`);
  } catch (e) { await db.logError('flag_ignore', e); }
});

// ── /set_mod ──────────────────────────────────────────────────────────────────
bot.command('set_mod', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const pin   = parts[1];
  const state = parts[2]?.toLowerCase();
  if (!pin || !(await db.checkAdminPin(pin))) return;
  const on = state === 'on';
  await db.setBotSetting('moderation_enabled', on);
  await safeSend(ctx, `🛡️ *Auto-Moderation ${on ? 'ENABLED 🟢' : 'DISABLED 🔴'}*\\.`);
});
  
// ═══════════════════════════════════════════════════════════════════════════
// § 17. LIVE SYSTEM PROMPT — BOT TRAINING
// ═══════════════════════════════════════════════════════════════════════════

bot.command('set_system_prompt', async (ctx) => {
  try {
    const parts     = ctx.message.text.split(' ');
    const pin       = parts[1];
    if (!pin || !(await db.checkAdminPin(pin))) return;

    const newPrompt = parts.slice(2).join(' ').trim();
    if (!newPrompt) {
      return safeSend(ctx,
        `❌ *Usage:*\n\`/set_system_prompt <PIN> <new instructions>\`\n\n` +
        `*Examples:*\n\`/set_system_prompt PECULIAR123 You are a strict math teacher.\`\n\n` +
        `To reset: \`/set_system_prompt PECULIAR123 default\``
      );
    }

    if (newPrompt.toLowerCase() === 'default') {
      await db.setBotSetting('system_prompt', 'default');
      return safeSend(ctx, `✅ *AI Personality Reset to Default\\!*\n\n_Active immediately — no restart needed\\._`);
    }

    await db.setBotSetting('system_prompt', newPrompt);
    await safeSend(ctx,
      `✅ *AI System Prompt Updated\\!* 🧠\n\n✦ ──────────────── ✦\n` +
      `*New Personality Preview:*\n_"${newPrompt.substring(0, 150)}${newPrompt.length > 150 ? '...' : ''}"_\n` +
      `✦ ──────────────── ✦\n\n🟢 *Active immediately — no restart needed\\!*\n\n` +
      `To revert: \`/set_system_prompt ${pin} default\``
    );
  } catch (e) { await db.logError('set_system_prompt', e); }
});

// ═══════════════════════════════════════════════════════════════════════════
// § 18. DYNAMIC MESSAGE EDITING (TRAINING)
// ═══════════════════════════════════════════════════════════════════════════

bot.command('set_welcome', async (ctx) => {
  const parts   = ctx.message.text.split(' ');
  const pin     = parts[1];
  const message = parts.slice(2).join(' ').trim();
  if (!pin || !(await db.checkAdminPin(pin))) return;
  if (!message) return safeSend(ctx, `❌ *Usage:* \`/set_welcome <PIN> Your welcome message\`\n_Use \\{name\\} for user's name\\._\n\nTo reset: \`/set_welcome <PIN> default\``);
  if (message.toLowerCase() === 'default') { await db.setBotSetting('welcome_msg', 'default'); return safeSend(ctx, `✅ *Welcome message reset to default\\.*`); }
  await db.setBotSetting('welcome_msg', message);
  await safeSend(ctx, `✅ *Welcome Message Updated\\!*\n\n_Preview:_\n\n${message.replace(/\{name\}/gi, 'Student')}\n\n🟢 *Active immediately on /start\\.*`);
});

bot.command('set_about', async (ctx) => {
  const parts   = ctx.message.text.split(' ');
  const pin     = parts[1];
  const message = parts.slice(2).join(' ').trim();
  if (!pin || !(await db.checkAdminPin(pin))) return;
  if (!message) return safeSend(ctx, `❌ *Usage:* \`/set_about <PIN> Your about text\`\n\nTo reset: \`/set_about <PIN> default\``);
  if (message.toLowerCase() === 'default') { await db.setBotSetting('about_msg', 'default'); return safeSend(ctx, `✅ *About message reset to default\\.*`); }
  await db.setBotSetting('about_msg', message);
  await safeSend(ctx, `✅ *About Message Updated\\!*\n\n🟢 Active immediately on /about\\.`);
});

bot.command('set_help', async (ctx) => {
  const parts   = ctx.message.text.split(' ');
  const pin     = parts[1];
  const message = parts.slice(2).join(' ').trim();
  if (!pin || !(await db.checkAdminPin(pin))) return;
  if (!message) return safeSend(ctx, `❌ *Usage:* \`/set_help <PIN> Your help message\`\n\nTo reset: \`/set_help <PIN> default\``);
  if (message.toLowerCase() === 'default') { await db.setBotSetting('help_msg', 'default'); return safeSend(ctx, `✅ *Help message reset to default\\.*`); }
  await db.setBotSetting('help_msg', message);
  await safeSend(ctx, `✅ *Help Message Updated\\!*\n\n🟢 Active immediately on /help\\.`);
});

// ═══════════════════════════════════════════════════════════════════════════
// § 19. REMAINING ADMIN COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

bot.command('ban', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const pin   = parts[1];
  const uid   = parts[2];
  if (!pin || !(await db.checkAdminPin(pin))) return;
  if (!uid) return safeSend(ctx, `❌ Usage: \`/ban <PIN> <USER_ID>\``);
  const u = await db.getUser(uid);
  if (!u) return safeSend(ctx, `❌ User \`${uid}\` not found\\.`);
  await db.setBanned(uid, true);
  await safeSend(ctx, `🚫 User \`${uid}\` (${u.username || 'no username'}) *banned*\\.`);
});

bot.command('unban', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const pin   = parts[1];
  const uid   = parts[2];
  if (!pin || !(await db.checkAdminPin(pin))) return;
  if (!uid) return safeSend(ctx, `❌ Usage: \`/unban <PIN> <USER_ID>\``);
  await db.setBanned(uid, false);
  await safeSend(ctx, `✅ User \`${uid}\` *unbanned*\\.`);
});

bot.command('changepin', async (ctx) => {
  const parts  = ctx.message.text.split(' ');
  const oldPin = parts[1];
  const newPin = parts[2];
  if (!oldPin || !(await db.checkAdminPin(oldPin))) return;
  if (!newPin || newPin.length < 6) return safeSend(ctx, `❌ New PIN must be at least 6 characters\\.`);
  await db.updateAdmin({ pin: newPin });
  await safeSend(ctx, `✅ *Admin PIN changed successfully\\!*`);
});

bot.command('broadcast', async (ctx) => {
  try {
    const parts   = ctx.message.text.split(' ');
    const pin     = parts[1];
    const message = parts.slice(2).join(' ').trim();
    if (!pin || !(await db.checkAdminPin(pin))) return;
    if (!message) return safeSend(ctx, `❌ Usage: \`/broadcast <PIN> Your message\``);

    const userIds = await db.getActiveUserIds();
    let ok = 0, fail = 0;

    await safeSend(ctx, `📢 *Broadcasting to ${userIds.length} users\\.\\.\\.*`);
    for (const uid of userIds) {
      try {
        await ctx.telegram.sendMessage(uid, `📢 *Announcement:*\n\n${message}`, { parse_mode: 'Markdown' });
        ok++;
      } catch { fail++; }
      await new Promise(r => setTimeout(r, 60));
    }
    await db.incBroadcasts();
    await safeSend(ctx, `✅ *Broadcast Done\\!*\n📤 Sent: *${ok}* | ❌ Failed: *${fail}*`);
  } catch (e) { await db.logError('broadcast', e); }
});

bot.command('broadcast_img', async (ctx) => {
  const pin = ctx.message.text.split(' ')[1];
  if (!pin || !(await db.checkAdminPin(pin))) return;
  ctx.session.broadcastMode = 'image';
  ctx.session.isAdmin       = true;
  await safeSend(ctx, `🖼 *Image Broadcast Mode Active\\!* Send the image to broadcast now\\.`);
});

bot.command('broadcast_pdf', async (ctx) => {
  const pin = ctx.message.text.split(' ')[1];
  if (!pin || !(await db.checkAdminPin(pin))) return;
  ctx.session.broadcastMode = 'pdf';
  ctx.session.isAdmin       = true;
  await safeSend(ctx, `📄 *PDF Broadcast Mode Active\\!* Send the PDF to broadcast now\\.`);
});

bot.command('maintenance', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const pin   = parts[1];
  const state = parts[2]?.toLowerCase();
  if (!pin || !(await db.checkAdminPin(pin))) return;
  const on = state === 'on';
  await db.setBotSetting('maintenance_mode', on);
  await safeSend(ctx, `🔧 *Maintenance ${on ? 'ENABLED 🔴' : 'DISABLED 🟢'}*\\.`);
});

bot.command('set_limit', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const pin   = parts[1];
  const uid   = parts[2];
  const num   = parseInt(parts[3], 10);
  if (!pin || !(await db.checkAdminPin(pin))) return;
  if (!uid || isNaN(num)) return safeSend(ctx, `❌ Usage: \`/set_limit <PIN> <USER_ID> <number>\``);
  await db.setUserField(uid, 'custom_limit', num);
  await safeSend(ctx, `✅ Limit for \`${uid}\` set to *${num}*\\.`);
});

bot.command('reset_usage', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const pin   = parts[1];
  const uid   = parts[2];
  if (!pin || !(await db.checkAdminPin(pin))) return;
  if (!uid) return safeSend(ctx, `❌ Usage: \`/reset_usage <PIN> <USER_ID>\``);
  await db.setUserField(uid, 'today_count', 0);
  await safeSend(ctx, `✅ Usage reset for \`${uid}\`\\.`);
});

bot.command('logs', async (ctx) => {
  const pin = ctx.message.text.split(' ')[1];
  if (!pin || !(await db.checkAdminPin(pin))) return;
  const logs = await db.getErrorLogs(10);
  if (!logs.length) return safeSend(ctx, `✅ *No error logs\\.*`);
  let msg = `📋 *Last 10 Errors:*\n\n`;
  logs.forEach((l, i) => {
    msg += `*${i + 1}.* \`${l.context}\`\n${l.message?.substring(0, 80)}\n_${new Date(l.timestamp).toISOString().split('T')[0]}_\n\n`;
  });
  await safeSend(ctx, msg);
});

bot.command('user_info', async (ctx) => {
  try {
    const parts = ctx.message.text.split(' ');
    const pin   = parts[1];
    const uid   = parts[2];
    if (!pin || !(await db.checkAdminPin(pin))) return;
    if (!uid) return safeSend(ctx, `❌ Usage: \`/user_info <PIN> <USER_ID>\``);

    const u = await db.getUser(uid);
    if (!u) return safeSend(ctx, `❌ User \`${uid}\` not found\\.`);

    const userLogs  = await db.getApiLogs({ userId: uid, limit: 5 });
    const userFlags = await db.getFlags();
    const uFlags    = userFlags.filter(f => f._id === uid);

    let msg = `✦ *User Info: \`${uid}\`*\n\n` +
      `📛 Username: ${u.username || 'None'}\n🏷 Custom Name: ${u.custom_name || 'None'}\n` +
      `📅 Joined: ${u.joined_date}\n🔢 Total Queries: ${u.query_count || 0}\n` +
      `📊 Today: ${u.today_count || 0}\n🚫 Banned: ${u.is_banned ? 'YES 🔴' : 'No 🟢'}\n` +
      `⚠️ Warnings: ${u.warn_count || 0}\n⚡ Custom Limit: ${u.custom_limit || 'Default'}\n` +
      `🛡️ Flags: ${uFlags.length}\n\n*Recent Activity:*\n`;

    userLogs.forEach(l => { msg += `▸ ${l.type} — ${new Date(l.timestamp).toISOString().split('T')[0]}\n`; });
    await safeSend(ctx, msg);
  } catch (e) { await db.logError('user_info', e); }
});

// ── /stats_calc <PIN> <query> ─────────────────────────────────────────────────
bot.command('stats_calc', async (ctx) => {
  try {
    const parts = ctx.message.text.split(' ');
    const pin   = parts[1];
    if (!pin || !(await db.checkAdminPin(pin))) return;

    const query = parts.slice(2).join(' ').trim();
    if (!query) return safeSend(ctx, `❌ Usage: \`/stats_calc <PIN> How many banned users?\``);

    const daysMatch = query.match(/(\d+)\s*day/i);
    const days      = daysMatch ? parseInt(daysMatch[1]) : /week/i.test(query) ? 7 : /month/i.test(query) ? 30 : 7;
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const userMatch = query.match(/@(\w+)/);
    const targetUn  = userMatch ? userMatch[1] : null;

    let result = '';

    if (/ban/i.test(query)) {
      const allUsers = await db.getAllUsers();
      const banned   = allUsers.filter(u => u.is_banned);
      result = `🚫 Total banned users: *${banned.length}*`;
    } else if (/flag|toxic|moderate/i.test(query)) {
      const pending = await db.countFlags('pending');
      const total   = await db.countFlags();
      result = `🛡️ Total flags: *${total}*\n⏳ Pending: *${pending}*\n✅ Resolved: *${total - pending}*`;
    } else if (/top|most|popular/i.test(query)) {
      const top = await db.getTopCommands({ sinceDate, limit: 3 });
      result    = `📊 Top 3 commands (last ${days} days):\n` + top.map((t, i) => `*${i + 1}.* ${t._id}: *${t.count}*`).join('\n');
    } else if (/user|people|active/i.test(query)) {
      const filterOpts = targetUn ? { sinceDate } : { sinceDate };
      // Count unique users from api_logs
      const logs   = await db.getApiLogs({ sinceDate, limit: 10000 });
      const unique = [...new Set(logs.map(l => l.userId))];
      result = `👥 Active users in last ${days} days: *${unique.length}*`;
    } else if (/call|api|request|query/i.test(query)) {
      const filterOpts = {};
      if (targetUn) {
        const allUsers = await db.getAllUsers();
        const target   = allUsers.find(u => u.username === `@${targetUn}`);
        if (target) filterOpts.userId = target._id;
      }
      const count = await db.countApiLogs({ ...filterOpts, sinceDate });
      result = `🔢 API calls in last ${days} days${targetUn ? ` by @${targetUn}` : ''}: *${count}*`;
    } else {
      const allUsers = await db.getAllUsers();
      const count    = await db.countApiLogs({ sinceDate });
      result = `📊 Stats (last ${days} days):\n▸ Total calls: *${count}*\n▸ Total users: *${allUsers.length}*\n▸ Banned: *${allUsers.filter(u => u.is_banned).length}*`;
    }

    await safeSend(ctx,
      `✦ ════════════════════ ✦\n   📊 *A N A L Y T I C S*\n✦ ════════════════════ ✦\n\n` +
      `🔍 Query: _"${query}"_\n\n${result}\n\n✦ ────────────────────── ✦`
    );
  } catch (e) { await db.logError('stats_calc', e); }
});

// ═══════════════════════════════════════════════════════════════════════════
// § 20. DYNAMIC COMMAND SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

const registeredCustomCommands = new Set();

function registerCustomCommand(name, prompt) {
  if (registeredCustomCommands.has(name)) return;
  registeredCustomCommands.add(name);

  bot.command(name, async (ctx) => {
    try {
      const userId      = await db.ensureUser(ctx.from);
      const displayName = await db.getDisplayName(userId, ctx.from);
      const { allowed } = await db.checkLimit(userId);
      if (!allowed) return safeSend(ctx, `⏰ *Daily limit reached, ${displayName}\\!* Resets at midnight\\.`);

      const userText = ctx.message.text.split(' ').slice(1).join(' ').trim()
        || ctx.session?.lastAnalyzedContent
        || (await db.getHistory(userId)).filter(m => m.role === 'user').slice(-1)[0]?.content
        || 'Help me study';

      const loadMsg  = await ctx.reply(`✦ Custom mode activated for ${displayName}...`);
      const messages = [
        { role: 'system', content: `${prompt}\n\nStudent name: ${displayName}. Always address them by name.\n\nEnd responses with "Does this help, ${displayName}? 😊"` },
        ...(await db.getHistory(userId)).slice(-6),
        { role: 'user', content: userText }
      ];

      const result = await callGroq(messages);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch (_) {}

      if (!result) return safeSend(ctx, `⚠️ AI is busy\\. Try again in a moment\\.`);

      await db.incrementUsage(userId);
      await db.logApiCall(userId, `custom:${name}`);
      await db.addToHistory(userId, 'user', userText);
      await db.addToHistory(userId, 'assistant', result);
      await sendLong(ctx, result);
    } catch (e) { await db.logError(`custom:${name}`, e); }
  });
}

// Load custom commands from MongoDB on boot
async function loadCustomCommands() {
  try {
    const cmds = await db.getCustomCommands();
    Object.entries(cmds).forEach(([name, data]) => {
      const p = typeof data === 'string' ? data : data.prompt;
      if (p) { console.log(`[Bot] Loading custom command: /${name}`); registerCustomCommand(name, p); }
    });
  } catch (e) { console.error('[Bot] Error loading custom commands:', e.message); }
}

bot.command('add_command', async (ctx) => {
  try {
    const parts = ctx.message.text.split(' ');
    const pin   = parts[1];
    if (!pin || !(await db.checkAdminPin(pin))) return;

    const name   = parts[2]?.replace(/^\//, '').toLowerCase();
    const prompt = parts.slice(3).join(' ').trim();

    if (!name || !prompt) {
      return safeSend(ctx,
        `❌ *Usage:*\n\`/add_command <PIN> <command_name> <AI system prompt>\`\n\n` +
        `*Example:*\n\`/add_command PECULIAR123 quiz_hard You are a strict quiz master. Generate 10 very hard MCQ questions.\``
      );
    }

    await db.setCustomCommand(name, prompt);
    registerCustomCommand(name, prompt);

    await safeSend(ctx,
      `✅ *Dynamic Command Created\\!* ✦\n\n▸ Command: \`/${name}\`\n▸ Prompt: _"${prompt.substring(0, 80)}..."_\n\n🟢 *Active immediately — no restart needed\\!*`
    );
  } catch (e) { await db.logError('add_command', e); }
});
// ═══════════════════════════════════════════════════════════════════════════
// § 21. DYNAMIC MENU BUTTON SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

bot.command('add_menu_button', async (ctx) => {
  try {
    const pin  = ctx.message.text.split(' ')[1];
    if (!pin || !(await db.checkAdminPin(pin))) return;

    const rest    = ctx.message.text.replace(/\/add_menu_button\s+\S+\s*/, '').trim();
    const matches = rest.match(/"([^"]+)"\s+"([^"]+)"/);

    if (!matches) {
      return safeSend(ctx,
        `❌ *Usage:*\n\`/add_menu_button <PIN> "Button Label" "callback_or_url"\`\n\n` +
        `*Examples:*\n\`/add_menu_button PECULIAR123 "🎨 Generate Art" "action_art"\`\n` +
        `\`/add_menu_button PECULIAR123 "🌐 Website" "https://example.com"\``
      );
    }

    const label   = matches[1];
    const cbOrUrl = matches[2];
    const newBtn  = cbOrUrl.startsWith('http') ? { text: label, url: cbOrUrl } : { text: label, callback_data: cbOrUrl };

    await db.addMenuButton([newBtn]);
    await safeSend(ctx, `✅ *Button Added\\!* ✦\n\n▸ Label: *${label}*\n▸ Action: \`${cbOrUrl}\`\n\n🟢 Appears in Main Menu immediately\\.`);
  } catch (e) { await db.logError('add_menu_button', e); }
});

bot.command('remove_menu_button', async (ctx) => {
  try {
    const pin  = ctx.message.text.split(' ')[1];
    if (!pin || !(await db.checkAdminPin(pin))) return;

    const rest    = ctx.message.text.replace(/\/remove_menu_button\s+\S+\s*/, '').trim();
    const matches = rest.match(/"([^"]+)"/);

    if (!matches) return safeSend(ctx, `❌ *Usage:* \`/remove_menu_button <PIN> "Button Label"\``);

    const label   = matches[1];
    const removed = await db.removeMenuButton(label);

    if (!removed) return safeSend(ctx, `❌ Button *"${label}"* not found\\.`);
    await safeSend(ctx, `✅ *Button Removed\\!*\n▸ Removed: *${label}*\nMenu updated immediately\\.`);
  } catch (e) { await db.logError('remove_menu_button', e); }
});

bot.command('list_menu', async (ctx) => {
  try {
    const pin = ctx.message.text.split(' ')[1];
    if (!pin || !(await db.checkAdminPin(pin))) return;

    const menuButtons = await db.getMenuButtons();
    if (!menuButtons.length) return safeSend(ctx, `📋 *Menu is empty\\.*`);

    let msg = `📋 *Current Menu Buttons:*\n\n`;
    menuButtons.forEach((row, ri) => {
      row.forEach(btn => {
        const target = btn.url ? `🔗 ${btn.url.substring(0, 40)}` : `📲 ${btn.callback_data}`;
        msg += `▸ Row ${ri + 1}: *${btn.text}* → \`${target}\`\n`;
      });
    });
    msg += `\n_Total rows: ${menuButtons.length}_`;
    await safeSend(ctx, msg);
  } catch (e) { await db.logError('list_menu', e); }
});

// ═══════════════════════════════════════════════════════════════════════════
// § 22. MEDIA HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

bot.on('photo', async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);

    // Broadcast image mode
    if (ctx.session?.broadcastMode === 'image' && ctx.session?.isAdmin) {
      const userIds = await db.getActiveUserIds();
      const fileId  = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      const cap     = ctx.message.caption || '';
      let ok = 0, fail = 0;
      await safeSend(ctx, `📢 *Broadcasting image to ${userIds.length} users\\.\\.\\.*`);
      for (const uid of userIds) {
        try { await ctx.telegram.sendPhoto(uid, fileId, { caption: cap, parse_mode: 'Markdown' }); ok++; } catch { fail++; }
        await new Promise(r => setTimeout(r, 60));
      }
      ctx.session.broadcastMode = null;
      return safeSend(ctx, `✅ *Image Broadcast Done\\!*\n📤 Sent: *${ok}* | ❌ Failed: *${fail}*`);
    }

    // Batch image awaiting
    if (ctx.session?.mode === 'image_awaiting') {
      if (!ctx.session.imagesReceived) ctx.session.imagesReceived = [];
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      ctx.session.imagesReceived.push(photo.file_id);
      const received = ctx.session.imagesReceived.length;
      const expected = ctx.session.imageCount;

      if (received < expected) {
        return safeSend(ctx, `✅ *Image ${received}/${expected} received\\.* Send the next one\\.`);
      }

      await safeSend(ctx, `✅ *All ${expected} image${expected > 1 ? 's' : ''} received\\!* Analyzing...`);
      await processImageWithVision(ctx, userId, displayName,
        ctx.session.imagesReceived[ctx.session.imagesReceived.length - 1],
        `Analyze all ${expected} images. Extract all text, diagrams, formulas and academic content.`
      );
      ctx.session.mode = null; ctx.session.imageCount = 0; ctx.session.imagesReceived = [];
      return;
    }

    // Single image
    const { allowed } = await db.checkLimit(userId);
    if (!allowed) return safeSend(ctx, `⏰ *Daily limit reached, ${displayName}\\!* Resets at midnight\\.`);

    const photo   = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption || 'Analyze this image. Extract all academic content, text, formulas, and diagrams in detail.';
    let extraCtx  = '';
    if (ctx.message.reply_to_message?.text) {
      extraCtx = `Previous context: "${ctx.message.reply_to_message.text.substring(0, 500)}"\n\n`;
    }

    await ctx.reply(`🔍 Analyzing image, ${displayName}...`);
    await processImageWithVision(ctx, userId, displayName, photo.file_id, `${extraCtx}${caption}`);
  } catch (e) { await db.logError('photoHandler', e); }
});

async function processImageWithVision(ctx, userId, displayName, fileId, prompt) {
  try {
    const fileInfo = await ctx.telegram.getFile(fileId);
    const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    const buffer   = await response.buffer();
    const base64   = buffer.toString('base64');

    const sysPrompt  = await buildSystemPrompt(displayName);
    const fullPrompt = `${sysPrompt}\n\n${prompt}`;
    const result     = await callGroqVision(fullPrompt, base64, 'image/jpeg');

    if (!result) return safeSend(ctx, `⚠️ Could not analyze image\\. Please try again\\.`);

    ctx.session.lastAnalyzedContent = result;
    await db.incrementUsage(userId);
    await db.logApiCall(userId, 'vision');
    await db.addToHistory(userId, 'user', '[Image uploaded]');
    await db.addToHistory(userId, 'assistant', result);

    await safeSend(ctx,
      `🔍 *I've analyzed this 📸 Image\\.*\n\n${cleanText(result)}\n\n_What shall we do with this content?_`,
      actionKeyboard()
    );
  } catch (e) {
    await db.logError('processImageWithVision', e);
    await safeSend(ctx, `❌ Could not process this image\\. Please try another format\\.`);
  }
}

bot.on('document', async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const doc         = ctx.message.document;
    const mimeType    = doc.mime_type || '';

    // Broadcast PDF mode
    if (ctx.session?.broadcastMode === 'pdf' && ctx.session?.isAdmin) {
      const userIds = await db.getActiveUserIds();
      let ok = 0, fail = 0;
      await safeSend(ctx, `📢 *Broadcasting PDF to ${userIds.length} users\\.\\.\\.*`);
      for (const uid of userIds) {
        try { await ctx.telegram.sendDocument(uid, doc.file_id, { caption: ctx.message.caption || '', parse_mode: 'Markdown' }); ok++; } catch { fail++; }
        await new Promise(r => setTimeout(r, 60));
      }
      ctx.session.broadcastMode = null;
      return safeSend(ctx, `✅ *PDF Broadcast Done\\!*\n📤 Sent: *${ok}* | ❌ Failed: *${fail}*`);
    }

    // Batch PDF awaiting
    if (ctx.session?.mode === 'pdf_awaiting') {
      if (!ctx.session.pdfsReceived) ctx.session.pdfsReceived = [];
      ctx.session.pdfsReceived.push({ fileId: doc.file_id, name: doc.file_name });
      const received = ctx.session.pdfsReceived.length;
      const expected = ctx.session.pdfCount;

      if (received < expected) {
        return safeSend(ctx, `✅ *PDF ${received}/${expected} received\\.* Send the next one\\.`);
      }

      await safeSend(ctx, `✅ *All ${expected} PDF${expected > 1 ? 's' : ''} received\\!* Processing...`);
      for (const pdf of ctx.session.pdfsReceived) {
        await processPDFDocument(ctx, userId, displayName, pdf.fileId, pdf.name);
      }
      ctx.session.mode = null; ctx.session.pdfCount = 0; ctx.session.pdfsReceived = [];
      return;
    }

    // Single document
    const { allowed } = await db.checkLimit(userId);
    if (!allowed) return safeSend(ctx, `⏰ *Daily limit reached, ${displayName}\\!* Resets at midnight\\.`);

    if (!mimeType.includes('pdf') && !mimeType.includes('text') && !mimeType.includes('document') && !mimeType.includes('msword') && !mimeType.includes('officedocument')) {
      return safeSend(ctx, `❌ *Unsupported file type\\.* Please upload a PDF, Word doc, or text file\\.`);
    }

    await ctx.reply(`📄 Processing ${mimeType.includes('pdf') ? 'PDF' : 'document'}, ${displayName}...`);
    await processPDFDocument(ctx, userId, displayName, doc.file_id, doc.file_name);
  } catch (e) { await db.logError('documentHandler', e); }
});

async function processPDFDocument(ctx, userId, displayName, fileId, fileName) {
  let tmpImagePath = null;
  try {
    const fileInfo = await ctx.telegram.getFile(fileId);
    const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    const buffer   = await response.buffer();

    let extractedText = '';
    const isPDF       = fileInfo.file_path?.toLowerCase().endsWith('.pdf') || (ctx.message?.document?.mime_type || '').includes('pdf');

    if (isPDF) {
      try {
        const pdfParse = require('pdf-parse');
        const pdfData  = await pdfParse(buffer);
        extractedText  = (pdfData.text || '').substring(0, 8000);

        if (extractedText.replace(/\s+/g, '').length < 100) {
          try {
            const { fromBuffer } = require('pdf2pic');
            const { v4: uuid4 }  = require('uuid');
            const converter      = fromBuffer(buffer, {
              density: 150, saveFilename: `pdf_${uuid4()}`, savePath: TMP_DIR,
              format: 'png', width: 1200, height: 1600
            });
            const page = await converter(1, { responseType: 'base64' });
            if (page?.base64) {
              const sysP   = await buildSystemPrompt(displayName);
              const vPrompt = `${sysP}\nThis is page 1 of "${fileName}". Extract ALL text, formulas, tables, diagrams. Be comprehensive.`;
              const vResult = await callGroqVision(vPrompt, page.base64, 'image/png');
              if (vResult) { extractedText = vResult; tmpImagePath = page.path; }
            }
          } catch (pe) { await db.logError('pdf2pic', pe); }
        }
      } catch (pe) {
        await db.logError('pdf-parse', pe);
        extractedText = buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').substring(0, 6000);
      }
    } else {
      extractedText = buffer.toString('utf8').substring(0, 8000);
    }

    if (!extractedText || extractedText.trim().length < 20) {
      extractedText = `[Document: ${fileName}. Image-based or no extractable text. Please describe what you need analyzed.]`;
    }

    const caption  = ctx.message?.caption || 'Analyze this document comprehensively. Extract key topics, main ideas, and important content.';
    const history  = await db.getHistory(userId);
    const sysPrompt = await buildSystemPrompt(displayName);
    const messages = [
      { role: 'system', content: sysPrompt },
      ...history.slice(-6),
      { role: 'user', content: `Document: "${fileName}"\n\nContent:\n${extractedText}\n\nInstruction: ${caption}` }
    ];

    const result = await callGroq(messages);
    if (!result) return safeSend(ctx, `⚠️ Could not analyze document\\. Please try again\\.`);

    ctx.session.lastAnalyzedContent = extractedText;
    await db.incrementUsage(userId);
    await db.logApiCall(userId, 'pdf');
    await db.addToHistory(userId, 'user', `[PDF: ${fileName}]`);
    await db.addToHistory(userId, 'assistant', result);

    await safeSend(ctx,
      `📄 *I've analyzed: "${fileName}"\\.*\n\n${cleanText(result)}\n\n_What shall we do with this content?_`,
      actionKeyboard()
    );
  } catch (e) {
    await db.logError('processPDFDocument', e);
    await safeSend(ctx, `❌ Could not read this file\\. Try another PDF or paste the text directly\\.`);
  } finally {
    cleanupFile(tmpImagePath);
  }
}

bot.on('voice', async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const { allowed } = await db.checkLimit(userId);
    if (!allowed) return safeSend(ctx, `⏰ *Daily limit reached, ${displayName}\\!* Resets at midnight\\.`);

    await ctx.reply(`🎤 Transcribing your voice note, ${displayName}...`);

    const fileInfo = await ctx.telegram.getFile(ctx.message.voice.file_id);
    const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    const buffer   = await response.buffer();

    const transcript = await callGroqWhisper(buffer, 'voice.ogg');
    if (!transcript) return safeSend(ctx, `⚠️ Could not transcribe audio\\. Type your question instead\\.`);

    await safeSend(ctx, `🎤 *Transcription:*\n_"${transcript}"_\n\nAnalyzing...`);

    const history  = await db.getHistory(userId);
    const sysPrompt = await buildSystemPrompt(displayName);
    const messages = [
      { role: 'system', content: sysPrompt },
      ...history.slice(-8),
      { role: 'user', content: transcript }
    ];

    const result = await callGroq(messages);
    if (!result) return safeSend(ctx, `⚠️ AI is busy\\. Try again\\.`);

    ctx.session.lastAnalyzedContent = transcript;
    await db.incrementUsage(userId);
    await db.logApiCall(userId, 'whisper');
    await db.addToHistory(userId, 'user', transcript);
    await db.addToHistory(userId, 'assistant', result);

    await safeSend(ctx,
      `🔍 *I've identified this as a 🎤 Voice Note\\.*\n\n${cleanText(result)}\n\n_What shall we do with this content?_`,
      actionKeyboard()
    );
  } catch (e) {
    await db.logError('voiceHandler', e);
    await safeSend(ctx, `❌ Could not process voice note\\. Please try again or type your question\\.`);
  }
});

bot.on(['video', 'video_note'], async (ctx) => {
  const userId      = await db.ensureUser(ctx.from);
  const displayName = await db.getDisplayName(userId, ctx.from);
  await safeSend(ctx,
    `🎥 *Video received, ${displayName}\\!*\n\nFor video content, please:\n▸ Extract the audio → send as voice note\n▸ OR take a screenshot → send as image\n▸ OR type/paste the content text directly\\!`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// § 23. MAIN TEXT HANDLER — CHAT + AUTO-MOD + NATURAL LANGUAGE
// ═══════════════════════════════════════════════════════════════════════════

bot.on('text', async (ctx) => {
  try {
    const userId      = await db.ensureUser(ctx.from);
    const displayName = await db.getDisplayName(userId, ctx.from);
    const text        = ctx.message.text?.trim();

    if (!text || text.startsWith('/')) return;

    // ── AUTO-MODERATION CHECK ──────────────────────────────────────────────
    const modResult = await moderateMessage(ctx, text);

    if (modResult.action === 'ban') return; // auto-banned, drop silently

    if (modResult.action === 'warn') {
      await safeSend(ctx,
        `⚠️ *Warning, ${displayName}\\!*\n\n` +
        `Your message contained content that violates our community guidelines\\.\n\n` +
        `Please keep all conversations *academic and respectful*\\.\n` +
        `Further violations may result in a ban\\.\n\n` +
        `_Let's focus on learning\\! 📚_`
      );
      if (modResult.severity === 'critical') return;
    }

    // ── DAILY LIMIT CHECK ──────────────────────────────────────────────────
    const { allowed, count, limit } = await db.checkLimit(userId);
    if (!allowed) {
      return safeSend(ctx, `⏰ *Daily Limit Reached, ${displayName}\\!*\n\n${usageBar(count, limit)}\n\nResets at midnight\\. 🌙`);
    }

    // ── BATCH COUNT INPUT ──────────────────────────────────────────────────
    if (ctx.session?.mode === 'image_count_pending') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1 || n > 20) return safeSend(ctx, `❌ Please enter a number between 1 and 20\\.`);
      ctx.session.imageCount = n; ctx.session.imagesReceived = []; ctx.session.mode = 'image_awaiting';
      return safeSend(ctx, `✅ Got it\\! Please send *${n}* image${n > 1 ? 's' : ''} now\\.`);
    }

    if (ctx.session?.mode === 'pdf_count_pending') {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1 || n > 20) return safeSend(ctx, `❌ Please enter a number between 1 and 20\\.`);
      ctx.session.pdfCount = n; ctx.session.pdfsReceived = []; ctx.session.mode = 'pdf_awaiting';
      return safeSend(ctx, `✅ Got it\\! Please send *${n}* PDF file${n > 1 ? 's' : ''} now\\.`);
    }

    // ── STRICT AI RULE CHECKS ──────────────────────────────────────────────
    if (/\b(llm|gpt|groq|claude|gemini|openai|api.?key|model|source.?code|how.{0,20}built|show.{0,15}code|backend|prompt.?inject)\b/i.test(text)) {
      return safeSend(ctx, `🤫 *Top Secret\\!*\nI'm your dedicated AI tutor\\. My inner workings are classified\\!\nBut I CAN help you ace that exam\\! Want to try a quiz? 📝`);
    }

    if (/\b(who (made|built|created|owns)|your owner|your creator|who is peculiar|propeak)\b/i.test(text)) {
      return safeSend(ctx,
        `🎓 *My Creator:*\n\nBuilt by *Peculiar*\\! 👑\nFounder of *Propeak Digital Academy*\nExpert Video Editor, Web Dev, Graphics Designer\\.\n📱 Contact: *07042999216*`,
        Markup.inlineKeyboard([[Markup.button.url('💬 Contact Peculiar', WA_SUPPORT)]])
      );
    }

    if (/\b(write.{0,20}(bot|script|hack|exploit|virus|malware|app|website)|how.{0,10}hack|crack|bypass|jailbreak)\b/i.test(text)) {
      return safeSend(ctx, `⚠️ *Out of Scope\\!*\nI'm strictly a *Student Tutor*\\. I help you understand concepts, not write scripts or hacks\\.\nLet's focus on your studies\\! 📖`);
    }

    // ── SMART SWIPE/REPLY CONTEXT ──────────────────────────────────────────
    let contextPrefix = '';
    if (ctx.message.reply_to_message) {
      const repliedText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '';
      if (repliedText) {
        contextPrefix = `Context from replied message:\n"${repliedText.substring(0, 1200)}"\n\nUser follow-up: `;
      }
    }

    // ── NATURAL LANGUAGE INTENT ────────────────────────────────────────────
    const intent = detectIntent(text);
    let userPrompt;

    if (intent) {
      const history = await db.getHistory(userId);
      const content = ctx.session?.lastAnalyzedContent
        || history.filter(m => m.role === 'user').slice(-1)[0]?.content;
      userPrompt = content ? buildLearningPrompt(intent, content) : `${contextPrefix}${text}`;
    } else {
      userPrompt = `${contextPrefix}${text}`;
    }

    // ── SEND TO AI ─────────────────────────────────────────────────────────
    const typingMsg = await ctx.reply(`💭 Thinking, ${displayName}...`);
    const history   = await db.getHistory(userId);
    const sysPrompt = await buildSystemPrompt(displayName);
    const messages  = [
      { role: 'system', content: sysPrompt },
      ...history.slice(-8),
      { role: 'user',   content: userPrompt }
    ];

    const result = await callGroq(messages);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, typingMsg.message_id); } catch (_) {}

    if (!result) return safeSend(ctx, `⚠️ *AI is busy right now, ${displayName}\\.*\nTry again in a moment\\! 🔄`);

    await db.incrementUsage(userId);
    await db.logApiCall(userId, 'chat');
    await db.addToHistory(userId, 'user', userPrompt);
    await db.addToHistory(userId, 'assistant', result);

    await sendLong(ctx, result);
  } catch (e) { await db.logError('textHandler', e); }
});
// ═══════════════════════════════════════════════════════════════════════════
// § 24. GLOBAL ERROR HANDLER & BOOT SEQUENCE
// ═══════════════════════════════════════════════════════════════════════════

bot.catch(async (err, ctx) => {
  console.error(`[Bot Error] Type: ${ctx?.updateType}`, err?.message);
  await db.logError(`update:${ctx?.updateType || 'unknown'}`, err);
  try { ctx?.reply('⚠️ Something went wrong. Please type /start to restart.').catch(() => {}); } catch (_) {}
});

// ── Startup sequence: DB first, then bot launch ───────────────────────────────
async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  🎓 Student Prompt Hub AI v4.0 — Starting...             ║');
  console.log('║  Hugging Face Docker Edition — MongoDB Cloud DB          ║');
  console.log('║  By Propeak Digital Academy | Founder: Peculiar          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  // Step 1: Connect to MongoDB
  await db.connect();

  // Step 2: Load dynamic commands from DB
  await loadCustomCommands();

  // Step 3: Launch bot
  await bot.launch();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  ✅ Student Prompt Hub AI v4.0 — ONLINE                  ║');
  console.log('║  Self-Training & Auto-Moderation Edition                 ║');
  console.log('║  Engine: Groq AI | DB: MongoDB Atlas | Port:', String(PORT).padEnd(4), '       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
}

main().catch(err => {
  console.error('[FATAL] Startup failed:', err.message);
  process.exit(1);
});

process.once('SIGINT',  () => { console.log('\n[Bot] Shutting down (SIGINT)...');  bot.stop('SIGINT');  });
process.once('SIGTERM', () => { console.log('\n[Bot] Shutting down (SIGTERM)...'); bot.stop('SIGTERM'); });
