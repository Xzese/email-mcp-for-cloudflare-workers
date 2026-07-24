import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildCloudflareConfig,
	writeCloudflareConfig,
} from "../scripts/generate-cloudflare-config.mjs";

const namespaceId = "a".repeat(32);

test("Cloudflare build config preserves dashboard variables and existing secrets", () => {
	const config = buildCloudflareConfig({ EMAIL_KV_NAMESPACE_ID: namespaceId });

	assert.equal(config.keep_vars, true);
	assert.equal("vars" in config, false);
	assert.deepEqual(config.secrets.required, [
		"CREDENTIAL_ENCRYPTION_KEY",
		"OUTLOOK_CLIENT_SECRET",
	]);
	assert.deepEqual(config.kv_namespaces, [{ binding: "EMAIL_KV", id: namespaceId }]);
	assert.deepEqual(config.durable_objects.bindings, [
		{ name: "MCP_OBJECT", class_name: "MyMCP" },
	]);
});

test("Cloudflare build config rejects missing or malformed KV namespace IDs", () => {
	assert.throws(
		() => buildCloudflareConfig({}),
		/must be configured as a Cloudflare build secret/,
	);
	assert.throws(
		() => buildCloudflareConfig({ EMAIL_KV_NAMESPACE_ID: "replace-with-an-id" }),
		/32-character hexadecimal namespace ID/,
	);
});

test("generated Cloudflare config is written as private JSON", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "email-mcp-config-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const outputPath = join(directory, "wrangler.generated.json");
	await writeCloudflareConfig({ EMAIL_KV_NAMESPACE_ID: namespaceId }, outputPath);
	const config = JSON.parse(await readFile(outputPath, "utf8"));
	const mode = (await stat(outputPath)).mode & 0o777;

	assert.equal(config.keep_vars, true);
	assert.equal(config.kv_namespaces[0].id, namespaceId);
	assert.equal("vars" in config, false);
	assert.equal(mode, 0o600);
});
