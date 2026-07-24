import assert from "node:assert/strict";
import test from "node:test";
import { decrypt, encrypt, openJson, sealJson } from "../src/crypto.ts";

const key = Buffer.alloc(32, 1).toString("base64");
const otherKey = Buffer.alloc(32, 2).toString("base64");

test("AES-GCM JSON values round-trip", async () => {
	const sealed = await sealJson({ accountId: "example", enabled: true }, key);
	assert.deepEqual(await openJson(sealed, key), { accountId: "example", enabled: true });
});

test("invalid encryption keys are rejected", async () => {
	await assert.rejects(
		encrypt(new TextEncoder().encode("secret"), Buffer.alloc(31).toString("base64")),
		/base64-encoded 32-byte key/,
	);
	await assert.rejects(encrypt(new TextEncoder().encode("secret"), "not-base64"), /32-byte key/);
});

test("short, tampered, and wrong-key ciphertext is rejected", async () => {
	await assert.rejects(decrypt(new Uint8Array(28).buffer, key), /Encrypted value is invalid/);

	const encrypted = new Uint8Array(await encrypt(new TextEncoder().encode("secret"), key));
	encrypted[encrypted.length - 1] ^= 1;
	await assert.rejects(decrypt(encrypted.buffer, key));

	const valid = await encrypt(new TextEncoder().encode("secret"), key);
	await assert.rejects(decrypt(valid, otherKey));
});

test("successfully decrypted non-JSON data is rejected", async () => {
	const encrypted = new Uint8Array(await encrypt(new TextEncoder().encode("not json"), key));
	const value = Buffer.from(encrypted).toString("base64url");
	await assert.rejects(openJson(value, key), SyntaxError);
});
