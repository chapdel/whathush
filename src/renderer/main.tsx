// Fenêtre principale : barre latérale des comptes et zone d'affichage.
// Les vues WhatsApp sont des couches natives posées au-dessus de la zone
// d'affichage : on n'y dessine que ce qui doit se voir quand aucune vue ne
// l'est (accueil, veille, erreur), et les modales masquent les vues (§29).

import { StrictMode, useCallback, useEffect, useState, useRef, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { compactSidebar, CONNECTION_BAR_HEIGHT, leastUsedAccountColor, SIDEBAR_WIDTH } from "../shared/constants";
import { formatRemaining, lifecycleLabel } from "../shared/format";
import { formatDateTime, formatNumber, setLocale, t } from "../shared/i18n";
import type { AccountItem, ShellState } from "../shared/ipc";
import { SHORTCUTS } from "../shared/shortcuts";
import { api, useNow, useShellState, useWindowWidth } from "./api";
import { Avatar, AccountIconPicker, Icon, Modal, ShortcutKeys, Swatches } from "./components/ui";
import logo from "./logo.svg";
import "./styles.css";

type ModalState = { kind: "notices" } | { kind: "add" } | { kind: "choose-link"; linkId: number } | { kind: "snooze-date"; accountId: string } | { kind: "shortcuts" } | null;

function ShortcutsModal({ onClose }: { onClose(): void }) {
  return (
    <Modal title={t("shortcuts.title")} onClose={onClose}>
      <p className="hint">{t("shortcuts.intro")}</p>
      <dl className="shortcut-list">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.id}>
            <dt>{t(shortcut.label)}</dt>
            <dd><ShortcutKeys keys={shortcut.keys} /></dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

/** F14 : lecture en cours (ou en pause) dans un compte, avec Pause / Reprendre. */
function NowPlaying({ state, collapsed }: { state: ShellState; collapsed: boolean }) {
  const media = state.nowPlaying;
  if (!media) return null;
  const title = media.title ?? (media.kind === "video" ? t("media.video") : t("media.voiceMessage"));
  const heading = t(media.playing ? "media.nowPlaying" : "media.paused", { label: media.label });
  const toggle = () => api.command({ type: "media-control", id: media.accountId, action: media.playing ? "pause" : "play" });
  const toggleLabel = media.playing ? t("media.pause") : t("media.resume");
  if (collapsed) {
    return <button type="button" className="icon-btn now-playing-compact" title={`${heading} · ${title}`} aria-label={`${heading}, ${toggleLabel}`} onClick={toggle}><Icon name={media.playing ? "pause" : "play"} /></button>;
  }
  return (
    <div className="now-playing" role="status" aria-label={`${heading} · ${title}`}>
      <span className="now-playing-text"><strong>{media.label}</strong><small>{media.playing ? title : `${t("media.pausedShort")} · ${title}`}</small></span>
      <button type="button" className="icon-btn" aria-label={toggleLabel} title={toggleLabel} onClick={toggle}><Icon name={media.playing ? "pause" : "play"} /></button>
      <button type="button" className="icon-btn" aria-label={t("common.show")} title={t("common.show")} onClick={() => api.command({ type: "switch-account", id: media.accountId })}><Icon name="expand" /></button>
    </div>
  );
}

/** F2 : téléchargements en cours, avec leur progression ; ouvre l'historique. */
function DownloadsIndicator({ state, collapsed }: { state: ShellState; collapsed: boolean }) {
  const { active, progress } = state.downloads;
  if (active === 0) return null;
  const label = t("downloads.active", { count: active });
  const percent = progress === null ? null : Math.round(progress * 100);
  return (
    <button type="button" className={collapsed ? "icon-btn downloads-indicator" : "btn btn-ghost downloads-indicator"} title={label} aria-label={label}
      onClick={() => api.command({ type: "open-settings", section: "downloads" })}>
      <Icon name="download" />
      {!collapsed && <span>{label}{percent !== null ? ` · ${formatNumber(percent)} %` : ""}</span>}
      <span className="progress" aria-hidden="true"><span style={{ width: `${percent ?? 0}%` }} /></span>
    </button>
  );
}

/** F1 : zoom qui vient de changer, montré dans la barre latérale (jamais sur la vue). */
function ZoomToast({ state }: { state: ShellState }) {
  const toast = state.zoomToast;
  const [visible, setVisible] = useState<number | null>(null);
  useEffect(() => {
    if (!toast) return;
    setVisible(toast.sequence);
    const timer = setTimeout(() => setVisible(null), 1600);
    return () => clearTimeout(timer);
  }, [toast?.sequence]);
  if (!toast || visible !== toast.sequence) return null;
  return <div className="zoom-toast" role="status">{t("shell.zoom", { percent: toast.percent })}</div>;
}

/** F6 : écran de verrouillage, rendu par la coque ; les vues WhatsApp sont masquées. */
function LockScreen({ state }: { state: ShellState }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useNow(1000);
  const waitSeconds = state.lock.retryAt ? Math.max(0, Math.ceil((new Date(state.lock.retryAt).getTime() - Date.now()) / 1000)) : 0;
  // Chaque essai renvoie un nouvel état : la saisie redevient possible.
  useEffect(() => setPending(false), [state.lock]);
  useEffect(() => input.current?.focus(), [waitSeconds === 0]);
  const submit = () => {
    if (!code || waitSeconds > 0 || pending) return;
    setPending(true);
    api.command({ type: "unlock", code });
    setCode("");
  };
  const press = (digit: string) => {
    setCode((current) => (current + digit).slice(0, 128));
    input.current?.focus();
  };
  return (
    <main className="lock-screen">
      <form className="lock-panel" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <img src={logo} alt="" className="welcome-logo" />
        <h1>{t("lock.title", { product: state.productName })}</h1>
        <p>{t("lock.prompt")}</p>
        <input ref={input} name="lock-code" className="input lock-input" type="password" inputMode="numeric" autoComplete="off" autoFocus aria-label={t("lock.code")}
          aria-invalid={state.lock.failed} aria-describedby="lock-status" value={code} disabled={waitSeconds > 0} onChange={(event) => setCode(event.target.value)} />
        <p id="lock-status" className={`lock-status${state.lock.failed ? " error" : ""}`} role="status">
          {waitSeconds > 0 ? t("lock.wait", { count: waitSeconds }) : state.lock.failed ? t("lock.wrong") : " "}
        </p>
        <div className="keypad" role="group" aria-label={t("lock.keypad")}>
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => <button key={digit} type="button" className="btn" disabled={waitSeconds > 0} onClick={() => press(digit)}>{digit}</button>)}
          <button type="button" className="btn" aria-label={t("lock.erase")} title={t("lock.erase")} disabled={waitSeconds > 0 || !code} onClick={() => setCode((current) => current.slice(0, -1))}><Icon name="collapse" /></button>
          <button type="button" className="btn" disabled={waitSeconds > 0} onClick={() => press("0")}>0</button>
          <button type="submit" className="btn btn-primary" aria-label={t("lock.unlock")} title={t("lock.unlock")} disabled={!code || waitSeconds > 0 || pending}><Icon name="check" /></button>
        </div>
        <button type="button" className="link-button" onClick={() => api.command({ type: "forgot-lock-code" })}>{t("lock.forgot")}</button>
      </form>
    </main>
  );
}

function sourceLabel(source: AccountItem["policy"]["source"]): string {
  return source === "default" ? "" : t(`source.${source}`);
}

function statusLine(account: AccountItem, now: Date): { text: string; tone: "" | "warn" | "error" } {
  if (account.inCall) return { text: t("status.callInProgress"), tone: "" };
  if (account.playback?.playing) return { text: t("media.playing"), tone: "" };
  if (account.lifecycle === "needs_qr") return { text: t("status.scanQr"), tone: "warn" };
  if (account.lifecycle === "crashed") return { text: t("status.errorReload"), tone: "error" };
  if (account.lifecycle === "offline") return { text: t("status.offline"), tone: "warn" };
  if (account.lifecycle !== "ready") return { text: lifecycleLabel(account.lifecycle), tone: "" };
  if (account.policy.mode !== "normal") {
    const label = account.policy.mode === "snoozed" ? t("status.snooze") : t("status.callsOnly");
    return { text: account.policy.until ? t("common.separator", { a: label, b: formatRemaining(new Date(account.policy.until), now) }) : label, tone: "" };
  }
  return { text: t("status.connected"), tone: "" };
}

function menuAt(event: MouseEvent, build: (x: number, y: number) => void, anchor?: HTMLElement | null): void {
  event.preventDefault();
  event.stopPropagation();
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    build(rect.left, rect.bottom + 4);
  } else {
    build(event.clientX, event.clientY);
  }
}

/** §31 : glisser un compte pour le déplacer ; l'ordre est celui de Ctrl+1…9. */
function reorder(state: ShellState, draggedId: string, targetId: string): void {
  if (draggedId === targetId) return;
  const ids = state.accounts.map((account) => account.id).filter((id) => id !== draggedId);
  const index = ids.indexOf(targetId);
  if (index < 0) return;
  const draggedIndex = state.accounts.findIndex((account) => account.id === draggedId);
  const targetIndex = state.accounts.findIndex((account) => account.id === targetId);
  ids.splice(draggedIndex < targetIndex ? index + 1 : index, 0, draggedId);
  api.command({ type: "reorder-accounts", ids });
}

function Sidebar({ state, collapsed, autoCompact, onAdd, onNotices }: { state: ShellState; collapsed: boolean; autoCompact: boolean; onAdd(): void; onNotices(): void }) {
  const now = useNow();
  const accountsRef = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const activeFocus = state.focus.profiles.find((profile) => profile.id === state.focus.activeProfileId);
  const focusName = activeFocus ? t("shell.focusActive", { name: activeFocus.name }) : null;
  const focusLabel = focusName
    ? state.focus.until ? t("common.separator", { a: focusName, b: formatRemaining(new Date(state.focus.until), now) }) : focusName
    : t("shell.focus");

  useEffect(() => api.onRequestFocusAccounts(() => {
    const list = accountsRef.current;
    (list?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? list?.querySelector<HTMLButtonElement>(".account-switch"))?.focus();
  }), []);
  useEffect(() => {
    accountsRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [state.activeId]);

  return (
    <aside className="sidebar" aria-label={t("shell.accounts")}>
      <div className="brand">
        <img src={logo} alt="" />
        <span className="brand-name">{state.productName}</span>
        <button type="button" className={`icon-btn${state.veiled ? " pressed" : ""}`} aria-pressed={state.veiled}
          title={`${state.veiled ? t("veil.untoggle") : t("veil.toggle")} (Ctrl+${t("keys.shift")}+H)`} aria-label={state.veiled ? t("veil.untoggle") : t("veil.toggle")}
          onClick={() => api.command({ type: "toggle-veil" })}>
          <Icon name={state.veiled ? "eye" : "eye-off"} />
        </button>
        {state.lock.enabled && <button type="button" className="icon-btn" title={`${t("lock.now")} (Ctrl+${t("keys.shift")}+L)`} aria-label={t("lock.now")}
          onClick={() => api.command({ type: "lock-now" })}><Icon name="lock" /></button>}
        <button type="button" className="icon-btn" disabled={autoCompact}
          title={autoCompact ? t("shell.expandBlocked") : collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
          aria-label={collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
          onClick={() => api.command({ type: "set-preferences", patch: { sidebarCollapsed: !collapsed } })}>
          <Icon name={collapsed ? "expand" : "collapse"} />
        </button>
      </div>
      <div className={`focus-control${activeFocus ? " active" : ""}`}>
        <button type="button" className={`focus-chip${activeFocus ? " active" : ""}`} title={focusLabel} aria-label={activeFocus ? focusLabel : t("shell.chooseFocus")}
          aria-haspopup="menu" onClick={(event) => menuAt(event, (x, y) => api.command({ type: "focus-menu", x, y }), event.currentTarget)}>
          <Icon name="target" /><span>{focusLabel}</span>
        </button>
        {activeFocus && !collapsed && <button type="button" className="icon-btn" aria-label={t("shell.disableFocus")} title={t("shell.disableFocus")}
          onClick={() => api.command({ type: "activate-focus", profileId: null, minutes: null })}><Icon name="close" /></button>}
      </div>
      {!collapsed && <div className="accounts-heading">{t("shell.accounts")} <span>{state.accounts.length || ""}</span></div>}
      <ul className="accounts" role="list" ref={accountsRef} aria-label={t("shell.accountsList")}>
        {state.accounts.map((account) => {
          const status = statusLine(account, now);
          const unread = account.unread ? (account.unread > 99 ? "99+" : String(account.unread)) : null;
          const until = account.policy.until ? t("shell.untilDate", { date: formatDateTime(new Date(account.policy.until), { dateStyle: "short", timeStyle: "short" }) }) : "";
          const title = `${t("shell.accountTitle", { label: account.label, status: status.text })}${sourceLabel(account.policy.source)}${until}${account.shortcut ? t("shell.shortcutHint", { n: account.shortcut }) : ""}`;
          const openMenu = (anchor: HTMLElement) => {
            const rect = anchor.getBoundingClientRect();
            api.command({ type: "account-menu", id: account.id, x: rect.left, y: rect.bottom + 4 });
          };
          return (
            <li key={account.id} className={`account${account.active ? " active" : ""}${dragging === account.id ? " dragging" : ""}${dropTarget === account.id ? " drop-target" : ""}`}
              data-account={account.label} draggable
              onContextMenu={(event) => menuAt(event, (x, y) => api.command({ type: "account-menu", id: account.id, x, y }))}
              onDragStart={(event) => { setDragging(account.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", account.id); }}
              onDragEnd={() => { setDragging(null); setDropTarget(null); }}
              onDragOver={(event) => { if (dragging && dragging !== account.id) { event.preventDefault(); setDropTarget(account.id); } }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => { event.preventDefault(); if (dragging) reorder(state, dragging, account.id); setDragging(null); setDropTarget(null); }}>
              <button type="button" className="account-switch" aria-current={account.active ? "true" : undefined}
                title={title} aria-label={`${account.label}, ${status.text}${until}${account.unread ? t("shell.unreadSuffix", { count: account.unread }) : ""}`}
                aria-keyshortcuts={account.shortcut ? `Control+${account.shortcut}` : undefined}
                onClick={() => api.command({ type: "switch-account", id: account.id })}
                onKeyDown={(event) => {
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); openMenu(event.currentTarget); return; }
                  const buttons = [...(accountsRef.current?.querySelectorAll<HTMLButtonElement>(".account-switch") ?? [])];
                  const index = buttons.indexOf(event.currentTarget);
                  const target = event.key === "ArrowDown" ? buttons[(index + 1) % buttons.length] : event.key === "ArrowUp" ? buttons[(index - 1 + buttons.length) % buttons.length] : event.key === "Home" ? buttons[0] : event.key === "End" ? buttons.at(-1) : null;
                  if (target) { event.preventDefault(); target.focus(); }
                }}>
                <Avatar label={account.label} color={account.color} icon={account.icon} account={collapsed ? account : undefined} showBadge={collapsed} />
                <span className="account-text"><span className="account-label">{account.label}</span><span className={`account-status ${status.tone}`}>{status.text}</span></span>
              </button>
              {unread && !collapsed && <span className={`badge${account.policy.mode !== "normal" || account.lifecycle !== "ready" ? " muted" : ""}`} aria-hidden="true">{unread}</span>}
              {!collapsed && <div className="account-actions">
                <button type="button" className="icon-btn" aria-haspopup={account.policy.mode === "normal" ? "menu" : undefined}
                  aria-label={account.policy.mode === "normal" ? t("shell.snoozeAccount", { label: account.label }) : t("shell.resumeAccount", { label: account.label })}
                  title={account.policy.mode === "normal" ? t("shell.snooze") : t("shell.resume")}
                  disabled={account.lifecycle === "sleeping"}
                  onClick={(event) => account.policy.mode !== "normal" ? api.command({ type: "resume", id: account.id }) : menuAt(event, (x, y) => api.command({ type: "snooze-menu", id: account.id, x, y }), event.currentTarget)}>
                  <Icon name={account.policy.mode === "normal" ? "bell" : "bell-off"} />
                </button>
                <button type="button" className="icon-btn more" aria-haspopup="menu" aria-label={t("shell.accountActions", { label: account.label })} title={t("shell.accountActionsTitle")}
                  onClick={(event) => openMenu(event.currentTarget)}><Icon name="more" /></button>
              </div>}
            </li>
          );
        })}
      </ul>
      {state.notices.length > 0 && (collapsed ?
        <button type="button" className="icon-btn notice-summary" title={state.notices.map((notice) => notice.message).join("\n")} aria-label={t("shell.noticesCount", { count: state.notices.length })} onClick={onNotices}><Icon name="info" /></button> :
        <div className="notices" aria-live="polite">{state.notices.map((notice) => <NoticeItem key={notice.id} notice={notice} />)}</div>)}
      <ZoomToast state={state} />
      <NowPlaying state={state} collapsed={collapsed} />
      <div className="sidebar-footer">
        <DownloadsIndicator state={state} collapsed={collapsed} />
        <button type="button" className="btn btn-ghost" onClick={onAdd} title={t("shell.addAccount")} aria-label={t("shell.addAccount")}><Icon name="plus" /><span>{t("shell.addAccount")}</span></button>
        <button type="button" className="btn btn-ghost" onClick={() => api.command({ type: "open-settings" })} title={t("shell.settingsTitle")} aria-label={t("shell.settings")} aria-keyshortcuts="Control+,"><Icon name="settings" /><span>{t("shell.settings")}</span><kbd>Ctrl ,</kbd></button>
      </div>
    </aside>
  );
}

function NoticeItem({ notice }: { notice: ShellState["notices"][number] }) {
  return <div className={`notice ${notice.level}`}><p>{notice.message}{notice.action && <button type="button" className="notice-action" onClick={() => {
    if (notice.action) api.command(notice.action.command);
    api.command({ type: "dismiss-notice", id: notice.id });
  }}>{notice.action.label}</button>}</p><button type="button" className="icon-btn" aria-label={t("common.close")} title={t("common.close")} onClick={() => api.command({ type: "dismiss-notice", id: notice.id })}><Icon name="close" /></button></div>;
}

function Welcome({ onAdd }: { onAdd(): void }) {
  return (
    <div className="panel welcome">
      <img src={logo} alt="" className="welcome-logo" />
      <h1>{t("welcome.title")}</h1>
      <p>{t("welcome.line1")}<br />{t("welcome.line2")}</p>
      <div className="actions"><button type="button" className="btn btn-primary" onClick={onAdd}><Icon name="plus" /> {t("welcome.addFirst")}</button></div>
      <p className="disclaimer">{t("welcome.disclaimer")}</p>
    </div>
  );
}

function Stage({ state, onAdd }: { state: ShellState; onAdd(): void }) {
  const active = state.accounts.find((account) => account.id === state.activeId);
  if (!active) return <Welcome onAdd={onAdd} />;

  if (active.lifecycle === "sleeping") {
    return (
      <div className="panel">
        <span className="panel-icon"><Icon name="moon" /></span>
        <h2>{t("stage.sleepingTitle", { label: active.label })}</h2>
        <p>{t("stage.sleepingBody")}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => api.command({ type: "wake-account", id: active.id })}>
            {t("stage.wake")}
          </button>
        </div>
      </div>
    );
  }

  if (active.lifecycle === "crashed") {
    return (
      <div className="panel">
        <span className="panel-icon"><Icon name="warning" /></span>
        <h2>{t("stage.crashedTitle", { label: active.label })}</h2>
        <p>{t("stage.crashedBody")}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => api.command({ type: "reload-account", id: active.id })}>
            {t("stage.reload")}
          </button>
        </div>
      </div>
    );
  }

  if (active.lifecycle === "offline") {
    return <div className="connection-bar" role="status"><Icon name="wifi-off" /><span>{t("stage.offline")} <small>{t("stage.reconnecting")}</small></span>
      <button type="button" className="btn btn-small" onClick={() => api.command({ type: "reload-account", id: active.id })}>{t("stage.retry")}</button></div>;
  }

  // Visible tant que la vue WhatsApp ne s'est pas encore peinte par-dessus.
  if (active.lifecycle === "loading") {
    return (
      <div className="panel">
        <p role="status">{t("stage.loading", { label: active.label })}</p>
      </div>
    );
  }
  return null;
}

function AddAccountModal({ usedColors, onClose }: { usedColors: string[]; onClose(): void }) {
  const [label, setLabel] = useState(usedColors.length === 0 ? t("add.defaultLabel") : "");
  const [color, setColor] = useState(() => leastUsedAccountColor(usedColors));
  const [icon, setIcon] = useState<string | null>(null);
  const submit = () => {
    if (!label.trim()) return;
    api.command({ type: "add-account", label: label.trim(), color, ...(icon ? { icon } : {}) });
    onClose();
  };
  return (
    <Modal title={t("add.title")} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>{t("common.name")}</span>
          <input name="account-name" className="input" autoFocus maxLength={40} placeholder={t("add.placeholder")} value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <details className="personalization"><summary>{t("add.personalize")}</summary><div className="form-grid">
          <div className="field"><span>{t("ui.icon")}</span><AccountIconPicker value={icon} onChange={setIcon} /></div>
          <div className="field"><span>{t("ui.color")}</span><Swatches value={color} onChange={setColor} /></div>
        </div></details>
        {/* §7 : contraintes WhatsApp à connaître avant de scanner. */}
        <ul className="hint hint-list">
          <li>
            {t("add.hintPhoneBefore")} <strong>{t("add.hintPhonePath")}</strong>{t("add.hintPhoneAfter")}
          </li>
          <li>{t("add.hintStayConnected")}</li>
          <li>{t("add.hintLimit")}</li>
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!label.trim()}>
            {t("common.add")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function localInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** §12 : Snooze jusqu'à une date choisie. */
function SnoozeDateModal({ account, onClose }: { account: AccountItem | undefined; onClose(): void }) {
  const [value, setValue] = useState(() => localInputValue(new Date(Date.now() + 24 * 60 * 60_000)));
  const until = new Date(value);
  const valid = !Number.isNaN(until.getTime()) && until.getTime() > Date.now() + 60_000;
  if (!account) return null;
  return (
    <Modal title={t("snoozeDate.title", { label: account.label })} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          api.command({ type: "snooze", id: account.id, preset: { kind: "until", until: until.toISOString() } });
          onClose();
        }}
      >
        <label className="field">
          <span>{t("snoozeDate.field")}</span>
          <input name="snooze-until" className="input" type="datetime-local" autoFocus aria-invalid={!valid} aria-describedby={!valid ? "snooze-date-error" : undefined} min={localInputValue(new Date())} value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {!valid ? <p className="hint" id="snooze-date-error">{t("snoozeDate.invalid")}</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>
            {t("snoozeDate.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ChooseAccountModal({ state, onClose }: { state: ShellState; onClose(): void }) {
  const phone = state.pendingLink?.phone;
  const cancel = () => {
    api.command({ type: "resolve-link", accountId: null });
    onClose();
  };
  return (
    <Modal title={t("chooseLink.title")} onClose={cancel}>
      {phone ? <p className="hint">{t("chooseLink.phone", { phone })}</p> : <p className="hint">{t("chooseLink.share")}</p>}
      <div className="choice-list">
        {state.accounts.map((account) => (
          <button type="button"
            key={account.id}
            className="choice"
            onClick={() => {
              api.command({ type: "resolve-link", accountId: account.id });
              onClose();
            }}
          >
            <Avatar label={account.label} color={account.color} icon={account.icon} account={account} />
            <span>
              <strong>{account.label}</strong>
              <br />
              <span className="hint">{lifecycleLabel(account.lifecycle)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={cancel}>
          {t("common.cancel")}
        </button>
      </div>
    </Modal>
  );
}

function App() {
  const state = useShellState();
  const windowWidth = useWindowWidth();
  const [modal, setModal] = useState<ModalState>(null);
  const openAdd = useCallback(() => setModal({ kind: "add" }), []);
  const close = useCallback(() => setModal(null), []);

  // Une demande de lien n'est ouverte qu'une fois : l'état périmé reçu juste après
  // le choix d'un compte ne doit pas rouvrir la fenêtre.
  const [handledLink, setHandledLink] = useState<number | null>(null);
  const pendingLinkId = state?.pendingLink?.id ?? null;

  useEffect(() => api.onRequestAddAccount(openAdd), [openAdd]);
  useEffect(() => api.onRequestShortcuts(() => setModal({ kind: "shortcuts" })), []);
  // F6 : le verrou ferme toute modale ouverte.
  const locked = state?.lock.locked ?? false;
  useEffect(() => {
    if (locked) setModal(null);
  }, [locked]);
  useEffect(() => api.onRequestSnoozeDate((accountId) => setModal({ kind: "snooze-date", accountId })), []);
  useEffect(() => {
    if (modal?.kind === "notices" && state?.notices.length === 0) setModal(null);
  }, [modal, state?.notices.length]);
  useEffect(() => {
    if (pendingLinkId !== null && pendingLinkId !== handledLink && modal === null) setModal({ kind: "choose-link", linkId: pendingLinkId });
  }, [pendingLinkId, handledLink, modal]);
  const closeLink = useCallback(() => {
    if (modal?.kind === "choose-link") setHandledLink(modal.linkId);
    setModal(null);
  }, [modal]);
  // §29 : pendant une modale, les vues WhatsApp sont masquées.
  useEffect(() => {
    api.command({ type: "set-modal", open: modal !== null });
  }, [modal]);

  if (!state) return null;
  // Langue poussée par le processus principal : chaque rendu repart de l'état reçu.
  setLocale(state.language, state.localeTag);
  if (document.documentElement.lang !== state.localeTag) document.documentElement.lang = state.localeTag;
  if (state.lock.locked) return <LockScreen state={state} />;
  const collapsed = compactSidebar(windowWidth, state.sidebarCollapsed);
  const width = collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded;
  return (
    <div className={`shell${collapsed ? " collapsed" : ""}`} style={{ ["--sidebar-width" as string]: `${width}px`, ["--connection-bar-height" as string]: `${CONNECTION_BAR_HEIGHT}px` }}>
      <Sidebar state={state} collapsed={collapsed} autoCompact={collapsed && !state.sidebarCollapsed} onAdd={openAdd} onNotices={() => setModal({ kind: "notices" })} />
      <main className="stage">
        <Stage state={state} onAdd={openAdd} />
      </main>
      {modal?.kind === "notices" && <Modal title={t("shell.notices")} onClose={close}><div className="notices">{state.notices.map((notice) => <NoticeItem key={notice.id} notice={notice} />)}</div></Modal>}
      {modal?.kind === "add" && <AddAccountModal usedColors={state.accounts.map((account) => account.color)} onClose={close} />}
      {modal?.kind === "choose-link" && <ChooseAccountModal state={state} onClose={closeLink} />}
      {modal?.kind === "snooze-date" && <SnoozeDateModal account={state.accounts.find((account) => account.id === modal.accountId)} onClose={close} />}
      {modal?.kind === "shortcuts" && <ShortcutsModal onClose={close} />}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
