'use strict';

/** Meal Mode popup. Polls SESSION_GET once a second, only while open. */
(() => {
  const el = (id) => document.getElementById(id);

  const ui = {
    idle: el('idle'),
    active: el('active'),
    budget: el('budget'),
    budgetOut: el('budgetOut'),
    start: el('start'),
    remaining: el('remaining'),
    barFill: el('barFill'),
    nowPlaying: el('nowPlaying'),
    plus1: el('plus1'),
    plus5: el('plus5'),
    done: el('done'),
    tolerance: el('tolerance'),
    pickerPct: el('pickerPct'),
    autoPick: el('autoPick'),
    settingsNote: el('settingsNote')
  };

  let session = { active: false, budgetSec: 0, watchedSec: 0, lastTitle: null };
  let settings = { defaultBudgetMin: 20, toleranceSec: 120, pickerAtPct: 0.9, autoPickSec: 8 };
  let pollTimer = null;
  let budgetTouched = false;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function mmss(totalSec) {
    const s = Math.max(0, Math.round(Number(totalSec) || 0));
    const m = Math.floor(s / 60);
    return String(m) + ':' + String(s % 60).padStart(2, '0');
  }

  function remainingSec() {
    return Math.max(0, (session.budgetSec || 0) - (session.watchedSec || 0));
  }

  function render() {
    const active = Boolean(session.active);
    if (ui.idle) ui.idle.hidden = active;
    if (ui.active) ui.active.hidden = !active;

    if (!active) {
      if (ui.budget && !budgetTouched) {
        ui.budget.value = String(settings.defaultBudgetMin);
      }
      if (ui.budgetOut && ui.budget) ui.budgetOut.textContent = ui.budget.value + ' min';
      return;
    }

    const left = remainingSec();
    if (ui.remaining) ui.remaining.textContent = mmss(left);
    if (ui.barFill) {
      const pct = session.budgetSec > 0 ? (left / session.budgetSec) * 100 : 0;
      ui.barFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      ui.barFill.classList.toggle('bar-over', left <= 0);
    }
    if (ui.nowPlaying) ui.nowPlaying.textContent = session.lastTitle || '';
  }

  function renderSettings() {
    if (ui.tolerance) ui.tolerance.value = String(Math.round(settings.toleranceSec));
    if (ui.pickerPct) ui.pickerPct.value = String(Math.round(settings.pickerAtPct * 100));
    if (ui.autoPick) ui.autoPick.value = String(Math.round(settings.autoPickSec));
  }

  function apply(reply, withSettings) {
    if (!reply) return;
    if (reply.session) session = reply.session;
    if (reply.settings) {
      settings = reply.settings;
      if (withSettings) renderSettings();
    }
    render();
  }

  async function refresh() {
    apply(await send({ type: 'SESSION_GET' }), false);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { refresh(); }, 1000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function saveSettings() {
    const pct = Number(ui.pickerPct && ui.pickerPct.value);
    const patch = {
      toleranceSec: Number(ui.tolerance && ui.tolerance.value),
      pickerAtPct: Number.isFinite(pct) ? pct / 100 : settings.pickerAtPct,
      autoPickSec: Number(ui.autoPick && ui.autoPick.value)
    };
    apply(await send({ type: 'SETTINGS_SET', settings: patch }), false);
    if (ui.settingsNote) {
      ui.settingsNote.textContent = 'Saved.';
      setTimeout(() => { if (ui.settingsNote) ui.settingsNote.textContent = ''; }, 1500);
    }
  }

  /* ------------------------------------------------------------- listeners */

  if (ui.budget) {
    ui.budget.addEventListener('input', () => {
      budgetTouched = true;
      if (ui.budgetOut) ui.budgetOut.textContent = ui.budget.value + ' min';
    });
  }

  if (ui.start) {
    ui.start.addEventListener('click', async () => {
      const budgetMin = Number(ui.budget && ui.budget.value) || settings.defaultBudgetMin;
      apply(await send({ type: 'SESSION_START', budgetMin }), false);
      await send({ type: 'SETTINGS_SET', settings: { defaultBudgetMin: budgetMin } });
    });
  }

  if (ui.plus1) {
    ui.plus1.addEventListener('click', async () => {
      apply(await send({ type: 'SESSION_EXTEND', sec: 60 }), false);
    });
  }

  if (ui.plus5) {
    ui.plus5.addEventListener('click', async () => {
      apply(await send({ type: 'SESSION_EXTEND', sec: 300 }), false);
    });
  }

  if (ui.done) {
    ui.done.addEventListener('click', async () => {
      budgetTouched = false;
      apply(await send({ type: 'SESSION_STOP' }), false);
    });
  }

  for (const input of [ui.tolerance, ui.pickerPct, ui.autoPick]) {
    if (input) input.addEventListener('change', () => { saveSettings(); });
  }

  window.addEventListener('unload', stopPolling);

  send({ type: 'SETTINGS_GET' }).then((reply) => {
    apply(reply, true);
    startPolling();
  });
})();
