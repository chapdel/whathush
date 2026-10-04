// Fenêtre principale : barre latérale des comptes et zone d'affichage.
// Les vues WhatsApp sont des couches natives posées au-dessus de la zone
// d'affichage : on n'y dessine que ce qui doit se voir quand aucune vue ne
// l'est (accueil, veille, erreur), et les modales masquent les vues (§29).

import { StrictMode, useCallback, useEffect, useState, useRef, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { compactSidebar, CONNECTION_BAR_HEIGHT, SIDEBAR_WIDTH } from "../shared/constants";
import { formatRemaining, lifecycleLabel } from "../shared/format";
import type { AccountItem, ShellState } from "../shared/ipc";
import { api, useNow, useShellState, useWindowWidth } from "./api";
import { Avatar, COLORS, AccountIconPicker, Icon, Modal, Swatches } from "./components/ui";
import logo from "./logo.svg";
import "./styles.css";

type ModalState = { kind: "notices" } | { kind: "add" } | { kind: "choose-link"; linkId: number } | { kind: "snooze-date"; accountId: string } | null;

const SOURCE_LABELS: Record<AccountItem["policy"]["source"], string> = {
  default: "",
  manual: " (manuel)",
  focus: " (Focus)",
  schedule: " (horaire)"
};

function statusLine(account: AccountItem, now: Date): { text: string; tone: "" | "warn" | "error" } {
  if (account.inCall) return { text: "Appel en cours", tone: "" };
  if (account.lifecycle === "needs_qr") return { text: "Scannez le QR code", tone: "warn" };
  if (account.lifecycle === "crashed") return { text: "Erreur : à recharger", tone: "error" };
  if (account.lifecycle === "offline") return { text: "Hors ligne", tone: "warn" };
  if (account.lifecycle !== "ready") return { text: lifecycleLabel(account.lifecycle), tone: "" };
  if (account.policy.mode !== "normal") {
    const label = account.policy.mode === "snoozed" ? "Snooze" : "Appels uniquement";
    const until = account.policy.until ? ` · ${formatRemaining(new Date(account.policy.until), now)}` : "";
    return { text: `${label}${until}`, tone: "" };
  }
  return { text: "Connecté", tone: "" };
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
  const focusLabel = activeFocus
    ? `Focus : ${activeFocus.name}${state.focus.until ? ` · ${formatRemaining(new Date(state.focus.until), now)}` : ""}`
    : "Focus";

  useEffect(() => api.onRequestFocusAccounts(() => {
    const list = accountsRef.current;
    (list?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? list?.querySelector<HTMLButtonElement>(".account-switch"))?.focus();
  }), []);
  useEffect(() => {
    accountsRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [state.activeId]);

  return (
    <aside className="sidebar" aria-label="Comptes">
      <div className="brand">
        <img src={logo} alt="" />
        <span className="brand-name">{state.productName}</span>
        <button type="button" className="icon-btn" disabled={autoCompact}
          title={autoCompact ? "Agrandissez la fenêtre pour déplier les comptes" : collapsed ? "Déplier la barre latérale" : "Replier la barre latérale"}
          aria-label={collapsed ? "Déplier la barre latérale" : "Replier la barre latérale"}
          onClick={() => api.command({ type: "set-preferences", patch: { sidebarCollapsed: !collapsed } })}>
          <Icon name={collapsed ? "expand" : "collapse"} />
        </button>
      </div>
      <div className={`focus-control${activeFocus ? " active" : ""}`}>
        <button type="button" className={`focus-chip${activeFocus ? " active" : ""}`} title={focusLabel} aria-label={activeFocus ? focusLabel : "Choisir un Focus"}
          aria-haspopup="menu" onClick={(event) => menuAt(event, (x, y) => api.command({ type: "focus-menu", x, y }), event.currentTarget)}>
          <Icon name="target" /><span>{focusLabel}</span>
        </button>
        {activeFocus && !collapsed && <button type="button" className="icon-btn" aria-label="Désactiver le Focus" title="Désactiver le Focus"
          onClick={() => api.command({ type: "activate-focus", profileId: null, minutes: null })}><Icon name="close" /></button>}
      </div>
      {!collapsed && <div className="accounts-heading">Comptes <span>{state.accounts.length || ""}</span></div>}
      <ul className="accounts" role="list" ref={accountsRef} aria-label="Comptes WhatsApp">
        {state.accounts.map((account) => {
          const status = statusLine(account, now);
          const unread = account.unread ? (account.unread > 99 ? "99+" : String(account.unread)) : null;
          const until = account.policy.until ? ` · jusqu’au ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(account.policy.until))}` : "";
          const title = `${account.label} — ${status.text}${SOURCE_LABELS[account.policy.source]}${until}${account.shortcut ? ` (Ctrl+${account.shortcut})` : ""}`;
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
                title={title} aria-label={`${account.label}, ${status.text}${until}${account.unread ? `, ${account.unread} non lus` : ""}`}
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
                  aria-label={`${account.policy.mode === "normal" ? "Snooze" : "Réactiver les notifications de"} ${account.label}`}
                  title={account.policy.mode === "normal" ? "Snooze" : "Réactiver les notifications"}
                  disabled={account.lifecycle === "sleeping"}
                  onClick={(event) => account.policy.mode !== "normal" ? api.command({ type: "resume", id: account.id }) : menuAt(event, (x, y) => api.command({ type: "snooze-menu", id: account.id, x, y }), event.currentTarget)}>
                  <Icon name={account.policy.mode === "normal" ? "bell" : "bell-off"} />
                </button>
                <button type="button" className="icon-btn more" aria-haspopup="menu" aria-label={`Actions pour ${account.label}`} title="Actions du compte (Maj+F10)"
                  onClick={(event) => openMenu(event.currentTarget)}><Icon name="more" /></button>
              </div>}
            </li>
          );
        })}
      </ul>
      {state.notices.length > 0 && (collapsed ?
        <button type="button" className="icon-btn notice-summary" title={state.notices.map((notice) => notice.message).join("\n")} aria-label={`${state.notices.length} informations à consulter`} onClick={onNotices}><Icon name="info" /></button> :
        <div className="notices" aria-live="polite">{state.notices.map((notice) => <NoticeItem key={notice.id} notice={notice} />)}</div>)}
      <div className="sidebar-footer">
        <button type="button" className="btn btn-ghost" onClick={onAdd} title="Ajouter un compte" aria-label="Ajouter un compte"><Icon name="plus" /><span>Ajouter un compte</span></button>
        <button type="button" className="btn btn-ghost" onClick={() => api.command({ type: "open-settings" })} title="Paramètres (Ctrl+,)" aria-label="Paramètres" aria-keyshortcuts="Control+,"><Icon name="settings" /><span>Paramètres</span><kbd>Ctrl ,</kbd></button>
      </div>
    </aside>
  );
}

function NoticeItem({ notice }: { notice: ShellState["notices"][number] }) {
  return <div className={`notice ${notice.level}`}><p>{notice.message}{notice.action && <button type="button" className="notice-action" onClick={() => {
    if (notice.action) api.command(notice.action.command);
    api.command({ type: "dismiss-notice", id: notice.id });
  }}>{notice.action.label}</button>}</p><button type="button" className="icon-btn" aria-label="Fermer" title="Fermer" onClick={() => api.command({ type: "dismiss-notice", id: notice.id })}><Icon name="close" /></button></div>;
}

function Welcome({ onAdd }: { onAdd(): void }) {
  return (
    <div className="panel welcome">
      <img src={logo} alt="" className="welcome-logo" />
      <h1>Connecter WhatsApp</h1>
      <p>Ajoutez un compte, puis scannez le QR code depuis<br />WhatsApp → Appareils connectés sur votre téléphone.</p>
      <div className="actions"><button type="button" className="btn btn-primary" onClick={onAdd}><Icon name="plus" /> Ajouter mon premier compte</button></div>
      <p className="disclaimer">WhatsApp Web officiel, dans une application indépendante.</p>
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
        <h2>« {active.label} » est en veille</h2>
        <p>Ce compte ne reçoit plus de messages ni d’appels. Réveillez-le pour retrouver vos conversations.</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => api.command({ type: "wake-account", id: active.id })}>
            Réveiller
          </button>
        </div>
      </div>
    );
  }

  if (active.lifecycle === "crashed") {
    return (
      <div className="panel">
        <span className="panel-icon"><Icon name="warning" /></span>
        <h2>« {active.label} » s’est arrêté</h2>
        <p>WhatsApp s’est interrompu pour ce compte. Réessayez pour retrouver vos conversations.</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => api.command({ type: "reload-account", id: active.id })}>
            Recharger
          </button>
        </div>
      </div>
    );
  }

  if (active.lifecycle === "offline") {
    return <div className="connection-bar" role="status"><Icon name="wifi-off" /><span>Connexion interrompue <small>Reconnexion automatique…</small></span>
      <button type="button" className="btn btn-small" onClick={() => api.command({ type: "reload-account", id: active.id })}>Réessayer</button></div>;
  }

  // Visible tant que la vue WhatsApp ne s'est pas encore peinte par-dessus.
  if (active.lifecycle === "loading") {
    return (
      <div className="panel">
        <p role="status">Connexion à « {active.label} »…</p>
      </div>
    );
  }
  return null;
}

function AddAccountModal({ existing, onClose }: { existing: number; onClose(): void }) {
  const [label, setLabel] = useState(existing === 0 ? "Personnel" : "");
  const [color, setColor] = useState(COLORS[existing % COLORS.length] ?? COLORS[0]!);
  const [icon, setIcon] = useState<string | null>(null);
  const submit = () => {
    if (!label.trim()) return;
    api.command({ type: "add-account", label: label.trim(), color, ...(icon ? { icon } : {}) });
    onClose();
  };
  return (
    <Modal title="Ajouter un compte" onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>Nom</span>
          <input name="account-name" className="input" autoFocus maxLength={40} placeholder="Personnel, Travail, Support…" value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <details className="personalization"><summary>Personnaliser ce compte</summary><div className="form-grid">
          <div className="field"><span>Icône</span><AccountIconPicker value={icon} onChange={setIcon} /></div>
          <div className="field"><span>Couleur</span><Swatches value={color} onChange={setColor} /></div>
        </div></details>
        <p className="hint">Sur votre téléphone : <strong>Appareils connectés → Connecter un appareil</strong>, puis scannez le QR code.</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={!label.trim()}>
            Ajouter
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
    <Modal title={`Snooze de « ${account.label} » jusqu’au…`} onClose={onClose}>
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
          <span>Date et heure de fin</span>
          <input name="snooze-until" className="input" type="datetime-local" autoFocus aria-invalid={!valid} aria-describedby={!valid ? "snooze-date-error" : undefined} min={localInputValue(new Date())} value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {!valid ? <p className="hint" id="snooze-date-error">Choisissez une date dans le futur.</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>
            Mettre en Snooze
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
    <Modal title="Ouvrir la conversation avec quel compte ?" onClose={cancel}>
      {phone ? <p className="hint">Conversation avec le +{phone}</p> : <p className="hint">Message à partager</p>}
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
          Annuler
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
  const collapsed = compactSidebar(windowWidth, state.sidebarCollapsed);
  const width = collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded;
  return (
    <div className={`shell${collapsed ? " collapsed" : ""}`} style={{ ["--sidebar-width" as string]: `${width}px`, ["--connection-bar-height" as string]: `${CONNECTION_BAR_HEIGHT}px` }}>
      <Sidebar state={state} collapsed={collapsed} autoCompact={collapsed && !state.sidebarCollapsed} onAdd={openAdd} onNotices={() => setModal({ kind: "notices" })} />
      <main className="stage">
        <Stage state={state} onAdd={openAdd} />
      </main>
      {modal?.kind === "notices" && <Modal title="Informations" onClose={close}><div className="notices">{state.notices.map((notice) => <NoticeItem key={notice.id} notice={notice} />)}</div></Modal>}
      {modal?.kind === "add" && <AddAccountModal existing={state.accounts.length} onClose={close} />}
      {modal?.kind === "choose-link" && <ChooseAccountModal state={state} onClose={closeLink} />}
      {modal?.kind === "snooze-date" && <SnoozeDateModal account={state.accounts.find((account) => account.id === modal.accountId)} onClose={close} />}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
