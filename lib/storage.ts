// Device-local settings only. Accounts now live in the server-side vault (see lib/vault-client),
// so they sync across devices; UI preferences like auto-refresh stay per-device here.

const SETTINGS_KEY = "usage.settings.v1";
const MAX_SETTINGS_BYTES = 4 * 1024;

export interface LocalNotificationSettings {
  remainingWarnings: boolean;
  resetNotifications: boolean;
}

export interface Settings {
  autoRefresh: boolean;
  localNotifications: LocalNotificationSettings;
}

const DEFAULT_SETTINGS: Settings = {
  autoRefresh: true,
  localNotifications: { remainingWarnings: true, resetNotifications: true },
};

function defaultSettings(): Settings {
  return {
    autoRefresh: DEFAULT_SETTINGS.autoRefresh,
    localNotifications: { ...DEFAULT_SETTINGS.localNotifications },
  };
}

export function loadSettings(): Settings {
  if (typeof window === "undefined") return defaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw || new TextEncoder().encode(raw).byteLength > MAX_SETTINGS_BYTES) return defaultSettings();

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultSettings();

    const candidate = parsed as {
      autoRefresh?: unknown;
      localNotifications?: unknown;
    };
    const localCandidate =
      candidate.localNotifications &&
      typeof candidate.localNotifications === "object" &&
      !Array.isArray(candidate.localNotifications)
        ? candidate.localNotifications as Partial<Record<keyof LocalNotificationSettings, unknown>>
        : {};
    return {
      autoRefresh:
        typeof candidate.autoRefresh === "boolean"
          ? candidate.autoRefresh
          : DEFAULT_SETTINGS.autoRefresh,
      localNotifications: {
        remainingWarnings:
          typeof localCandidate.remainingWarnings === "boolean"
            ? localCandidate.remainingWarnings
            : DEFAULT_SETTINGS.localNotifications.remainingWarnings,
        resetNotifications:
          typeof localCandidate.resetNotifications === "boolean"
            ? localCandidate.resetNotifications
            : DEFAULT_SETTINGS.localNotifications.resetNotifications,
      },
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: Settings): boolean {
  if (typeof window === "undefined") return true;
  try {
    if (
      typeof settings.autoRefresh !== "boolean" ||
      typeof settings.localNotifications?.remainingWarnings !== "boolean" ||
      typeof settings.localNotifications?.resetNotifications !== "boolean"
    ) return false;
    const canonical =
      `{"autoRefresh":${settings.autoRefresh},"localNotifications":` +
      `{"remainingWarnings":${settings.localNotifications.remainingWarnings},` +
      `"resetNotifications":${settings.localNotifications.resetNotifications}}}`;
    window.localStorage.setItem(SETTINGS_KEY, canonical);
    return true;
  } catch {
    return false;
  }
}
