import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wrangler = await readFile("wrangler.toml", "utf8");
const workerTypes = await readFile("worker-configuration.d.ts", "utf8");

assert.doesNotMatch(wrangler, /^\s*account_id\s*=/m, "wrangler.toml must not contain account_id");
assert.match(
	wrangler,
	/id = "replace-with-your-kv-namespace-id"/,
	"wrangler.toml must keep the sanitized KV placeholder",
);
assert.match(
	wrangler,
	/TEAM_DOMAIN = "https:\/\/your-team\.cloudflareaccess\.com"/,
	"wrangler.toml must keep the sanitized Access domain",
);
assert.doesNotMatch(
	workerTypes,
	/TEAM_DOMAIN:\s*"/,
	"generated Worker types must not contain a literal Access domain",
);
assert.doesNotMatch(
	workerTypes,
	/POLICY_AUD:\s*"/,
	"generated Worker types must not contain a literal Access audience",
);

console.log("Public configuration is sanitized.");
