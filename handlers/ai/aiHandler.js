// handlers/ai/aiHandler.js（精簡版）
// 由正式版 Mousebot 的 aiHandler.js 精簡而來：只有單一人格（群聊），人格由 AI_PERSONA 決定。
//   保留：/ai ask、/ai clear、/ai chance set / toggle、@ 提及回覆、隨機插話
//   拿掉：/ai mode、/ai scope、/ai prompt edit、/ai tts、/ai gugu、TTS 朗讀、function calling 工具、
//         /response 自訂回應的判斷（精簡版沒有這些模組）
// 沒有設定 GEMINI_API_KEY 時 setupAICommands 不註冊任何東西（index.js 也不會載入這個檔案）。

const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } = require('discord.js');

const {
    getGeminiResponse,
    getShortResponse,
    isEmptyResponseError,
    EMPTY_RESPONSE_MESSAGE,
} = require('./aiCore');

const {
    clearUserInChannel, clearChannelMemory,
    recordBotMessageContext,
    processAttachments,
    processCustomEmojis,
    processImageUrls,
    processEmbeds,
    withTyping,
    replaceMentions,
} = require('./aiUtils');

const {
    DEFAULT_CHANCE,
    getReplyChance,
    shouldRandomReply,
    setReplyChance,
    resetReplyChance,
    isChannelDisabled,
    toggleChannel,
} = require('./aiChance');

const persona = require('./persona');
const { buildPayloads } = require('./memeStore');
const bootSummary = require('../../utils/bootSummary');
const { isOwner } = require('../../utils/config');
const { isQuotaError, quotaMessage, describeLimits } = require('./aiQuota');
const { MODEL_NAME } = require('./geminiClient');
const { ENABLED_GUILD_IDS: SEARCH_GUILD_IDS } = require('./searchGrounding');
const logger = require('../../utils/logger');

/** 有設定 GEMINI_API_KEY 才啟用 AI（index.js 也用它決定要不要多要訊息相關的 intents） */
function isAIEnabled() {
    return !!process.env.GEMINI_API_KEY?.trim();
}

// 每則訊息都會跑一次的正規表示式：單段非空白匹配（網址中任一處出現圖片副檔名），避免長訊息 O(n²) 回溯
const LIKELY_IMAGE_LINK_RE = /https?:\/\/\S+\.(?:png|jpe?g|webp|heic|heif|gif)(?:\?\S*)?|cdn\.discordapp\.com\/attachments\//i;

const MISSING_SIGNATURE_HINT = '[系統提示：使用者傳送的 Discord 圖片網址缺少了安全簽名參數(?ex=...&is=...)，導致權限不足無法讀取。請告訴使用者連結後面的參數不見了，請他重新上傳圖片或貼完整的連結。]';

// 被 AI 額度擋下時回覆一則提示，數秒後自動刪除，避免連續觸發時洗版
const QUOTA_NOTICE_TTL_MS = 10 * 1000;
async function replyQuotaNotice(message, error) {
    const sent = await message.reply({ content: quotaMessage(error), allowedMentions: { repliedUser: false } }).catch(() => null);
    if (sent) setTimeout(() => sent.delete().catch(() => {}), QUOTA_NOTICE_TTL_MS).unref?.();
}

// 模型沒有產生文字時至少回一句，不要讓使用者 @ 了卻毫無反應
async function replyEmptyNotice(message) {
    await message.reply({ content: EMPTY_RESPONSE_MESSAGE, allowedMentions: { repliedUser: false } }).catch(() => {});
}

// 「顯示名稱 (@username)」：與群組歷史的發言者標籤一致
function labelOf(member, user) {
    return `${member?.displayName ?? user.globalName ?? user.username} (@${user.username})`;
}

// ════════════════════════════════════════════════════════
//  /ai：ask / clear / chance(group)
// ════════════════════════════════════════════════════════
const aiCommand = {
    data: new SlashCommandBuilder()
        .setName('ai')
        .setDescription('AI 對話相關功能')
        // 精簡版沒有 DM 的 intent，群聊歷史也以伺服器頻道為單位：只在伺服器內提供
        .setContexts(InteractionContextType.Guild)

        // ── /ai ask ──
        .addSubcommand(sub =>
            sub.setName('ask')
                .setDescription('詢問 AI 問題')
                .addStringOption(opt =>
                    opt.setName('question').setDescription('你想問的問題').setRequired(true)
                )
                .addAttachmentOption(opt =>
                    opt.setName('image').setDescription('附上圖片（選填）').setRequired(false)
                )
        )

        // ── /ai clear ──
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('清除你在這個頻道與 AI 的對話記憶')
                .addBooleanOption(opt =>
                    opt.setName('all')
                        .setDescription('清除整個頻道所有人的對話記憶（僅限管理員）')
                        .setRequired(false)
                )
        )

        // ── /ai chance set / toggle（子指令群組，僅限管理員） ──
        .addSubcommandGroup(group =>
            group.setName('chance')
                .setDescription('AI 隨機回覆機率設定')
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('設定本伺服器的 AI 隨機回覆機率')
                        .addNumberOption(opt =>
                            opt.setName('chance')
                                .setDescription(`機率 0~100（%），不填則重置為預設值 ${(DEFAULT_CHANCE * 100).toFixed(0)}%`)
                                .setMinValue(0)
                                .setMaxValue(100)
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('toggle')
                        .setDescription('切換本頻道的 AI 隨機回覆開關（不影響其他頻道）')
                )
        )

        .setDefaultMemberPermissions(null), // 個別子指令權限在 execute() 內手動判斷

    async execute(interaction) {
        const sub   = interaction.options.getSubcommand();
        const group = interaction.options.getSubcommandGroup(false);

        if (group === 'chance') return handleChanceSet(interaction);

        switch (sub) {
            case 'ask':   return handleAsk(interaction);
            case 'clear': return handleClear(interaction);
        }
    }
};

// ── /ai ask ──────────────────────────────────────────────
async function handleAsk(interaction) {
    const userId     = interaction.user.id;
    const userName   = interaction.user.username;
    const botId      = interaction.client.user.id;
    const attachment = interaction.options.getAttachment('image');
    const rawQuestion = interaction.options.getString('question');
    // 範圍只在這裡解析一次，歷史與訊息紀錄都用同一份
    const scope      = persona.scopeFor(interaction.guildId);
    const mode       = scope.persona;
    // askText：群組歷史會在這則回覆前面補上問題（問題本身不在頻道訊息裡）
    const logExtra   = { kind: scope.kind, scopeKey: scope.scopeKey, askText: rawQuestion };

    await interaction.deferReply();

    try {
        // emoji → 網址圖片（需要清理後的文字）與附件下載彼此獨立，並行處理
        const [{ cleanedText: question, emojiParts, urlImagePartsRaw }, attachmentParts] = await Promise.all([
            processCustomEmojis(rawQuestion).then(async ({ cleanedText, emojiParts }) => ({
                cleanedText,
                emojiParts,
                // 傳入 client，讓 processImageUrls 內部可嘗試修復缺簽名網址
                urlImagePartsRaw: await processImageUrls(cleanedText, interaction.client, { guildId: interaction.guildId, userId }),
            })),
            attachment ? processAttachments(new Map([[attachment.id, attachment]])) : [],
        ]);

        const urlImageParts = urlImagePartsRaw.map(part =>
            part.type === 'missing_signature' ? { type: 'text', text: MISSING_SIGNATURE_HINT } : part
        );

        const { chunks, files } = await getGeminiResponse({
            userId, prompt: question, imageParts: [...emojiParts, ...urlImageParts, ...attachmentParts],
            channel: interaction.channel, messageId: interaction.id, botId, scope,
            userName: labelOf(interaction.member, interaction.user),
        });

        // 表情包附件跟在最後一塊文字上；只有圖時 payloads 只有一個 { files }
        const [first, ...rest] = buildPayloads(chunks, files);
        const replyMsg = await interaction.editReply(first);
        recordBotMessageContext(replyMsg.id, mode, userId, userName, logExtra);

        for (const payload of rest) {
            const followUpMsg = await interaction.followUp({ ...payload, fetchReply: true });
            recordBotMessageContext(followUpMsg.id, mode, userId, userName, logExtra);
        }
    } catch (error) {
        if (isQuotaError(error)) {
            await interaction.editReply({ content: quotaMessage(error) }).catch(() => {});
            return;
        }
        if (isEmptyResponseError(error)) {
            await interaction.editReply({ content: EMPTY_RESPONSE_MESSAGE }).catch(() => {});
            return;
        }
        logger.error('AI', `/ai ask 錯誤：${error.message}`);
        await interaction.deleteReply().catch(() => {});
    }
}

// ── 權限檢查小工具 ──────────────────────────────────────
// （子指令群組無法個別套用 setDefaultMemberPermissions，改為手動檢查）
function isAdmin(interaction) {
    return interaction.guild && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

// ── /ai clear ────────────────────────────────────────────
// 群組歷史是依頻道抓的，所以清除也以這個頻道（討論串就是討論串本身）為單位
async function handleClear(interaction) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const all = interaction.options.getBoolean('all') ?? false;
    const baseMessage = persona.getClearMessage();

    if (all) {
        if (!isAdmin(interaction) && !isOwner(userId)) {
            return interaction.reply({ content: '❌ 清除整個頻道的對話記憶需要管理員權限。', flags: MessageFlags.Ephemeral });
        }
        clearChannelMemory(channelId);
        return interaction.reply({ content: `${baseMessage}\n> 已清除**這個頻道所有人**的對話記憶。` });
    }
    // 一般成員只讓自己的發言退出這個頻道的群組歷史；措辭不能像是整個頻道都清掉了
    clearUserInChannel(channelId, userId);
    await interaction.reply({ content: `${baseMessage}\n> 只清除了**你自己**在這個頻道的對話記憶，其他人的不受影響。` });
}

// ── /ai chance set / toggle ─────────────────────────────
async function handleChanceSet(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) {
        return interaction.reply({ content: '❌ 此指令只能在伺服器中使用', flags: MessageFlags.Ephemeral });
    }
    if (!isAdmin(interaction) && !isOwner(interaction.user.id)) {
        return interaction.reply({ content: '❌ 你沒有權限使用此指令。', flags: MessageFlags.Ephemeral });
    }

    if (interaction.options.getSubcommand() === 'toggle') {
        const channelId = interaction.channelId;
        const { disabled } = toggleChannel(channelId);
        return interaction.reply({
            content: disabled
                ? `🔕 已關閉 <#${channelId}> 的 AI 隨機回覆（@ 提及仍有效）`
                : `🔔 已開啟 <#${channelId}> 的 AI 隨機回覆`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // set
    const raw = interaction.options.getNumber('chance');
    if (raw === null) {
        const defaultChance = resetReplyChance(guildId);
        return interaction.reply({
            content: `🔄 已重置本伺服器的隨機回覆機率為預設值：**${(defaultChance * 100).toFixed(1)}%**`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const result = setReplyChance(guildId, raw / 100);
    if (!result.success) {
        return interaction.reply({ content: `❌ 設定失敗：${result.error}`, flags: MessageFlags.Ephemeral });
    }

    let hint = '';
    if (result.chance === 0)      hint = '\n> ⚠️ 機率為 0%，AI 將不會主動隨機回覆。';
    else if (result.chance === 1) hint = '\n> ⚠️ 機率為 100%，AI 將對每則訊息都隨機回覆。';
    else if (result.chance > 0.5) hint = '\n> ⚠️ 機率偏高，AI 可能會非常頻繁地回覆。';

    return interaction.reply({
        content: `✅ 已將本伺服器的 AI 隨機回覆機率設為 **${(result.chance * 100).toFixed(1)}%**${hint}`,
        flags: MessageFlags.Ephemeral,
    });
}

// ════════════════════════════════════════════════════════
//  訊息處理：@ 提及、隨機插話
// ════════════════════════════════════════════════════════
async function sendChunks(message, { chunks, files }, scope) {
    const logExtra = { kind: scope.kind, scopeKey: scope.scopeKey };
    for (const payload of buildPayloads(chunks, files)) {
        const sentMsg = await message.channel.send(payload);
        recordBotMessageContext(sentMsg.id, scope.persona, message.author.id, message.author.username, logExtra);
    }
}

async function handleMention(message, client, { rawQuestion, hasAttachment, hasLikelyImageLink, scope }) {
    const userId = message.author.id;
    const botId  = client.user.id;
    const base   = { userId, channel: message.channel, messageId: message.id, botId, message, scope };
    const isEmptyContent = !rawQuestion && !hasAttachment && !hasLikelyImageLink;

    try {
        let result;
        if (isEmptyContent) {
            // 只 @ 沒打字：有引用時由 buildMessagePartsWithReference 補上引用內容與提示，
            // 沒引用就是純打招呼（buildMessagePartsWithReference 會標成「只 @ 了你，沒有說任何話」）
            result = await withTyping(message.channel, () => getGeminiResponse({ ...base, prompt: '' }));
        } else {
            // 「正在輸入中」涵蓋圖片下載/壓縮階段，使用者不用乾等
            result = await withTyping(message.channel, async () => {
                // emoji → 網址圖片、embed、附件三者彼此獨立，並行處理
                const [{ question, emojiParts, urlImagePartsRaw }, embedParts, attachmentParts] = await Promise.all([
                    processCustomEmojis(rawQuestion).then(async ({ cleanedText, emojiParts }) => ({
                        question: cleanedText,
                        emojiParts,
                        urlImagePartsRaw: await processImageUrls(cleanedText, client, { guildId: message.guildId, userId }),
                    })),
                    processEmbeds(message.embeds),
                    processAttachments(message.attachments),
                ]);

                // 缺簽名的網址：embed 預覽讀得到就不用提示
                const urlImageParts = urlImagePartsRaw.flatMap(part => {
                    if (part.type !== 'missing_signature') return [part];
                    return embedParts.length > 0 ? [] : [{ type: 'text', text: MISSING_SIGNATURE_HINT }];
                });

                return getGeminiResponse({
                    ...base, prompt: question,
                    imageParts: [...emojiParts, ...urlImageParts, ...embedParts, ...attachmentParts],
                });
            });
        }
        await sendChunks(message, result, scope);
    } catch (error) {
        if (isQuotaError(error)) await replyQuotaNotice(message, error);
        else if (isEmptyResponseError(error)) await replyEmptyNotice(message);
        else logger.error('AI', `@ 回覆錯誤：${error.message}`);
    }
}

async function handleRandomReply(message, client, { hasAttachment, hasReference, scope }) {
    const botId = client.user.id;

    // 回覆別人的訊息不插話
    if (hasReference) {
        let isReplyingToOther = false;
        if (message.mentions.repliedUser) {
            isReplyingToOther = message.mentions.repliedUser.id !== botId;
        } else {
            const refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (refMsg && refMsg.author.id !== botId) isReplyingToOther = true;
        }
        if (isReplyingToOther) return;
    }

    if (isChannelDisabled(message.channel.id)) return;

    const rawCleaned = replaceMentions(message, botId);
    if (!rawCleaned && !hasAttachment) return;

    // 只要訊息含有任何連結（包含圖片連結），隨機回覆一律不回應
    if (/(https?:\/\/[^\s)\]>]+)|(www\.[^\s)\]>]+)/i.test(rawCleaned)) return;

    if (!shouldRandomReply(message.id, getReplyChance(message.guild?.id))) return;

    try {
        const shortReply = await withTyping(message.channel, async () => {
            const [{ cleanedText, emojiParts }, attachmentParts] = await Promise.all([
                processCustomEmojis(rawCleaned),
                processAttachments(message.attachments),
            ]);
            return getShortResponse({
                userId: message.author.id, prompt: cleanedText, imageParts: [...emojiParts, ...attachmentParts],
                channel: message.channel, messageId: message.id, botId, message, scope,
            });
        });
        if (shortReply) await sendChunks(message, shortReply, scope);
    } catch (error) {
        logger.error('AI', `隨機回覆錯誤：${error.message}`);
    }
}

// ════════════════════════════════════════════════════════
//  setupAICommands
// ════════════════════════════════════════════════════════
function setupAICommands(client) {
    if (!isAIEnabled()) {
        bootSummary.report('AI 對話 (/ai)', 'off', '未設定 GEMINI_API_KEY，AI 功能停用');
        return false;
    }

    client.commands.set(aiCommand.data.name, aiCommand);

    const hasFile = persona.hasPersonaFile();
    const personaText = hasFile
        ? `人格：${persona.getPersonaName()}（${persona.getPersonaKey()}）`
        : `找不到 data/prompts/modes/${persona.getPersonaKey()}.md，使用內建的通用人格`;
    bootSummary.report(
        'AI 對話 (/ai)',
        hasFile ? 'ok' : 'warn',
        `Gemini (${MODEL_NAME}) 單一人格；${personaText}；額度：${describeLimits()}；` +
        `搜尋接地：${SEARCH_GUILD_IDS.size ? `${SEARCH_GUILD_IDS.size} 個伺服器` : '停用'}`
    );

    client.on('messageCreate', async message => {
        if (message.author.bot || !message.guild) return;

        const hasAttachment = message.attachments.size > 0;
        const content = message.content?.trim() || '';
        const hasLikelyImageLink = LIKELY_IMAGE_LINK_RE.test(content);
        if (!content && !hasAttachment && !hasLikelyImageLink) return;

        const botId = client.user.id;
        const mentionedRoles = message.mentions.roles;
        // 只認直接 @Bot（含回覆 Bot 的訊息）與 Bot 自己的整合身分組；
        // 預設的 has() 會把 @everyone/@here 與「Bot 也有的身分組」都算成 @Bot
        const isMentioned =
            message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true }) ||
            mentionedRoles.some(r => r.tags?.botId === botId);
        const hasOtherMention =
            message.mentions.users.some(u => u.id !== botId) ||
            mentionedRoles.size > 0;
        const hasReference = !!message.reference?.messageId;

        if (hasOtherMention && !hasReference && !isMentioned) return;

        // 範圍只在這裡解析一次，歷史與訊息紀錄都用同一份
        const scope = persona.scopeFor(message.guild.id);

        if (isMentioned) {
            // 將提及轉換為名字，並濾掉機器人自己（頻道停用隨機回覆不影響 @ 提及）
            const rawQuestion = replaceMentions(message, botId);
            await handleMention(message, client, { rawQuestion, hasAttachment, hasLikelyImageLink, scope });
        } else {
            await handleRandomReply(message, client, { hasAttachment, hasReference, scope });
        }
    });
    return true;
}

module.exports = { setupAICommands, isAIEnabled };
