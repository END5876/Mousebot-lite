'use strict';
// admin/api/voice.js（精簡版）— 音樂播放控制與點歌、閒置自動停止、自動加入語音頻道
// 與正式版的差別：精簡版沒有手動加入／離開語音頻道（由自動加入管理）與喚醒詞監聽，不回報 voice:join、voice:wakeWord

const { getVoiceConnection } = require('@discordjs/voice');
const voiceMonitor = require('../../handlers/musicplayer/voiceActivityMonitor');
const autoJoin = require('../../handlers/autoJoinHandler');
const { TEXT_TYPES, VOICE_TYPES, guildSummary, guildChannels } = require('../discordInfo');
const {
  voiceInfo, musicState, idleMonitorState, musicAction, libraryList, onlineSearch, enqueueFromPanel,
} = require('../voiceState');
const { HttpError, bool, snowflake, str, requireReady } = require('../http');

const LOOP_LABEL = { off: '關閉循環', one: '開啟單曲循環', all: '開啟列表循環' };

function autoJoinState(client) {
  const config = autoJoin.getAutoJoinConfig();
  const channel = config.targetChannelId ? client.channels.cache.get(config.targetChannelId) : null;
  const guildId = channel?.guild?.id ?? config.targetGuildId;
  const connection = guildId ? getVoiceConnection(guildId) : null;
  return {
    enabled: config.enabled,
    targetChannelId: config.targetChannelId,
    targetGuildId: guildId ?? null,
    channelName: channel?.name ?? null,
    guildName: channel?.guild?.name ?? null,
    // Bot 是否真的在目標頻道裡（連線就緒且頻道一致）
    connected: !!connection && connection.state.status === 'ready' && connection.joinConfig.channelId === config.targetChannelId,
  };
}

module.exports = function registerVoice(router, client) {
  const guildOf = (params) => {
    requireReady(client);
    const guild = client.guilds.cache.get(snowflake(params.guildId, '伺服器'));
    if (!guild) throw new HttpError(404, 'Bot 不在這個伺服器');
    return guild;
  };

  router.get('/api/voice', () => {
    requireReady(client);
    const guilds = [...client.guilds.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map((guild) => ({
        ...guildSummary(guild),
        voice: voiceInfo(guild),
        music: musicState(guild.id),
        idleMonitor: idleMonitorState(guild.id),
        voiceChannels: guildChannels(guild, VOICE_TYPES),
        textChannels: guildChannels(guild, TEXT_TYPES),
      }));
    return { autoJoin: autoJoinState(client), guilds };
  });


  // ── 音樂：控制、點歌 ─────────────────────────────────────
  // body：{ action: 'skip'|'stop'|'loop'|'random'|'clearQueue'|'removeQueue'|'enqueue', mode?, on?, index?, key?, item?, next? }
  router.post('/api/music/:guildId', async ({ params, body, audit }) => {
    const guild = guildOf(params);
    if (body.action === 'enqueue') {
      const { message } = await enqueueFromPanel(client, guild, body);
      audit(`在「${guild.name}」點歌：${message}`);
      return { message, music: musicState(guild.id) };
    }
    const title = musicState(guild.id)?.current?.title;
    const message = await musicAction(guild.id, body);
    const what = {
      skip: `跳過「${title}」`,
      stop: '停止播放',
      loop: LOOP_LABEL[body.mode],
      random: body.on ? '開啟隨機連播' : '關閉隨機連播',
      clearQueue: '清空佇列',
      removeQueue: message.replace(/^已/, ''),
    }[body.action];
    audit(`音樂（${guild.name}）：${what}`);
    return { message, music: musicState(guild.id) };
  });

  router.get('/api/music/library', ({ query }) => libraryList(query.get('q')));

  router.get('/api/music/search', async ({ query }) => {
    const q = str(query.get('q'), '搜尋關鍵字', { max: 200 });
    return { results: await onlineSearch(q) };
  });

  router.put('/api/voice/:guildId/idle', ({ params, body, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const enabled = bool(body.enabled, '閒置自動停止');
    voiceMonitor.setEnabled(guildId, enabled);
    audit(`${enabled ? '開啟' : '關閉'}「${client.guilds.cache.get(guildId)?.name ?? guildId}」的閒置自動停止`);
    return idleMonitorState(guildId);
  });

  // body：{ enabled?: boolean, channelId?: string }
  router.put('/api/autojoin', async ({ body, audit }) => {
    requireReady(client);
    if (body.channelId !== undefined) {
      const channelId = snowflake(body.channelId, '語音頻道');
      try {
        await autoJoin.setAutoJoinTarget(client, channelId);
      } catch (err) {
        if (err.code === 'EINVAL') throw new HttpError(400, err.message);
        throw err;
      }
      const state = autoJoinState(client);
      audit(`把自動加入的目標頻道設為「${state.guildName} › ${state.channelName}」`);
    }
    if (body.enabled !== undefined) {
      const enabled = bool(body.enabled, '自動加入');
      autoJoin.setAutoJoinEnabled(client, enabled);
      audit(`${enabled ? '開啟' : '關閉'}自動加入語音頻道`);
    }
    return autoJoinState(client);
  });
};
