// Fenêtre des paramètres (§26, §27, §30, §31) : fenêtre séparée, jamais d'overlay
// au-dessus des vues WhatsApp (§29).

import { StrictMode, useEffect, useState, useId, cloneElement, isValidElement, type ReactNode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { AccountPatch, DownloadEntry, PreferencesPatch, SettingsSection, SettingsState } from "../shared/ipc";
import type { AccountConfig, AccountPermissions, FocusProfile, LanguagePreference, Mode, PermissionChoice, ProxyServer, Schedule, ScheduleRule } from "../shared/schemas";
import { SHORTCUTS } from "../shared/shortcuts";
import { DEFAULT_ACCOUNT_COLOR } from "../shared/constants";
import { formatBytes, formatDateTime, formatNumber, languageName, LOCALES, resolveLocale, setLocale, t, weekdayName, type Locale } from "../shared/i18n";
import { api, useSettingsState } from "./api";
import { Avatar, AccountIconPicker, Icon, navigationKeys, Segmented, ShortcutKeys, Swatches, Toggle } from "./components/ui";
import logo from "./logo.svg";
import "./styles.css";

type Section = SettingsSection;

const MODES: Mode[] = ["normal", "snoozed", "calls-only"];
const modeOptions = () => MODES.map((mode) => ({ value: mode, label: t(`mode.${mode}`) }));
const autoSleepOptions = () => [
  { value: "", label: t("common.never") },
  ...(["15", "30", "60", "180"] as const).map((value) => ({ value, label: t(`autoSleep.${value}`) }))
];

function Row({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  const id = useId();
  const control = isValidElement(children) && children.type === "select"
    ? cloneElement(children as ReactElement<{ "aria-labelledby"?: string }>, { "aria-labelledby": id }) : children;
  return (
    <div className="row" role="group" aria-labelledby={id}>
      <div className="row-text">
        <strong id={id}>{title}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
      {control}
    </div>
  );
}

function setPreferences(patch: PreferencesPatch): void {
  api.command({ type: "set-preferences", patch });
}

// --- Général ------------------------------------------------------------------------

const NATIVE_LANGUAGE_NAMES: Record<Locale, string> = { fr: "Français", en: "English" };

function SpellcheckSettings({ state }: { state: SettingsState }) {
  const preferences = state.preferences;
  const { available, bundled, systemDictionary } = state.spellcheck;
  const chosen = preferences.spellcheckLanguages;
  const choices = [...new Set([...bundled, ...available])].filter((language) => available.includes(language) && !chosen.includes(language));
  const usesGoogle = preferences.spellcheckMode === "custom" && chosen.some((language) => !bundled.includes(language));
  const detail = preferences.spellcheckMode === "system" && !systemDictionary ? t("spellcheck.noSystemDictionary") : usesGoogle ? t("spellcheck.googleNotice") : t("spellcheck.detail");
  return (
    <>
      <Row title={t("general.spellcheckLanguage")} detail={detail}>
        <select
          className="select"
          name="spellcheck-mode"
          value={preferences.spellcheckMode}
          onChange={(event) => setPreferences({ spellcheckMode: event.target.value as SettingsState["preferences"]["spellcheckMode"] })}
        >
          <option value="off">{t("spellcheck.off")}</option>
          <option value="system">{systemDictionary ? t("spellcheck.system", { language: languageName(systemDictionary) }) : t("spellcheck.systemNone")}</option>
          <option value="custom">{t("spellcheck.custom")}</option>
        </select>
      </Row>
      {preferences.spellcheckMode === "custom" && (
        <div className="row spellcheck-languages">
          <ul className="chips" aria-label={t("spellcheck.custom")}>
            {chosen.map((language) => (
              <li key={language} className="chip">
                <span>{languageName(language)}</span>
                <small className={bundled.includes(language) ? "tag" : "tag tag-warn"}>{bundled.includes(language) ? t("spellcheck.bundledTag") : t("spellcheck.googleTag")}</small>
                <button type="button" className="icon-btn" aria-label={t("spellcheck.remove", { language: languageName(language) })} title={t("spellcheck.remove", { language: languageName(language) })}
                  onClick={() => setPreferences({ spellcheckLanguages: chosen.filter((candidate) => candidate !== language) })}><Icon name="close" /></button>
              </li>
            ))}
          </ul>
          <select className="select" name="spellcheck-add" aria-label={t("spellcheck.addLanguage")} value="" disabled={chosen.length >= 5} title={chosen.length >= 5 ? t("spellcheck.max") : undefined}
            onChange={(event) => event.target.value && setPreferences({ spellcheckLanguages: [...chosen, event.target.value] })}>
            <option value="">{t("spellcheck.addLanguage")}</option>
            {choices.map((language) => (
              <option key={language} value={language}>
                {languageName(language)}{bundled.includes(language) ? ` · ${t("spellcheck.bundledTag")}` : ` · ${t("spellcheck.googleTag")}`}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

function GeneralSection({ state }: { state: SettingsState }) {
  const preferences = state.preferences;
  const systemLocale = resolveLocale("system", state.systemLanguages).locale;
  return (
    <>
      <h2>{t("section.general")}</h2>
      <p className="section-intro">{t("general.intro")}</p>

      <div className="settings-group">
        <Row title={t("general.language")} detail={t("general.languageDetail")}>
          <select className="select" name="language" value={preferences.language} onChange={(event) => setPreferences({ language: event.target.value as LanguagePreference })}>
            <option value="system">{t("general.languageSystem", { language: NATIVE_LANGUAGE_NAMES[systemLocale] })}</option>
            {LOCALES.map((candidate) => (
              <option key={candidate} value={candidate} lang={candidate}>
                {NATIVE_LANGUAGE_NAMES[candidate]}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="section-label">{t("general.startup")}</div>
      <div className="settings-group">
        <Row title={t("general.launchAtLogin")}>
          <Toggle label={t("general.launchAtLogin")} checked={preferences.launchAtLogin} onChange={(launchAtLogin) => setPreferences({ launchAtLogin })} />
        </Row>
        <Row
          title={t("general.closeToTray")}
          detail={state.trayAvailable ? undefined : t("general.noTray")}
        >
          <Toggle
            label={t("general.closeToTrayLabel")}
            checked={preferences.closeToTray && state.trayAvailable}
            disabled={!state.trayAvailable}
            onChange={(closeToTray) => setPreferences({ closeToTray })}
          />
        </Row>
        <Row title={t("general.startMinimized")} detail={state.trayAvailable ? t("general.startMinimizedTray") : t("general.startMinimizedNoTray")}>
          <Toggle label={t("general.startMinimized")} checked={preferences.startMinimized} onChange={(startMinimized) => setPreferences({ startMinimized })} />
        </Row>
      </div>

      <div className="section-label">{t("general.spellcheck")}</div>
      <div className="settings-group">
        <SpellcheckSettings state={state} />
      </div>

      <div className="section-label">{t("general.playback")}</div>
      <div className="settings-group">
        <Row title={t("general.exclusivePlayback")} detail={t("general.exclusivePlaybackDetail")}>
          <Toggle label={t("general.exclusivePlayback")} checked={preferences.exclusivePlayback} onChange={(exclusivePlayback) => setPreferences({ exclusivePlayback })} />
        </Row>
      </div>

      <div className="section-label">{t("shortcuts.title")}</div>
      <div className="settings-group">
        <p className="hint">{t("shortcuts.intro")}</p>
        <dl className="shortcut-list">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.id}>
              <dt>{t(shortcut.label)}</dt>
              <dd><ShortcutKeys keys={shortcut.keys} /></dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

function AppearanceSection({ state }: { state: SettingsState }) {
  const preferences = state.preferences;
  return <><h2>{t("section.appearance")}</h2><p className="section-intro">{t("appearance.intro")}</p>

      <div className="settings-group">
        <Row title={t("appearance.theme")} detail={t("appearance.themeDetail")}>
          <Segmented
            aria-label={t("appearance.theme")}
            value={preferences.theme}
            options={[
              { value: "system", label: t("appearance.system") },
              { value: "light", label: t("appearance.light") },
              { value: "dark", label: t("appearance.dark") }
            ]}
            onChange={(theme) => setPreferences({ theme })}
          />
        </Row>
        <Row title={t("appearance.compactSidebar")}>
          <Toggle label={t("appearance.compactSidebar")} checked={preferences.sidebarCollapsed} onChange={(sidebarCollapsed) => setPreferences({ sidebarCollapsed })} />
        </Row>
        <Row title={t("appearance.scale")} detail={t("appearance.scaleDetail")}>
          <select className="select" name="interface-scale" value={preferences.interfaceScale} onChange={(event) => setPreferences({ interfaceScale: Number(event.target.value) })}>
            {[90, 100, 110, 120, 130, 140, 150].map((value) => <option key={value} value={value}>{formatNumber(value / 100, { style: "percent" })}</option>)}
          </select>
        </Row>
        {state.trayAvailable && (
          <Row title={t("appearance.trayCount")}>
            <Segmented
              aria-label={t("appearance.trayCount")}
              value={preferences.trayCountStyle}
              options={[
                { value: "number", label: t("trayCount.number") },
                { value: "dot", label: t("trayCount.dot") },
                { value: "none", label: t("trayCount.none") }
              ]}
              onChange={(trayCountStyle) => setPreferences({ trayCountStyle })}
            />
          </Row>
        )}
      </div>
      <p className="hint">{t("appearance.whatsappTheme")}</p>

  </>;
}

function FilesSection({ state }: { state: SettingsState }) {
  const preferences = state.preferences;
  return <><h2>{t("section.files")}</h2><p className="section-intro">{t("files.intro")}</p>

      <div className="settings-group">
        <Row title={t("files.askLocation")} detail={t("files.askLocationDetail")}>
          <Toggle label={t("files.askLocationLabel")} checked={preferences.askDownloadLocation} onChange={(askDownloadLocation) => setPreferences({ askDownloadLocation })} />
        </Row>
        <Row title={t("files.links")} detail={t("files.linksDetail")}>
          <Toggle label={t("files.linksLabel")} checked={preferences.handleWhatsappLinks} onChange={(handleWhatsappLinks) => setPreferences({ handleWhatsappLinks })} />
        </Row>
      </div>

  </>;
}

// --- Comptes ---------------------------------------------------------------------------

// --- Proxy (F9) ---------------------------------------------------------------------------

const PROXY_HOST = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/;

/** Serveur, identifiants et test, pour le réglage global ou un compte. */
function ProxyServerForm({ state, scope, server, onApply }: { state: SettingsState; scope: "global" | string; server: ProxyServer | null; onApply(server: ProxyServer): void }) {
  const [draft, setDraft, dirty] = useDraft<ProxyServer>(server ?? { type: "http", host: "", port: 3128, auth: false });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const valid = PROXY_HOST.test(draft.host.trim()) && Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535;
  const hasCredentials = scope === "global" ? state.security.proxyCredentials.global : Boolean(state.security.proxyCredentials.accounts[scope]);
  const test = state.proxyTests[scope];
  const applied = server !== null && !dirty;
  return (
    <div className="form-grid">
      <div className="form-row">
        <label className="field">
          <span>{t("proxy.type")}</span>
          <select className="select" name="proxy-type" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as ProxyServer["type"] })}>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </label>
        <label className="field">
          <span>{t("proxy.host")}</span>
          <input className="input" name="proxy-host" spellCheck={false} value={draft.host} aria-invalid={draft.host !== "" && !valid} onChange={(event) => setDraft({ ...draft, host: event.target.value })} />
        </label>
        <label className="field">
          <span>{t("proxy.port")}</span>
          <input className="input" name="proxy-port" type="number" min={1} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} />
        </label>
      </div>
      <Row title={t("proxy.auth")}>
        <Toggle label={t("proxy.auth")} checked={draft.auth} onChange={(auth) => setDraft({ ...draft, auth })} />
      </Row>
      {draft.host !== "" && !valid && <p className="hint status-error">{t("proxy.invalid")}</p>}
      <div className="button-row">
        <button type="button" className="btn btn-primary" disabled={!valid || !dirty} onClick={() => onApply({ ...draft, host: draft.host.trim() })}>{t("proxy.apply")}</button>
        <button type="button" className="btn" disabled={!applied || test?.running} onClick={() => api.command({ type: "test-proxy", scope })}>{test?.running ? t("proxy.testing") : t("proxy.test")}</button>
        {test && !test.running && (
          <span className={`hint ${test.ok ? "status-ok" : "status-error"}`} role="status">{test.ok ? t("proxy.testOk", { route: test.route }) : t("proxy.testFailed", { error: test.error ?? "" })}</span>
        )}
      </div>
      {draft.auth && (
        <>
          {!state.security.secureStorage && <p className="callout">{t("proxy.noKeyring")}</p>}
          <div className="form-row credentials">
            <label className="field">
              <span>{t("proxy.username")}</span>
              <input className="input" name="proxy-username" autoComplete="off" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label className="field">
              <span>{t("proxy.password")}</span>
              <input className="input" name="proxy-password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <button type="button" className="btn" disabled={!username || !password} onClick={() => {
              api.command({ type: "set-proxy-credentials", scope, username, password });
              setPassword("");
            }}>{t("proxy.saveCredentials")}</button>
          </div>
          {hasCredentials && (
            <div className="button-row">
              <span className="hint status-ok">{state.security.secureStorage ? t("proxy.credentialsSaved") : t("proxy.credentialsMemory")}</span>
              <button type="button" className="btn btn-small" onClick={() => api.command({ type: "clear-proxy-credentials", scope })}>{t("proxy.clearCredentials")}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NetworkSection({ state }: { state: SettingsState }) {
  const proxy = state.preferences.proxy;
  return (
    <>
      <h2>{t("section.network")}</h2>
      <p className="section-intro">{t("network.intro")}</p>
      <div className="settings-group">
        <Row title={t("proxy.title")}>
          <select className="select" name="proxy-mode" value={proxy.mode}
            onChange={(event) => {
              const mode = event.target.value as typeof proxy.mode;
              if (mode !== "manual" || proxy.server) setPreferences({ proxy: { ...proxy, mode } });
              else setPreferences({ proxy: { mode: "none", server: proxy.server } });
            }}>
            <option value="system">{t("proxy.system")}</option>
            <option value="none">{t("proxy.none")}</option>
            {proxy.server && <option value="manual">{t("proxy.manual")}</option>}
          </select>
        </Row>
      </div>
      <div className="section-label">{t("proxy.manual")}</div>
      <div className="settings-group">
        <ProxyServerForm state={state} scope="global" server={proxy.server} onApply={(server) => setPreferences({ proxy: { mode: "manual", server } })} />
        <p className="hint">{t("proxy.webrtc")}</p>
      </div>
    </>
  );
}

// --- Comptes ---------------------------------------------------------------------------

const PERMISSION_KEYS: Array<keyof AccountPermissions> = ["microphone", "camera", "location", "screenShare"];

function PermissionsSettings({ account }: { account: AccountConfig }) {
  const set = (key: keyof AccountPermissions, value: string) => api.command({ type: "update-account", id: account.id, patch: { permissions: { [key]: value } } });
  return (
    <>
      {PERMISSION_KEYS.map((key) => {
        const choices: PermissionChoice[] = key === "screenShare" ? ["ask", "deny"] : ["allow", "ask", "deny"];
        return (
          <Row key={key} title={t(`permission.${key}`)} detail={key === "screenShare" ? t("permission.screenShareDetail") : undefined}>
            <Segmented aria-label={t(`permission.${key}`)} value={account.permissions[key]} options={choices.map((value) => ({ value, label: t(`choice.${value}`) }))} onChange={(value) => set(key, value)} />
          </Row>
        );
      })}
    </>
  );
}

function AccountProxySettings({ account, state }: { account: AccountConfig; state: SettingsState }) {
  const update = (patch: AccountPatch) => api.command({ type: "update-account", id: account.id, patch });
  const [editing, setEditing] = useState(account.proxyMode === "manual");
  useEffect(() => setEditing(account.proxyMode === "manual"), [account.proxyMode]);
  return (
    <>
      <Row title={t("account.proxy")}>
        <select className="select" name="account-proxy-mode" value={editing ? "manual" : account.proxyMode}
          onChange={(event) => {
            const mode = event.target.value as AccountConfig["proxyMode"];
            if (mode === "manual" && !account.proxy) setEditing(true);
            else {
              setEditing(mode === "manual");
              update({ proxyMode: mode });
            }
          }}>
          <option value="inherit">{t("proxyMode.inherit")}</option>
          <option value="none">{t("proxyMode.none")}</option>
          <option value="manual">{t("proxyMode.manual")}</option>
        </select>
      </Row>
      {editing && <ProxyServerForm state={state} scope={account.id} server={account.proxy} onApply={(proxy) => update({ proxy, proxyMode: "manual" })} />}
    </>
  );
}

function AccountEditor({ account, state }: { account: AccountConfig; state: SettingsState }) {
  const [label, setLabel] = useState(account.label);
  useEffect(() => setLabel(account.label), [account.label]);

  const update = (patch: AccountPatch) => api.command({ type: "update-account", id: account.id, patch });
  const notifications = account.notifications;
  const setNotification = (key: keyof AccountConfig["notifications"], value: boolean) => update({ notifications: { [key]: value } });
  const memory = state.memory[account.id];

  return (
    <div>
      <div className="section-label">{t("account.identity")}</div>
      <div className="settings-group form-grid">
        <label className="field">
          <span>{t("common.name")}</span>
          <input name="account-name"
            className="input"
            maxLength={40}
            value={label}
            aria-invalid={!label.trim()}
            aria-describedby={!label.trim() ? "account-name-error" : undefined}
            onChange={(event) => setLabel(event.target.value)}
            onBlur={() => label.trim() && label.trim() !== account.label && update({ label: label.trim() })}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setLabel(account.label); }}
          />
          {!label.trim() && <small className="hint" id="account-name-error">{t("account.nameRequired")}</small>}
        </label>
        <div className="field">
          <span>{t("ui.icon")}</span>
          <AccountIconPicker value={account.icon ?? null} onChange={(icon) => update({ icon })} />
        </div>
        <div className="field">
          <span>{t("ui.color")}</span>
          <Swatches value={account.color ?? DEFAULT_ACCOUNT_COLOR} onChange={(color) => update({ color })} />
        </div>
      </div>

      <div className="section-label">{t("account.notifications")}</div>
      <div className="settings-group">
        <Row title={t("account.notificationsEnabled")}>
          <Toggle label={t("account.notificationsEnabled")} checked={notifications.enabled} onChange={(value) => setNotification("enabled", value)} />
        </Row>
        <Row title={t("account.sound")}>
          <Toggle label={t("account.sound")} checked={notifications.sound} disabled={!notifications.enabled} onChange={(value) => setNotification("sound", value)} />
        </Row>
        <Row title={t("account.preview")} detail={t("account.previewDetail")}>
          <Toggle label={t("account.preview")} checked={notifications.showPreview} onChange={(value) => setNotification("showPreview", value)} />
        </Row>
        <Row title={t("account.badge")}>
          <Toggle label={t("account.badgeLabel")} checked={notifications.badge} onChange={(value) => setNotification("badge", value)} />
        </Row>
        <Row title={t("account.includeInTotal")}>
          <Toggle label={t("account.includeInTotal")} checked={notifications.includeInTotal} onChange={(value) => setNotification("includeInTotal", value)} />
        </Row>
        <Row title={t("account.badgeWhileSnoozed")}>
          <Toggle label={t("account.badgeWhileSnoozedLabel")} checked={notifications.badgeWhileSnoozed} onChange={(value) => setNotification("badgeWhileSnoozed", value)} />
        </Row>
      </div>

      <div className="section-label">{t("account.schedulesResources")}</div>
      <div className="settings-group">
        <Row title={t("account.schedule")} detail={t("account.scheduleDetail")}>
          <select name="setting" className="select" value={account.scheduleId ?? ""} onChange={(event) => update({ scheduleId: event.target.value || null })}>
            <option value="">{t("common.none")}</option>
            {state.schedules.map((schedule) => (
              <option key={schedule.id} value={schedule.id}>
                {schedule.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t("account.autoSleep")} detail={memory ? t("account.memory", { mb: memory }) : t("account.neverInCall")}>
          <select name="setting"
            className="select"
            value={account.autoSleepAfterMinutes ? String(account.autoSleepAfterMinutes) : ""}
            onChange={(event) => update({ autoSleepAfterMinutes: event.target.value ? Number(event.target.value) : null })}
          >
            {autoSleepOptions().map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="section-label">{t("account.permissions")}</div>
      <div className="settings-group">
        <p className="hint">{t("account.permissionsDetail")}</p>
        <PermissionsSettings account={account} />
        <Row title={t("account.zoom")} detail={t("account.zoomDetail")}>
          <select className="select" name="account-zoom" value={account.zoomPercent} onChange={(event) => update({ zoomPercent: Number(event.target.value) })}>
            {[50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200].map((value) => <option key={value} value={value}>{formatNumber(value / 100, { style: "percent" })}</option>)}
          </select>
        </Row>
      </div>

      <div className="section-label">{t("section.network")}</div>
      <div className="settings-group">
        <AccountProxySettings account={account} state={state} />
      </div>

      <div className="section-label">{t("account.session")}</div>
      <div className="settings-group">
        <div className="button-row">
          <button type="button" className="btn" onClick={() => api.command({ type: "reload-account", id: account.id })}>
            {t("account.reload")}
          </button>
          <button type="button" className="btn" onClick={() => api.command({ type: "clear-cache", id: account.id })} title={t("account.clearCacheTitle")}>
            {t("account.clearCache")}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => api.command({ type: "request-remove-account", id: account.id })}>{t("account.remove")}</button>
        </div>
        <p className="hint" style={{ paddingBottom: 12, margin: 0 }}>
          {t("account.removeHint")}
        </p>
      </div>
    </div>
  );
}

/** §31 : l'ordre des comptes est aussi celui des raccourcis Ctrl+1…9. */
function moveAccount(state: SettingsState, id: string, step: number): void {
  const ids = state.accounts.map((account) => account.id);
  const index = ids.indexOf(id);
  const target = index + step;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
  api.command({ type: "reorder-accounts", ids });
}

function AccountsSection({ state }: { state: SettingsState }) {
  const [selected, setSelected] = useState<string | null>(state.navigationRequest?.accountId ?? state.accounts[0]?.id ?? null);
  useEffect(() => {
    if (state.navigationRequest?.accountId) setSelected(state.navigationRequest.accountId);
  }, [state.navigationRequest?.sequence]);
  const account = state.accounts.find((candidate) => candidate.id === selected) ?? state.accounts[0];
  return (
    <>
      <h2>{t("section.accounts")}</h2>
      <p className="section-intro">{t("accounts.intro")}</p>
      {state.accounts.length === 0 ? (
        <p className="empty">{t("accounts.empty")}</p>
      ) : (
        <div className="split">
          <div className="account-list-group"><div className="list" onKeyDown={navigationKeys}>
            {state.accounts.map((candidate) => (
              <button type="button" key={candidate.id} className={`list-item${candidate.id === account?.id ? " active" : ""}`} aria-current={candidate.id === account?.id ? "true" : undefined} title={candidate.label} onClick={() => setSelected(candidate.id)}>
                <Avatar label={candidate.label} color={candidate.color ?? DEFAULT_ACCOUNT_COLOR} icon={candidate.icon ?? null} />
                <span>{candidate.label}</span>
              </button>
            ))}
          </div>
            {account && state.accounts.length > 1 ? (
              <div className="button-row">
                <button type="button" className="btn btn-small" disabled={state.accounts[0]?.id === account.id} onClick={() => moveAccount(state, account.id, -1)}>
                  <span className="rotate-up"><Icon name="collapse" /></span> {t("accounts.moveUp")}
                </button>
                <button type="button" className="btn btn-small" disabled={state.accounts.at(-1)?.id === account.id} onClick={() => moveAccount(state, account.id, 1)}>
                  <span className="rotate-down"><Icon name="expand" /></span> {t("accounts.moveDown")}
                </button>
              </div>
            ) : null}
          </div>
          {account ? <AccountEditor key={account.id} account={account} state={state} /> : null}
        </div>
      )}
    </>
  );
}

// --- Horaires ----------------------------------------------------------------------------

const templates = (): Array<{ label: string; build(): Schedule }> => [
  {
    label: t("schedules.templateOffice"),
    build: () => ({
      id: crypto.randomUUID(),
      name: t("schedules.templateOfficeName"),
      defaultMode: "snoozed",
      rules: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", mode: "normal" }]
    })
  },
  {
    label: t("schedules.templateNights"),
    build: () => ({
      id: crypto.randomUUID(),
      name: t("schedules.templateNightsName"),
      defaultMode: "normal",
      rules: [{ days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "08:00", mode: "calls-only" }]
    })
  }
];

/**
 * Brouillon d'un objet enregistré : réinitialisé seulement quand la valeur
 * enregistrée change vraiment. L'état arrive par IPC sous forme d'objets neufs à
 * chaque rafraîchissement, une dépendance sur l'objet effacerait les modifications.
 */
function useDraft<T>(saved: T): [T, (value: T) => void, boolean] {
  const serialized = JSON.stringify(saved);
  const [draft, setDraft] = useState<T>(saved);
  useEffect(() => setDraft(JSON.parse(serialized) as T), [serialized]);
  return [draft, setDraft, JSON.stringify(draft) !== serialized];
}

function ScheduleEditor({ schedule }: { schedule: Schedule }) {
  const [draft, setDraft, dirty] = useDraft(schedule);
  const setRule = (index: number, rule: ScheduleRule) => setDraft({ ...draft, rules: draft.rules.map((candidate, position) => (position === index ? rule : candidate)) });

  return (
    <div>
      <div className="settings-group form-grid">
        <label className="field">
          <span>{t("common.name")}</span>
          <input name="name" className="input" maxLength={60} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label className="field">
          <span>{t("schedules.outside")}</span>
          <select name="setting" className="select" value={draft.defaultMode} onChange={(event) => setDraft({ ...draft, defaultMode: event.target.value as Mode })}>
            {modeOptions().map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="section-label">{t("schedules.rules")}</div>
      <div className="settings-group">
        {draft.rules.length === 0 ? <p className="empty">{t("schedules.noRules")}</p> : null}
        {draft.rules.map((rule, index) => (
          <div className="rule" key={index}>
            <div className="days">
              {[1, 2, 3, 4, 5, 6, 7].map((iso, position) => {
                const selected = rule.days.includes(iso);
                return (
                  <button
                    key={position}
                    type="button"
                    className={`day${selected ? " selected" : ""}`}
                    aria-pressed={selected}
                    aria-label={weekdayName(iso, "long")}
                    title={weekdayName(iso, "long")}
                    onClick={() => {
                      const days = selected ? rule.days.filter((candidate) => candidate !== iso) : [...rule.days, iso].sort();
                      if (days.length > 0) setRule(index, { ...rule, days });
                    }}
                  >
                    {weekdayName(iso, "narrow")}
                  </button>
                );
              })}
            </div>
            <input name="schedule-time" className="input" type="time" value={rule.start} onChange={(event) => setRule(index, { ...rule, start: event.target.value })} aria-label={t("schedules.start")} />
            <span className="arrow">→</span>
            <input name="schedule-time" className="input" type="time" value={rule.end} onChange={(event) => setRule(index, { ...rule, end: event.target.value })} aria-label={t("schedules.end")} />
            <select name="setting" className="select" value={rule.mode} onChange={(event) => setRule(index, { ...rule, mode: event.target.value as Mode })} aria-label={t("schedules.mode")}>
              {modeOptions().map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button type="button" className="icon-btn" aria-label={t("schedules.removeRule")} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_rule, position) => position !== index) })}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        <div className="button-row">
          <button type="button" className="btn btn-small" onClick={() => setDraft({ ...draft, rules: [...draft.rules, { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", mode: "normal" }] })}>
            <Icon name="plus" /> {t("schedules.addRule")}
          </button>
        </div>
      </div>
      <p className="hint">{t("schedules.help")}</p>
      <div className="button-row">
        <button type="button" className="btn btn-primary" disabled={!dirty || !draft.name.trim()} onClick={() => api.command({ type: "save-schedule", schedule: { ...draft, name: draft.name.trim() } })}>
          {t("common.save")}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => api.command({ type: "request-delete-schedule", id: schedule.id })}>{t("schedules.delete")}</button>
      </div>
    </div>
  );
}

function SchedulesSection({ state }: { state: SettingsState }) {
  const [selected, setSelected] = useState<string | null>(null);
  const schedule = state.schedules.find((candidate) => candidate.id === selected) ?? state.schedules[0];
  const create = (template: Schedule) => {
    api.command({ type: "save-schedule", schedule: template });
    setSelected(template.id);
  };
  return (
    <>
      <h2>{t("section.schedules")}</h2>
      <p className="section-intro">{t("schedules.intro")}</p>
      <div className="split">
        <div className="list" onKeyDown={navigationKeys}>
          {state.schedules.map((candidate) => (
            <button type="button" key={candidate.id} className={`list-item${candidate.id === schedule?.id ? " active" : ""}`} aria-current={candidate.id === schedule?.id ? "true" : undefined} title={candidate.name} onClick={() => setSelected(candidate.id)}>
              <Icon name="calendar" />
              <span>{candidate.name}</span>
            </button>
          ))}
          {templates().map((template) => (
            <button type="button" key={template.label} className="btn btn-small btn-ghost" onClick={() => create(template.build())}>
              <Icon name="plus" /> {template.label}
            </button>
          ))}
        </div>
        {schedule ? <ScheduleEditor key={schedule.id} schedule={schedule} /> : <p className="empty">{t("schedules.empty")}</p>}
      </div>
    </>
  );
}

// --- Focus ------------------------------------------------------------------------------

function FocusEditor({ profile, state }: { profile: FocusProfile; state: SettingsState }) {
  const [draft, setDraft, dirty] = useDraft(profile);
  const active = state.focus.active?.profileId === profile.id;

  return (
    <div>
      <div className="settings-group form-grid">
        <label className="field">
          <span>{t("common.name")}</span>
          <input name="name" className="input" maxLength={60} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
      </div>
      <div className="section-label">{t("focus.during")}</div>
      <div className="settings-group">
        {state.accounts.map((account) => (
          <Row key={account.id} title={account.label}>
            <select name="setting"
              className="select"
              value={draft.modes[account.id] ?? ""}
              onChange={(event) => {
                const modes = { ...draft.modes };
                if (event.target.value) modes[account.id] = event.target.value as Mode;
                else delete modes[account.id];
                setDraft({ ...draft, modes });
              }}
            >
              <option value="">{draft.othersMode ? t("focus.likeOthers") : t("focus.unchanged")}</option>
              {modeOptions().map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Row>
        ))}
        <Row title={t("focus.others")} detail={t("focus.othersDetail")}>
          <select name="setting"
            className="select"
            value={draft.othersMode ?? ""}
            onChange={(event) => {
              const { othersMode: _previous, ...rest } = draft;
              setDraft(event.target.value ? { ...rest, othersMode: event.target.value as Mode } : rest);
            }}
          >
            <option value="">{t("focus.othersUnchanged")}</option>
            {modeOptions().map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Row>
      </div>
      <div className="button-row">
        <button type="button" className="btn btn-primary" disabled={!dirty || !draft.name.trim()} onClick={() => api.command({ type: "save-focus-profile", profile: { ...draft, name: draft.name.trim() } })}>
          {t("common.save")}
        </button>
        <button type="button" className="btn" disabled={dirty && !active} title={dirty && !active ? t("focus.saveFirst") : undefined} onClick={() => api.command({ type: "activate-focus", profileId: active ? null : profile.id, minutes: null })}>
          {active ? t("focus.deactivate") : t("focus.activate")}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => api.command({ type: "request-delete-focus-profile", id: profile.id })}>{t("focus.delete")}</button>
      </div>
    </div>
  );
}

function FocusSection({ state }: { state: SettingsState }) {
  const [selected, setSelected] = useState<string | null>(null);
  const profile = state.focus.profiles.find((candidate) => candidate.id === selected) ?? state.focus.profiles[0];
  const create = () => {
    const created: FocusProfile = { id: crypto.randomUUID(), name: t("focus.defaultName", { n: state.focus.profiles.length + 1 }), modes: {}, othersMode: "snoozed" };
    api.command({ type: "save-focus-profile", profile: created });
    setSelected(created.id);
  };
  return (
    <>
      <h2>{t("section.focus")}</h2>
      <p className="section-intro">{t("focus.intro")}</p>
      <div className="split">
        <div className="list" onKeyDown={navigationKeys}>
          {state.focus.profiles.map((candidate) => (
            <button type="button" key={candidate.id} className={`list-item${candidate.id === profile?.id ? " active" : ""}`} aria-current={candidate.id === profile?.id ? "true" : undefined} title={candidate.name} onClick={() => setSelected(candidate.id)}>
              <Icon name="target" />
              <span>
                {candidate.name}
                {state.focus.active?.profileId === candidate.id ? t("focus.active") : ""}
              </span>
            </button>
          ))}
          <button type="button" className="btn btn-small btn-ghost" onClick={create}>
            <Icon name="plus" /> {t("focus.new")}
          </button>
        </div>
        {profile ? <FocusEditor key={profile.id} profile={profile} state={state} /> : <p className="empty">{t("focus.empty")}</p>}
      </div>
    </>
  );
}

// --- Téléchargements (F2) -------------------------------------------------------------------

function downloadStatus(entry: DownloadEntry): { text: string; warn: boolean } {
  if (entry.missing) return { text: t("downloads.missing"), warn: true };
  if (entry.state === "progressing") return { text: t("downloads.progressing", { percent: Math.round((entry.progress ?? 0) * 100) }), warn: false };
  return { text: t(`downloads.${entry.state}`), warn: entry.state !== "completed" };
}

function DownloadsSection({ state }: { state: SettingsState }) {
  return (
    <>
      <h2>{t("section.downloads")}</h2>
      <p className="section-intro">{t("downloads.intro")}</p>
      <div className="settings-group">
        <Row title={t("downloads.retention")} detail={t("downloads.retentionDetail")}>
          <select className="select" name="downloads-retention" value={state.preferences.downloadsHistoryDays} onChange={(event) => setPreferences({ downloadsHistoryDays: Number(event.target.value) })}>
            {([0, 7, 30, 90, 365] as const).map((days) => <option key={days} value={days}>{t(`retention.${days}`)}</option>)}
          </select>
        </Row>
      </div>
      {state.downloads.length === 0 ? (
        <p className="empty">{t("downloads.empty")}</p>
      ) : (
        <>
          <ul className="entries" aria-label={t("section.downloads")}>
            {state.downloads.map((entry) => {
              const status = downloadStatus(entry);
              const date = formatDateTime(new Date(entry.finishedAt ?? entry.startedAt), { dateStyle: "medium", timeStyle: "short" });
              return (
                <li key={entry.id} className="entry" data-download={entry.fileName}>
                  <span className="entry-icon"><Icon name="file" /></span>
                  <span className="entry-text">
                    <strong>{entry.fileName}</strong>
                    <small>{t("downloads.meta", { account: entry.accountLabel, size: formatBytes(entry.bytes), date })} · <span className={status.warn ? "warn" : undefined}>{status.text}</span></small>
                  </span>
                  <span className="entry-actions">
                    {entry.state === "completed" && !entry.missing && <button type="button" className="btn btn-small" onClick={() => api.command({ type: "download-open", id: entry.id })}>{t("downloads.open")}</button>}
                    <button type="button" className="icon-btn" aria-label={`${t("downloads.showInFolder")} : ${entry.fileName}`} title={t("downloads.showInFolder")} onClick={() => api.command({ type: "download-show", id: entry.id })}><Icon name="folder" /></button>
                    <button type="button" className="icon-btn" aria-label={`${t("downloads.remove")} : ${entry.fileName}`} title={t("downloads.remove")} onClick={() => api.command({ type: "download-remove", id: entry.id })}><Icon name="close" /></button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="button-row">
            <button type="button" className="btn btn-danger" onClick={() => api.command({ type: "downloads-clear" })}>{t("downloads.clear")}</button>
          </div>
        </>
      )}
    </>
  );
}

// --- Sécurité (F6, F7) ---------------------------------------------------------------------

function LockCodeForm({ enabled }: { enabled: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const tooShort = next.length > 0 && next.length < 4;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = next.length >= 4 && next === confirm && (!enabled || current.length > 0);
  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
  };
  return (
    <form className="form-grid" onSubmit={(event) => {
      event.preventDefault();
      if (!ready) return;
      api.command({ type: "set-lock-code", current: enabled ? current : null, next });
      reset();
    }}>
      {enabled && (
        <label className="field">
          <span>{t("lock.currentCode")}</span>
          <input className="input" name="lock-current" type="password" autoComplete="off" value={current} onChange={(event) => setCurrent(event.target.value)} />
        </label>
      )}
      <label className="field">
        <span>{t("lock.newCode")}</span>
        <input className="input" name="lock-new" type="password" autoComplete="new-password" aria-invalid={tooShort} value={next} onChange={(event) => setNext(event.target.value)} />
        <small className="hint">{tooShort ? t("lock.tooShort") : t("lock.codeHint")}</small>
      </label>
      <label className="field">
        <span>{t("lock.confirmCode")}</span>
        <input className="input" name="lock-confirm" type="password" autoComplete="new-password" aria-invalid={mismatch} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        {mismatch && <small className="hint status-error">{t("lock.mismatch")}</small>}
      </label>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!ready}>{enabled ? t("lock.changeCode") : t("lock.setCode")}</button>
        {enabled && (
          <button type="button" className="btn btn-danger" disabled={!current} onClick={() => {
            api.command({ type: "disable-lock", current });
            reset();
          }}>{t("lock.disable")}</button>
        )}
      </div>
    </form>
  );
}

function SecuritySection({ state }: { state: SettingsState }) {
  const lock = state.security.lock;
  const veil = state.preferences.privacyVeil;
  const setLock = (options: Partial<typeof lock>) => api.command({ type: "set-lock-options", options });
  return (
    <>
      <h2>{t("section.security")}</h2>
      <p className="section-intro">{t("security.intro")}</p>

      <div className="section-label">{t("lock.section")}</div>
      <div className="settings-group">
        <p className="callout">{t("lock.what")}</p>
        {!lock.enabled && <LockCodeForm key="new" enabled={false} />}
        {lock.enabled && (
          <>
            <Row title={t("lock.onStart")}>
              <Toggle label={t("lock.onStart")} checked={lock.onStart} onChange={(onStart) => setLock({ onStart })} />
            </Row>
            <Row title={t("lock.onHide")} detail={t("lock.onHideDetail")}>
              <Toggle label={t("lock.onHide")} checked={lock.onHide} onChange={(onHide) => setLock({ onHide })} />
            </Row>
            <Row title={t("lock.idle")}>
              <select className="select" name="lock-idle" value={lock.idleMinutes} onChange={(event) => setLock({ idleMinutes: Number(event.target.value) })}>
                <option value={0}>{t("common.never")}</option>
                {([5, 15, 30, 60] as const).map((minutes) => <option key={minutes} value={minutes}>{t(`lock.idle${minutes}`)}</option>)}
              </select>
            </Row>
            <Row title={t("lock.onScreenLock")} detail={t("lock.onScreenLockDetail")}>
              <Toggle label={t("lock.onScreenLock")} checked={lock.onScreenLock} onChange={(onScreenLock) => setLock({ onScreenLock })} />
            </Row>
            <div className="button-row">
              <button type="button" className="btn" onClick={() => api.command({ type: "lock-now" })}><Icon name="lock" /> {t("lock.now")}</button>
            </div>
            <details className="disclosure">
              <summary>{t("lock.changeCode")} · {t("lock.disable")}</summary>
              <LockCodeForm key="change" enabled={true} />
            </details>
          </>
        )}
      </div>

      <div className="section-label">{t("security.veil")}</div>
      <div className="settings-group">
        <Row title={t("veil.onBlur")} detail={t("veil.onBlurDetail")}>
          <Toggle label={t("veil.onBlur")} checked={veil.onBlur} onChange={(onBlur) => setPreferences({ privacyVeil: { onBlur } })} />
        </Row>
        <Row title={t("veil.onScreenShare")} detail={t("veil.onScreenShareDetail")}>
          <Toggle label={t("veil.onScreenShare")} checked={veil.onScreenShare} onChange={(onScreenShare) => setPreferences({ privacyVeil: { onScreenShare } })} />
        </Row>
        <Row title={`${t("veil.blurMessages")} (${t("common.experimental")})`} detail={t("veil.blurMessagesDetail")}>
          <Toggle label={t("veil.blurMessages")} checked={veil.blurMessages} onChange={(blurMessages) => setPreferences({ privacyVeil: { blurMessages } })} />
        </Row>
        <div className="button-row">
          <span className="hint"><ShortcutKeys keys={["Ctrl", "Shift", "H"]} /> {t("shortcut.veil")}</span>
        </div>
      </div>
    </>
  );
}

// --- À propos --------------------------------------------------------------------------

function AboutSection({ state }: { state: SettingsState }) {
  return (
    <>
      <h2>{t("section.about")}</h2>
      <p className="section-intro">{state.disclaimer}</p>
      <div className="section-label">{t("about.version")}</div>
      <div className="settings-group">
        <dl className="kv">
          <dt>{state.productName}</dt>
          <dd>{state.versions.app}</dd>
          <dt>Electron</dt>
          <dd>{state.versions.electron}</dd>
          <dt>Chromium</dt>
          <dd>{state.versions.chromium}</dd>
          <dt>Node.js</dt>
          <dd>{state.versions.node}</dd>
        </dl>
      </div>
      <div className="section-label">{t("about.privacy")}</div>
      <div className="settings-group">
        <ul className="steps" style={{ padding: "12px 0 12px 20px" }}>
          <li>{t("about.privacy1")}</li>
          <li>{t("about.privacy2")}</li>
          <li>{t("about.privacy3")}</li>
        </ul>
      </div>
      <div className="section-label">{t("about.diagnostic")}</div>
      <div className="settings-group">
        <dl className="kv">
          <dt>{t("about.data")}</dt>
          <dd>{state.paths.userData}</dd>
          <dt>{t("about.logs")}</dt>
          <dd>{state.paths.logs}</dd>
        </dl>
        <div className="button-row">
          <button type="button" className="btn btn-small" onClick={() => api.command({ type: "open-logs" })}>
            {t("about.openLogs")}
          </button>
          <button type="button" className="btn btn-small" onClick={() => api.command({ type: "create-diagnostic-report" })}>
            {t("about.report")}
          </button>
          <button type="button" className="btn btn-small" onClick={() => api.command({ type: "report-problem" })}>
            {t("about.reportIssue")}
          </button>
        </div>
        <p className="hint">{t("about.reportDetail")}</p>
      </div>
    </>
  );
}

// --- Fenêtre -------------------------------------------------------------------------------

const SECTIONS: Array<{ id: Section; icon: Parameters<typeof Icon>[0]["name"] }> = [
  { id: "general", icon: "sliders" },
  { id: "appearance", icon: "moon" },
  { id: "accounts", icon: "user" },
  { id: "schedules", icon: "calendar" },
  { id: "focus", icon: "target" },
  { id: "security", icon: "shield" },
  { id: "files", icon: "chat" },
  { id: "downloads", icon: "download" },
  { id: "network", icon: "globe" },
  { id: "about", icon: "info" }
];

function SettingsApp() {
  const state = useSettingsState();
  const [section, setSection] = useState<Section>("general");
  useEffect(() => {
    if (state?.navigationRequest) setSection(state.navigationRequest.section);
  }, [state?.navigationRequest?.sequence]);
  if (!state) return null;
  setLocale(state.language, state.localeTag);
  if (document.documentElement.lang !== state.localeTag) document.documentElement.lang = state.localeTag;
  // Le titre de la page devient celui de la fenêtre.
  const title = t("window.settingsTitle", { product: state.productName });
  if (document.title !== title) document.title = title;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("settings.sections")} onKeyDown={navigationKeys}>
        <h1>
          <img src={logo} alt="" /> {t("settings.title")}
        </h1>
        {SECTIONS.map((item) => (
          <button type="button" key={item.id} className={`nav-item${section === item.id ? " active" : ""}`} onClick={() => setSection(item.id)} aria-current={section === item.id ? "page" : undefined}>
            <Icon name={item.icon} />
            {t(`section.${item.id}`)}
          </button>
        ))}
      </nav>
      <main className="settings-main" key={section}>
        {Boolean(state.notices?.length) && <div className="settings-notices" aria-live="polite">
          {state.notices?.map((notice) => <div key={notice.id} className={`notice ${notice.level}`}><p>{notice.message}</p>
            <button type="button" className="icon-btn" aria-label={t("settings.closeNotice")} title={t("common.close")} onClick={() => api.command({ type: "dismiss-notice", id: notice.id })}><Icon name="close" /></button>
          </div>)}
        </div>}
        {section === "appearance" && <AppearanceSection state={state} />}
        {section === "files" && <FilesSection state={state} />}
        {section === "general" && <GeneralSection state={state} />}
        {section === "accounts" && <AccountsSection state={state} />}
        {section === "schedules" && <SchedulesSection state={state} />}
        {section === "focus" && <FocusSection state={state} />}
        {section === "about" && <AboutSection state={state} />}
        {section === "security" && <SecuritySection state={state} />}
        {section === "downloads" && <DownloadsSection state={state} />}
        {section === "network" && <NetworkSection state={state} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>
);
