'use strict';

let timerId = null;

self.addEventListener('message', (event) => {
  if (event.data?.type === 'STOP') {
    stopTimer();
    return;
  }

  if (event.data?.type !== 'START') return;
  const intervalSeconds = clampInteger(event.data.intervalSeconds, 5, 60, 10);
  stopTimer();
  timerId = self.setInterval(() => {
    self.postMessage({ type: 'CHECK_TICK' });
  }, intervalSeconds * 1_000);
});

function stopTimer() {
  if (timerId === null) return;
  self.clearInterval(timerId);
  timerId = null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
