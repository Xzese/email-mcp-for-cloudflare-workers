# Email MCP Server for Cloudflare Workers

A container-free remote MCP server for Gmail, Outlook, iCloud, and custom IMAP/SMTP accounts.

The Worker connects directly to IMAP and SMTP using Cloudflare outbound TCP sockets. Mailbox credentials are AES-256-GCM encrypted before being stored in Workers KV.

## Public source, private deployments

This repository publishes the server source under the MIT License. It does not provide a shared,
publicly accessible email service. Every operator deploys their own Worker, KV namespace,
Cloudflare Access application, Microsoft Entra application, and secrets.

All configured mailboxes share one encrypted account store within a deployment. The server is
therefore intended for one owner or a small group of mutually trusted users. Do not grant
Cloudflare Access to unrelated tenants or users who should not share mailbox access.

The checked-in `wrangler.toml` is a sanitized example. For a local or manually initiated
deployment, copy it to the ignored production configuration and replace every placeholder with
identifiers from your own accounts:

```bash
cp wrangler.toml wrangler.production.toml
```

Never commit `wrangler.production.toml`, `.dev.vars`, private keys, certificates, Worker secrets,
mailbox credentials, or OAuth client secrets.

For repository-connected Cloudflare builds, do not commit or upload
`wrangler.production.toml`. The build generates an ignored `wrangler.generated.json` containing
the real KV binding while preserving the runtime variables and secrets already configured in the
Cloudflare dashboard. See [Cloudflare repository builds](#cloudflare-repository-builds).

## Tools

- `email_add_account`, `email_list_accounts`, `email_remove_account`
- `email_test_connection`
- `email_list_folders`, `email_get_mailbox_status`, `email_get_all_account_mailbox_statuses`
- `email_search_messages`, `email_search_all_accounts`, `email_list_all_inbox_messages`, `email_get_message`, `email_get_message_thread`, `email_get_message_attachment`
- `email_update_message_flags`, `email_move_messages`, `email_archive_messages`, `email_move_messages_to_trash`, `email_delete_messages_permanently`
- `email_create_message_draft`, `email_create_forward_draft`, `email_update_message_draft`, `email_send_draft`

Every tool publishes an MCP output schema and returns validated `structuredContent`. A JSON text
copy is also returned for compatibility with clients that do not yet consume structured output.

## Local setup

Create `.dev.vars`:

```dotenv
CREDENTIAL_ENCRYPTION_KEY=base64-encoded-32-byte-key
ACCESS_LOCAL_DEV=true
```

Generate the encryption key with:

```bash
openssl rand -base64 32
```

Then run:

```bash
npm install
npm run dev
```

Connect an MCP client to `http://localhost:8787/mcp`.

`ACCESS_LOCAL_DEV` bypasses Access verification only when the request hostname is `localhost`,
`127.0.0.1`, or `::1`. Never configure it as a production Worker variable or secret.

MCP tool calls emit structured events to Cloudflare Workers Logs with the tool name, status,
duration, and a safe error category. Tool arguments, upstream error text, credentials, and email
content are not logged.
View production events under **Workers & Pages → email-mcp-server → Observability** or stream
local/deployed events with `npx wrangler tail`.

In VS Code, open **Run and Debug**, select **Email MCP: Local server**, and click Run (or
press F5). Wrangler loads the same `.dev.vars` file automatically in the integrated terminal.

## Cloudflare Access

Production authentication is handled by a Cloudflare Access self-hosted application with
Managed OAuth. The Worker also verifies every `Cf-Access-Jwt-Assertion` signature, issuer, and
audience before routing a request.

1. Deploy the Worker once to obtain its `*.workers.dev` hostname. Until Access is configured,
   the placeholder issuer and audience make the Worker fail closed.
2. In **Zero Trust → Access controls → Applications**, create a **Self-hosted and private**
   application for the Worker hostname.
3. Add an Allow policy restricted to your email or identity group. This server uses one shared
   encrypted account store, so do not authorize unrelated users.
4. Configure one-time PIN or an identity provider. Enable MFA at the identity provider or in
   the Access policy where appropriate.
5. Under the application's advanced settings, enable **Managed OAuth**. Configure only the
   redirect URIs required by your MCP clients; enable localhost or loopback redirects only when
   needed for local clients such as MCP Inspector.
6. Copy the application **AUD** tag and your Zero Trust team domain into the ignored
   `wrangler.production.toml`:

```toml
[vars]
TEAM_DOMAIN = "https://your-team.cloudflareaccess.com"
POLICY_AUD = "your-access-application-aud-tag"
OUTLOOK_CLIENT_ID = "your-microsoft-entra-application-client-id"
OUTLOOK_TENANT = "consumers"
```

See Cloudflare's [Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
and [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
guides for the current dashboard and redirect-URI configuration.

## Microsoft Entra app registration for Outlook

Outlook.com, Hotmail, Live, and Microsoft 365 accounts use interactive Microsoft OAuth. The
Microsoft account that owns the app registration does not need to be the mailbox account. Each
mailbox owner signs in and grants the app access when **Outlook** is selected in the account form.

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open **Entra ID → App
   registrations → New registration**.
2. Enter any name and choose the supported account type:
    - For Outlook.com, Hotmail, and Live accounts only, choose **Personal Microsoft accounts only**.
    - To support both personal and work/school accounts, choose **Accounts in any organizational
      directory and personal Microsoft accounts**.
3. After registering, copy **Application (client) ID** from **Overview**. Do not use the object ID,
   client-secret ID, or client-secret value as `OUTLOOK_CLIENT_ID`.
4. Open **Authentication → Add a platform → Web** and add every callback URL from which the flow
   will be started. The path and port must match exactly:

    ```text
    https://<worker>.<subdomain>.workers.dev/oauth/outlook/callback
    http://localhost:8787/oauth/outlook/callback
    ```

    The localhost entry is only needed for local development. Add another localhost URL if Wrangler
    runs on a different port. Leave both implicit grant checkboxes clear and leave **Allow public
    client flows** disabled; this server uses the authorization-code flow with PKCE.

5. Open **API permissions → Add a permission → APIs my organization uses → Office 365 Exchange
   Online → Delegated permissions**, then add:
    - `IMAP.AccessAsUser.All`
    - `SMTP.Send`

    The Worker also requests `openid`, `profile`, `email`, and `offline_access` during sign-in.
    Organizational policies may require an administrator to grant consent; personal accounts can
    normally grant consent interactively.

6. Open **Certificates & secrets → Client secrets → New client secret**. Copy the secret's
   **Value** immediately. Microsoft only displays it once. Do not copy the **Secret ID**.

Set the application client ID and appropriate Microsoft sign-in tenant in
`wrangler.production.toml`:

```toml
[vars]
OUTLOOK_CLIENT_ID = "your-application-client-id"
OUTLOOK_TENANT = "consumers"
```

Use `"consumers"` for personal Microsoft accounts, `"organizations"` for work/school accounts,
`"common"` for both, or a specific tenant ID for one organization. The app registration's
supported account type must allow the value selected here.

For local development, put the client-secret **Value** in `.dev.vars`:

```dotenv
OUTLOOK_CLIENT_SECRET="your-client-secret-value"
```

For production, install it as a Worker secret instead of placing it in the TOML configuration:

```bash
printf '%s' 'your-client-secret-value' | npx wrangler secret put OUTLOOK_CLIENT_SECRET --config wrangler.production.toml
```

Common configuration errors:

- `unauthorized_client` or “not enabled for consumers” means the app's supported account type does
  not allow personal accounts, or `OUTLOOK_CLIENT_ID` is not the Application (client) ID.
- `AADSTS50011` means the callback URL does not exactly match a configured **Web** redirect URI.
- `invalid_client` during the callback usually means the secret is expired or the Secret ID was
  supplied instead of the secret Value.

See Microsoft's documentation for [registering an
application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app),
[redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri),
[client credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials),
and [OAuth for IMAP and
SMTP](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth).

## Production secret and deployment

Create and fill `wrangler.production.toml` as described above. The public example intentionally
cannot be deployed until its placeholder KV namespace and Access values are replaced.

For an existing deployment, first confirm the required secrets are present:

```bash
npx wrangler secret list --config wrangler.production.toml
```

Do not replace an existing `CREDENTIAL_ENCRYPTION_KEY`; existing encrypted account records depend
on it. For a brand-new deployment with no stored accounts, generate and install the key without
writing it to disk:

```bash
CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"
printf '%s' "$CREDENTIAL_ENCRYPTION_KEY" | npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY --config wrangler.production.toml
unset CREDENTIAL_ENCRYPTION_KEY
```

Deploy after updating the Access variables:

```bash
npm run deploy
```

The production MCP endpoint is `https://<worker>.<subdomain>.workers.dev/mcp`.

Open `https://<worker>.<subdomain>.workers.dev/` to manage email accounts through the
Access-protected web interface. Credentials submitted there go directly from the browser to the
Worker and do not pass through an MCP client or language model.

## Cloudflare repository builds

Cloudflare only receives files committed to the connected Git repository, so it cannot read the
ignored local `wrangler.production.toml`. Configure the existing Worker as follows:

1. Keep these runtime values under **Settings → Variables and Secrets**:
    - Plaintext: `OUTLOOK_CLIENT_ID`, `OUTLOOK_TENANT`, `POLICY_AUD`, and `TEAM_DOMAIN`.
    - Secret: `CREDENTIAL_ENCRYPTION_KEY` and `OUTLOOK_CLIENT_SECRET`.
2. Under **Settings → Build → Variables and Secrets**, add a build environment variable named
   `EMAIL_KV_NAMESPACE_ID`, set it to the existing `EMAIL_KV` namespace ID, and enable
   **Encrypt**. Runtime variables from step 1 are not available to repository build commands.
3. Set the deploy command to `npm run cloudflare:upload` for the first verification build. This
   creates a version without promoting it to the active deployment.
4. After verifying the uploaded version, change the deploy command to
   `npm run cloudflare:deploy` to deploy successful `main` builds automatically.

The repository includes `.node-version`, so Cloudflare uses the supported Node version without a
separate build variable. The generated configuration sets `keep_vars: true`, omits `vars`, and
declares the required secret names without supplying or replacing their values. It is written
with owner-only file permissions and ignored by Git.

Do not replace `CREDENTIAL_ENCRYPTION_KEY` on an existing deployment. Existing encrypted account
records can only be read with the key that encrypted them.

## Account settings

Prefer the web management interface at the Worker root to add, edit, or remove accounts. Editing
can change the display name, email address, IMAP/SMTP hosts, ports, and TLS modes without replacing
the stored password or OAuth tokens. The `email_add_account` tool remains available for clients
that explicitly need programmatic setup.
Each configured account also has a **Test connection** action that authenticates with its stored
credentials and reports the connection result without exposing those credentials to the browser.

Use the exact folder path returned by `email_list_folders`. Search results default to newest
first; set `sortOrder` to `oldest` for chronological order. Results include their folder path;
pass that folder and IMAP UID to `email_get_message` or mutation tools.

`email_search_messages` returns a structured result with `status`, `outcome`, `count`, `total`, `empty`,
`messages`, and an opaque `nextCursor` when another page is available. Pass `nextCursor` back as
`cursor` with otherwise identical search criteria. An `outcome` of `no_matches` explicitly means
the IMAP search completed successfully with zero matching messages; it does not indicate a
connection or folder error.

`email_list_all_inbox_messages` lists message summaries from `INBOX` across all configured accounts,
or the supplied `accountIds`, without requiring search filters. `email_search_all_accounts` applies the
same summary shape with optional filters across `INBOX` by default or another supplied folder. Both
return a flat message list with account identity on every message plus per-account totals, errors,
and account-specific `nextCursor` values for follow-up single-account searches. `email_get_all_account_mailbox_statuses`
checks message counts across the same selected accounts. These multi-inbox tools are read-only;
archive, move, trash, delete, and mark operations remain scoped to one explicit account.

Search filters can be combined and include `from`, `to`, `cc`, `bcc`, `subject`, body-only text,
all header/body text, Message-ID, internal and sent dates, message size, IMAP keywords, and the
seen, flagged, answered, draft, or deleted states. All supplied filters must match. Search
summaries include `messageId`, `inReplyTo`, `references`, and a header-derived `threadId`.
State filters use explicit three-way values rather than checkboxes: for example, `seen` accepts
`any`, `seen`, or `unseen`, while `flagged` accepts `any`, `flagged`, or `unflagged`. The answered,
draft, and deleted filters follow the same pattern, so an unset state is distinct from not
filtering by that state.

`email_get_message_thread` accepts the folder and IMAP UID of any message and returns up to 100 summaries from
the same header-based conversation, oldest first. This works without requiring the optional IMAP
`THREAD` extension, but it is scoped to one folder and depends on messages having valid
`Message-ID`, `In-Reply-To`, and `References` headers. Use each returned IMAP UID with `email_get_message` when
full message content is required.

`email_get_mailbox_status` returns the total and unread message counts plus IMAP `RECENT`, `UIDNEXT`,
and `UIDVALIDITY` values for one folder.

`email_get_message` includes a zero-based `attachmentIndex` for every attachment. Pass the folder, IMAP UID,
and index to `email_get_message_attachment` to retrieve its raw bytes as `contentBase64`.

IMAP configuration is required for every account. SMTP is optional; accounts without it can read,
search, draft, and manage mail but cannot use `email_send_draft`. `email_list_accounts` reports
`capabilities.canSend` so MCP clients can determine whether sending is available before attempting it.

`email_update_message_flags` accepts one IMAP UID or an array of up to 100 IMAP UIDs and `seen: true/false` for read/unread
and `flagged: true/false` for flagged/unflagged. Either or both states can be changed in one call.

`email_move_messages` accepts either one IMAP UID or an array of up to 100 IMAP UIDs and moves them in one IMAP
operation to an explicit `targetFolder`.

Use `email_archive_messages` for archiving; it moves up to 100 messages to the account's advertised
IMAP Archive folder, or the provider all-mail folder when that is the advertised archive destination.

Use `email_move_messages_to_trash` for normal deletion; it moves up to 100 messages to the folder advertised with
the IMAP `\Trash` special-use flag. `email_delete_messages_permanently` permanently marks and expunges up to 100
messages by IMAP UID and should only be used when permanent deletion is intended.

Sending is a two-step workflow: call `email_create_message_draft`, then pass its returned `folder` and
IMAP UID field `uid` to `email_send_draft`. After SMTP accepts the message, the server appends a copy to the IMAP Sent
folder and then removes the draft. A Sent append failure is reported as `sentSaved: false`, and a
cleanup failure is reported as `draftDeleted: false`, without reporting the already accepted send
as failed.

Draft attachments use native MIME encoding. Pass up to 20 attachments as `attachments`, each
with `filename`, `contentType`, and `contentBase64`. The base64 value must contain the raw file
bytes without a data-URL prefix. Draft text and HTML bodies are emitted as quoted-printable MIME
parts; base64 is only required for attachment bytes.

To create a reply, call `email_create_message_draft` with `replyToMessage.folder` and
the original message's IMAP UID in `replyToMessage.uid`. The server derives the recipient and subject and adds the correct
`In-Reply-To` and `References` headers. Reply drafts quote the original message by default; set
`replyToMessage.quoteOriginal: false` only when the original message should not be quoted. Set
`replyAll` within `replyToMessage` when needed; top-level `to`, `cc`, and `subject` values override
the derived values. Set top-level `replyTo` when the outgoing draft should include a `Reply-To` header.
`email_create_forward_draft` creates a forward draft and includes the original attachments unless
`includeAttachments` is false. `email_update_message_draft` replaces an existing IMAP draft and returns its
new IMAP UID; omitted fields are preserved, and an empty `attachments` array removes all attachments.

| Provider | IMAP                            | SMTP                              | Authentication              |
| -------- | ------------------------------- | --------------------------------- | --------------------------- |
| Gmail    | `imap.gmail.com:993` TLS        | `smtp.gmail.com:465` TLS          | Google app password         |
| Outlook  | `outlook.office365.com:993` TLS | `smtp.office365.com:587` STARTTLS | Microsoft OAuth2 sign-in    |
| iCloud   | `imap.mail.me.com:993` TLS      | `smtp.mail.me.com:587` STARTTLS   | Apple app-specific password |
| Custom   | Provider supplied               | Provider supplied                 | Password or OAuth2          |

For port 587, set `smtpSecure` to `false`; the native SMTP client negotiates STARTTLS. Cloudflare blocks outbound SMTP port 25.

Outlook refresh uses the Entra application client ID and Worker-held client secret. Microsoft may
require tenant administrator consent for delegated Exchange permissions, depending on the tenant's
consent policy. SMTP AUTH must also be enabled for the Exchange Online mailbox if sending fails.

## Security

Cloudflare Access authenticates users and enforces the application policy before traffic reaches
the Worker. The Worker independently validates the Access JWT using the team JWKS, issuer, and
application audience. Mailbox passwords and OAuth tokens are AES-256-GCM encrypted in Workers KV
and are never returned by account tools. Changing `CREDENTIAL_ENCRYPTION_KEY` makes existing
stored accounts unreadable.
