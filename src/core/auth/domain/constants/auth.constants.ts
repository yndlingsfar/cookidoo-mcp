/** Token- und Session-Lebensdauern sowie Missbrauchs-Limits des Türstehers. */
export const ACCESS_TTL_S = 3600; // Access-Token: 1 Stunde
export const REFRESH_TTL_S = 30 * 24 * 3600; // Refresh-Token: 30 Tage
export const CODE_TTL_S = 300; // Authorization-Code: 5 Minuten
export const LOGIN_TTL_S = 600; // offener Login-Vorgang: 10 Minuten

export const MAX_LOGIN_FAILURES = 5; // Fehlversuche pro IP...
export const LOGIN_FAILURE_WINDOW_S = 300; // ...in diesem Fenster -> Sperre
export const LOGIN_DELAY_MS = 1000; // künstliche Bremse pro Fehlversuch

export const MAX_OPEN_LOGINS = 500; // gleichzeitig offene Logins (RAM)
export const MAX_CLIENTS = 200; // gespeicherte Clients (Disk)

export const DEFAULT_SCOPES = ['cookidoo'];
