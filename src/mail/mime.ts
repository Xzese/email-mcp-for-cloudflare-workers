export interface DraftInput {
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string;
	inReplyTo?: string;
	references?: string[];
	subject: string;
	text?: string;
	html?: string;
	attachments?: Array<{
		filename: string;
		contentType: string;
		contentBase64: string;
	}>;
}

export function buildDraftMessage(
	from: string,
	input: DraftInput,
): {
	messageId: string;
	source: Uint8Array;
} {
	const messageId = `<${crypto.randomUUID()}@email-mcp-worker>`;
	const cc = list(input.cc);
	const bcc = list(input.bcc);
	const headers = [
		`From: ${from}`,
		`To: ${addressHeader(input.to)}`,
		...(cc.length ? [`Cc: ${addressHeader(cc)}`] : []),
		...(bcc.length ? [`Bcc: ${addressHeader(bcc)}`] : []),
		...(input.replyTo ? [`Reply-To: ${addressHeader(input.replyTo)}`] : []),
		...(input.inReplyTo ? [`In-Reply-To: ${sanitizeMessageId(input.inReplyTo)}`] : []),
		...(input.references?.length
			? [`References: ${input.references.map(sanitizeMessageId).join(" ")}`]
			: []),
		`Subject: ${encodeHeader(input.subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: ${messageId}`,
		"MIME-Version: 1.0",
	];
	let contentHeaders: string[];
	let contentBody: string;
	if (input.text && input.html) {
		const boundary = `boundary-${crypto.randomUUID()}`;
		const textPart = bodyPart("text/plain", input.text);
		const htmlPart = bodyPart("text/html", input.html);
		contentHeaders = [`Content-Type: multipart/alternative; boundary="${boundary}"`];
		contentBody = [
			`--${boundary}`,
			...textPart.headers,
			"",
			textPart.body,
			`--${boundary}`,
			...htmlPart.headers,
			"",
			htmlPart.body,
			`--${boundary}--`,
		].join("\r\n");
	} else {
		const part = bodyPart(
			input.html ? "text/html" : "text/plain",
			input.html ?? input.text ?? "",
		);
		contentHeaders = part.headers;
		contentBody = part.body;
	}
	let body: string;
	if (input.attachments?.length) {
		const boundary = `mixed-${crypto.randomUUID()}`;
		headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
		body = [
			`--${boundary}`,
			...contentHeaders,
			"",
			contentBody,
			...input.attachments.flatMap((attachment) => attachmentPart(boundary, attachment)),
			`--${boundary}--`,
		].join("\r\n");
	} else {
		headers.push(...contentHeaders);
		body = contentBody;
	}
	return {
		messageId,
		source: new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${body}`),
	};
}

function bodyPart(
	contentType: "text/plain" | "text/html",
	value: string,
): {
	headers: string[];
	body: string;
} {
	return {
		headers: [
			`Content-Type: ${contentType}; charset="UTF-8"`,
			"Content-Transfer-Encoding: quoted-printable",
		],
		body: toQuotedPrintable(value),
	};
}

function attachmentPart(
	boundary: string,
	attachment: { filename: string; contentType: string; contentBase64: string },
): string[] {
	const filename = attachment.filename.replace(/[\r\n]/g, "_");
	const fallbackFilename = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encodedFilename = encodeURIComponent(filename);
	const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType)
		? attachment.contentType
		: "application/octet-stream";
	const encoded = normalizeBase64(attachment.contentBase64);
	return [
		`--${boundary}`,
		`Content-Type: ${contentType}`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodedFilename}`,
		"",
		encoded,
	];
}

function normalizeBase64(value: string): string {
	const compact = value.replace(/\s+/g, "");
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact))
		throw new Error("Attachment contentBase64 is not valid base64");
	return compact.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function list(value?: string | string[]): string[] {
	return value ? (Array.isArray(value) ? value : [value]) : [];
}

function addressHeader(value: string | string[]): string {
	return list(value).map(formatAddress).join(", ");
}

function formatAddress(value: string): string {
	const sanitized = sanitizeHeader(value).trim();
	const match = sanitized.match(/^(.*?)\s*<([^<>]+)>$/);
	if (!match) return sanitized;
	const name = match[1].trim().replace(/^"|"$/g, "");
	const address = match[2].trim();
	return name ? `${encodePhrase(name)} <${address}>` : address;
}

function encodePhrase(value: string): string {
	const sanitized = sanitizeHeader(value).trim();
	return /^[\x20-\x7e]*$/.test(sanitized)
		? `"${sanitized.replace(/(["\\])/g, "\\$1")}"`
		: encodeHeader(sanitized);
}

function encodeHeader(value: string): string {
	const sanitized = sanitizeHeader(value);
	return /^[\x20-\x7e]*$/.test(sanitized) ? sanitized : encodeMimeWords(sanitized);
}

function sanitizeHeader(value: string): string {
	return value.replace(/[\r\n]/g, " ");
}

function sanitizeMessageId(value: string): string {
	return sanitizeHeader(value).trim();
}

function encodeMimeWords(value: string): string {
	const prefix = "=?UTF-8?Q?";
	const suffix = "?=";
	const maxLength = 75 - prefix.length - suffix.length;
	const words: string[] = [];
	let current = "";
	for (const character of value) {
		const token = encodedWordToken(character);
		if (current && current.length + token.length > maxLength) {
			words.push(`${prefix}${current}${suffix}`);
			current = "";
		}
		current += token;
	}
	if (current || words.length === 0) words.push(`${prefix}${current}${suffix}`);
	return words.join("\r\n ");
}

function encodedWordToken(value: string): string {
	return [...new TextEncoder().encode(value)]
		.map((byte) => {
			if (byte === 0x20) return "_";
			if (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d && byte !== 0x3f && byte !== 0x5f)
				return String.fromCharCode(byte);
			return hexByte(byte);
		})
		.join("");
}

export function decodeHeaderWords(value: string): string {
	const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
	return joined.replace(
		/=\?([^?\s]+)\?([bqBQ])\?([^?]*)\?=/g,
		(match, charset: string, encoding: string, text: string) => {
			try {
				const bytes =
					encoding.toUpperCase() === "B"
						? decodeBase64Bytes(text)
						: decodeQEncodedBytes(text);
				return decodeBytes(bytes, charset);
			} catch {
				return match;
			}
		},
	);
}

function decodeBase64Bytes(value: string): Uint8Array {
	const binary = atob(value.replace(/\s+/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function decodeQEncodedBytes(value: string): Uint8Array {
	const bytes: number[] = [];
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character === "_") {
			bytes.push(0x20);
			continue;
		}
		if (character === "=" && isHex(value[index + 1]) && isHex(value[index + 2])) {
			bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
			index += 2;
			continue;
		}
		bytes.push(character.charCodeAt(0));
	}
	return new Uint8Array(bytes);
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
	const label = charset.trim().toLowerCase() === "utf8" ? "utf-8" : charset.trim();
	try {
		return new TextDecoder(label).decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

function isHex(value: string | undefined): boolean {
	return value !== undefined && /^[\da-f]$/i.test(value);
}

function toQuotedPrintable(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map(quotedPrintableLine)
		.join("\r\n");
}

function quotedPrintableLine(value: string): string {
	const bytes = [...new TextEncoder().encode(value)];
	let lastNonWhitespace = bytes.length - 1;
	while (
		lastNonWhitespace >= 0 &&
		(bytes[lastNonWhitespace] === 0x20 || bytes[lastNonWhitespace] === 0x09)
	)
		lastNonWhitespace -= 1;
	const tokens = bytes.map((byte, index) => {
		const trailingWhitespace = index > lastNonWhitespace && (byte === 0x20 || byte === 0x09);
		if (
			!trailingWhitespace &&
			(byte === 0x09 || (byte >= 0x20 && byte <= 0x7e && byte !== 0x3d))
		)
			return String.fromCharCode(byte);
		return hexByte(byte);
	});
	const lines: string[] = [];
	let line = "";
	for (const token of tokens) {
		if (line.length + token.length > 75) {
			lines.push(`${line}=`);
			line = "";
		}
		line += token;
	}
	lines.push(line);
	return lines.join("\r\n");
}

function hexByte(byte: number): string {
	return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}
