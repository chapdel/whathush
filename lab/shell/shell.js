// UI de la coque du lab. Volontairement sans framework : la vraie UI viendra en phase 2.
// Rien n'est dessiné dans #stage par-dessus les vues WhatsApp.

const api = window.lab;

const els = {
  body: document.body,
  platform: document.getElementById("platform"),
  addForm: document.getElementById("add-form"),
  addLabel: document.getElementById("add-label"),
  accounts: document.getElementById("accounts"),
  actions: document.getElementById("actions"),
  actionsTitle: document.getElementById("actions-title"),
  totals: document.getElementById("totals"),
  toggleLogs: document.getElementById("toggle-logs"),
  openLogs: document.getElementById("open-logs"),
  placeholder: document.getElementById("placeholder"),
  logLines: document.getElementById("log-lines"),
  logs: document.getElementById("logs")
};

const LIFECYCLE_LABELS = {
  sleeping: "en veille",
  loading: "chargement",
  loaded: "chargé",
  crashed: "crash",
  failed: "échec de chargement"
};

let state = null;
let removeArmedFor = null;
let removeTimer = null;

function render(next) {
  state = next;
  els.platform.textContent = state.platform;
  document.documentElement.style.setProperty("--sidebar", `${state.sidebarWidth}px`);
  document.documentElement.style.setProperty("--logs", `${state.logHeight}px`);
  els.body.classList.toggle("logs-hidden", !state.logsVisible);
  els.toggleLogs.textContent = state.logsVisible ? "Masquer les logs" : "Afficher les logs";

  renderAccounts();
  renderActions();
  renderPlaceholder();

  const memory = state.totalMemoryMB === null ? "–" : `${state.totalMemoryMB} Mo`;
  els.totals.textContent = `Non-lus : ${state.totalUnread} · RAM totale : ${memory}`;
}

function renderAccounts() {
  els.accounts.replaceChildren(
    ...state.accounts.map((account, index) => {
      const item = document.createElement("li");
      item.classList.toggle("active", account.visible);
      item.title = index < 9 ? `Ctrl+${index + 1}` : "";
      item.addEventListener("click", () => api.command({ type: "switch", id: account.id }));

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = account.color;

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = account.label;

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = account.unread ? String(account.unread) : "";

      const meta = document.createElement("span");
      meta.className = "meta";
      meta.append(...metaParts(account));

      item.append(dot, label, badge, meta);
      return item;
    })
  );
}

function metaParts(account) {
  const parts = [LIFECYCLE_LABELS[account.lifecycle] ?? account.lifecycle];
  if (account.memoryMB !== null) parts.push(`${account.memoryMB} Mo`);
  if (account.snoozed) parts.push("🔕");
  if (account.micActive) parts.push("🎤");
  if (account.camActive) parts.push("📷");
  if (account.screenShareActive) parts.push("🖥");
  if (account.audible) parts.push("🔊");

  const nodes = [document.createTextNode(parts.join(" · "))];
  if (account.pageVisibility) {
    // Page « visible » alors que le compte est caché = risque d'accusés de lecture.
    const leak = account.pageVisibility === "visible" && !account.visible;
    const span = document.createElement("span");
    if (leak) span.className = "warn";
    span.textContent = ` · page ${account.pageVisibility}${leak ? " ⚠" : ""}`;
    nodes.push(span);
  }
  return nodes;
}

function activeAccount() {
  return state.accounts.find((account) => account.id === state.activeId) ?? null;
}

function renderActions() {
  const account = activeAccount();
  els.actions.hidden = !account;
  if (!account) return;
  els.actionsTitle.textContent = account.label;
  const sleeping = account.lifecycle === "sleeping";
  for (const button of els.actions.querySelectorAll("button")) {
    const action = button.dataset.action;
    if (action === "sleep-toggle") button.textContent = sleeping ? "Réveiller" : "Mettre en veille";
    if (action === "snooze") button.textContent = account.snoozed ? "Fin du Snooze" : "Snooze";
    if (action === "remove") {
      const armed = removeArmedFor === account.id;
      button.textContent = armed ? "Confirmer ?" : "Supprimer";
      button.classList.toggle("confirm", armed);
    }
    if (["reload", "devtools", "crash"].includes(action)) button.disabled = sleeping;
  }
}

function renderPlaceholder() {
  const account = activeAccount();
  if (!account) {
    els.placeholder.textContent = "Ajoutez un compte pour commencer.";
  } else if (account.lifecycle === "sleeping") {
    els.placeholder.textContent = `« ${account.label} » est en veille. Utilisez « Réveiller » dans la barre latérale.`;
  } else {
    els.placeholder.textContent = "";
  }
}

els.actions.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const account = activeAccount();
  if (!button || !account) return;
  const action = button.dataset.action;

  if (action === "remove") {
    // Confirmation en deux clics, sans boîte de dialogue bloquante.
    if (removeArmedFor === account.id) {
      removeArmedFor = null;
      clearTimeout(removeTimer);
      api.command({ type: "remove", id: account.id });
    } else {
      removeArmedFor = account.id;
      clearTimeout(removeTimer);
      removeTimer = setTimeout(() => {
        removeArmedFor = null;
        renderActions();
      }, 3000);
      renderActions();
    }
    return;
  }

  if (action === "sleep-toggle") {
    api.command({ type: account.lifecycle === "sleeping" ? "wake" : "sleep", id: account.id });
  } else {
    api.command({ type: action, id: account.id });
  }
});

els.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  api.command({ type: "add", label: els.addLabel.value });
  els.addLabel.value = "";
});

els.toggleLogs.addEventListener("click", () => api.command({ type: "toggle-logs" }));
els.openLogs.addEventListener("click", () => api.command({ type: "open-logs" }));

function appendLog(entry) {
  const item = document.createElement("li");
  item.className = entry.level;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = `[${entry.account ?? "lab"}] `;
  const data = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
  item.append(document.createTextNode(`${entry.ts.slice(11, 19)} `), who, document.createTextNode(`${entry.event}${data}`));
  els.logLines.append(item);
  while (els.logLines.children.length > 300) els.logLines.firstElementChild.remove();
  els.logs.scrollTop = els.logs.scrollHeight;
}

api.onState(render);
api.onLog(appendLog);
api.getState().then((initial) => initial && render(initial));
api.getLogs().then((entries) => entries.forEach(appendLog));
