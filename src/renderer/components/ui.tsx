import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type CSSProperties } from "react";
import { initials } from "../../shared/format";
import { t } from "../../shared/i18n";
import type { AccountItem } from "../../shared/ipc";
import { ACCOUNT_COLORS } from "../../shared/constants";

export const COLORS: string[] = ACCOUNT_COLORS.map((color) => color.value);
const colorName = (color: string): string | null => {
  const entry = ACCOUNT_COLORS.find((candidate) => candidate.value === color);
  return entry ? t(`color.${entry.name}`) : null;
};

// --- Icônes (traits simples, couleur héritée) ---------------------------------------

const paths: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  collapse: <path d="M15 18l-6-6 6-6" />,
  expand: <path d="M9 18l6-6-6-6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  "bell-off": <><path d="M3 3l18 18M9 3a6 6 0 0 1 9 5c0 2 0 3 1 5M6 6v2c0 7-3 7-3 9h14M10 21h4" /></>,
  phone: <path d="M7 3H4a1 1 0 0 0-1 1c0 9 8 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a16 16 0 0 1-7-7l2-2-2-5z" />,
  "wifi-off": <><path d="M3 3l18 18M2 8a16 16 0 0 1 3-2M9 4a16 16 0 0 1 13 4M5 12a11 11 0 0 1 4-2M14 10a11 11 0 0 1 5 2M8 16a6 6 0 0 1 8 0M12 20h.01" /></>,
  briefcase: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3" /></>,
  home: <><path d="M3 10l9-7 9 7v11H3zM9 21v-8h6v8" /></>,
  chat: <path d="M4 4h16v12H9l-5 4V4zM8 8h8M8 12h5" />,
  warning: <><path d="M12 3L2 21h20L12 3zM12 9v5M12 17h.01" /></>,
  refresh: <><path d="M20 6v5h-5M4 18v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3" /></>,
  check: <path d="M5 12l4 4L19 6" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  play: <path d="M7 4l13 8-13 8z" />,
  backspace: <><path d="M21 5H9l-6 7 6 7h12z" /><path d="M17 9l-6 6M11 9l6 6" /></>,
  pause: <path d="M7 4v16M17 4v16" />,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  "eye-off": <><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.6 3.3M6.6 6.7C4.3 8.3 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  eye: <><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="3" /></>,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></>,
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  leaf: <path d="M5 20c0-9 6-15 15-15 0 9-6 15-15 15zM5 20l8-8" />
};

export type IconName = keyof typeof paths;

/** Navigation d'une liste desktop sans déclencher involontairement une action. */
export function navigationKeys(event: KeyboardEvent<HTMLElement>): void {
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".nav-item, .list-item")];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
  if (!step && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const next = event.key === "Home" ? items[0] : event.key === "End" ? items.at(-1) : items[(index + step + items.length) % items.length];
  next?.focus();
}

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

// --- Avatar d'un compte ----------------------------------------------------------------

export function Avatar({
  label,
  color,
  icon,
  account,
  showBadge = false
}: {
  label: string;
  color: string;
  icon: string | null;
  account?: AccountItem;
  showBadge?: boolean;
}) {
  // Mode économie : le compte dort entre deux relèves mais reste joignable, il n'est pas grisé.
  const economy = Boolean(account?.economy);
  const dim = account?.lifecycle === "sleeping" && !economy;
  let state: ReactNode = null;
  if (account) {
    if (account.inCall) state = <span className="state call"><Icon name="phone" /></span>;
    else if (account.playback?.playing) state = <span className="state call"><Icon name="play" /></span>;
    else if (account.lifecycle === "needs_qr" || account.lifecycle === "crashed") state = <span className="state warn"><Icon name="warning" /></span>;
    else if (account.lifecycle === "offline") state = <span className="state"><Icon name="wifi-off" /></span>;
    else if (economy) state = <span className="state"><Icon name="leaf" /></span>;
    else if (account.lifecycle === "sleeping") state = <span className="state"><Icon name="moon" /></span>;
    else if (account.policy.mode === "snoozed") state = <span className="state"><Icon name="bell-off" /></span>;
    else if (account.policy.mode === "calls-only") state = <span className="state"><Icon name="phone" /></span>;
  }
  return (
    <span className={`avatar${dim ? " dim" : ""}`} style={{ "--account-color": color } as CSSProperties} aria-hidden="true">
      {icon && icon in paths ? <Icon name={icon} /> : icon ? <span className="emoji">{icon}</span> : initials(label)}
      {state}
      {showBadge && account?.unread ? <span className={`badge${account.policy.mode !== "normal" ? " muted" : ""}`}>{account.unread > 99 ? "99+" : account.unread}</span> : null}
    </span>
  );
}

// --- Contrôles --------------------------------------------------------------------------

export function Toggle({ checked, onChange, disabled = false, label }: { checked: boolean; onChange(value: boolean): void; disabled?: boolean; label: string }) {
  return <input type="checkbox" role="switch" aria-label={label} className="toggle" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
}

/** Radios desktop : une entrée Tab ; flèches/Home/End déplacent et sélectionnent. */
function radioKeys(event: KeyboardEvent<HTMLDivElement>): void {
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const index = radios.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const next = event.key === "Home" ? radios[0] : event.key === "End" ? radios.at(-1) : radios[(index + step + radios.length) % radios.length];
  next?.focus();
  next?.click();
}

export function Segmented<T extends string>({ value, options, onChange, "aria-label": label }: { value: T; options: Array<{ value: T; label: string }>; onChange(value: T): void; "aria-label": string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={radioKeys}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" tabIndex={value === option.value ? 0 : -1} aria-checked={value === option.value} className={value === option.value ? "selected" : ""} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("input, .choice, .notice-action")?.focus();
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
      <dialog className="modal" aria-label={title} ref={ref} onCancel={(event) => { event.preventDefault(); onClose(); }}
        onMouseDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose();
        }}>
        <div className="modal-heading">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" aria-label={t("ui.closeDialog")} title={t("ui.closeEscape")} onClick={onClose}><Icon name="close" /></button>
        </div>
        {children}
      </dialog>
  );
}

export function Swatches({ value, onChange }: { value: string; onChange(color: string): void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={t("ui.color")} onKeyDown={radioKeys}>
      {(COLORS.includes(value) ? COLORS : [value, ...COLORS]).map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          tabIndex={value === color ? 0 : -1}
          aria-label={colorName(color) ?? t("ui.currentColor")}
          title={colorName(color) ?? t("ui.currentColor")}
          className={`swatch${value === color ? " selected" : ""}`}
          style={{ background: color }}
          onClick={() => onChange(color)}
        >{value === color && <Icon name="check" />}</button>
      ))}
    </div>
  );
}

export function AccountIconPicker({ value, onChange }: { value: string | null; onChange(icon: string | null): void }) {
  const choices = [
    { value: null, label: t("ui.iconInitials") },
    { value: "user", label: t("ui.iconPersonal") },
    { value: "briefcase", label: t("ui.iconWork") },
    { value: "home", label: t("ui.iconHome") },
    { value: "chat", label: t("ui.iconChat") },
    { value: "moon", label: t("ui.iconEvening") },
    ...(value && !["user", "briefcase", "home", "chat", "moon"].includes(value) ? [{ value, label: t("ui.iconCurrent") }] : [])
  ];
  return (
    <div className="icon-choices" role="radiogroup" aria-label={t("ui.icon")} onKeyDown={radioKeys}>
      {choices.map((choice) => (
        <button key={choice.label} type="button" role="radio" tabIndex={value === choice.value ? 0 : -1} aria-checked={value === choice.value}
          aria-label={choice.label} title={choice.label} className={`identity-icon${value === choice.value ? " selected" : ""}`} onClick={() => onChange(choice.value)}>
          {choice.value === null ? "Aa" : choice.value in paths ? <Icon name={choice.value} /> : choice.value}
        </button>
      ))}
    </div>
  );
}

/** Touches d'un raccourci : « Shift » se dit « Maj » en français. */
export function ShortcutKeys({ keys }: { keys: readonly string[] }) {
  return <span className="keys">{keys.map((key) => <kbd key={key}>{key === "Shift" ? t("keys.shift") : key}</kbd>)}</span>;
}
