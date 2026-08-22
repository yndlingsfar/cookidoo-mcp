/** HTML-Escaping gegen XSS über bösartige Client-Metadaten. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function loginPageHtml(input: {
  txn: string;
  clientName: string;
  redirectTarget: string;
}): string {
  const txn = escapeHtml(input.txn);
  const clientName = escapeHtml(input.clientName);
  const target = escapeHtml(input.redirectTarget);
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Cookidoo-MCP Login</title></head>
<body style="font-family: sans-serif; max-width: 28rem; margin: 4rem auto; line-height: 1.5;">
  <h2>🔐 Cookidoo-MCP</h2>
  <p>Eine Anwendung möchte Zugriff auf deinen Cookidoo-Account:</p>
  <ul style="background: #f4f4f4; padding: 1rem 1.5rem; border-radius: .5rem; list-style: none;">
    <li><strong>Anwendung:</strong> ${clientName}</li>
    <li style="margin-top: .5rem;"><strong>Weiterleitung nach:</strong><br><code style="word-break: break-all;">${target}</code></li>
  </ul>
  <p style="color: #b00020;">⚠️ Gib die Passphrase <strong>nur</strong> ein, wenn du diesen Login gerade
  <strong>selbst</strong> gestartet hast. Kennst du Anwendung oder Ziel nicht — schließe diese Seite.</p>
  <form method="post" action="/login">
    <input type="hidden" name="txn" value="${txn}">
    <input type="password" name="phrase" autofocus style="width: 100%; padding: .5rem;">
    <button type="submit" style="margin-top: 1rem; padding: .5rem 1.5rem;">Erlauben</button>
  </form>
</body></html>`;
}
