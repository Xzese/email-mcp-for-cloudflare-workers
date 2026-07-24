import { writeFile } from "node:fs/promises";

export const generatedConfigPath = "wrangler.generated.json";

export function buildCloudflareConfig(environment = process.env) {
	const kvNamespaceId = environment.EMAIL_KV_NAMESPACE_ID?.trim();
	if (!kvNamespaceId)
		throw new Error("EMAIL_KV_NAMESPACE_ID must be configured as a Cloudflare build secret");
	if (!/^[a-f0-9]{32}$/i.test(kvNamespaceId))
		throw new Error("EMAIL_KV_NAMESPACE_ID must be a 32-character hexadecimal namespace ID");

	return {
		$schema: "node_modules/wrangler/config-schema.json",
		name: "email-mcp-server",
		main: "src/index.ts",
		compatibility_date: "2026-06-14",
		compatibility_flags: ["nodejs_compat"],
		keep_vars: true,
		secrets: {
			required: ["CREDENTIAL_ENCRYPTION_KEY", "OUTLOOK_CLIENT_SECRET"],
		},
		migrations: [
			{
				tag: "v1",
				new_sqlite_classes: ["MyMCP"],
			},
		],
		durable_objects: {
			bindings: [
				{
					name: "MCP_OBJECT",
					class_name: "MyMCP",
				},
			],
		},
		kv_namespaces: [
			{
				binding: "EMAIL_KV",
				id: kvNamespaceId,
			},
		],
		observability: {
			enabled: true,
		},
	};
}

export async function writeCloudflareConfig(
	environment = process.env,
	outputPath = generatedConfigPath,
) {
	const config = buildCloudflareConfig(environment);
	await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	return outputPath;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
	const outputPath = await writeCloudflareConfig();
	console.log(`Generated private Cloudflare deployment configuration at ${outputPath}`);
}
