import { Hono, type Context } from "hono";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { openJson, sealJson } from "./crypto";
import { AccountStore } from "./mail/account-store";
import { MailService } from "./mail/mail-service";
import type { AccountAuth, MailAccount, MailEnv } from "./mail/types";
import {
	assertValidOutlookOAuthCallback,
	createOutlookOAuthState,
	type OutlookOAuthState,
} from "./outlook-oauth";

const app = new Hono<{ Bindings: MailEnv }>();
const OUTLOOK_SCOPES =
	"openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send";
const microsoftJwks = createRemoteJWKSet(
	new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"),
);

type MailContext = Context<{ Bindings: MailEnv }>;

interface PendingAccountChange {
	mode: "add" | "update";
	accountId?: string;
	account: Omit<MailAccount, "id">;
	createdAt: number;
}

app.get("/", async (c) => {
	try {
		const accounts = await accountStore(c.env).list();
		const editId = c.req.query("edit");
		const editAccount = editId ? accounts.find((account) => account.id === editId) : undefined;
		const connectionFlash = cookieValue(c.req.raw, "connection_test");
		if (connectionFlash)
			c.header("Set-Cookie", clearConnectionTestCookie(c.req.url.startsWith("https://")));
		if (editId && !editAccount) throw new Error("Account to edit was not found");
		return c.html(
			managementPage(
				accounts,
				c.req.query("status") ||
					(connectionFlash === "connection_ok" ||
					connectionFlash === "connection_imap_only"
						? connectionFlash
						: undefined),
				undefined,
				outlookConfigured(c.env),
				editAccount,
			),
		);
	} catch (error) {
		return c.html(
			managementPage([], undefined, errorMessage(error), outlookConfigured(c.env)),
			500,
		);
	}
});

app.post("/accounts", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	let account: Omit<MailAccount, "id">;
	try {
		const form = await c.req.formData();
		account = accountInput(form);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(
			managementPage(accounts, undefined, errorMessage(error), outlookConfigured(c.env)),
			400,
		);
	}

	let testResult: { smtpConfigured: boolean };
	try {
		testResult = await testNewAccount(c.env, account);
	} catch (error) {
		return accountTestFailureResponse(c, error, {
			mode: "add",
			account,
			createdAt: Date.now(),
		});
	}

	try {
		await accountStore(c.env).add(account);
		return c.redirect(
			testResult.smtpConfigured ? "/?status=added_tested" : "/?status=added_tested_imap_only",
			303,
		);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(
			managementPage(accounts, undefined, errorMessage(error), outlookConfigured(c.env)),
			500,
		);
	}
});

app.post("/accounts/pending/retry", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	let pending: PendingAccountChange;
	try {
		pending = await pendingAccountChange(c.env, await c.req.formData());
	} catch (error) {
		return pendingAccountError(c, error);
	}

	let testResult: { smtpConfigured: boolean };
	try {
		testResult = await testNewAccount(c.env, pending.account);
	} catch (error) {
		return accountTestFailureResponse(c, error, pending);
	}

	try {
		await persistAccountChange(c.env, pending);
		const status = testResult.smtpConfigured
			? pending.mode === "add"
				? "added_tested"
				: "updated_tested"
			: pending.mode === "add"
				? "added_tested_imap_only"
				: "updated_tested_imap_only";
		return c.redirect(`/?status=${status}`, 303);
	} catch (error) {
		return pendingAccountError(c, error);
	}
});

app.post("/accounts/pending/edit-test", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	let pending: PendingAccountChange;
	try {
		const form = await c.req.formData();
		pending = await pendingAccountChange(c.env, form);
		pending.account = accountInput(form, pending.account.auth);
	} catch (error) {
		return pendingAccountError(c, error);
	}

	let testResult: { smtpConfigured: boolean };
	try {
		testResult = await testNewAccount(c.env, pending.account);
	} catch (error) {
		return accountTestFailureResponse(c, error, pending);
	}

	try {
		await persistAccountChange(c.env, pending);
		const status = testResult.smtpConfigured
			? pending.mode === "add"
				? "added_tested"
				: "updated_tested"
			: pending.mode === "add"
				? "added_tested_imap_only"
				: "updated_tested_imap_only";
		return c.redirect(`/?status=${status}`, 303);
	} catch (error) {
		return pendingAccountError(c, error);
	}
});

app.post("/accounts/pending/save", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	try {
		const pending = await pendingAccountChange(c.env, await c.req.formData());
		await persistAccountChange(c.env, pending);
		return c.redirect(
			pending.mode === "add" ? "/?status=added_untested" : "/?status=updated_untested",
			303,
		);
	} catch (error) {
		return pendingAccountError(c, error);
	}
});

app.post("/accounts/pending/cancel", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);
	return c.redirect("/", 303);
});

app.post("/accounts/:id/update", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	const store = accountStore(c.env);
	let account: MailAccount;
	try {
		const form = await c.req.formData();
		const existing = await store.get(c.req.param("id"));
		account = { id: existing.id, ...accountInput(form, existing.auth) };
	} catch (error) {
		const accounts = await store.list().catch(() => []);
		const editAccount = accounts.find((account) => account.id === c.req.param("id"));
		return c.html(
			managementPage(
				accounts,
				undefined,
				errorMessage(error),
				outlookConfigured(c.env),
				editAccount,
			),
			400,
		);
	}

	let testResult: { smtpConfigured: boolean };
	try {
		testResult = await testNewAccount(c.env, account);
	} catch (error) {
		return accountTestFailureResponse(c, error, {
			mode: "update",
			accountId: account.id,
			account,
			createdAt: Date.now(),
		});
	}

	try {
		await store.update(account);
		return c.redirect(
			testResult.smtpConfigured
				? "/?status=updated_tested"
				: "/?status=updated_tested_imap_only",
			303,
		);
	} catch (error) {
		return pendingAccountError(c, error);
	}
});

app.post("/accounts/:id/test", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	try {
		const mail = new MailService(accountStore(c.env), {
			clientId: c.env.OUTLOOK_CLIENT_ID,
			clientSecret: c.env.OUTLOOK_CLIENT_SECRET,
		});
		const result = await mail.testConnection(c.req.param("id"));
		c.header(
			"Set-Cookie",
			connectionTestCookie(c.req.url.startsWith("https://"), result.smtpConfigured),
		);
		return c.redirect("/", 303);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(
			managementPage(
				accounts,
				undefined,
				`Connection test failed: ${errorMessage(error)}`,
				outlookConfigured(c.env),
			),
			502,
		);
	}
});

app.post("/accounts/:id/remove", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	try {
		await accountStore(c.env).remove(c.req.param("id"));
		return c.redirect("/?status=removed", 303);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(
			managementPage(accounts, undefined, errorMessage(error), outlookConfigured(c.env)),
			400,
		);
	}
});

app.post("/oauth/outlook/start", async (c) => {
	if (!isTrustedFormSubmission(c.req.raw)) return c.text("Forbidden", 403);

	try {
		const config = outlookConfig(c.env);
		const form = await c.req.formData();
		const { oauthState, codeChallenge } = await createOutlookOAuthState(
			validName(required(form, "name")),
		);
		const redirectUri = outlookRedirectUri(c.req.raw);
		const authorize = new URL(
			`https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/authorize`,
		);
		authorize.search = new URLSearchParams({
			client_id: config.clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			response_mode: "query",
			scope: OUTLOOK_SCOPES,
			state: oauthState.state,
			nonce: oauthState.nonce,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			prompt: "select_account",
		}).toString();
		c.header(
			"Set-Cookie",
			oauthCookie(
				await sealJson(oauthState, c.env.CREDENTIAL_ENCRYPTION_KEY),
				c.req.url.startsWith("https://"),
			),
		);
		return c.redirect(authorize.toString(), 303);
	} catch (error) {
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(
			managementPage(accounts, undefined, errorMessage(error), outlookConfigured(c.env)),
			400,
		);
	}
});

app.get("/oauth/outlook/callback", async (c) => {
	try {
		const config = outlookConfig(c.env);
		const oauthError = c.req.query("error");
		if (oauthError) throw new Error(`Microsoft authorization failed: ${oauthError}`);
		const code = c.req.query("code");
		const returnedState = c.req.query("state");
		const sealedState = cookieValue(c.req.raw, "outlook_oauth");
		if (!code || !returnedState || !sealedState)
			throw new Error("Outlook authorization expired");
		const oauthState = await openJson<OutlookOAuthState>(
			sealedState,
			c.env.CREDENTIAL_ENCRYPTION_KEY,
		);
		assertValidOutlookOAuthCallback(oauthState, returnedState);

		const body = new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			grant_type: "authorization_code",
			code,
			redirect_uri: outlookRedirectUri(c.req.raw),
			code_verifier: oauthState.codeVerifier,
			scope: OUTLOOK_SCOPES,
		});
		const response = await fetch(
			`https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/token`,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body,
			},
		);
		if (!response.ok) throw new Error(`Microsoft token exchange failed (${response.status})`);
		const token = await response.json<{
			access_token: string;
			refresh_token?: string;
			expires_in: number;
			id_token: string;
		}>();
		if (!token.access_token || !token.refresh_token || !token.id_token)
			throw new Error("Microsoft did not return the required OAuth tokens");
		const identity = await verifyMicrosoftIdentity(
			token.id_token,
			config.clientId,
			oauthState.nonce,
		);

		await accountStore(c.env).add({
			name: oauthState.displayName,
			email: identity.email,
			imap: { host: "outlook.office365.com", port: 993, secure: true },
			smtp: { host: "smtp.office365.com", port: 587, secure: false },
			auth: {
				type: "oauth2",
				accessToken: token.access_token,
				refreshToken: token.refresh_token,
				clientId: config.clientId,
				tenant: config.tenant,
				expiresAt: Date.now() + token.expires_in * 1000,
			},
		});
		c.header("Set-Cookie", clearOauthCookie(c.req.url.startsWith("https://")));
		return c.redirect("/?status=outlook_connected", 303);
	} catch (error) {
		c.header("Set-Cookie", clearOauthCookie(c.req.url.startsWith("https://")));
		const accounts = await accountStore(c.env)
			.list()
			.catch(() => []);
		return c.html(
			managementPage(accounts, undefined, errorMessage(error), outlookConfigured(c.env)),
			400,
		);
	}
});

app.get("/diagnostics/imap", async (c) => {
	try {
		const mail = new MailService(accountStore(c.env), {
			clientId: c.env.OUTLOOK_CLIENT_ID,
			clientSecret: c.env.OUTLOOK_CLIENT_SECRET,
		});
		const connection = await mail.testConnection();
		const folders = await mail.listFolders();
		return c.json({ ...connection, folderCount: folders.length, folders });
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 502);
	}
});

function accountStore(env: MailEnv): AccountStore {
	return new AccountStore(env.EMAIL_KV, env.CREDENTIAL_ENCRYPTION_KEY);
}

async function testNewAccount(
	env: MailEnv,
	account: Omit<MailAccount, "id">,
): Promise<{ smtpConfigured: boolean }> {
	const mail = new MailService(accountStore(env), {
		clientId: env.OUTLOOK_CLIENT_ID,
		clientSecret: env.OUTLOOK_CLIENT_SECRET,
	});
	return mail.testAccount({ id: "pending", ...account });
}

async function pendingAccountChange(env: MailEnv, form: FormData): Promise<PendingAccountChange> {
	const sealed = requiredSecret(form, "pending");
	const pending = await openJson<PendingAccountChange>(sealed, env.CREDENTIAL_ENCRYPTION_KEY);
	if (
		(pending.mode !== "add" && pending.mode !== "update") ||
		!pending.account ||
		!pending.createdAt ||
		Date.now() - pending.createdAt > 10 * 60_000 ||
		(pending.mode === "update" && !pending.accountId)
	)
		throw new Error("Pending account expired; enter the account details again");
	return pending;
}

async function persistAccountChange(env: MailEnv, pending: PendingAccountChange): Promise<void> {
	const store = accountStore(env);
	if (pending.mode === "add") {
		await store.add(pending.account);
		return;
	}
	await store.update({ id: pending.accountId!, ...pending.account });
}

async function accountTestFailureResponse(
	c: MailContext,
	error: unknown,
	pending: PendingAccountChange,
) {
	const accounts = await accountStore(c.env)
		.list()
		.catch(() => []);
	const sealed = await sealJson(pending, c.env.CREDENTIAL_ENCRYPTION_KEY);
	return c.html(
		managementPage(accounts, undefined, undefined, outlookConfigured(c.env), undefined, {
			message: errorMessage(error),
			pending: sealed,
			change: pending,
		}),
		502,
	);
}

async function pendingAccountError(c: MailContext, error: unknown) {
	const accounts = await accountStore(c.env)
		.list()
		.catch(() => []);
	return c.html(
		managementPage(accounts, undefined, errorMessage(error), outlookConfigured(c.env)),
		400,
	);
}

function managementPage(
	accounts: MailAccount[],
	status?: string,
	error?: string,
	outlookOAuthConfigured = false,
	editAccount?: MailAccount,
	accountTestFailure?: {
		message: string;
		pending: string;
		change: PendingAccountChange;
	},
): string {
	const testSuccess =
		status === "added_tested"
			? {
					title: "Connection test successful",
					message:
						"IMAP and SMTP authentication both passed. The account has been saved.",
				}
			: status === "updated_tested"
				? {
						title: "Connection test successful",
						message:
							"IMAP and SMTP authentication both passed. The account changes have been saved.",
					}
				: status === "added_tested_imap_only"
					? {
							title: "Connection test successful",
							message:
								"IMAP authentication passed and the account has been saved. SMTP is not configured, so this account cannot send email.",
						}
					: status === "updated_tested_imap_only"
						? {
								title: "Connection test successful",
								message:
									"IMAP authentication passed and the account changes have been saved. SMTP is not configured, so this account cannot send email.",
							}
						: status === "connection_imap_only"
							? {
									title: "Connection test successful",
									message:
										"IMAP authentication passed. SMTP is not configured, so this account cannot send email.",
								}
							: status === "connection_ok"
								? {
										title: "Connection test successful",
										message: "IMAP and SMTP authentication both passed.",
									}
								: undefined;
	const notice =
		status === "added"
			? '<div class="notice success" role="status">Account added.</div>'
			: status === "added_untested"
				? '<div class="notice success" role="status">Account saved without a successful connection test.</div>'
				: status === "updated_untested"
					? '<div class="notice success" role="status">Account changes saved without a successful connection test.</div>'
					: status === "outlook_connected"
						? '<div class="notice success" role="status">Outlook account connected.</div>'
						: status === "updated"
							? '<div class="notice success" role="status">Account settings updated.</div>'
							: status === "removed"
								? '<div class="notice success" role="status">Account removed.</div>'
								: error
									? `<div class="notice error" role="alert">${escapeHtml(error)}</div>`
									: "";
	const rows = accounts.length
		? accounts
				.map(
					(account) => `<li class="account">
						<div class="account-header">
							<div class="account-identity"><span class="account-avatar" aria-hidden="true">${escapeHtml(account.name.charAt(0).toUpperCase())}</span><div><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.email)}</span></div></div>
							<div class="account-actions">
								<a class="secondary action-link" href="/?edit=${encodeURIComponent(account.id)}">Edit</a>
								<form method="post" action="/accounts/${encodeURIComponent(account.id)}/test">
									<button class="secondary" type="submit">Test connection</button>
								</form>
								<form method="post" action="/accounts/${encodeURIComponent(account.id)}/remove" onsubmit="return confirm('Remove this account?')">
									<button class="danger" type="submit">Remove</button>
								</form>
							</div>
						</div>
						<details class="account-details">
							<summary>Connection settings</summary>
							<dl class="account-settings">
								<div><dt>IMAP</dt><dd>${escapeHtml(account.imap.host)}:${account.imap.port}</dd></div>
								<div><dt>IMAP security</dt><dd>${account.imap.secure ? "Implicit TLS" : "STARTTLS"}</dd></div>
								<div><dt>SMTP</dt><dd>${account.smtp ? `${escapeHtml(account.smtp.host)}:${account.smtp.port}` : "Not configured"}</dd></div>
								${account.smtp ? `<div><dt>SMTP security</dt><dd>${account.smtp.secure ? "Implicit TLS" : "STARTTLS"}</dd></div>` : ""}
								<div><dt>Can send</dt><dd>${account.smtp ? "Yes" : "No"}</dd></div>
								<div><dt>Authentication</dt><dd>${account.auth.type === "oauth2" ? "OAuth 2.0" : "Password"}</dd></div>
							</dl>
						</details>
					</li>`,
				)
				.join("")
		: '<li class="empty">No email accounts configured.</li>';
	const editor = accountEditor(
		editAccount,
		outlookOAuthConfigured,
		accountTestFailure?.change,
		accountTestFailure?.pending,
	);
	const testFailure = accountTestFailure
		? `<dialog class="account-dialog test-failure-dialog" id="test-failure-dialog" aria-labelledby="test-failure-heading">
		<section class="dialog-card">
			<div class="test-failure-icon" aria-hidden="true">!</div>
			<h2 id="test-failure-heading">Connection test failed</h2>
			<p>The account has not been saved. Check the error and choose what to do next.</p>
			<div class="test-error" role="alert">${escapeHtml(accountTestFailure.message)}</div>
			<div class="test-actions">
				<form method="post" action="/accounts/pending/retry"><input type="hidden" name="pending" value="${escapeHtml(accountTestFailure.pending)}"><button type="submit">Run test again</button></form>
				<button class="secondary" id="edit-failed-account" type="button">Edit details</button>
				<form method="post" action="/accounts/pending/save"><input type="hidden" name="pending" value="${escapeHtml(accountTestFailure.pending)}"><button class="secondary" type="submit">Save anyway</button></form>
				<form method="post" action="/accounts/pending/cancel"><button class="plain-button" type="submit">Cancel</button></form>
			</div>
		</section>
	</dialog>`
		: "";
	const testSuccessDialog = testSuccess
		? `<dialog class="account-dialog test-result-dialog" id="test-success-dialog" aria-labelledby="test-success-heading">
		<section class="dialog-card">
			<div class="test-success-icon" aria-hidden="true">✓</div>
			<h2 id="test-success-heading">${testSuccess.title}</h2>
			<p>${testSuccess.message}</p>
			<button class="test-result-close" id="test-success-close" type="button">Done</button>
		</section>
	</dialog>`
		: "";

	return `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<meta name="referrer" content="no-referrer">
			<title>Email account management</title>
			<style>
				:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f5f7fb; }
				* { box-sizing: border-box; }
				body { margin: 0; }
				main { width: min(58rem, calc(100% - 2rem)); margin: 3rem auto; }
				header { margin-bottom: 1.5rem; }
				.page-header, .section-heading, .dialog-heading { display: flex; gap: 1rem; align-items: center; justify-content: space-between; }
				.page-header > div, .dialog-heading > div { min-width: 0; }
				h1, h2 { margin: 0 0 .5rem; line-height: 1.2; }
				h1 { font-size: clamp(1.75rem, 5vw, 2.5rem); }
				p { margin: 0; color: #5d6678; }
				.card { background: #fff; border: 1px solid #dfe3eb; border-radius: .9rem; padding: 1.4rem; box-shadow: 0 8px 28px rgba(23,32,51,.06); }
				.notice { margin: 0 0 1.25rem; padding: .8rem 1rem; border-radius: .6rem; }
				.success { color: #146c43; background: #eaf8f0; border: 1px solid #bce7ce; }
				.error { color: #9b2c2c; background: #fff0f0; border: 1px solid #f0bcbc; }
				.count { display: inline-flex; align-items: center; justify-content: center; min-width: 1.75rem; height: 1.75rem; padding: 0 .5rem; border-radius: 999px; color: #5d6678; background: #eef1f6; font-size: .8rem; font-weight: 700; }
				.accounts { list-style: none; padding: 0; margin: .85rem 0 0; }
				.account { padding: 1.1rem 0; border-top: 1px solid #e8ebf0; }
				.account:first-child { border-top: 0; }
				.account span { display: block; color: #5d6678; overflow-wrap: anywhere; }
				.account-header { display: flex; gap: 1rem; align-items: center; justify-content: space-between; }
				.account-identity { display: flex; min-width: 0; gap: .75rem; align-items: center; }
				.account-avatar { display: grid !important; flex: 0 0 auto; width: 2.5rem; height: 2.5rem; place-items: center; border-radius: .65rem; color: #245fc2 !important; background: #edf3ff; font-weight: 800; }
				.account-details { margin-top: .75rem; }
				.account-details summary { display: flex; width: fit-content; gap: .4rem; align-items: center; list-style: none; cursor: pointer; color: #245fc2; font-size: .85rem; font-weight: 700; }
				.account-details summary::-webkit-details-marker { display: none; }
				.account-details summary::before { content: "›"; font-size: 1.2rem; line-height: .8; transition: transform .15s ease; }
				.account-details[open] summary::before { transform: rotate(90deg); }
				.account-details summary:hover { color: #194c9f; }
				.account-settings { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem 1.5rem; margin: .8rem 0 0; padding: .85rem 1rem; border-radius: .6rem; color: #495368; background: #f7f9fc; font-size: .85rem; }
				.account-settings div { display: grid; grid-template-columns: minmax(6.5rem, 8rem) minmax(0, 1fr); gap: .5rem; }
				.account-settings dt { color: #747d8f; }
				.account-settings dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
				.account-actions { display: flex; flex: 0 0 auto; gap: .5rem; }
				.account-actions button, .account-actions a { white-space: nowrap; }
				.empty { color: #747d8f; padding-top: .5rem; }
				fieldset { border: 0; margin: 1.25rem 0 0; padding: 0; }
				legend { font-weight: 700; margin-bottom: .75rem; }
				.fieldset-heading { display: flex; width: 100%; gap: 1rem; align-items: center; justify-content: space-between; }
				.smtp-toggle { display: flex; gap: .45rem; align-items: center; color: #5d6678; font-size: .83rem; font-weight: 700; }
				.fields { display: grid; grid-template-columns: 1fr 1fr; gap: .9rem; }
				.server-fields { grid-template-columns: minmax(0, 2fr) minmax(6.5rem, 1fr) auto; align-items: end; }
				.account-detail-fields > .fields:first-child { margin-top: 1.25rem; }
				#manual-account-fields > .fields:first-child { margin-top: .9rem; }
				.provider-picker { margin-top: 1.25rem; }
				.provider-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .65rem; }
				.provider-option { display: grid; min-height: 4.25rem; padding: .75rem .5rem; place-items: center; border: 1px solid #bdc4d0; color: #384256; background: #fff; }
				.provider-option:hover { border-color: #3976d7; color: #245fc2; background: #f7faff; }
				.provider-option[aria-pressed="true"] { border-color: #245fc2; outline: 3px solid #c9dcff; color: #245fc2; background: #edf3ff; }
				label { display: grid; gap: .35rem; color: #384256; font-size: .9rem; font-weight: 600; }
				.full { grid-column: 1 / -1; }
				input, select, button { font: inherit; }
				input:not([type="checkbox"]), select { width: 100%; height: 2.75rem; padding: .7rem .75rem; color: #172033; background: #fff; border: 1px solid #bdc4d0; border-radius: .45rem; }
				input:not([type="checkbox"]):focus, select:focus { outline: 3px solid #c9dcff; border-color: #3976d7; }
				.check { display: flex; gap: .5rem; align-items: center; align-self: end; min-height: 2.65rem; }
				.check input { width: auto; }
				button { cursor: pointer; padding: .7rem 1rem; border: 0; border-radius: .45rem; background: #245fc2; color: #fff; font-weight: 700; }
				button:hover { background: #194c9f; }
				button:disabled { cursor: not-allowed; opacity: .55; }
				.primary-action { flex: 0 0 auto; box-shadow: 0 4px 12px rgba(36,95,194,.2); }
				.secondary { padding: .5rem .75rem; border: 0; border-radius: .45rem; color: #245fc2; background: #edf3ff; font-weight: 700; }
				.secondary:hover { background: #dce8ff; }
				.action-link { display: inline-flex; align-items: center; text-decoration: none; }
				.danger { padding: .5rem .75rem; color: #a12e2e; background: #fff0f0; }
				.danger:hover { background: #f8dada; }
				.submit { margin-top: 1.25rem; }
				.form-actions { display: flex; gap: .75rem; align-items: center; margin-top: 1.25rem; }
				.form-actions .submit { margin: 0; }
				.cancel-link { color: #5d6678; font-weight: 700; text-decoration: none; }
				.cancel-link:hover { color: #172033; text-decoration: underline; }
				.help { margin-top: .8rem; font-size: .83rem; }
				.account-dialog { width: min(42rem, calc(100% - 2rem)); max-height: calc(100vh - 2rem); margin: auto; padding: 0; overflow: auto; border: 0; border-radius: 1rem; color: inherit; background: transparent; box-shadow: 0 24px 70px rgba(23,32,51,.28); }
				.account-dialog::backdrop { background: rgba(23,32,51,.5); backdrop-filter: blur(3px); }
				.dialog-card { padding: 1.5rem; background: #fff; }
				.dialog-heading { padding-bottom: 1rem; border-bottom: 1px solid #e8ebf0; }
				.dialog-heading h2 { margin-bottom: .25rem; }
				.icon-button { display: grid; flex: 0 0 auto; width: 2.25rem; height: 2.25rem; padding: 0; place-items: center; border-radius: 999px; color: #5d6678; background: #eef1f6; font-size: 1.35rem; }
				.icon-button:hover { color: #172033; background: #dfe3eb; }
				.test-failure-dialog { width: min(34rem, calc(100% - 2rem)); }
				.test-failure-dialog .dialog-card, .test-result-dialog .dialog-card { text-align: center; }
				.test-failure-icon { display: grid; width: 3rem; height: 3rem; margin: 0 auto 1rem; place-items: center; border-radius: 999px; color: #9b2c2c; background: #fff0f0; font-size: 1.5rem; font-weight: 800; }
				.test-result-dialog { width: min(34rem, calc(100% - 2rem)); }
				.test-success-icon { display: grid; width: 3rem; height: 3rem; margin: 0 auto 1rem; place-items: center; border-radius: 999px; color: #146c43; background: #eaf8f0; font-size: 1.5rem; font-weight: 800; }
				.test-result-close { margin-top: 1.25rem; min-width: 7rem; }
				.test-error { margin: 1rem 0; padding: .85rem 1rem; border-radius: .6rem; color: #9b2c2c; background: #fff0f0; overflow-wrap: anywhere; text-align: left; }
				.test-actions { display: flex; gap: .65rem; justify-content: center; flex-wrap: wrap; }
				.plain-button { color: #5d6678; background: transparent; }
				.plain-button:hover { color: #172033; background: #eef1f6; }
				[hidden] { display: none !important; }
				@media (max-width: 760px) { main { margin: 1.5rem auto; } .fields, .account-settings { grid-template-columns: 1fr; } .full { grid-column: auto; } }
				@media (max-width: 560px) { .page-header, .account-header { align-items: stretch; flex-direction: column; } .primary-action { width: 100%; } .account-actions { display: grid; grid-template-columns: 1fr 1fr; } .account-actions > :last-child { grid-column: 1 / -1; } .account-actions button, .account-actions a { justify-content: center; width: 100%; } .account-settings div { grid-template-columns: 1fr; gap: .1rem; } .provider-options { grid-template-columns: 1fr 1fr; } }
			</style>
		</head>
		<body>
			<main>
				<header class="page-header"><div><h1>Email accounts</h1><p>Manage the mailboxes available to your MCP server.</p></div><button class="primary-action" id="add-account-button" type="button">＋ Add account</button></header>
				${notice}
				<section class="card" aria-labelledby="configured-heading">
					<div class="section-heading"><h2 id="configured-heading">Configured accounts</h2><span class="count" aria-label="${accounts.length} configured accounts">${accounts.length}</span></div>
						<ul class="accounts">${rows}</ul>
				</section>
				${editor.html}
				${testFailure}
				${testSuccessDialog}
			</main>
			${editor.script}
			${accountTestFailure ? '<script>const testFailureDialog = document.getElementById("test-failure-dialog"); testFailureDialog.addEventListener("cancel", (event) => event.preventDefault()); document.getElementById("edit-failed-account").addEventListener("click", () => { testFailureDialog.close(); document.getElementById("account-editor").showModal(); }); testFailureDialog.showModal();</script>' : ""}
			${testSuccess ? '<script>const testSuccessDialog = document.getElementById("test-success-dialog"); document.getElementById("test-success-close").addEventListener("click", () => testSuccessDialog.close()); testSuccessDialog.showModal();</script>' : ""}
			<script>const statusUrl = new URL(window.location.href); if (statusUrl.searchParams.has("status")) { statusUrl.searchParams.delete("status"); history.replaceState(null, "", statusUrl.pathname + statusUrl.search + statusUrl.hash); }</script>
		</body>
	</html>`;
}

function accountEditor(
	account?: MailAccount,
	outlookOAuthConfigured = false,
	pendingChange?: PendingAccountChange,
	pendingToken?: string,
): { html: string; script: string } {
	const editing = Boolean(account || pendingChange);
	const existingAccount = pendingChange ? pendingChange.mode === "update" : Boolean(account);
	const autoOpen = Boolean(account && !pendingChange);
	const formAccount = pendingChange
		? { id: pendingChange.accountId ?? "pending", ...pendingChange.account }
		: account;
	const html = `<dialog class="account-dialog" id="account-editor" aria-labelledby="account-editor-heading">
	<section class="dialog-card">
		<div class="dialog-heading"><div><h2 id="account-editor-heading">${pendingChange ? "Edit account details" : editing ? "Edit account" : "Add an account"}</h2><p>${pendingChange ? "The credential from the failed test is preserved securely." : editing ? "Update the mailbox connection settings." : "Choose a provider and enter the account details."}</p></div><button class="icon-button" type="button" data-dialog-close aria-label="Close">×</button></div>
		<form method="post" action="${pendingChange ? "/accounts/pending/edit-test" : editing ? `/accounts/${encodeURIComponent(account!.id)}/update` : "/accounts"}" autocomplete="off" id="account-form">
			${pendingToken ? `<input type="hidden" name="pending" value="${escapeHtml(pendingToken)}">` : ""}
			${
				editing
					? ""
					: `<fieldset class="provider-picker"><legend>Provider</legend><div class="provider-options" role="group" aria-label="Email provider">
				<button class="provider-option" type="button" data-provider="gmail" aria-pressed="false">Gmail</button>
				<button class="provider-option" type="button" data-provider="icloud" aria-pressed="false">iCloud</button>
				<button class="provider-option" type="button" data-provider="outlook" aria-pressed="false">Outlook</button>
				<button class="provider-option" type="button" data-provider="custom" aria-pressed="false">Custom</button>
			</div></fieldset>`
			}
			<div class="account-detail-fields" id="account-detail-fields"${editing ? "" : " hidden"}>
			<div class="fields">
				<label class="full">Display name<input name="name" value="${escapeHtml(formAccount?.name ?? "")}" required maxlength="100" autocomplete="off"></label>
			</div>
			<div id="manual-account-fields">
			<div class="fields">
				<label class="full">Email address<input name="email" type="email" value="${escapeHtml(formAccount?.email ?? "")}" required maxlength="320" autocomplete="username"></label>
			</div>
			<fieldset><legend>Incoming mail (IMAP)</legend><div class="fields server-fields">
				<label>Host<input name="imapHost" id="imap-host" value="${escapeHtml(formAccount?.imap.host ?? "")}" required></label>
				<label>Port<input name="imapPort" id="imap-port" type="number" min="1" max="65535" value="${formAccount?.imap.port ?? ""}" placeholder="993" required></label>
				<label class="check" title="Use implicit TLS"><input name="imapSecure" id="imap-secure" type="checkbox"${formAccount?.imap.secure === false ? "" : " checked"}> TLS</label>
			</div></fieldset>
			<fieldset><legend class="fieldset-heading"><span>Outgoing mail (SMTP)</span><label class="smtp-toggle"><input name="smtpEnabled" id="smtp-enabled" type="checkbox"${formAccount?.smtp ? " checked" : ""}> Enable SMTP</label></legend><div class="fields server-fields" id="smtp-fields"${formAccount?.smtp ? "" : " hidden"}>
				<label>Host<input name="smtpHost" id="smtp-host" value="${escapeHtml(formAccount?.smtp?.host ?? "")}" required></label>
				<label>Port<input name="smtpPort" id="smtp-port" type="number" min="1" max="65535" value="${formAccount?.smtp?.port ?? ""}" placeholder="587" required></label>
				<label class="check" title="Use implicit TLS"><input name="smtpSecure" id="smtp-secure" type="checkbox"${formAccount?.smtp?.secure === false ? "" : " checked"}> TLS</label>
			</div></fieldset>
			${
				editing
					? ""
					: `<fieldset><legend>Authentication</legend><div class="fields">
				<label class="full" id="auth-type-field">Type<select name="authType" id="auth-type"><option value="password">App password</option><option value="oauth2">OAuth 2.0 tokens</option></select></label>
				<label class="full" id="password-field">App password<input name="password" id="password" type="password" autocomplete="new-password"></label>
				<div class="fields full" id="oauth-fields" hidden>
					<label class="full">Access token<input name="accessToken" id="access-token" type="password" autocomplete="off"></label>
					<label class="full">Refresh token<input name="refreshToken" type="password" autocomplete="off"></label>
					<label>Client ID<input name="oauthClientId" autocomplete="off"></label>
					<label>Tenant<input name="oauthTenant" value="consumers" autocomplete="off"></label>
				</div>
			</div></fieldset>`
			}
			</div>
			<div class="form-actions">
				<button class="submit" id="account-submit" type="submit">${existingAccount ? "Test and save changes" : "Test and save account"}</button>
				${editing ? '<a class="cancel-link" href="/">Cancel</a>' : '<button class="secondary" type="button" data-dialog-close>Cancel</button>'}
			</div>
			<p class="help" id="account-help">${pendingChange ? "Change the connection details and test again. The stored pending credential is never returned to the page." : editing ? "Changing the email address also changes the username used for IMAP and SMTP authentication." : "Use an app-specific password for Gmail or iCloud. Passwords and tokens are never displayed after saving."}</p>
			</div>
		</form>
	</section>
	</dialog>`;

	const providerScript = editing
		? ""
		: `
			const outlookOAuthConfigured = ${outlookOAuthConfigured};
			const presets = {
				gmail: { imapHost: "imap.gmail.com", imapPort: "993", smtpHost: "smtp.gmail.com", smtpPort: "465", smtpSecure: true, smtpEnabled: true, auth: "password" },
				icloud: { imapHost: "imap.mail.me.com", imapPort: "993", smtpHost: "smtp.mail.me.com", smtpPort: "587", smtpSecure: false, smtpEnabled: true, auth: "password" },
				outlook: { imapHost: "outlook.office365.com", imapPort: "993", smtpHost: "smtp.office365.com", smtpPort: "587", smtpSecure: false, smtpEnabled: true, auth: "oauth2" }
			};
			const byId = (id) => document.getElementById(id);
			function updateAuth() {
				const oauth = byId("auth-type").value === "oauth2";
				byId("password-field").hidden = oauth;
				byId("oauth-fields").hidden = !oauth;
				byId("password").required = !oauth;
				byId("access-token").required = oauth;
			}
			function updateProvider(provider) {
				const outlook = provider === "outlook";
				const form = byId("account-form");
				byId("account-detail-fields").hidden = false;
				const manualFields = byId("manual-account-fields");
				const submit = byId("account-submit");
				manualFields.hidden = outlook;
				form.action = outlook ? "/oauth/outlook/start" : "/accounts";
				submit.textContent = outlook ? "Continue with Microsoft" : "Test and save account";
				submit.disabled = outlook && !outlookOAuthConfigured;
				byId("account-help").textContent = outlook
					? outlookOAuthConfigured
						? "Sign in with Microsoft to authorize IMAP and SMTP access. Tokens are stored encrypted and are not shown in the browser."
						: "Set OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET to enable Microsoft sign-in."
					: "Use an app-specific password for Gmail or iCloud. Passwords and tokens are never displayed after saving.";
				const preset = presets[provider];
				byId("auth-type-field").hidden = Boolean(preset);
				if (preset) {
					byId("imap-host").value = preset.imapHost; byId("imap-port").value = preset.imapPort;
					byId("smtp-host").value = preset.smtpHost; byId("smtp-port").value = preset.smtpPort;
					byId("imap-secure").checked = true; byId("smtp-secure").checked = preset.smtpSecure;
					byId("smtp-enabled").checked = preset.smtpEnabled;
					byId("auth-type").value = preset.auth;
				} else {
					byId("imap-host").value = ""; byId("imap-port").value = "";
					byId("smtp-host").value = ""; byId("smtp-port").value = "";
					byId("imap-secure").checked = true; byId("smtp-secure").checked = false;
					byId("smtp-enabled").checked = false;
					byId("auth-type").value = "password";
				}
				manualFields.querySelectorAll("input, select, button").forEach((control) => control.disabled = outlook);
				if (!outlook) updateSmtp();
				updateAuth();
			}
			document.querySelectorAll("[data-provider]").forEach((button) => {
				button.addEventListener("click", () => {
					document.querySelectorAll("[data-provider]").forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
					updateProvider(button.dataset.provider);
				});
			});
			byId("auth-type").addEventListener("change", updateAuth);
			`;
	const script = `<script>
		const accountDialog = document.getElementById("account-editor");
		const addAccountButton = document.getElementById("add-account-button");
		const smtpEnabled = document.getElementById("smtp-enabled");
		const smtpFields = document.getElementById("smtp-fields");
		function updateSmtp() {
			smtpFields.hidden = !smtpEnabled.checked;
			smtpFields.querySelectorAll("input").forEach((input) => input.disabled = !smtpEnabled.checked);
		}
		smtpEnabled.addEventListener("change", updateSmtp);
		updateSmtp();
		const closeAccountDialog = () => ${editing ? 'window.location.assign("/")' : "accountDialog.close()"};
		addAccountButton.addEventListener("click", () => {
			if (!accountDialog.open) accountDialog.showModal();
		});
		accountDialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
			button.addEventListener("click", closeAccountDialog);
		});
		accountDialog.addEventListener("click", (event) => {
			if (event.target === accountDialog) closeAccountDialog();
		});
		${providerScript}
		${autoOpen ? "accountDialog.showModal();" : ""}
	</script>`;
	return { html, script };
}

function outlookConfigured(env: MailEnv): boolean {
	return Boolean(env.OUTLOOK_CLIENT_ID && env.OUTLOOK_CLIENT_SECRET);
}

function outlookConfig(env: MailEnv): {
	clientId: string;
	clientSecret: string;
	tenant: string;
} {
	if (!env.OUTLOOK_CLIENT_ID || !env.OUTLOOK_CLIENT_SECRET)
		throw new Error("Outlook OAuth is not configured");
	if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(env.OUTLOOK_CLIENT_ID))
		throw new Error("OUTLOOK_CLIENT_ID must be a Microsoft Entra application client ID");
	const tenant = env.OUTLOOK_TENANT || "consumers";
	if (
		!/^(?:common|organizations|consumers|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.test(
			tenant,
		)
	)
		throw new Error("OUTLOOK_TENANT must be common, organizations, consumers, or a tenant ID");
	return {
		clientId: env.OUTLOOK_CLIENT_ID,
		clientSecret: env.OUTLOOK_CLIENT_SECRET,
		tenant,
	};
}

function outlookRedirectUri(request: Request): string {
	return `${new URL(request.url).origin}/oauth/outlook/callback`;
}

function oauthCookie(value: string, secure: boolean): string {
	return `outlook_oauth=${value}; Path=/oauth/outlook/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`;
}

function clearOauthCookie(secure: boolean): string {
	return `outlook_oauth=; Path=/oauth/outlook/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

function connectionTestCookie(secure: boolean, smtpConfigured: boolean): string {
	return `connection_test=${smtpConfigured ? "connection_ok" : "connection_imap_only"}; Path=/; HttpOnly; SameSite=Strict; Max-Age=60${secure ? "; Secure" : ""}`;
}

function clearConnectionTestCookie(secure: boolean): string {
	return `connection_test=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function cookieValue(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") || "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim() || undefined;
	}
	return undefined;
}

async function verifyMicrosoftIdentity(
	idToken: string,
	clientId: string,
	nonce: string,
): Promise<{ email: string }> {
	const unverified = decodeJwt(idToken);
	if (typeof unverified.tid !== "string" || !/^[0-9a-f-]{36}$/i.test(unverified.tid))
		throw new Error("Microsoft identity token has no valid tenant");
	const issuer = `https://login.microsoftonline.com/${unverified.tid}/v2.0`;
	const { payload } = await jwtVerify(idToken, microsoftJwks, {
		issuer,
		audience: clientId,
	});
	if (payload.nonce !== nonce) throw new Error("Microsoft identity token nonce is invalid");
	const email =
		typeof payload.preferred_username === "string"
			? payload.preferred_username
			: typeof payload.email === "string"
				? payload.email
				: undefined;
	if (!email) throw new Error("Microsoft identity did not return an email address");
	return { email: validEmail(email) };
}

function isTrustedFormSubmission(request: Request): boolean {
	if (request.headers.get("Sec-Fetch-Site") === "same-origin") return true;
	const origin = request.headers.get("Origin");
	if (origin === new URL(request.url).origin) return true;
	const referrer = request.headers.get("Referer");
	if (!referrer) return false;
	try {
		return new URL(referrer).origin === new URL(request.url).origin;
	} catch {
		return false;
	}
}

function accountInput(form: FormData, existingAuth?: AccountAuth): Omit<MailAccount, "id"> {
	let auth = existingAuth;
	if (!auth) {
		const authType = value(form, "authType");
		auth =
			authType === "password"
				? { type: "password", password: requiredSecret(form, "password") }
				: authType === "oauth2"
					? {
							type: "oauth2",
							accessToken: requiredSecret(form, "accessToken"),
							refreshToken: optionalSecret(form, "refreshToken"),
							clientId: optional(form, "oauthClientId"),
							tenant: optional(form, "oauthTenant") || "consumers",
						}
					: fail("Select a supported authentication type");
	}
	return {
		name: validName(required(form, "name")),
		email: validEmail(required(form, "email")),
		imap: {
			host: validHost(required(form, "imapHost"), "IMAP host"),
			port: validPort(required(form, "imapPort"), "IMAP port"),
			secure: checkbox(form, "imapSecure"),
		},
		smtp: checkbox(form, "smtpEnabled")
			? {
					host: validHost(required(form, "smtpHost"), "SMTP host"),
					port: validPort(required(form, "smtpPort"), "SMTP port"),
					secure: checkbox(form, "smtpSecure"),
				}
			: undefined,
		auth,
	};
}

function value(form: FormData, name: string): string {
	const input = form.get(name);
	return typeof input === "string" ? input.trim() : "";
}

function required(form: FormData, name: string): string {
	const input = value(form, name);
	if (!input) throw new Error(`${name} is required`);
	return input;
}

function optional(form: FormData, name: string): string | undefined {
	return value(form, name) || undefined;
}

function requiredSecret(form: FormData, name: string): string {
	const input = form.get(name);
	if (typeof input !== "string" || !input) throw new Error(`${name} is required`);
	return input;
}

function optionalSecret(form: FormData, name: string): string | undefined {
	const input = form.get(name);
	return typeof input === "string" && input ? input : undefined;
}

function checkbox(form: FormData, name: string): boolean {
	return form.get(name) === "on";
}

function validPort(input: string, label: string): number {
	const port = Number(input);
	if (!Number.isInteger(port) || port < 1 || port > 65_535)
		throw new Error(`${label} must be between 1 and 65535`);
	return port;
}

function validEmail(input: string): string {
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) throw new Error("Enter a valid email address");
	return input;
}

function validName(input: string): string {
	if (input.length > 100) throw new Error("Display name must be 100 characters or fewer");
	return input;
}

function validHost(input: string, label: string): string {
	if (
		input.length > 253 ||
		!/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(
			input,
		)
	)
		throw new Error(`${label} is invalid`);
	return input;
}

function fail(message: string): never {
	throw new Error(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!,
	);
}

export default app;
