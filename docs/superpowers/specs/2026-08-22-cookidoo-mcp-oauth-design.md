# Design: OAuth-Türsteher für den Cookidoo-MCP

**Datum:** 2026-08-22
**Status:** Entwurf zur Review
**Autor:** Daniel Steiner (mit Claude Code)
**Fork:** https://github.com/yndlingsfar/cookidoo-mcp (upstream: sisques-labs/cookidoo-mcp)

## 1. Ziel & Kontext

Der Cookidoo-MCP (`POST /api/mcp`, NestJS + `@modelcontextprotocol/sdk`) soll
öffentlich über einen Cloudflare-Tunnel als **Custom Connector auf claude.ai**
nutzbar sein — analog zum bereits betriebenen `ynab-mcp`.

**Das Problem:** Upstream hat *keine* Authentifizierung auf dem MCP-Endpunkt
(Code-Kommentar: „there is no per-request auth to enforce here"). Die
Cookidoo-Zugangsdaten liegen serverseitig; wer die öffentliche URL kennt, kann
über 40+ Tools den Cookidoo-Account des Betreibers steuern (Einkaufsliste,
Wochenplan, Rezepte — lesend **und** schreibend).

**Die Lösung:** Ein OAuth-2.0-Türsteher vor `/api/mcp`, portiert aus dem
bewährten YNAB-Modell (`ynab-mcp/auth.py`). claude.ai-Connectoren sprechen
OAuth 2.0 mit Dynamic Client Registration (DCR) + PKCE; genau das liefert der
Türsteher, geschützt durch eine Passphrase-Login-Seite.

### Nicht-Ziele (YAGNI)

- Kein Multi-User/Mandantenfähigkeit — ein Server = ein Cookidoo-Account
  (wie Upstream und wie YNAB).
- Keine Änderung an den bestehenden Tools, CQRS-Handlern oder dem
  Cookidoo-HTTP-Client. Der Auth-Code ist rein additiv.
- Kein Cloudflare Access — für den claude.ai-Web-Connector untauglich
  (Connector kann den Access-Login im OAuth-Flow nicht durchlaufen).
- Kein Auth-Gateway-Sidecar — bewusst verworfen zugunsten eines einzelnen
  Deployables (siehe Entscheidungen).

## 2. Entscheidungen (bereits abgestimmt)

| Frage | Entscheidung |
|---|---|
| Client | claude.ai Web-Connector → voller OAuth-Server (DCR+PKCE) nötig |
| Ansatz | **A** — Fork mit In-App-OAuth (nicht Sidecar, nicht Cloudflare Access) |
| Fork-Ort | GitHub-Fork `yndlingsfar/cookidoo-mcp`, lokal in `~/Projects/cookidoo-mcp` |
| Cookidoo-Markt | Deutschland: `de` / `de-DE` / `https://cookidoo.de/foundation/de-DE` |
| Cloudflare | Bestehenden Tunnel wiederverwenden (neuer Public Hostname), kein zweiter cloudflared-Container |

## 3. Architektur

### 3.1 Portierung YNAB → Cookidoo

Das Python- und das TypeScript-MCP-SDK bieten dieselbe Auth-Struktur: Das SDK
bringt die OAuth-Protokoll-Endpunkte mit; wir implementieren nur den *Provider*
(Token-Speicher + Antworten auf die „Türsteher-Fragen") und die *Login-Seite*.

| YNAB (Python, `auth.py`) | Cookidoo (TypeScript, neu) |
|---|---|
| `mcp` SDK OAuth-Endpunkte (`/authorize`, `/token`, `/register`, Discovery) | `mcpAuthRouter` aus `@modelcontextprotocol/sdk/server/auth/router.js` |
| `YnabAuthProvider(OAuthAuthorizationServerProvider)` | `CookidooAuthProvider implements OAuthServerProvider` |
| `Ablage` (`auth_store.json`, atomar, chmod 600) | `TokenStore`-Service (gleiche Semantik, `/data`-Volume) |
| `/login` Passphrase-Seite + `/login` POST-Prüfung | Login-Handler (GET zeigt Consent-Formular, POST prüft Passphrase) |
| `load_access_token` bei jedem Request | `BearerAuthGuard` vor `McpController` (nutzt `provider.verifyAccessToken`) |

### 3.2 Integration in NestJS

Der MCP-Endpunkt ist ein NestJS-Controller (`@Controller('mcp')`, Global-Prefix
`api`). Die OAuth-Endpunkte des SDK sind Express-Router. Wiring:

1. In `main.ts` das rohe Express-Instance holen:
   `const expressApp = app.getHttpAdapter().getInstance();`
2. Den `mcpAuthRouter` (issuer = `MCP_PUBLIC_URL`) und die Login-Routen
   (`GET /login`, `POST /login`) darauf mounten — **vor** `app.listen`.
   Diese Endpunkte liegen auf Root-Ebene (nicht unter `/api`), passend zu den
   Discovery-Metadaten, die der SDK unter
   `/.well-known/oauth-authorization-server` und
   `/.well-known/oauth-protected-resource` ausliefert.
3. `McpController.handleRequest` mit `@UseGuards(BearerAuthGuard)` schützen.
   Der Guard liest den `Authorization: Bearer …`-Header, ruft
   `provider.verifyAccessToken(token)` und antwortet bei Fehlen/Ungültigkeit
   mit `401` + `WWW-Authenticate: Bearer resource_metadata="…"` (wie vom
   MCP-Auth-Spec verlangt, damit der Connector die Discovery findet).
4. `GET /api/health` und alle OAuth-/Login-Endpunkte bleiben **ungeschützt**.

**Warum SDK-Router statt Handrolling:** Der heikle Protokoll-Teil (DCR, PKCE,
Code/Token-Tausch, Metadaten-Discovery) kommt geprüft aus dem SDK. Wir schreiben
nur Speicher + Login — exakt der Umfang von `auth.py`.

### 3.3 Komponenten (neues Modul `src/core/auth/`)

Passend zur DDD-Struktur des Repos:

```
src/core/auth/
  auth.module.ts                         # bindet Provider, Store, Guard, Login-Controller
  application/
    services/
      token-store.service.ts             # JSON-Ablage, atomar, chmod 600
      token-store.service.spec.ts
      cookidoo-auth.provider.ts          # implements OAuthServerProvider
      cookidoo-auth.provider.spec.ts
      login-rate-limiter.service.ts      # Bruteforce-Bremse pro IP
  domain/
    constants/auth.constants.ts          # Lebensdauern, Caps, Limits
  transport/
    guards/bearer-auth.guard.ts          # schützt /api/mcp
    rest/login.controller.ts             # GET/POST /login (Consent + Passphrase)
    rest/login.templates.ts              # HTML-Formular (HTML-escaped)
  auth.wiring.ts                         # mountet mcpAuthRouter + Login auf Express
```

`env.validation.ts` wird um die neuen Variablen erweitert (optional, aber wenn
eine gesetzt ist, müssen alle für den Auth-Modus gesetzt sein).

## 4. Konfiguration (neue Env-Vars)

Analog zum YNAB-Schalter: Auth ist **nur aktiv**, wenn `MCP_PUBLIC_URL` **und**
`MCP_LOGIN_SECRET` gesetzt sind. Ohne sie startet der Server wie bisher ohne
Auth (lokale Entwicklung/stdio-artige Nutzung bleibt möglich).

| Variable | Pflicht (Auth-Modus) | Beschreibung |
|---|---|---|
| `MCP_LOGIN_SECRET` | ja | Passphrase der Login-Seite. Lang & zufällig (`openssl rand -base64 32`). |
| `MCP_PUBLIC_URL` | ja | Öffentliche Basis-URL mit `https://`, ohne Trailing-Slash. Issuer der OAuth-Metadaten. |
| `MCP_DATA_DIR` | nein (Default `/data`) | Verzeichnis für `auth_store.json`. Als Volume mounten (Verzeichnis, nie die Datei — atomarer `rename`). |
| `MCP_TRUST_PROXY` | nein (Default `true` im Container) | Express `trust proxy`, damit `X-Forwarded-For` hinter cloudflared korrekt ausgewertet wird. |

Bestehende (unverändert): `COOKIDOO_EMAIL`, `COOKIDOO_PASSWORD`,
`COOKIDOO_COUNTRY_CODE=de`, `COOKIDOO_LANGUAGE=de-DE`,
`COOKIDOO_URL=https://cookidoo.de/foundation/de-DE`, `COOKIDOO_COOKIE_FILE`
(empfohlen: `/data/.cookidoo-session.json` zur Session-Persistenz), `PORT=3000`.

## 5. Sicherheits-Parität (übernommen aus `auth.py`)

Jede Härtung aus dem YNAB-Review wird portiert:

- **Atomare Store-Writes**: erst `*.tmp` schreiben, `chmod 600`, dann `rename`
  (atomar) → kein Crash-Loop durch halb geschriebene Datei.
- **Korruptions-Schutz**: unlesbare `auth_store.json` beiseitelegen
  (`.json.kaputt`) und leer starten, statt beim Boot zu sterben.
- **Constant-time-Vergleich** der Passphrase (`crypto.timingSafeEqual`).
- **Bruteforce-Bremse**: max. 5 Fehlversuche / 5 min / IP → `429`; künstliche
  Verzögerung (~1 s) pro Fehlversuch; Vorgang nach Überschreitung verbrennen.
- **IP-Ermittlung** hinter Proxy: letzte Adresse aus `X-Forwarded-For`
  (cloudflared/Express `trust proxy`), nicht die (fälschbare) erste.
- **Consent-/Anti-Phishing-Seite**: zeigt Client-Name + Redirect-Ziel,
  **HTML-escaped** (kein XSS über bösartige Client-Metadaten), mit Warnhinweis.
- **Caps gegen unbegrenztes Wachstum**: `MAX_CLIENTS` (DCR-Flut), alte Clients
  ohne aktive Tokens werden verdrängt; `MAX_OFFENE_LOGINS` (RAM-DoS).
- **Token-Lebensdauern**: Access 1 h, Refresh 30 Tage (rotiert bei Nutzung),
  Auth-Code 5 min, offener Login 10 min.
- **Dateirechte**: Store nur für Owner lesbar (`chmod 600`).

## 6. Deployment

### 6.1 `docker-compose.yml` (neu, im Repo-Root des Forks)

```yaml
services:
  cookidoo-mcp:
    build: .
    image: cookidoo-mcp:latest
    container_name: cookidoo-mcp
    env_file: .env
    volumes:
      - ~/cookidoo-mcp-data:/data      # auth_store.json + .cookidoo-session.json
    restart: unless-stopped
    networks:
      - proxy                          # dasselbe externe Netz wie ynab-mcp + cloudflared
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

networks:
  proxy:
    external: true
```

**Kein Host-Port-Publish** — cloudflared erreicht den Container direkt über das
`proxy`-Netz (`http://cookidoo-mcp:3000`). Weniger Angriffsfläche als YNABs
`127.0.0.1:8000`-Bind. (Optional für lokales Debugging temporär
`127.0.0.1:8001:3000` ergänzen.)

### 6.2 Cloudflare-Tunnel (bestehenden wiederverwenden)

Der vorhandene cloudflared-Container (aktuell `cloudflared-ynab`) hängt bereits
im `proxy`-Netz und kann einen zweiten Hostname bedienen. Schritte:

1. Zero Trust → Networks → Tunnels → *bestehender Tunnel* → Public Hostname
   hinzufügen: `cookidoo-mcp.<deine-domain>` → Service `http://cookidoo-mcp:3000`.
2. `cookidoo-mcp` dem `proxy`-Netz beitreten (via Compose oben) → Container-DNS
   `cookidoo-mcp` ist für cloudflared auflösbar.
3. `MCP_PUBLIC_URL=https://cookidoo-mcp.<deine-domain>` in die `.env` eintragen.

Kein zweiter cloudflared-Container, kein neuer Tunnel-Token nötig.

### 6.3 `.env.example` erweitern

Um die Auth-Variablen (Abschnitt 4) plus deutschen Markt als Default-Beispiel.
`.env` bleibt in `.gitignore` (bereits vorhanden), niemals committen.

## 7. Teststrategie

Jest + supertest sind vorhanden. Neue Tests (spiegeln
`ynab-mcp/test_oauth.py`, `test_consent.py`, `test_bruteforce.py`,
`test_dos.py`):

- **Unit — `TokenStore`**: atomarer Write, `chmod 600`, korrupte Datei →
  beiseitelegen + leer starten, Ablauf-Cleanup.
- **Unit — `CookidooAuthProvider`**: register/get client, authorize→txn,
  code-exchange, refresh-Rotation, verifyAccessToken (gültig/abgelaufen),
  Caps (`MAX_CLIENTS`/`MAX_OFFENE_LOGINS`).
- **Unit — Rate-Limiter**: Sperre nach 5 Fehlversuchen, Fenster-Reset.
- **e2e**: `POST /api/mcp` ohne Token → `401` + `WWW-Authenticate`; voller Flow
  Register→Authorize→Login(Passphrase)→Code→Token→`/api/mcp` erfolgreich;
  falsche Passphrase → `403`; Bruteforce → `429`; Consent-HTML escaped;
  `/api/health` ohne Auth → `200`.
- **Regression**: bestehende Tests bleiben grün; ohne `MCP_*`-Vars kein
  Auth-Zwang (Backward-Compat).

## 8. Umsetzungsreihenfolge (grob, Detaillierung im Plan)

1. `auth.constants.ts` + Env-Validierung erweitern.
2. `TokenStore` (+ Tests) — reine Persistenz, keine Abhängigkeiten.
3. `CookidooAuthProvider` (+ Tests) — nutzt TokenStore.
4. Login-Controller + Templates + Rate-Limiter (+ Tests).
5. `BearerAuthGuard` + `auth.wiring.ts`; Einhängen in `main.ts` und
   `McpController`.
6. e2e-Auth-Flow-Test grün.
7. `docker-compose.yml`, `.env.example`, README-Abschnitt „Betrieb mit Auth".
8. Deploy auf Portainer + Cloudflare-Hostname + claude.ai-Connector-Test.

## 9. Risiken & offene Punkte

- **SDK-Auth-API-Details**: exakte Signaturen von `OAuthServerProvider` /
  `mcpAuthRouter` in `@modelcontextprotocol/sdk@1.29` werden zu Beginn der
  Umsetzung gegen die installierten Typen verifiziert (Context7/Quellcode),
  bevor der Provider geschrieben wird.
- **claude.ai-Connector-Flow**: neuere Connectoren verlangen die
  `oauth-protected-resource`-Metadaten; der `WWW-Authenticate`-Header muss
  korrekt darauf zeigen. Wird im e2e-Test und beim echten Connector-Test
  abgesichert.
- **Cookidoo-Login inoffiziell**: der Upstream-Client scraped den
  Cookidoo-OAuth2-Cookie-Flow — kann bei Cookidoo-Änderungen brechen. Nicht
  Teil dieses Designs, aber Betriebsrisiko; `COOKIDOO_DEBUG=true` hilft.
- **Vollzugangsdaten in `.env`**: E-Mail + echtes Passwort liegen im Klartext
  auf dem Server (nicht scoped wie ein API-Token). `.env` nur auf dem Server,
  Dateirechte prüfen, niemals committen.
