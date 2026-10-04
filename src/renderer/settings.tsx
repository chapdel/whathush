// Fenêtre des paramètres (§26, §27, §30, §31) : fenêtre séparée, jamais d'overlay
// au-dessus des vues WhatsApp (§29).

import { StrictMode, useEffect, useState, useId, cloneElement, isValidElement, type ReactNode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { AccountPatch, PreferencesPatch, SettingsState } from "../shared/ipc";
import type { AccountConfig, FocusProfile, Mode, Schedule, ScheduleRule } from "../shared/schemas";
import { DEFAULT_ACCOUNT_COLOR } from "../shared/constants";
import { api, useSettingsState } from "./api";
import { Avatar, AccountIconPicker, Icon, navigationKeys, Segmented, Swatches, Toggle } from "./components/ui";
import logo from "./logo.svg";
import "./styles.css";

type Section = "general" | "appearance" | "files" | "accounts" | "schedules" | "focus" | "about";

const MODE_LABELS: Record<Mode, string> = {
  normal: "Notifications normales",
  snoozed: "Snooze (silence)",
  "calls-only": "Appels uniquement (expérimental)"
};
const DAYS = ["L", "M", "M", "J", "V", "S", "D"];
const DAY_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const AUTO_SLEEP = [
  { value: "", label: "Jamais" },
  { value: "15", label: "Après 15 min d’inactivité" },
  { value: "30", label: "Après 30 min d’inactivité" },
  { value: "60", label: "Après 1 h d’inactivité" },
  { value: "180", label: "Après 3 h d’inactivité" }
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

function GeneralSection({ state }: { state: SettingsState }) {
  const preferences = state.preferences;
  const languages = state.spellcheckLanguages;
  return (
    <>
      <h2>Général</h2>
      <p className="section-intro">Comportement de l’application sur ce bureau.</p>

      <div className="section-label">Démarrage et fermeture</div>
      <div className="settings-group">
        <Row title="Lancer à l’ouverture de session">
          <Toggle label="Lancer à l’ouverture de session" checked={preferences.launchAtLogin} onChange={(launchAtLogin) => setPreferences({ launchAtLogin })} />
        </Row>
        <Row
          title="Garder l’application ouverte à la fermeture"
          detail={state.trayAvailable ? undefined : "Indisponible : aucune zone de notification détectée. Sous GNOME, installez l’extension AppIndicator."}
        >
          <Toggle
            label="Fermer vers la zone de notification"
            checked={preferences.closeToTray && state.trayAvailable}
            disabled={!state.trayAvailable}
            onChange={(closeToTray) => setPreferences({ closeToTray })}
          />
        </Row>
        <Row title="Démarrer réduit" detail={state.trayAvailable ? "La fenêtre s’ouvre depuis l’icône de la zone de notification." : "La fenêtre démarre réduite dans la barre des tâches."}>
          <Toggle label="Démarrer réduit" checked={preferences.startMinimized} onChange={(startMinimized) => setPreferences({ startMinimized })} />
        </Row>
      </div>

      <div className="section-label">Correcteur orthographique</div>
      <div className="settings-group">
        <Row
          title="Langue du correcteur"
          detail="Désactivé par défaut : Electron télécharge les dictionnaires depuis les serveurs de Google au premier usage."
        >
          <select
            className="select"
            aria-label="Langue du correcteur"
            name="spellcheck-language"
            value={preferences.spellcheckLanguages[0] ?? ""}
            onChange={(event) => setPreferences({ spellcheckLanguages: event.target.value ? [event.target.value] : [] })}
          >
            <option value="">Désactivé</option>
            {languages.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </Row>
      </div>
    </>
  );
}

function AppearanceSection({ state }: { state: SettingsState }) {
  const preferences = state.preferences;
  return <><h2>Apparence</h2><p className="section-intro">Thème et densité de la barre des comptes.</p>

      <div className="settings-group">
        <Row title="Thème" detail="Suit aussi le thème de WhatsApp s’il est réglé sur « Défaut du système ».">
          <Segmented
            value={preferences.theme}
            options={[
              { value: "system", label: "Système" },
              { value: "light", label: "Clair" },
              { value: "dark", label: "Sombre" }
            ]}
            onChange={(theme) => setPreferences({ theme })}
          />
        </Row>
        <Row title="Barre latérale compacte">
          <Toggle label="Barre latérale compacte" checked={preferences.sidebarCollapsed} onChange={(sidebarCollapsed) => setPreferences({ sidebarCollapsed })} />
        </Row>
      </div>

  </>;
}

function FilesSection({ state }: { state: SettingsState }) {
  const preferences = state.preferences;
  return <><h2>Fichiers et liens</h2><p className="section-intro">Téléchargements et liens de conversation.</p>

      <div className="settings-group">
        <Row title="Demander où enregistrer les téléchargements" detail="Sinon, les fichiers sont enregistrés dans Téléchargements. Les fichiers existants sont conservés.">
          <Toggle label="Demander l’emplacement" checked={preferences.askDownloadLocation} onChange={(askDownloadLocation) => setPreferences({ askDownloadLocation })} />
        </Row>
        <Row title="Ouvrir les liens whatsapp:// avec cette application" detail="Les liens de conversation demandent alors avec quel compte les ouvrir. Sans effet dans la version Flatpak, où le bureau gère l’association.">
          <Toggle label="Liens whatsapp://" checked={preferences.handleWhatsappLinks} onChange={(handleWhatsappLinks) => setPreferences({ handleWhatsappLinks })} />
        </Row>
      </div>

  </>;
}

// --- Comptes ---------------------------------------------------------------------------

function AccountEditor({ account, state }: { account: AccountConfig; state: SettingsState }) {
  const [label, setLabel] = useState(account.label);
  useEffect(() => setLabel(account.label), [account.label]);

  const update = (patch: AccountPatch) => api.command({ type: "update-account", id: account.id, patch });
  const notifications = account.notifications;
  const setNotification = (key: keyof AccountConfig["notifications"], value: boolean) => update({ notifications: { [key]: value } });
  const memory = state.memory[account.id];

  return (
    <div>
      <div className="section-label">Identité</div>
      <div className="settings-group form-grid">
        <label className="field">
          <span>Nom</span>
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
          {!label.trim() && <small className="hint" id="account-name-error">Donnez un nom à ce compte.</small>}
        </label>
        <div className="field">
          <span>Icône</span>
          <AccountIconPicker value={account.icon ?? null} onChange={(icon) => update({ icon })} />
        </div>
        <div className="field">
          <span>Couleur</span>
          <Swatches value={account.color ?? DEFAULT_ACCOUNT_COLOR} onChange={(color) => update({ color })} />
        </div>
      </div>

      <div className="section-label">Notifications</div>
      <div className="settings-group">
        <Row title="Notifications activées">
          <Toggle label="Notifications activées" checked={notifications.enabled} onChange={(value) => setNotification("enabled", value)} />
        </Row>
        <Row title="Son">
          <Toggle label="Son" checked={notifications.sound} disabled={!notifications.enabled} onChange={(value) => setNotification("sound", value)} />
        </Row>
        <Row title="Aperçu du message" detail="Désactivé : « Nouveau message », utile pendant un partage d’écran.">
          <Toggle label="Aperçu du message" checked={notifications.showPreview} onChange={(value) => setNotification("showPreview", value)} />
        </Row>
        <Row title="Badge de non-lus">
          <Toggle label="Badge" checked={notifications.badge} onChange={(value) => setNotification("badge", value)} />
        </Row>
        <Row title="Compter dans le total">
          <Toggle label="Compter dans le total" checked={notifications.includeInTotal} onChange={(value) => setNotification("includeInTotal", value)} />
        </Row>
        <Row title="Garder le badge pendant un Snooze">
          <Toggle label="Badge pendant le Snooze" checked={notifications.badgeWhileSnoozed} onChange={(value) => setNotification("badgeWhileSnoozed", value)} />
        </Row>
      </div>

      <div className="section-label">Horaires et ressources</div>
      <div className="settings-group">
        <Row title="Horaire automatique" detail="Choisissez un horaire créé dans « Horaires ».">
          <select name="setting" className="select" value={account.scheduleId ?? ""} onChange={(event) => update({ scheduleId: event.target.value || null })}>
            <option value="">Aucun</option>
            {state.schedules.map((schedule) => (
              <option key={schedule.id} value={schedule.id}>
                {schedule.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Mise en veille automatique" detail={memory ? `Mémoire actuelle : ${memory} Mo` : "Jamais pendant un appel."}>
          <select name="setting"
            className="select"
            value={account.autoSleepAfterMinutes ? String(account.autoSleepAfterMinutes) : ""}
            onChange={(event) => update({ autoSleepAfterMinutes: event.target.value ? Number(event.target.value) : null })}
          >
            {AUTO_SLEEP.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="section-label">Session</div>
      <div className="settings-group">
        <div className="button-row">
          <button type="button" className="btn" onClick={() => api.command({ type: "reload-account", id: account.id })}>
            Recharger WhatsApp
          </button>
          <button type="button" className="btn" onClick={() => api.command({ type: "clear-cache", id: account.id })} title="La session est conservée">
            Vider le cache
          </button>
          <button type="button" className="btn btn-danger" onClick={() => api.command({ type: "request-remove-account", id: account.id })}>Supprimer le compte…</button>
        </div>
        <p className="hint" style={{ paddingBottom: 12, margin: 0 }}>
          La suppression efface la session de ce compte sur cet ordinateur. Retirez aussi l’appareil depuis le téléphone : WhatsApp → Appareils connectés.
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
      <h2>Comptes</h2>
      <p className="section-intro">Les modifications sont enregistrées automatiquement. L’ordre définit les raccourcis Ctrl+1…9.</p>
      {state.accounts.length === 0 ? (
        <p className="empty">Aucun compte pour l’instant. Ajoutez-en un depuis la fenêtre principale.</p>
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
                  <span className="rotate-up"><Icon name="collapse" /></span> Monter
                </button>
                <button type="button" className="btn btn-small" disabled={state.accounts.at(-1)?.id === account.id} onClick={() => moveAccount(state, account.id, 1)}>
                  <span className="rotate-down"><Icon name="expand" /></span> Descendre
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

const TEMPLATES: Array<{ label: string; build(): Schedule }> = [
  {
    label: "Heures de bureau (lun–ven 8 h–18 h)",
    build: () => ({
      id: crypto.randomUUID(),
      name: "Heures de bureau",
      defaultMode: "snoozed",
      rules: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", mode: "normal" }]
    })
  },
  {
    label: "Nuits calmes (22 h–8 h, appels seulement)",
    build: () => ({
      id: crypto.randomUUID(),
      name: "Nuits calmes",
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
          <span>Nom</span>
          <input name="name" className="input" maxLength={60} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label className="field">
          <span>Hors des plages ci-dessous</span>
          <select name="setting" className="select" value={draft.defaultMode} onChange={(event) => setDraft({ ...draft, defaultMode: event.target.value as Mode })}>
            {Object.entries(MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="section-label">Plages</div>
      <div className="settings-group">
        {draft.rules.length === 0 ? <p className="empty">Aucune plage : le mode ci-dessus s’applique en permanence.</p> : null}
        {draft.rules.map((rule, index) => (
          <div className="rule" key={index}>
            <div className="days">
              {DAYS.map((day, position) => {
                const iso = position + 1;
                const selected = rule.days.includes(iso);
                return (
                  <button
                    key={position}
                    type="button"
                    className={`day${selected ? " selected" : ""}`}
                    aria-pressed={selected}
                    aria-label={DAY_NAMES[position]}
                    title={DAY_NAMES[position]}
                    onClick={() => {
                      const days = selected ? rule.days.filter((candidate) => candidate !== iso) : [...rule.days, iso].sort();
                      if (days.length > 0) setRule(index, { ...rule, days });
                    }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            <input name="schedule-time" className="input" type="time" value={rule.start} onChange={(event) => setRule(index, { ...rule, start: event.target.value })} aria-label="Début" />
            <span className="arrow">→</span>
            <input name="schedule-time" className="input" type="time" value={rule.end} onChange={(event) => setRule(index, { ...rule, end: event.target.value })} aria-label="Fin" />
            <select name="setting" className="select" value={rule.mode} onChange={(event) => setRule(index, { ...rule, mode: event.target.value as Mode })} aria-label="Mode">
              {Object.entries(MODE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button type="button" className="icon-btn" aria-label="Supprimer la plage" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_rule, position) => position !== index) })}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        <div className="button-row">
          <button type="button" className="btn btn-small" onClick={() => setDraft({ ...draft, rules: [...draft.rules, { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", mode: "normal" }] })}>
            <Icon name="plus" /> Ajouter une plage
          </button>
        </div>
      </div>
      <p className="hint">Une plage dont la fin précède le début passe minuit. Si plusieurs plages se recouvrent, la plus silencieuse l’emporte.</p>
      <div className="button-row">
        <button type="button" className="btn btn-primary" disabled={!dirty || !draft.name.trim()} onClick={() => api.command({ type: "save-schedule", schedule: { ...draft, name: draft.name.trim() } })}>
          Enregistrer
        </button>
        <button type="button" className="btn btn-danger" onClick={() => api.command({ type: "request-delete-schedule", id: schedule.id })}>Supprimer l’horaire…</button>
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
      <h2>Horaires</h2>
      <p className="section-intro">Snooze automatique selon le jour et l’heure. Associez un horaire à un compte dans « Comptes ».</p>
      <div className="split">
        <div className="list" onKeyDown={navigationKeys}>
          {state.schedules.map((candidate) => (
            <button type="button" key={candidate.id} className={`list-item${candidate.id === schedule?.id ? " active" : ""}`} aria-current={candidate.id === schedule?.id ? "true" : undefined} title={candidate.name} onClick={() => setSelected(candidate.id)}>
              <Icon name="calendar" />
              <span>{candidate.name}</span>
            </button>
          ))}
          {TEMPLATES.map((template) => (
            <button type="button" key={template.label} className="btn btn-small btn-ghost" onClick={() => create(template.build())}>
              <Icon name="plus" /> {template.label}
            </button>
          ))}
        </div>
        {schedule ? <ScheduleEditor key={schedule.id} schedule={schedule} /> : <p className="empty">Choisissez un modèle pour créer votre premier horaire.</p>}
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
          <span>Nom</span>
          <input name="name" className="input" maxLength={60} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
      </div>
      <div className="section-label">Pendant ce Focus</div>
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
              <option value="">{draft.othersMode ? `Comme les autres comptes` : "Inchangé"}</option>
              {Object.entries(MODE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Row>
        ))}
        <Row title="Comptes non listés" detail="S’applique aussi aux comptes ajoutés plus tard.">
          <select name="setting"
            className="select"
            value={draft.othersMode ?? ""}
            onChange={(event) => {
              const { othersMode: _previous, ...rest } = draft;
              setDraft(event.target.value ? { ...rest, othersMode: event.target.value as Mode } : rest);
            }}
          >
            <option value="">Inchangés</option>
            {Object.entries(MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Row>
      </div>
      <div className="button-row">
        <button type="button" className="btn btn-primary" disabled={!dirty || !draft.name.trim()} onClick={() => api.command({ type: "save-focus-profile", profile: { ...draft, name: draft.name.trim() } })}>
          Enregistrer
        </button>
        <button type="button" className="btn" disabled={dirty && !active} title={dirty && !active ? "Enregistrez les modifications avant d’activer ce Focus" : undefined} onClick={() => api.command({ type: "activate-focus", profileId: active ? null : profile.id, minutes: null })}>
          {active ? "Désactiver" : "Activer maintenant"}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => api.command({ type: "request-delete-focus-profile", id: profile.id })}>Supprimer le Focus…</button>
      </div>
    </div>
  );
}

function FocusSection({ state }: { state: SettingsState }) {
  const [selected, setSelected] = useState<string | null>(null);
  const profile = state.focus.profiles.find((candidate) => candidate.id === selected) ?? state.focus.profiles[0];
  const create = () => {
    const created: FocusProfile = { id: crypto.randomUUID(), name: `Focus ${state.focus.profiles.length + 1}`, modes: {}, othersMode: "snoozed" };
    api.command({ type: "save-focus-profile", profile: created });
    setSelected(created.id);
  };
  return (
    <>
      <h2>Focus</h2>
      <p className="section-intro">Choisissez les comptes qui peuvent vous interrompre. Un Snooze manuel reste prioritaire.</p>
      <div className="split">
        <div className="list" onKeyDown={navigationKeys}>
          {state.focus.profiles.map((candidate) => (
            <button type="button" key={candidate.id} className={`list-item${candidate.id === profile?.id ? " active" : ""}`} aria-current={candidate.id === profile?.id ? "true" : undefined} title={candidate.name} onClick={() => setSelected(candidate.id)}>
              <Icon name="target" />
              <span>
                {candidate.name}
                {state.focus.active?.profileId === candidate.id ? " · actif" : ""}
              </span>
            </button>
          ))}
          <button type="button" className="btn btn-small btn-ghost" onClick={create}>
            <Icon name="plus" /> Nouveau Focus
          </button>
        </div>
        {profile ? <FocusEditor key={profile.id} profile={profile} state={state} /> : <p className="empty">Créez un Focus, par exemple « Réunion » ou « Soirée ».</p>}
      </div>
    </>
  );
}

// --- À propos --------------------------------------------------------------------------

function AboutSection({ state }: { state: SettingsState }) {
  return (
    <>
      <h2>À propos</h2>
      <p className="section-intro">{state.disclaimer}</p>
      <div className="section-label">Version</div>
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
      <div className="section-label">Vie privée</div>
      <div className="settings-group">
        <ul className="steps" style={{ padding: "12px 0 12px 20px" }}>
          <li>Aucun serveur, aucune statistique, aucun suivi.</li>
          <li>Les messages restent dans WhatsApp Web ; l’application n’en stocke ni n’en journalise le contenu.</li>
          <li>Les sessions de chaque compte sont isolées dans leur propre dossier, accessible à votre seul utilisateur.</li>
        </ul>
      </div>
      <div className="section-label">Diagnostic</div>
      <div className="settings-group">
        <dl className="kv">
          <dt>Données</dt>
          <dd>{state.paths.userData}</dd>
          <dt>Journaux</dt>
          <dd>{state.paths.logs}</dd>
        </dl>
        <div className="button-row">
          <button type="button" className="btn btn-small" onClick={() => api.command({ type: "open-logs" })}>
            Ouvrir le dossier des journaux
          </button>
        </div>
      </div>
    </>
  );
}

// --- Fenêtre -------------------------------------------------------------------------------

const SECTIONS: Array<{ id: Section; label: string; icon: Parameters<typeof Icon>[0]["name"] }> = [
  { id: "general", label: "Général", icon: "sliders" },
  { id: "appearance", label: "Apparence", icon: "moon" },
  { id: "accounts", label: "Comptes", icon: "user" },
  { id: "schedules", label: "Horaires", icon: "calendar" },
  { id: "focus", label: "Focus", icon: "target" },
  { id: "files", label: "Fichiers et liens", icon: "chat" },
  { id: "about", label: "À propos", icon: "info" }
];

function SettingsApp() {
  const state = useSettingsState();
  const [section, setSection] = useState<Section>("general");
  useEffect(() => {
    if (state?.navigationRequest) setSection(state.navigationRequest.section);
  }, [state?.navigationRequest?.sequence]);
  if (!state) return null;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Sections" onKeyDown={navigationKeys}>
        <h1>
          <img src={logo} alt="" /> Paramètres
        </h1>
        {SECTIONS.map((item) => (
          <button type="button" key={item.id} className={`nav-item${section === item.id ? " active" : ""}`} onClick={() => setSection(item.id)} aria-current={section === item.id ? "page" : undefined}>
            <Icon name={item.icon} />
            {item.label}
          </button>
        ))}
      </nav>
      <main className="settings-main" key={section}>
        {Boolean(state.notices?.length) && <div className="settings-notices" aria-live="polite">
          {state.notices?.map((notice) => <div key={notice.id} className={`notice ${notice.level}`}><p>{notice.message}</p>
            <button type="button" className="icon-btn" aria-label="Fermer l’information" title="Fermer" onClick={() => api.command({ type: "dismiss-notice", id: notice.id })}><Icon name="close" /></button>
          </div>)}
        </div>}
        {section === "appearance" && <AppearanceSection state={state} />}
        {section === "files" && <FilesSection state={state} />}
        {section === "general" && <GeneralSection state={state} />}
        {section === "accounts" && <AccountsSection state={state} />}
        {section === "schedules" && <SchedulesSection state={state} />}
        {section === "focus" && <FocusSection state={state} />}
        {section === "about" && <AboutSection state={state} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>
);
