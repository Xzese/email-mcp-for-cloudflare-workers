import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { simpleParser } from "mailparser";
import { senderSettings, configuredSender } from "../src/mail/sender.ts";
import { buildDraftMessage } from "../src/mail/mime.ts";
import { encrypt } from "../src/crypto.ts";
import type { MailAccount } from "../src/mail/types.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { transformSync } = await import("esbuild");
// Compile before installing module hooks to avoid reentrant loading in esbuild's sync service.
const sourceRoot = new URL("../src/", import.meta.url);
const compiled = new Map(
	readdirSync(sourceRoot, { recursive: true })
		.filter((name) => name.endsWith(".ts"))
		.map((name) => {
			const url = new URL(name, sourceRoot);
			return [
				url.href,
				transformSync(readFileSync(url, "utf8"), {
					loader: "ts",
					format: "esm",
					target: "es2022",
				}).code,
			];
		}),
);

// Load Worker modules in Node; every network operation must be explicitly mocked.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "agents/mcp")
			return {
				url: "data:text/javascript,export class McpAgent { static serve() { return {}; } }",
				shortCircuit: true,
			};
		if (specifier === "cloudflare:sockets")
			return {
				url: 'data:text/javascript,export function connect() { throw new Error("Unexpected network connection in sender test"); }',
				shortCircuit: true,
			};
		if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
			const url = new URL(`${specifier}.ts`, context.parentURL);
			if (existsSync(url)) return nextResolve(url.href, context);
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (compiled.has(url))
			return { format: "module", shortCircuit: true, source: compiled.get(url) };
		return nextLoad(url, context);
	},
});

const { AccountStore } = await import("../src/mail/account-store.ts");
const { MailService } = await import("../src/mail/mail-service.ts");
const { NativeImapSession } = await import("../src/mail/native-imap.ts");
const { NativeSmtpSession } = await import("../src/mail/native-smtp.ts");
const { default: app } = await import("../src/app.ts");
const { MyMCP } = await import("../src/index.ts");
const encryptionKey = Buffer.alloc(32, 3).toString("base64");

function account(overrides: Partial<MailAccount> = {}): MailAccount {
	return {
		id: "account-1",
		name: "iCloud",
		email: "login@icloud.com",
		aliases: ["personal@icloud.com", "work@icloud.com"],
		defaultFrom: "personal@icloud.com",
		imap: { host: "imap.mail.me.com", port: 993, secure: true },
		smtp: { host: "smtp.mail.me.com", port: 465, secure: true },
		auth: { type: "password", password: "stored-secret" },
		...overrides,
	};
}

async function fixture(initial = account()) {
	let data = await encrypt(new TextEncoder().encode(JSON.stringify([initial])), encryptionKey);
	const kv = {
		async get() {
			return data;
		},
		async put(_key: string, value: ArrayBuffer) {
			data = value;
		},
	};
	const store = new AccountStore(kv as unknown as KVNamespace, encryptionKey);
	return {
		store,
		mail: new MailService(store),
		env: { EMAIL_KV: kv, CREDENTIAL_ENCRYPTION_KEY: encryptionKey },
	};
}

function mockImap(t: any, original?: string) {
	const saved: Uint8Array[] = [];
	t.mock.method(NativeImapSession.prototype, "connect", async () => {});
	t.mock.method(NativeImapSession.prototype, "close", async () => {});
	t.mock.method(NativeImapSession.prototype, "getMessage", async () => ({
		source: new TextEncoder().encode(original),
		flags: ["\\Draft"],
	}));
	t.mock.method(NativeImapSession.prototype, "createDraft", async (source: Uint8Array) => {
		saved.push(source);
		return { folder: "Drafts", uid: 42 };
	});
	t.mock.method(
		NativeImapSession.prototype,
		"replaceDraft",
		async (_folder: string, _uid: number, source: Uint8Array) => {
			saved.push(source);
			return { folder: "Drafts", uid: 43 };
		},
	);
	return saved;
}

function original(from = "other@example.com") {
	return `From: ${from}\r\nTo: Personal <PERSONAL@icloud.com>, login@icloud.com, colleague@example.com\r\nCc: work@icloud.com, colleague@example.com\r\nSubject: Hello\r\nMessage-ID: <original@example.com>\r\n\r\nOriginal body`;
}

test("legacy accounts retain their login sender; aliases normalize and deduplicate", () => {
	assert.deepEqual(senderSettings({ email: "login@icloud.com" }), {
		aliases: [],
		defaultFrom: "login@icloud.com",
	});
	assert.deepEqual(
		senderSettings({
			...account(),
			aliases: [" personal@icloud.com ", "PERSONAL@icloud.com", "LOGIN@icloud.com"],
		}),
		{
			aliases: ["personal@icloud.com"],
			defaultFrom: "personal@icloud.com",
		},
	);
	assert.equal(configuredSender(account(), "WORK@icloud.com"), "work@icloud.com");
	for (const from of [
		"foreign@example.com",
		"personal@icloud.com\r\nBcc: attacker@example.com",
		"personal@icloud.com, work@icloud.com",
	]) {
		assert.throws(() => configuredSender(account(), from));
	}
	assert.throws(() => senderSettings({ ...account(), aliases: ["invalid"] }));
});

test("encrypted sender updates preserve credentials and reject removing the current default", async () => {
	const { store } = await fixture();
	await store.updateSender(undefined, { defaultFrom: "work@icloud.com" });
	assert.equal((await store.get()).defaultFrom, "work@icloud.com");
	assert.deepEqual((await store.get()).auth, account().auth);
	await assert.rejects(
		store.updateSender(undefined, { aliases: [] }),
		/From address is not configured/,
	);
	assert.deepEqual((await store.get()).aliases, account().aliases);
	await store.updateSender(undefined, { aliases: [], defaultFrom: "login@icloud.com" });
	assert.deepEqual((await store.get()).aliases, []);
	assert.equal((await store.get()).email, "login@icloud.com");
	assert.deepEqual((await store.get()).auth, account().auth);
});

test("new drafts use the configured default and accept per-message aliases", async (t) => {
	const { mail } = await fixture();
	const saved = mockImap(t);
	const result = await mail.createDraft({
		to: "other@example.com",
		subject: "Test",
		text: "Body",
	});
	assert.equal(result.from, "personal@icloud.com");
	assert.equal((await simpleParser(Buffer.from(saved[0]))).from?.value[0].address, result.from);
	await mail.createDraft({
		from: "work@icloud.com",
		to: "other@example.com",
		subject: "Test",
		text: "Body",
	});
	assert.equal(
		(await simpleParser(Buffer.from(saved[1]))).from?.value[0].address,
		"work@icloud.com",
	);
	await assert.rejects(
		mail.createDraft({ from: "foreign@example.com", to: "other@example.com", subject: "Test" }),
		/From address is not configured/,
	);
	assert.equal(saved.length, 2);
});

test("reply-all excludes every own alias and still respects recipient overrides", async (t) => {
	const { mail } = await fixture();
	const saved = mockImap(t, original());
	await mail.createDraft({
		text: "Reply",
		replyToMessage: { folder: "INBOX", uid: 1, replyAll: true },
	});
	const parsed = await simpleParser(Buffer.from(saved[0]));
	assert.equal(parsed.from?.value[0].address, "personal@icloud.com");
	assert.equal(parsed.to?.text, "other@example.com");
	assert.equal(parsed.cc?.text, "colleague@example.com");
	assert.equal(parsed.inReplyTo, "<original@example.com>");
	await mail.createDraft({
		to: "work@icloud.com",
		cc: ["login@icloud.com"],
		text: "Override",
		replyToMessage: { folder: "INBOX", uid: 1, replyAll: true },
	});
	const overridden = await simpleParser(Buffer.from(saved[1]));
	assert.equal(overridden.to?.text, "work@icloud.com");
	assert.equal(overridden.cc?.text, "login@icloud.com");
});

test("forwards accept an alias and draft edits preserve or explicitly change their From", async (t) => {
	const { mail, store } = await fixture();
	const saved = mockImap(t, original("Personal <personal@icloud.com>"));
	const forwarded = await mail.createForwardDraft({
		folder: "INBOX",
		uid: 1,
		to: "other@example.com",
		from: "work@icloud.com",
	});
	assert.equal(forwarded.from, "work@icloud.com");
	assert.equal(
		(await simpleParser(Buffer.from(saved[0]))).from?.value[0].address,
		"work@icloud.com",
	);
	await store.updateSender(undefined, { defaultFrom: "login@icloud.com" });
	const edited = await mail.editDraft({ folder: "Drafts", uid: 1, text: "Edited" });
	assert.equal(edited.from, "personal@icloud.com");
	assert.equal(
		(await simpleParser(Buffer.from(saved[1]))).from?.value[0].address,
		"personal@icloud.com",
	);
	const changed = await mail.editDraft({ folder: "Drafts", uid: 1, from: "work@icloud.com" });
	assert.equal(changed.from, "work@icloud.com");
	assert.equal(
		(await simpleParser(Buffer.from(saved[2]))).from?.value[0].address,
		"work@icloud.com",
	);
	await assert.rejects(
		mail.editDraft({ folder: "Drafts", uid: 1, from: "foreign@example.com" }),
		/From address is not configured/,
	);
	assert.equal(saved.length, 3);
});

for (const auth of [account().auth, { type: "oauth2" as const, accessToken: "stored-token" }]) {
	test(`SMTP ${auth.type} authenticates as login email and sends the saved alias`, async (t) => {
		const session = new NativeSmtpSession(account({ auth })) as any;
		const commands: string[] = [];
		const outgoing: string[] = [];
		t.mock.method(session, "open", async () => {});
		t.mock.method(session, "quit", async () => {});
		t.mock.method(session, "expect", async () => []);
		t.mock.method(session, "command", async (value: string) => {
			commands.push(value);
			return [];
		});
		t.mock.method(session, "write", async (value: string) => {
			outgoing.push(value);
		});
		const draft = buildDraftMessage("work@icloud.com", {
			to: "other@example.com",
			bcc: "hidden@example.com",
			subject: "Test",
			text: "Body",
		});
		const result = await session.sendRaw(draft.source);
		assert.equal(result.from, "work@icloud.com");
		assert.ok(commands.includes("MAIL FROM:<work@icloud.com>"));
		assert.ok(commands.includes("RCPT TO:<hidden@example.com>"));
		assert.match(outgoing[0], /^From: work@icloud.com\r\n/);
		assert.doesNotMatch(outgoing[0], /^Bcc:/m);
		if (auth.type === "password") {
			assert.ok(commands.includes(btoa("login@icloud.com")));
			assert.ok(commands.includes(btoa(auth.password)));
		} else {
			const payload = commands.find((value) => value.startsWith("AUTH XOAUTH2 "))!;
			assert.equal(
				atob(payload.slice("AUTH XOAUTH2 ".length)),
				`user=login@icloud.com\x01auth=Bearer stored-token\x01\x01`,
			);
		}
	});
}

test("SMTP rejects missing, multiple, or removed senders before connecting", async (t) => {
	const session = new NativeSmtpSession(account()) as any;
	const open = t.mock.method(session, "open", async () => {});
	for (const from of ["foreign@example.com", "personal@icloud.com, work@icloud.com"]) {
		await assert.rejects(
			session.sendRaw(
				buildDraftMessage(from, { to: "other@example.com", subject: "Test" }).source,
			),
		);
	}
	await assert.rejects(
		session.sendRaw(
			new TextEncoder().encode("To: other@example.com\r\nSubject: Test\r\n\r\nBody"),
		),
	);
	assert.equal(open.mock.callCount(), 0);
});

test("web sender changes save without connecting and keep the OAuth identity", async () => {
	const { store, env } = await fixture(
		account({
			auth: { type: "oauth2", accessToken: "private-token", refreshToken: "private-refresh" },
		}),
	);
	const form = new URLSearchParams({
		name: "iCloud",
		email: "login@icloud.com",
		aliases: "personal@icloud.com, work@icloud.com",
		defaultFrom: "work@icloud.com",
		imapHost: "imap.mail.me.com",
		imapPort: "993",
		imapSecure: "on",
		smtpEnabled: "on",
		smtpHost: "smtp.mail.me.com",
		smtpPort: "465",
		smtpSecure: "on",
	});
	const response = await app.request(
		"https://mail.example.com/accounts/account-1/update",
		{
			method: "POST",
			headers: { origin: "https://mail.example.com" },
			body: form,
		},
		env as any,
	);
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), "/?status=updated");
	assert.equal((await store.get()).defaultFrom, "work@icloud.com");
	assert.equal((await store.get()).email, "login@icloud.com");
	assert.deepEqual((await store.get()).auth, {
		type: "oauth2",
		accessToken: "private-token",
		refreshToken: "private-refresh",
	});
	const page = await app.request("https://mail.example.com/?edit=account-1", {}, env as any);
	const html = await page.text();
	assert.match(html, /name="defaultFrom"[^>]*value="work@icloud.com"/);
	assert.match(html, /name="aliases"[^>]*value="personal@icloud.com, work@icloud.com"/);
	assert.doesNotMatch(html, /private-token|private-refresh/);
	form.set("defaultFrom", "foreign@example.com");
	const rejected = await app.request(
		"https://mail.example.com/accounts/account-1/update",
		{
			method: "POST",
			headers: { origin: "https://mail.example.com" },
			body: form,
		},
		env as any,
	);
	assert.equal(rejected.status, 400);
	assert.equal((await store.get()).defaultFrom, "work@icloud.com");
});

test("MCP exposes sender settings and validates structured account and draft outputs", async (t) => {
	const { store, env } = await fixture();
	const agent = new MyMCP();
	(agent as any).env = env;
	await agent.init();
	const client = new Client({ name: "sender-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await agent.server.connect(serverTransport);
	await client.connect(clientTransport);
	t.after(async () => {
		await client.close();
		await agent.server.close();
	});
	t.mock.method(console, "log", () => {});
	t.mock.method(console, "error", () => {});
	const tools = (await client.listTools()).tools;
	const updateTool = tools.find((tool) => tool.name === "email_update_account_sender")!;
	assert.ok(updateTool.outputSchema);
	assert.equal(updateTool.annotations?.openWorldHint, false);
	assert.equal(updateTool.annotations?.readOnlyHint, false);
	assert.equal(updateTool.annotations?.idempotentHint, true);
	const listed = await client.callTool({ name: "email_list_accounts", arguments: {} });
	assert.ok(listed.structuredContent);
	assert.equal(
		(listed.structuredContent.accounts as any[])[0].defaultFrom,
		"personal@icloud.com",
	);
	assert.doesNotMatch(JSON.stringify(listed), /stored-secret/);
	const updated = await client.callTool({
		name: "email_update_account_sender",
		arguments: { accountId: "account-1", defaultFrom: "work@icloud.com" },
	});
	assert.deepEqual(updated.structuredContent, {
		accountId: "account-1",
		email: "login@icloud.com",
		aliases: account().aliases,
		defaultFrom: "work@icloud.com",
	});
	assert.deepEqual((await store.get()).auth, account().auth);
	const invalid = await client.callTool({
		name: "email_update_account_sender",
		arguments: { defaultFrom: "foreign@example.com" },
	});
	assert.equal(invalid.isError, true);
	assert.equal((await store.get()).defaultFrom, "work@icloud.com");
	const saved = mockImap(t);
	const draft = await client.callTool({
		name: "email_create_message_draft",
		arguments: { to: "other@example.com", subject: "MCP alias", text: "Body" },
	});
	assert.equal(draft.isError, undefined);
	assert.equal(draft.structuredContent?.from, "work@icloud.com");
	assert.equal(
		(await simpleParser(Buffer.from(saved[0]))).from?.value[0].address,
		"work@icloud.com",
	);
});
