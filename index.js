require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, Collection, MessageFlags } = require('discord.js');
const logger = require('./utils/logger');
const bootSummary = require('./utils/bootSummary');

// ── 導入處理器（縮減版：只保留 autojoin + music）───────────
const { setupAutoJoinCommands }  = require('./handlers/autoJoinHandler');

// ── 音樂模組 ───────────────────────────────────────────────
const { setupUnifiedCommands }   = require('./handlers/musicplayer/unifiedQueue');
const { setupOnlineMusicEngine } = require('./handlers/musicplayer/onlineMusicHandler');
const { setupLocalMusicEngine }  = require('./handlers/musicplayer/localMusicHandler');

// ── 創建客戶端 ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ]
});

// ── Slash Command 集合 ─────────────────────────────────────
client.commands = new Collection();

// ── 註冊模組處理器 ─────────────────────────────────────────
setupAutoJoinCommands(client);

// ── Slash Command 互動處理 ─────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── Autocomplete（必須在最上面）────────────────────────
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error('❌ Autocomplete 錯誤：', err);
      }
    }
    return;
  }

  // ── Slash Command ───────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    console.warn(`⚠️ 找不到指令：/${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(`❌ 執行指令 /${interaction.commandName} 時發生錯誤：`, error);
    const reply = {
      content: '❌ 執行指令時發生錯誤，請稍後再試。',
      flags: MessageFlags.Ephemeral,
    };
    // 回覆錯誤訊息本身也可能失敗（互動已逾時、頻道已刪除），不要讓它變成 unhandled rejection
    const send = interaction.replied || interaction.deferred
      ? interaction.followUp(reply)
      : interaction.reply(reply);
    await send.catch(err => console.error('❌ 回覆錯誤訊息失敗：', err.message));
  }
});

// ── 註冊 Slash Commands 到 Discord ────────────────────────
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [...client.commands.values()].map(cmd => cmd.data.toJSON());

  try {
    logger.debug('Boot', '正在註冊 Slash Commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    bootSummary.report('Slash Commands 註冊', 'ok', `已同步 ${commands.length} 個指令到 Discord`);
  } catch (err) {
    bootSummary.report('Slash Commands 註冊', 'off', `註冊失敗: ${err.message}`);
    console.error('❌ Slash Commands 註冊失敗:', err);
  }
}

// ── Bot 啟動 ───────────────────────────────────────────────
client.once('clientReady', async () => {
  logger.success('Discord', `已登入為 ${client.user.tag}（${client.guilds.cache.size} 個伺服器）`);

  // ── 音樂引擎初始化（需 async，在 ready 後執行）──────────
  // 順序重要：先注入引擎，再載入統一指令
  await setupOnlineMusicEngine(); // 1. 注入 online 引擎（含 yt-dlp 檢查）
  setupLocalMusicEngine(client);  // 2. 注入 local 引擎（/music local list 由 setupUnifiedCommands 註冊）
  setupUnifiedCommands(client);   // 3. 載入合併後的 /music 指令

  client.user.setPresence({
    activities: [{ name: '皮鼓', type: 2 }],
    status: 'online'
  });

  await registerSlashCommands();

  // ── 所有模組都已回報狀態，統一印出開機摘要 ────────────
  bootSummary.print();
});

// ── 錯誤處理 ──────────────────────────────────────────────
client.on('error', error => {
  console.error('❌ Discord 客戶端錯誤：', error);
});

process.on('unhandledRejection', error => {
  console.error('❌ 未處理的 Promise 拒絕：', error);
});

process.on('uncaughtException', error => {
  console.error('❌ 未捕捉的例外：', error);
});

// ── 正常關機（SIGTERM / SIGINT）──────────────────────────
// 沒有這個處理時程序是被訊號直接殺掉，process.on('exit') 不會執行，
// onlineMusicHandler 的 yt-dlp 子程序清理會被跳過。
// 先關閉 Discord 連線（最多等 SHUTDOWN_TIMEOUT_MS），再以 process.exit() 結束。
const SHUTDOWN_TIMEOUT_MS = 3000;
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`⏹️ 收到 ${signal}，正在關閉...`);
  const timeout = new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
  try {
    await Promise.race([client.destroy(), timeout]);
  } catch {}
  // process.exit() 會觸發各模組註冊的 'exit' 處理（結束 yt-dlp 子程序）
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => gracefulShutdown(signal));
}

// ── 登入 ──────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('❌ 登入失敗：', error);
  process.exit(1);
});
