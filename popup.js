'use strict';

const elements = {
  monitorStatus: document.querySelector('#monitor-status'),
  newId: document.querySelector('#new-id'),
  newLabel: document.querySelector('#new-label'),
  addButton: document.querySelector('#add-button'),
  streamerCount: document.querySelector('#streamer-count'),
  streamerList: document.querySelector('#streamer-list'),
  interval: document.querySelector('#interval'),
  desktopNotifications: document.querySelector('#desktop-notifications'),
  soundEnabled: document.querySelector('#sound-enabled'),
  message: document.querySelector('#message'),
  testButton: document.querySelector('#test-button'),
  checkButton: document.querySelector('#check-button'),
  saveButton: document.querySelector('#save-button'),
};

let config = null;
let broadcastStates = {};
let monitorMeta = {};
let draftStreamers = [];

elements.addButton.addEventListener('click', addStreamer);
elements.newId.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addStreamer();
});
elements.newLabel.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addStreamer();
});
elements.saveButton.addEventListener('click', () => void saveSettings());
elements.checkButton.addEventListener('click', () => void checkNow());
elements.testButton.addEventListener('click', () => void testNotification());

void loadData();

async function loadData() {
  setButtonsDisabled(true);
  try {
    const response = await sendMessage({ type: 'GET_DATA' });
    if (!response?.ok) throw new Error(response?.error || '설정을 불러오지 못했습니다.');

    config = response.config;
    broadcastStates = response.broadcastStates || {};
    monitorMeta = response.monitorMeta || {};
    draftStreamers = config.streamers.map((streamer) => ({ ...streamer }));
    syncControls();
    renderStreamers();
    renderMonitorStatus(response.checkInProgress);
  } catch (error) {
    showMessage(errorMessage(error), 'error');
    elements.monitorStatus.textContent = '백그라운드 감시 상태를 확인하지 못했습니다.';
    elements.monitorStatus.classList.add('error');
  } finally {
    setButtonsDisabled(false);
  }
}

function syncControls() {
  elements.interval.value = String(config.checkIntervalSeconds);
  elements.desktopNotifications.checked = config.desktopNotifications;
  elements.soundEnabled.checked = config.soundEnabled;
}

function addStreamer() {
  const id = normalizeStreamerId(elements.newId.value);
  const label = elements.newLabel.value.trim().slice(0, 40);

  if (!isValidStreamerId(id)) {
    showMessage('ID는 영문 소문자, 숫자, 밑줄(_)을 사용해 2~30자로 입력하세요.', 'error');
    elements.newId.focus();
    return;
  }

  if (draftStreamers.some((streamer) => streamer.id === id)) {
    showMessage('이미 등록된 스트리머 ID입니다.', 'error');
    return;
  }

  draftStreamers.push({
    id,
    label,
    enabled: true,
    autoOpen: true,
  });
  elements.newId.value = '';
  elements.newLabel.value = '';
  renderStreamers();
  showMessage(`${id}을(를) 추가했습니다. 설정을 저장해 주세요.`, '');
  elements.newId.focus();
}

function renderStreamers() {
  elements.streamerList.replaceChildren();
  const enabledCount = draftStreamers.filter((streamer) => streamer.enabled).length;
  elements.streamerCount.textContent = `${enabledCount}/${draftStreamers.length}명 감시`;

  if (draftStreamers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '등록된 스트리머가 없습니다.';
    elements.streamerList.append(empty);
    return;
  }

  draftStreamers.forEach((streamer) => {
    const card = document.createElement('article');
    card.className = 'streamer-card';

    const top = document.createElement('div');
    top.className = 'streamer-top';

    const identity = document.createElement('div');
    const id = document.createElement('div');
    id.className = 'streamer-id';
    id.textContent = streamer.id;
    const status = document.createElement('div');
    applyStatus(status, broadcastStates[streamer.id]);
    identity.append(id, status);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'remove';
    removeButton.textContent = '삭제';
    removeButton.addEventListener('click', () => {
      draftStreamers = draftStreamers.filter((item) => item.id !== streamer.id);
      renderStreamers();
    });
    top.append(identity, removeButton);

    const controls = document.createElement('div');
    controls.className = 'streamer-controls';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.maxLength = 40;
    labelInput.placeholder = '표시 이름';
    labelInput.value = streamer.label;
    labelInput.addEventListener('input', () => {
      streamer.label = labelInput.value.trimStart().slice(0, 40);
    });

    const watchLabel = makeCheckboxLabel('감시', streamer.enabled, (checked) => {
      streamer.enabled = checked;
      renderStreamerCount();
    });
    const autoOpenLabel = makeCheckboxLabel(
      '자동 열기',
      streamer.autoOpen,
      (checked) => {
        streamer.autoOpen = checked;
      },
    );

    controls.append(labelInput, watchLabel, autoOpenLabel);
    card.append(top, controls);
    elements.streamerList.append(card);
  });
}

function renderStreamerCount() {
  const enabledCount = draftStreamers.filter((streamer) => streamer.enabled).length;
  elements.streamerCount.textContent = `${enabledCount}/${draftStreamers.length}명 감시`;
}

function makeCheckboxLabel(text, checked, onChange) {
  const label = document.createElement('label');
  label.className = 'mini-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const caption = document.createElement('span');
  caption.textContent = text;
  label.append(input, caption);
  return label;
}

function applyStatus(element, state) {
  element.className = 'streamer-status';
  if (!state) {
    element.textContent = '확인 전';
    return;
  }
  if (state.lastError) {
    element.classList.add('error');
    element.textContent = `확인 오류 · ${state.lastError}`;
    return;
  }
  if (state.isLive) {
    element.classList.add('live');
    element.textContent = state.title ? `● LIVE · ${state.title}` : '● LIVE';
    return;
  }
  element.textContent = '오프라인';
}

function renderMonitorStatus(checking = false) {
  elements.monitorStatus.classList.remove('error');
  if (checking) {
    elements.monitorStatus.textContent = '현재 방송 상태를 확인 중입니다.';
    return;
  }

  if (monitorMeta.lastCheckError) {
    elements.monitorStatus.classList.add('error');
    elements.monitorStatus.textContent = `최근 확인 오류 · ${monitorMeta.lastCheckError}`;
    return;
  }

  if (monitorMeta.lastCheckAt) {
    const checkedTime = new Date(monitorMeta.lastCheckAt).toLocaleString('ko-KR');
    elements.monitorStatus.textContent = `백그라운드 감시 작동 중 · 최근 확인 ${checkedTime}`;
    return;
  }

  elements.monitorStatus.textContent = '백그라운드 감시 준비됨 · 설정 저장 후 확인을 시작합니다.';
}

async function saveSettings() {
  setButtonsDisabled(true);
  try {
    const nextConfig = {
      checkIntervalSeconds: clampInteger(elements.interval.value, 5, 60, 10),
      desktopNotifications: elements.desktopNotifications.checked,
      soundEnabled: elements.soundEnabled.checked,
      streamers: draftStreamers.map((streamer) => ({
        ...streamer,
        label: streamer.label.trim(),
      })),
    };

    const response = await sendMessage({
      type: 'SAVE_CONFIG',
      config: nextConfig,
    });
    if (!response?.ok) throw new Error(response?.error || '설정을 저장하지 못했습니다.');

    config = nextConfig;
    showMessage('설정을 저장했습니다. 백그라운드 확인을 시작합니다.', 'success');
    window.setTimeout(() => void loadData(), 700);
  } catch (error) {
    showMessage(errorMessage(error), 'error');
  } finally {
    setButtonsDisabled(false);
  }
}

async function checkNow() {
  setButtonsDisabled(true);
  elements.checkButton.textContent = '확인 중…';
  renderMonitorStatus(true);

  try {
    const response = await sendMessage({ type: 'CHECK_NOW' });
    if (!response?.ok) throw new Error(response?.error || '방송 상태 확인에 실패했습니다.');
    showMessage(
      response.busy
        ? '이미 방송 상태를 확인 중입니다.'
        : `${response.checkedCount}명의 상태를 확인했습니다.`,
      'success',
    );
    await loadData();
  } catch (error) {
    showMessage(errorMessage(error), 'error');
  } finally {
    elements.checkButton.textContent = '지금 확인';
    setButtonsDisabled(false);
  }
}

async function testNotification() {
  setButtonsDisabled(true);
  try {
    const response = await sendMessage({ type: 'TEST_NOTIFICATION' });
    if (!response?.ok) throw new Error(response?.error || '테스트 알림에 실패했습니다.');
    showMessage('테스트 알림과 알림음을 실행했습니다.', 'success');
  } catch (error) {
    showMessage(errorMessage(error), 'error');
  } finally {
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  elements.addButton.disabled = disabled;
  elements.saveButton.disabled = disabled;
  elements.checkButton.disabled = disabled;
  elements.testButton.disabled = disabled;
}

function showMessage(message, type) {
  elements.message.textContent = message;
  elements.message.className = `message ${type || ''}`.trim();
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
