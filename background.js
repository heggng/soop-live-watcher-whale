'use strict';

const CONFIG_KEY = 'config';
const STATE_KEY = 'broadcastStates';
const META_KEY = 'monitorMeta';
const ALARM_NAME = 'soop-live-check';
const API_URL = 'https://live.sooplive.com/afreeca/player_live_api.php';
const PLAY_URL = 'https://play.sooplive.com/';
const OFFSCREEN_PATH = 'offscreen.html';
const NOTIFICATION_ICON_PATH = 'icon128.png';
const FALLBACK_NOTIFICATION_ICON_PATH = 'icon48.png';

const DEFAULT_CONFIG = Object.freeze({
  checkIntervalSeconds: 10,
  desktopNotifications: true,
  soundEnabled: true,
  streamers: [],
});

let checkInProgress = false;
let creatingOffscreenDocument = null;
let settingsWindowId = null;

chrome.action.onClicked.addListener(() => {
  void openSettingsWindow();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === settingsWindowId) settingsWindowId = null;
});

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap(true);
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void checkAllStreamers();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[CONFIG_KEY]) {
    const config = normalizeConfig(changes[CONFIG_KEY].newValue);
    void resetAlarm();
    void configureFastMonitor(config);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const streamerId = getStreamerIdFromNotification(notificationId);
  if (streamerId) void openStreamWindow(streamerId);
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  const streamerId = getStreamerIdFromNotification(notificationId);
  if (streamerId) void openStreamWindow(streamerId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;

  if (message.type === 'FAST_CHECK_TICK' && message.source === 'offscreen') {
    void checkAllStreamers()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'GET_DATA') {
    void getPopupData()
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'SAVE_CONFIG') {
    void saveConfig(message.config)
      .then(() => {
        sendResponse({ ok: true });
        void checkAllStreamers();
      })
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'CHECK_NOW') {
    void checkAllStreamers()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'TEST_NOTIFICATION') {
    void testNotification()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  return false;
});

void bootstrap(false);

async function bootstrap(checkImmediately) {
  const stored = await storageGet([CONFIG_KEY, STATE_KEY, META_KEY]);
  const config = normalizeConfig(stored[CONFIG_KEY]);
  const updates = {};

  if (!stored[CONFIG_KEY]) updates[CONFIG_KEY] = config;
  if (!isPlainObject(stored[STATE_KEY])) updates[STATE_KEY] = {};
  if (!isPlainObject(stored[META_KEY])) {
    updates[META_KEY] = { lastCheckAt: 0, lastCheckError: '' };
  }

  if (Object.keys(updates).length > 0) await storageSet(updates);
  await ensureAlarm();
  await configureFastMonitor(config);

  if (checkImmediately || config.streamers.some((streamer) => streamer.enabled)) {
    await checkAllStreamers();
  }
}

async function getPopupData() {
  const stored = await storageGet([CONFIG_KEY, STATE_KEY, META_KEY]);
  return {
    config: normalizeConfig(stored[CONFIG_KEY]),
    broadcastStates: isPlainObject(stored[STATE_KEY]) ? stored[STATE_KEY] : {},
    monitorMeta: isPlainObject(stored[META_KEY])
      ? stored[META_KEY]
      : { lastCheckAt: 0, lastCheckError: '' },
    checkInProgress,
  };
}

async function saveConfig(value) {
  const config = normalizeConfig(value);
  const stored = await storageGet([STATE_KEY]);
  const previousStates = isPlainObject(stored[STATE_KEY]) ? stored[STATE_KEY] : {};
  const configuredIds = new Set(config.streamers.map((streamer) => streamer.id));
  const prunedStates = Object.fromEntries(
    Object.entries(previousStates).filter(([id]) => configuredIds.has(id)),
  );

  await storageSet({
    [CONFIG_KEY]: config,
    [STATE_KEY]: prunedStates,
  });
  await resetAlarm();
  await configureFastMonitor(config);
}

async function checkAllStreamers() {
  if (checkInProgress) return { busy: true };
  checkInProgress = true;
  await setActionBadge('…', '#6c55d9');

  try {
    const stored = await storageGet([CONFIG_KEY, STATE_KEY]);
    const config = normalizeConfig(stored[CONFIG_KEY]);
    let states = isPlainObject(stored[STATE_KEY]) ? stored[STATE_KEY] : {};
    const enabledStreamers = config.streamers.filter((streamer) => streamer.enabled);

    for (const streamer of enabledStreamers) {
      states = await checkOneStreamer(streamer, config, states);
    }

    const now = Date.now();
    await storageSet({
      [STATE_KEY]: states,
      [META_KEY]: {
        lastCheckAt: now,
        lastCheckError: '',
      },
    });
    await updateLiveBadge(config, states);
    return { busy: false, checkedCount: enabledStreamers.length, lastCheckAt: now };
  } catch (error) {
    const now = Date.now();
    await storageSet({
      [META_KEY]: {
        lastCheckAt: now,
        lastCheckError: errorMessage(error),
      },
    });
    await setActionBadge('!', '#d97706');
    throw error;
  } finally {
    checkInProgress = false;
  }
}

async function checkOneStreamer(streamer, config, states) {
  const previous = isPlainObject(states[streamer.id]) ? states[streamer.id] : {};
  const checkedAt = Date.now();

  try {
    const channel = await requestChannelState(streamer.id);
    const result = Number(channel.RESULT);

    if (result === 0) {
      return {
        ...states,
        [streamer.id]: {
          ...previous,
          isLive: false,
          broadcastNo: '',
          checkedAt,
          lastError: '',
        },
      };
    }

    if (result !== 1) {
      throw new Error(`SOOP 응답 코드 ${String(channel.RESULT ?? '없음')}`);
    }

    const broadcastNo = String(channel.BNO ?? '').trim();
    const status = String(channel.BSTATUS ?? '').toUpperCase();
    if (!broadcastNo || (status && status !== 'BROADING')) {
      throw new Error('방송 중 응답에 유효한 방송번호가 없습니다.');
    }

    const nextState = {
      ...previous,
      isLive: true,
      broadcastNo,
      nickname: String(channel.BJNICK || streamer.label || streamer.id),
      title: String(channel.TITLE || ''),
      checkedAt,
      lastError: '',
    };
    const isNewBroadcast = previous.notifiedBroadcastNo !== broadcastNo;

    if (isNewBroadcast) {
      nextState.notifiedBroadcastNo = broadcastNo;
    }

    const nextStates = {
      ...states,
      [streamer.id]: nextState,
    };

    if (isNewBroadcast) {
      // 알림이나 새 창을 띄우기 전에 먼저 기록해 서비스 워커 재시작 시 중복을 막습니다.
      await storageSet({ [STATE_KEY]: nextStates });
      try {
        await notifyBroadcastStarted(streamer, nextState, config);
      } catch (error) {
        console.error('SOOP 방송 시작 알림 표시 실패:', error);
      }
      if (streamer.autoOpen) {
        try {
          await openStreamWindow(streamer.id);
        } catch (error) {
          console.error('SOOP 방송 창 열기 실패:', error);
        }
      }
    }

    return nextStates;
  } catch (error) {
    return {
      ...states,
      [streamer.id]: {
        ...previous,
        checkedAt,
        lastError: errorMessage(error),
      },
    };
  }
}

async function requestChannelState(streamerId) {
  const body = new URLSearchParams({
    bid: streamerId,
    bno: '',
    type: 'live',
    pwd: '',
    player_type: 'html5',
    stream_type: 'common',
    quality: 'HD',
    mode: 'landing',
    from_api: '0',
    is_revive: 'false',
  }).toString();

  const response = await fetch(`${API_URL}?bjid=${encodeURIComponent(streamerId)}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body,
    cache: 'no-store',
    credentials: 'omit',
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!isPlainObject(payload?.CHANNEL)) {
    throw new Error('SOOP 응답에 CHANNEL 데이터가 없습니다.');
  }
  return payload.CHANNEL;
}

async function notifyBroadcastStarted(streamer, state, config) {
  const displayName = streamer.label || state.nickname || streamer.id;
  const notificationId = makeNotificationId(streamer.id, state.broadcastNo);
  const failures = [];

  if (config.desktopNotifications) {
    try {
      await createNotificationWithImageFallback(notificationId, {
        type: 'basic',
        title: '🔴 SOOP 방송 시작',
        message: state.title
          ? `${displayName}\n${state.title}`
          : `${displayName} 님이 방송을 시작했습니다.`,
        buttons: [{ title: '방송 열기' }],
        priority: 2,
        requireInteraction: false,
        silent: true,
      });
    } catch (error) {
      failures.push(`팝업: ${errorMessage(error)}`);
    }
  }

  if (config.soundEnabled) {
    try {
      await playAlertSound();
    } catch (error) {
      failures.push(`알림음: ${errorMessage(error)}`);
    }
  }

  if (failures.length > 0) throw new Error(failures.join(' / '));
}

async function testNotification() {
  const stored = await storageGet([CONFIG_KEY]);
  const config = normalizeConfig(stored[CONFIG_KEY]);
  const firstStreamer = config.streamers[0];
  const displayName = firstStreamer?.label || firstStreamer?.id || '테스트 스트리머';
  const failures = [];

  if (config.desktopNotifications) {
    try {
      await createNotificationWithImageFallback(`soop-test:${Date.now()}`, {
        type: 'basic',
        title: '🔔 SOOP 알림 테스트',
        message: `${displayName} 알림이 정상적으로 표시됩니다.`,
        priority: 1,
        requireInteraction: false,
        silent: true,
      });
    } catch (error) {
      failures.push(`팝업: ${errorMessage(error)}`);
    }
  }

  if (config.soundEnabled) {
    try {
      await playAlertSound();
    } catch (error) {
      failures.push(`알림음: ${errorMessage(error)}`);
    }
  }

  if (failures.length > 0) throw new Error(failures.join(' / '));
}

async function createNotificationWithImageFallback(notificationId, options) {
  try {
    return await createNotification(notificationId, {
      ...options,
      iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON_PATH),
    });
  } catch (error) {
    if (!/image|download/i.test(errorMessage(error))) throw error;
    return createNotification(notificationId, {
      ...options,
      iconUrl: chrome.runtime.getURL(FALLBACK_NOTIFICATION_ICON_PATH),
    });
  }
}

async function playAlertSound() {
  if (!chrome.offscreen) return;
  await ensureOffscreenDocument();
  await sendRuntimeMessage({
    target: 'offscreen',
    type: 'PLAY_ALERT',
  });
}

async function configureFastMonitor(config) {
  if (!chrome.offscreen) return;
  const hasEnabledStreamer = config.streamers.some((streamer) => streamer.enabled);
  const hasDocument = await hasOffscreenDocument();

  if (!hasEnabledStreamer) {
    if (hasDocument) {
      await sendRuntimeMessage({
        target: 'offscreen',
        type: 'STOP_MONITOR',
      });
    }
    return;
  }

  if (!hasDocument) await ensureOffscreenDocument();
  await sendRuntimeMessage({
    target: 'offscreen',
    type: 'CONFIGURE_MONITOR',
    intervalSeconds: config.checkIntervalSeconds,
  });
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS'],
    justification: '5~60초 간격의 SOOP 감시 워커와 방송 시작 알림음을 실행합니다.',
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }

  const clientsList = await self.clients.matchAll();
  return clientsList.some((client) => client.url === offscreenUrl);
}

async function openStreamWindow(streamerId) {
  const url = `${PLAY_URL}${encodeURIComponent(streamerId)}`;
  await createWindow({
    url,
    type: 'normal',
    focused: true,
    width: 1440,
    height: 900,
  });
}

async function openSettingsWindow() {
  if (settingsWindowId !== null) {
    try {
      await updateWindow(settingsWindowId, { focused: true });
      return;
    } catch {
      settingsWindowId = null;
    }
  }

  const createdWindow = await createWindow({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    focused: true,
    width: 760,
    height: 840,
  });
  settingsWindowId = createdWindow?.id ?? null;
}

function makeNotificationId(streamerId, broadcastNo) {
  return `soop-live:${encodeURIComponent(streamerId)}:${encodeURIComponent(broadcastNo)}`;
}

function getStreamerIdFromNotification(notificationId) {
  if (!notificationId.startsWith('soop-live:')) return '';
  const encodedId = notificationId.split(':')[1] || '';
  try {
    return normalizeStreamerId(decodeURIComponent(encodedId));
  } catch {
    return '';
  }
}

async function ensureAlarm() {
  const current = await getAlarm(ALARM_NAME);
  if (current && Number(current.periodInMinutes) === 1) return;
  await resetAlarm();
}

async function resetAlarm() {
  await clearAlarm(ALARM_NAME);
  await createAlarm(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: 1,
  });
}

async function updateLiveBadge(config, states) {
  const liveCount = config.streamers.filter(
    (streamer) => streamer.enabled && states[streamer.id]?.isLive,
  ).length;
  await setActionBadge(liveCount > 0 ? String(liveCount) : '', '#e13246');
}

async function setActionBadge(text, color) {
  await new Promise((resolve) => {
    chrome.action.setBadgeBackgroundColor({ color }, () => resolve());
  });
  await new Promise((resolve) => {
    chrome.action.setBadgeText({ text }, () => resolve());
  });
}

function normalizeConfig(value) {
  const raw = isPlainObject(value) ? value : {};
  const seen = new Set();
  const streamers = Array.isArray(raw.streamers)
    ? raw.streamers
        .map((streamer) => ({
          id: normalizeStreamerId(streamer?.id ?? ''),
          label: String(streamer?.label ?? '').trim().slice(0, 40),
          enabled: streamer?.enabled !== false,
          autoOpen: streamer?.autoOpen !== false,
        }))
        .filter((streamer) => {
          if (!isValidStreamerId(streamer.id) || seen.has(streamer.id)) return false;
          seen.add(streamer.id);
          return true;
        })
    : [];

  return {
    checkIntervalSeconds: clampInteger(
      raw.checkIntervalSeconds ?? DEFAULT_CONFIG.checkIntervalSeconds,
      5,
      60,
      DEFAULT_CONFIG.checkIntervalSeconds,
    ),
    desktopNotifications: raw.desktopNotifications !== false,
    soundEnabled: raw.soundEnabled !== false,
    streamers,
  };
}

function normalizeStreamerId(value) {
  return String(value).trim().toLowerCase();
}

function isValidStreamerId(value) {
  return /^[a-z0-9_]{2,30}$/.test(value);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function getAlarm(name) {
  return new Promise((resolve) => {
    chrome.alarms.get(name, (alarm) => resolve(alarm));
  });
}

function clearAlarm(name) {
  return new Promise((resolve) => {
    chrome.alarms.clear(name, () => resolve());
  });
}

function createAlarm(name, alarmInfo) {
  return new Promise((resolve, reject) => {
    chrome.alarms.create(name, alarmInfo, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function createNotification(notificationId, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(notificationId, options, (createdId) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(createdId);
    });
  });
}

function createWindow(options) {
  return new Promise((resolve, reject) => {
    chrome.windows.create(options, (createdWindow) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(createdWindow);
    });
  });
}

function updateWindow(windowId, updateInfo) {
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, updateInfo, (updatedWindow) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(updatedWindow);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
