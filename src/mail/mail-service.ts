import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { Buffer } from "node:buffer";
import { safeErrorCategory } from "../observability";
import type { AccountStore } from "./account-store";
import type { MailAccount } from "./types";
import { NativeImapSession } from "./native-imap";
import { buildDraftMessage, NativeSmtpSession, type DraftInput } from "./native-smtp";

interface CreateDraftInput extends Omit<DraftInput, "to" | "subject"> {
	accountId?: string;
	to?: string | string[];
	subject?: string;
	replyToMessage?: {
		folder: string;
		uid: number;
		replyAll?: boolean;
		quoteOriginal?: boolean;
	};
}

interface SearchFilters {
	folder: string;
	from?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	body?: string;
	text?: string;
	messageId?: string;
	since?: string;
	before?: string;
	on?: string;
	sentSince?: string;
	sentBefore?: string;
	seen?: "any" | "seen" | "unseen";
	flagged?: "any" | "flagged" | "unflagged";
	answered?: "any" | "answered" | "unanswered";
	draft?: "any" | "draft" | "not_draft";
	deleted?: "any" | "deleted" | "not_deleted";
	keyword?: string;
	largerThan?: number;
	smallerThan?: number;
	limit: number;
	cursor?: string;
	sortOrder?: "newest" | "oldest";
}

interface MultiAccountInput {
	accountIds?: string[];
	folder: string;
}

export class MailService {
	constructor(
		private store: AccountStore,
		private outlookOAuth?: { clientId?: string; clientSecret?: string },
	) {}

	async testConnection(accountId?: string) {
		const account = await this.authorizedAccount(accountId);
		return this.testAccount(account);
	}

	async testAccount(account: MailAccount) {
		const session = new NativeImapSession(account);
		let capabilities: string[];
		try {
			await session.connect();
			capabilities = await session.capabilities();
		} finally {
			await session.close();
		}
		if (account.smtp) await new NativeSmtpSession(account).testConnection();
		return {
			connected: true,
			accountId: account.id,
			email: account.email,
			capabilities,
			smtpConfigured: Boolean(account.smtp),
			smtpConnected: account.smtp ? true : undefined,
		};
	}

	async listFolders(accountId?: string) {
		const account = await this.authorizedAccount(accountId);
		const session = new NativeImapSession(account);
		try {
			await session.connect();
			return await session.listFolders();
		} finally {
			await session.close();
		}
	}

	async mailboxStatus(accountId: string | undefined, folder: string) {
		return this.withImap(accountId, async (session, account) => ({
			accountId: account.id,
			...(await session.mailboxStatus(folder)),
		}));
	}

	async mailboxStatusAll(input: MultiAccountInput) {
		const accounts = await this.selectedAccounts(input.accountIds);
		const results = await mapConcurrent(accounts, 3, async (account) => {
			try {
				const authorized = await this.authorizedAccount(account.id);
				const status = await this.withImapAccount(authorized, async (session) =>
					session.mailboxStatus(input.folder),
				);
				return {
					accountId: authorized.id,
					accountName: authorized.name,
					accountEmail: authorized.email,
					ok: true as const,
					...status,
				};
			} catch (error) {
				return {
					accountId: account.id,
					accountName: account.name,
					accountEmail: account.email,
					ok: false as const,
					folder: input.folder,
					error: errorMessage(error),
				};
			}
		});
		return {
			status: "ok" as const,
			count: results.length,
			succeeded: results.filter((result) => result.ok).length,
			failed: results.filter((result) => !result.ok).length,
			accounts: results,
		};
	}

	async search(
		input: {
			accountId?: string;
		} & SearchFilters,
	) {
		return this.withImap(input.accountId, async (session, account) => {
			const cursorKey = searchCursorKey(input, account.id);
			const offset = decodeSearchCursor(input.cursor, cursorKey);
			const result = await session.search({ ...input, offset });
			const messages = result.messages;
			const empty = messages.length === 0;
			const nextOffset = offset + messages.length;
			return {
				status: "ok" as const,
				outcome: empty ? ("no_matches" as const) : ("matches_found" as const),
				accountId: account.id,
				folder: input.folder,
				count: messages.length,
				total: result.total,
				empty,
				cursor: input.cursor,
				nextCursor:
					nextOffset < result.total
						? encodeSearchCursor(nextOffset, cursorKey)
						: undefined,
				message: empty
					? "Search completed successfully. No messages matched the search criteria; this is not an IMAP or folder error."
					: `Search completed successfully with ${messages.length} matching message${messages.length === 1 ? "" : "s"}.`,
				messages,
			};
		});
	}

	async searchAll(input: Omit<SearchFilters, "cursor"> & { accountIds?: string[] }) {
		const accounts = await this.selectedAccounts(input.accountIds);
		const results = await mapConcurrent(accounts, 3, async (account) => {
			try {
				const authorized = await this.authorizedAccount(account.id);
				const cursorKey = searchCursorKey(input, authorized.id);
				const result = await this.withImapAccount(authorized, async (session) =>
					session.search({ ...input, offset: 0 }),
				);
				const messages = result.messages.map((message) => ({
					...message,
					accountName: authorized.name,
					accountEmail: authorized.email,
				}));
				const nextCursor =
					messages.length < result.total
						? encodeSearchCursor(messages.length, cursorKey)
						: undefined;
				return {
					accountId: authorized.id,
					accountName: authorized.name,
					accountEmail: authorized.email,
					ok: true as const,
					folder: input.folder,
					count: messages.length,
					total: result.total,
					nextCursor,
					messages,
				};
			} catch (error) {
				return {
					accountId: account.id,
					accountName: account.name,
					accountEmail: account.email,
					ok: false as const,
					folder: input.folder,
					count: 0,
					total: 0,
					error: errorMessage(error),
					messages: [],
				};
			}
		});
		const messages = results
			.flatMap((result) => result.messages)
			.sort((left, right) => compareSearchMessages(left, right, input.sortOrder ?? "newest"));
		const total = results.reduce((sum, result) => sum + result.total, 0);
		const failures = results.filter((result) => !result.ok).length;
		return {
			status: "ok" as const,
			outcome: messages.length ? ("matches_found" as const) : ("no_matches" as const),
			count: messages.length,
			total,
			empty: messages.length === 0,
			succeeded: results.length - failures,
			failed: failures,
			message: messages.length
				? `Search completed across ${results.length} account${results.length === 1 ? "" : "s"} with ${messages.length} matching message${messages.length === 1 ? "" : "s"}.`
				: `Search completed across ${results.length} account${results.length === 1 ? "" : "s"}. No messages matched the search criteria.`,
			accounts: results.map(({ messages: _messages, ...result }) => result),
			messages,
		};
	}

	async listAllInboxes(input: {
		accountIds?: string[];
		limit: number;
		sortOrder?: "newest" | "oldest";
	}) {
		return this.searchAll({
			accountIds: input.accountIds,
			folder: "INBOX",
			seen: "any",
			flagged: "any",
			answered: "any",
			draft: "any",
			deleted: "any",
			limit: input.limit,
			sortOrder: input.sortOrder ?? "newest",
		});
	}

	async getThread(accountId: string | undefined, folder: string, uid: number, limit: number) {
		return this.withImap(accountId, async (session, account) => ({
			accountId: account.id,
			...(await session.getThread(folder, uid, limit)),
		}));
	}

	async getMessage(accountId: string | undefined, folder: string, uid: number) {
		return this.withImap(accountId, async (session, account) => {
			const message = await session.getMessage(folder, uid);
			const parsed = await simpleParser(Buffer.from(message.source));
			const references = normalizeReferences(parsed.references);
			return {
				accountId: account.id,
				uid,
				messageId: parsed.messageId,
				inReplyTo: parsed.inReplyTo,
				references,
				threadId: references[0] ?? parsed.inReplyTo ?? parsed.messageId,
				subject: parsed.subject,
				from: parsed.from?.text,
				to: parsed.to,
				cc: parsed.cc,
				date: parsed.date?.toISOString(),
				text: parsed.text,
				html: typeof parsed.html === "string" ? parsed.html : undefined,
				attachments: parsed.attachments.map((item, attachmentIndex) => ({
					attachmentIndex,
					filename: item.filename,
					contentType: item.contentType,
					size: item.size,
				})),
				flags: [...(message.flags ?? [])],
			};
		});
	}

	async getAttachment(
		accountId: string | undefined,
		folder: string,
		uid: number,
		attachmentIndex: number,
	) {
		return this.withImap(accountId, async (session, account) => {
			const message = await session.getMessage(folder, uid);
			const parsed = await simpleParser(Buffer.from(message.source));
			const attachment = parsed.attachments[attachmentIndex];
			if (!attachment)
				throw new Error(
					`Attachment index ${attachmentIndex} was not found on message UID ${uid}`,
				);
			return {
				accountId: account.id,
				folder,
				uid,
				attachmentIndex,
				filename: attachment.filename,
				contentType: attachment.contentType,
				size: attachment.size,
				contentId: attachment.cid,
				contentBase64: attachment.content.toString("base64"),
			};
		});
	}

	async mark(
		accountId: string | undefined,
		folder: string,
		uid: number | number[],
		states: { seen?: boolean; flagged?: boolean },
	) {
		return this.withImap(accountId, async (session) => {
			await session.mark(folder, uid, states);
			return { uid, ...states };
		});
	}

	async move(
		accountId: string | undefined,
		folder: string,
		uid: number | number[],
		targetFolder: string,
	) {
		return this.withImap(accountId, async (session) => {
			await session.move(folder, uid, targetFolder);
			return { uid, from: folder, to: targetFolder };
		});
	}

	async delete(accountId: string | undefined, folder: string, uid: number | number[]) {
		return this.withImap(accountId, async (session) => {
			await session.delete(folder, uid);
			return { uid, deleted: true };
		});
	}

	async trash(accountId: string | undefined, folder: string, uid: number | number[]) {
		return this.withImap(accountId, async (session) => {
			const destination = await session.trash(folder, uid);
			return { uid, from: folder, to: destination.folder, trashed: true };
		});
	}

	async archive(accountId: string | undefined, folder: string, uid: number | number[]) {
		return this.withImap(accountId, async (session) => {
			const destination = await session.archive(folder, uid);
			return { uid, from: folder, to: destination.folder, archived: true };
		});
	}

	async createDraft(input: CreateDraftInput) {
		const account = await this.authorizedAccount(input.accountId);
		let draftInput: DraftInput;
		if (input.replyToMessage) {
			const parsed = await this.parsedMessage(
				input.accountId,
				input.replyToMessage.folder,
				input.replyToMessage.uid,
			);
			const primary = input.to
				? list(input.to)
				: addressList(parsed.replyTo ?? parsed.from).filter(
						(address) => normalizeAddress(address) !== normalizeAddress(account.email),
					);
			if (primary.length === 0) throw new Error("The original message has no reply address");
			const copied = input.cc
				? list(input.cc)
				: input.replyToMessage.replyAll
					? uniqueAddresses([
							...addressList(parsed.to),
							...addressList(parsed.cc),
						]).filter(
							(address) =>
								normalizeAddress(address) !== normalizeAddress(account.email) &&
								!primary.some(
									(recipient) =>
										normalizeAddress(recipient) === normalizeAddress(address),
								),
						)
					: undefined;
			const quoted =
				input.replyToMessage.quoteOriginal === false ? undefined : quotedOriginal(parsed);
			draftInput = {
				...input,
				to: primary,
				cc: copied,
				subject: input.subject || prefixedSubject(parsed.subject, "Re:"),
				text: input.text === undefined ? undefined : appendText(input.text, quoted?.text),
				html: input.html === undefined ? undefined : appendHtml(input.html, quoted?.html),
				inReplyTo: parsed.messageId,
				references: messageReferences(parsed),
			};
		} else {
			if (!input.to) throw new Error("Provide to or replyToMessage");
			if (input.subject === undefined) throw new Error("Provide subject for a new draft");
			draftInput = { ...input, to: input.to, subject: input.subject };
		}
		const draft = buildDraftMessage(account.email, draftInput);
		const location = await this.withImap(input.accountId, (session) =>
			session.createDraft(draft.source, draft.messageId),
		);
		return { accountId: account.id, ...location, messageId: draft.messageId };
	}

	async createForwardDraft(input: {
		accountId?: string;
		folder: string;
		uid: number;
		to: string | string[];
		cc?: string | string[];
		bcc?: string | string[];
		replyTo?: string;
		subject?: string;
		text?: string;
		html?: string;
		includeAttachments?: boolean;
	}) {
		const parsed = await this.parsedMessage(input.accountId, input.folder, input.uid);
		const forwarded = forwardedOriginal(parsed);
		const includeBothFormats = input.text === undefined && input.html === undefined;
		return this.createDraft({
			accountId: input.accountId,
			to: input.to,
			cc: input.cc,
			bcc: input.bcc,
			replyTo: input.replyTo,
			subject: input.subject ?? prefixedSubject(parsed.subject, "Fwd:"),
			text:
				input.text !== undefined || includeBothFormats
					? appendText(input.text, forwarded.text)
					: undefined,
			html:
				input.html !== undefined || includeBothFormats
					? appendHtml(input.html, forwarded.html)
					: undefined,
			attachments: input.includeAttachments === false ? undefined : draftAttachments(parsed),
		});
	}

	async editDraft(input: {
		accountId?: string;
		folder: string;
		uid: number;
		to?: string | string[];
		cc?: string | string[];
		bcc?: string | string[];
		replyTo?: string;
		subject?: string;
		text?: string;
		html?: string;
		attachments?: DraftInput["attachments"];
	}) {
		const account = await this.authorizedAccount(input.accountId);
		return this.withImap(input.accountId, async (session) => {
			const existing = await session.getMessage(input.folder, input.uid);
			if (!existing.flags.some((flag) => flag.toLowerCase() === "\\draft"))
				throw new Error(`Message UID ${input.uid} is not marked as an IMAP draft`);
			const parsed = await simpleParser(Buffer.from(existing.source));
			const draft = buildDraftMessage(account.email, {
				to: input.to ?? addressList(parsed.to),
				cc: input.cc ?? optionalAddresses(parsed.cc),
				bcc: input.bcc ?? optionalAddresses(parsed.bcc),
				replyTo: input.replyTo ?? addressList(parsed.replyTo)[0],
				subject: input.subject ?? parsed.subject ?? "",
				text: input.text ?? parsed.text,
				html: input.html ?? (typeof parsed.html === "string" ? parsed.html : undefined),
				attachments: input.attachments ?? draftAttachments(parsed),
				inReplyTo: parsed.inReplyTo,
				references: normalizeReferences(parsed.references),
			});
			const location = await session.replaceDraft(
				input.folder,
				input.uid,
				draft.source,
				draft.messageId,
			);
			return {
				accountId: account.id,
				replaced: { folder: input.folder, uid: input.uid },
				...location,
				messageId: draft.messageId,
			};
		});
	}

	async sendDraft(accountId: string | undefined, folder: string, uid: number) {
		const account = await this.authorizedAccount(accountId);
		if (!account.smtp)
			throw new Error(
				`SMTP is not configured for account ${account.name}; sending email is unavailable`,
			);
		const draft = await this.withImap(accountId, (session) => session.getMessage(folder, uid));
		const result = await new NativeSmtpSession(account).sendRaw(draft.source);
		let sentSaved = true;
		let sentLocation: { folder: string; uid: number } | undefined;
		let sentError: string | undefined;
		try {
			sentLocation = await this.withImap(accountId, (session) =>
				session.saveSent(draft.source, result.messageId),
			);
		} catch (error) {
			sentSaved = false;
			sentError = error instanceof Error ? error.message : String(error);
			console.error({
				event: "sent_append",
				status: "error",
				accountId: account.id,
				folder,
				uid,
				error: safeErrorCategory(error),
			});
		}
		let draftDeleted = true;
		try {
			await this.withImap(accountId, (session) => session.delete(folder, uid));
		} catch (error) {
			draftDeleted = false;
			console.error({
				event: "draft_cleanup",
				status: "error",
				accountId: account.id,
				folder,
				uid,
				error: safeErrorCategory(error),
			});
		}
		return {
			...result,
			accountId: account.id,
			folder,
			uid,
			sentSaved,
			sentFolder: sentLocation?.folder,
			sentUid: sentLocation?.uid,
			sentError,
			draftDeleted,
		};
	}

	private async withImap<T>(
		accountId: string | undefined,
		operation: (session: NativeImapSession, account: MailAccount) => Promise<T>,
	) {
		const account = await this.authorizedAccount(accountId);
		return this.withImapAccount(account, operation);
	}

	private async withImapAccount<T>(
		account: MailAccount,
		operation: (session: NativeImapSession, account: MailAccount) => Promise<T>,
	) {
		const session = new NativeImapSession(account);
		try {
			await session.connect();
			return await operation(session, account);
		} finally {
			await session.close();
		}
	}

	private async selectedAccounts(accountIds?: string[]): Promise<MailAccount[]> {
		const accounts = await this.store.list();
		if (accounts.length === 0) throw new Error("No email accounts configured");
		if (!accountIds?.length) return accounts;

		const requested = [...new Set(accountIds)];
		const found = new Map(accounts.map((account) => [account.id, account]));
		const missing = requested.filter((accountId) => !found.has(accountId));
		if (missing.length) throw new Error(`Account ${missing.join(", ")} not found`);
		return requested.map((accountId) => found.get(accountId)!);
	}

	private async parsedMessage(accountId: string | undefined, folder: string, uid: number) {
		const message = await this.withImap(accountId, (session) =>
			session.getMessage(folder, uid),
		);
		return simpleParser(Buffer.from(message.source));
	}

	private async authorizedAccount(accountId?: string): Promise<MailAccount> {
		const account = await this.store.get(accountId);
		if (account.auth.type !== "oauth2" || !account.auth.refreshToken || !account.auth.clientId)
			return account;
		if (account.auth.expiresAt && account.auth.expiresAt > Date.now() + 60_000) return account;
		const endpoint = `https://login.microsoftonline.com/${account.auth.tenant ?? "consumers"}/oauth2/v2.0/token`;
		const body = new URLSearchParams({
			client_id: account.auth.clientId,
			grant_type: "refresh_token",
			refresh_token: account.auth.refreshToken,
			scope: "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
		});
		if (this.outlookOAuth?.clientSecret && this.outlookOAuth.clientId === account.auth.clientId)
			body.set("client_secret", this.outlookOAuth.clientSecret);
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		if (!response.ok) throw new Error(`Outlook token refresh failed (${response.status})`);
		const token = await response.json<{
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		}>();
		account.auth.accessToken = token.access_token;
		account.auth.refreshToken = token.refresh_token ?? account.auth.refreshToken;
		account.auth.expiresAt = Date.now() + token.expires_in * 1000;
		await this.store.update(account);
		return account;
	}
}

function searchCursorKey(
	input: {
		folder: string;
		from?: string;
		to?: string;
		cc?: string;
		bcc?: string;
		subject?: string;
		body?: string;
		text?: string;
		messageId?: string;
		since?: string;
		before?: string;
		on?: string;
		sentSince?: string;
		sentBefore?: string;
		seen?: "any" | "seen" | "unseen";
		flagged?: "any" | "flagged" | "unflagged";
		answered?: "any" | "answered" | "unanswered";
		draft?: "any" | "draft" | "not_draft";
		deleted?: "any" | "deleted" | "not_deleted";
		keyword?: string;
		largerThan?: number;
		smallerThan?: number;
		sortOrder?: "newest" | "oldest";
	},
	accountId: string,
): string {
	return JSON.stringify({
		accountId,
		folder: input.folder,
		from: input.from,
		to: input.to,
		cc: input.cc,
		bcc: input.bcc,
		subject: input.subject,
		body: input.body,
		text: input.text,
		messageId: input.messageId,
		since: input.since,
		before: input.before,
		on: input.on,
		sentSince: input.sentSince,
		sentBefore: input.sentBefore,
		seen: input.seen,
		flagged: input.flagged,
		answered: input.answered,
		draft: input.draft,
		deleted: input.deleted,
		keyword: input.keyword,
		largerThan: input.largerThan,
		smallerThan: input.smallerThan,
		sortOrder: input.sortOrder ?? "newest",
	});
}

function encodeSearchCursor(offset: number, key: string): string {
	return Buffer.from(JSON.stringify({ offset, key })).toString("base64url");
}

function decodeSearchCursor(cursor: string | undefined, key: string): number {
	if (!cursor) return 0;
	try {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
			offset?: unknown;
			key?: unknown;
		};
		if (
			decoded.key !== key ||
			typeof decoded.offset !== "number" ||
			!Number.isSafeInteger(decoded.offset) ||
			decoded.offset < 0
		)
			throw new Error();
		return decoded.offset;
	} catch {
		throw new Error("Search cursor is invalid or belongs to different search criteria");
	}
}

async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	operation: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex++;
			results[currentIndex] = await operation(items[currentIndex]);
		}
	});
	await Promise.all(workers);
	return results;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compareSearchMessages(
	left: { uid: number; date?: string },
	right: { uid: number; date?: string },
	sortOrder: "newest" | "oldest",
): number {
	const parsedLeft = left.date ? new Date(left.date).valueOf() : Number.NaN;
	const parsedRight = right.date ? new Date(right.date).valueOf() : Number.NaN;
	const leftTime = Number.isFinite(parsedLeft) ? parsedLeft : left.uid;
	const rightTime = Number.isFinite(parsedRight) ? parsedRight : right.uid;
	return sortOrder === "newest" ? rightTime - leftTime : leftTime - rightTime;
}

function addressList(value?: AddressObject | AddressObject[]): string[] {
	if (!value) return [];
	return (Array.isArray(value) ? value : [value]).flatMap((entry) =>
		entry.value.map(({ address, name }) =>
			address ? (name ? `${name} <${address}>` : address) : name,
		),
	);
}

function optionalAddresses(value?: AddressObject | AddressObject[]): string[] | undefined {
	const addresses = addressList(value);
	return addresses.length ? addresses : undefined;
}

function list(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

function normalizeAddress(value: string): string {
	return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

function uniqueAddresses(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const normalized = normalizeAddress(value);
		if (!normalized || seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	});
}

function normalizeReferences(value?: string | string[]): string[] {
	return value ? (Array.isArray(value) ? value : [value]) : [];
}

function messageReferences(parsed: ParsedMail): string[] {
	return [
		...normalizeReferences(parsed.references),
		...(parsed.messageId ? [parsed.messageId] : []),
	];
}

function prefixedSubject(subject: string | undefined, prefix: string): string {
	const current = subject ?? "";
	return current.toLowerCase().startsWith(prefix.toLowerCase())
		? current
		: `${prefix} ${current}`.trim();
}

function draftAttachments(parsed: ParsedMail): NonNullable<DraftInput["attachments"]> {
	return parsed.attachments.map((attachment) => ({
		filename: attachment.filename ?? "attachment",
		contentType: attachment.contentType,
		contentBase64: attachment.content.toString("base64"),
	}));
}

function quotedOriginal(parsed: ParsedMail): { text?: string; html?: string } {
	return {
		text: parsed.text
			? parsed.text
					.split(/\r?\n/)
					.map((line) => `> ${line}`)
					.join("\n")
			: undefined,
		html:
			typeof parsed.html === "string" ? `<blockquote>${parsed.html}</blockquote>` : undefined,
	};
}

function forwardedOriginal(parsed: ParsedMail): { text: string; html: string } {
	const from = parsed.from?.text ?? "";
	const to = addressList(parsed.to).join(", ");
	const date = parsed.date?.toISOString() ?? "";
	const subject = parsed.subject ?? "";
	const heading = `---------- Forwarded message ----------\nFrom: ${from}\nDate: ${date}\nSubject: ${subject}\nTo: ${to}`;
	const htmlHeading = `<p>---------- Forwarded message ----------<br>From: ${escapeHtml(from)}<br>Date: ${escapeHtml(date)}<br>Subject: ${escapeHtml(subject)}<br>To: ${escapeHtml(to)}</p>`;
	return {
		text: `${heading}\n\n${parsed.text ?? ""}`,
		html: `${htmlHeading}${typeof parsed.html === "string" ? parsed.html : `<pre>${escapeHtml(parsed.text ?? "")}</pre>`}`,
	};
}

function appendText(introduction?: string, original?: string): string | undefined {
	return (
		[introduction, original]
			.filter((value): value is string => value !== undefined)
			.join("\n\n") || undefined
	);
}

function appendHtml(introduction?: string, original?: string): string | undefined {
	return (
		[introduction, original]
			.filter((value): value is string => value !== undefined)
			.join("<br><br>") || undefined
	);
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
	);
}
