function decodeKey(encryptionKey: string): Uint8Array {
	let raw: Uint8Array;
	try {
		raw = Uint8Array.from(atob(encryptionKey), (character) => character.charCodeAt(0));
	} catch {
		throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
	}
	if (raw.byteLength !== 32)
		throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
	return raw;
}

async function key(encryptionKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", decodeKey(encryptionKey), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

export async function encrypt(value: Uint8Array, encryptionKey: string): Promise<ArrayBuffer> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await key(encryptionKey),
		value,
	);
	const output = new Uint8Array(iv.byteLength + ciphertext.byteLength);
	output.set(iv);
	output.set(new Uint8Array(ciphertext), iv.byteLength);
	return output.buffer;
}

export async function decrypt(value: ArrayBuffer, encryptionKey: string): Promise<ArrayBuffer> {
	const bytes = new Uint8Array(value);
	if (bytes.byteLength < 29) throw new Error("Encrypted value is invalid");
	return crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: bytes.slice(0, 12) },
		await key(encryptionKey),
		bytes.slice(12),
	);
}

export async function sealJson(value: unknown, encryptionKey: string): Promise<string> {
	const encrypted = new Uint8Array(
		await encrypt(new TextEncoder().encode(JSON.stringify(value)), encryptionKey),
	);
	return bytesToBase64Url(encrypted);
}

export async function openJson<T>(value: string, encryptionKey: string): Promise<T> {
	const plaintext = await decrypt(base64UrlToBytes(value).buffer as ArrayBuffer, encryptionKey);
	return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export function bytesToBase64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
