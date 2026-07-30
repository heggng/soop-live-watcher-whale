'use strict';

let audioContext = null;
const monitorWorker = new Worker('monitor-worker.js');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'CONFIGURE_MONITOR') {
    monitorWorker.postMessage({
      type: 'START',
      intervalSeconds: message.intervalSeconds,
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'STOP_MONITOR') {
    monitorWorker.postMessage({ type: 'STOP' });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== 'PLAY_ALERT') return false;

  void playAlertSound()
    .then(() => sendResponse({ ok: true }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
});

monitorWorker.addEventListener('message', (event) => {
  if (event.data?.type !== 'CHECK_TICK') return;
  chrome.runtime.sendMessage(
    {
      type: 'FAST_CHECK_TICK',
      source: 'offscreen',
    },
    () => {
      // 서비스 워커가 재시작되는 순간의 일시적 연결 오류는 다음 틱에서 복구됩니다.
      void chrome.runtime.lastError;
    },
  );
});

async function playAlertSound() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('AudioContext를 지원하지 않습니다.');

  audioContext ??= new AudioContextClass();
  if (audioContext.state === 'suspended') await audioContext.resume();

  const startAt = audioContext.currentTime + 0.03;
  const masterGain = audioContext.createGain();
  masterGain.gain.setValueAtTime(0.0001, startAt);
  masterGain.gain.exponentialRampToValueAtTime(0.2, startAt + 0.02);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.95);
  masterGain.connect(audioContext.destination);

  [
    { frequency: 659.25, offset: 0, duration: 0.22 },
    { frequency: 783.99, offset: 0.25, duration: 0.22 },
    { frequency: 987.77, offset: 0.5, duration: 0.36 },
  ].forEach(({ frequency, offset, duration }) => {
    const oscillator = audioContext.createOscillator();
    const noteGain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, startAt + offset);
    noteGain.gain.setValueAtTime(0.0001, startAt + offset);
    noteGain.gain.exponentialRampToValueAtTime(0.9, startAt + offset + 0.015);
    noteGain.gain.exponentialRampToValueAtTime(
      0.0001,
      startAt + offset + duration,
    );
    oscillator.connect(noteGain);
    noteGain.connect(masterGain);
    oscillator.start(startAt + offset);
    oscillator.stop(startAt + offset + duration + 0.02);
  });
}
