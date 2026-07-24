import { connect } from "cloudflare:sockets";
import type { MailAccount, ServerConfig } from "./types";

export { buildDraftMessage, type DraftInput } from "./mime";

export class NativeSmtpSession {
	private socket?: Socket;
	private reader?: ReadableStreamDefaultReader<Uint8Array>;
	private writer?: WritableStreamDefaultWriter<Uint8Array>;
	private buffered = "";

	private smtp: ServerConfig;

	constructor(private account: MailAccount) {
		if (!account.smtp) throw new Error("SMTP is not configured for this account");
		this.smtp = account.smtp;
	}

	async testConnection() {
		await this.open();
		try {
			await this.handshakeAndAuthenticate();
			return { connected: true };
		} finally {
			await this.quit();
		}
	}

	async sendRaw(source: Uint8Array) {
		const raw = new TextDecoder().decode(source);
		const headers = parseHeaders(raw);
		const recipients = [headers.to, headers.cc, headers.bcc]
			.flatMap((value) => addresses(value))
			.filter((value, index, values) => values.indexOf(value) === index);
		if (recipients.length === 0) throw new Error("Draft has no recipients");
		const messageId = headers["message-id"] ?? undefined;
		await this.open();
		try {
			await this.handshakeAndAuthenticate();
			await this.command(`MAIL FROM:<${this.account.email}>`, [250]);
			for (const recipient of recipients)
				await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
			await this.command("DATA", [354]);
			const outgoing = stripBcc(raw).trimEnd().replace(/^\./gm, "..");
			await this.write(`${outgoing}\r\n.\r\n`);
			await this.expect(undefined, [250]);
			return { messageId, accepted: recipients, rejected: [] as string[] };
		} finally {
			await this.quit();
		}
	}

	private async handshakeAndAuthenticate(): Promise<void> {
		await this.expect(undefined, [220]);
		await this.command(`EHLO email-mcp-worker`, [250]);
		if (!this.smtp.secure) {
			await this.command("STARTTLS", [220]);
			this.reader?.releaseLock();
			this.writer?.releaseLock();
			this.socket = this.socket!.startTls({
				expectedServerHostname: this.smtp.host,
			});
			await withTimeout(this.socket.opened, 12_000, "SMTP STARTTLS timed out");
			this.buffered = "";
			this.acquireStreams();
			await this.command("EHLO email-mcp-worker", [250]);
		}
		await this.authenticate();
	}

	private async quit(): Promise<void> {
		try {
			await this.command("QUIT", [221]);
		} catch {
			// Close the socket even when the server has already disconnected.
		}
		await this.socket?.close().catch(() => undefined);
	}

	private async open(): Promise<void> {
		this.socket = connect(
			{ hostname: this.smtp.host, port: this.smtp.port },
			{
				secureTransport: this.smtp.secure ? "on" : "starttls",
				allowHalfOpen: false,
			},
		);
		await withTimeout(this.socket.opened, 12_000, "SMTP socket connection timed out");
		this.acquireStreams();
	}

	private acquireStreams(): void {
		this.reader = this.socket!.readable.getReader();
		this.writer = this.socket!.writable.getWriter();
	}

	private async authenticate(): Promise<void> {
		if (this.account.auth.type === "oauth2") {
			const payload = `user=${this.account.email}\x01auth=Bearer ${this.account.auth.accessToken}\x01\x01`;
			await this.command(`AUTH XOAUTH2 ${btoa(payload)}`, [235]);
			return;
		}
		await this.command("AUTH LOGIN", [334]);
		await this.command(btoa(this.account.email), [334]);
		await this.command(btoa(this.account.auth.password), [235]);
	}

	private async command(value: string, expected: number[]): Promise<string[]> {
		await this.write(`${value}\r\n`);
		return this.expect(value.split(" ")[0], expected);
	}

	private async write(value: string): Promise<void> {
		await this.writer!.write(new TextEncoder().encode(value));
	}

	private async expect(command: string | undefined, expected: number[]): Promise<string[]> {
		const lines: string[] = [];
		while (true) {
			const line = await withTimeout(
				this.readLine(),
				20_000,
				`SMTP ${command ?? "greeting"} timed out`,
			);
			lines.push(line);
			const match = line.match(/^(\d{3})([ -])/);
			if (!match) continue;
			if (match[2] === "-") continue;
			const code = Number(match[1]);
			if (!expected.includes(code))
				throw new Error(
					`SMTP ${command ?? "connection"} failed (${code}): ${line.slice(4, 300)}`,
				);
			return lines;
		}
	}

	private async readLine(): Promise<string> {
		while (true) {
			const newline = this.buffered.indexOf("\r\n");
			if (newline >= 0) {
				const line = this.buffered.slice(0, newline);
				this.buffered = this.buffered.slice(newline + 2);
				return line;
			}
			const { done, value } = await this.reader!.read();
			if (done) throw new Error("SMTP server closed the connection");
			this.buffered += new TextDecoder().decode(value, { stream: true });
		}
	}
}

function parseHeaders(source: string): Record<string, string> {
	const headerBlock = source.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, " ");
	return Object.fromEntries(
		headerBlock
			.split(/\r?\n/)
			.map((line) => line.match(/^([^:]+):\s*(.*)$/))
			.filter((match): match is RegExpMatchArray => Boolean(match))
			.map((match) => [match[1].toLowerCase(), match[2]]),
	);
}

function addresses(value?: string): string[] {
	if (!value) return [];
	return splitAddressHeader(value)
		.map((entry) => entry.match(/<([^>]+)>/)?.[1] ?? entry.trim())
		.filter(Boolean);
}

function splitAddressHeader(value: string): string[] {
	const entries: string[] = [];
	let entry = "";
	let quoted = false;
	let escaped = false;
	let angleDepth = 0;
	for (const character of value) {
		if (escaped) {
			entry += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quoted) {
			entry += character;
			escaped = true;
			continue;
		}
		if (character === '"') quoted = !quoted;
		if (!quoted && character === "<") angleDepth += 1;
		if (!quoted && character === ">" && angleDepth > 0) angleDepth -= 1;
		if (!quoted && angleDepth === 0 && character === ",") {
			if (entry.trim()) entries.push(entry.trim());
			entry = "";
			continue;
		}
		entry += character;
	}
	if (entry.trim()) entries.push(entry.trim());
	return entries;
}

function stripBcc(source: string): string {
	return source.replace(/^Bcc:.*(?:\r?\n[ \t].*)*\r?\n/gim, "");
}

async function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([operation, expired]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
