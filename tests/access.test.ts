import assert from "node:assert/strict";
import test from "node:test";
import { accessRejection, isLocalDevelopment, type AccessEnv } from "../src/access.ts";

function env(values: Partial<AccessEnv> = {}): AccessEnv {
	return {
		ACCESS_LOCAL_DEV: "false",
		...values,
	};
}

test("local development bypass is restricted to exact loopback hostnames", () => {
	const localEnv = env({ ACCESS_LOCAL_DEV: "true" });

	assert.equal(isLocalDevelopment(new Request("http://localhost:8787/"), localEnv), true);
	assert.equal(isLocalDevelopment(new Request("http://127.0.0.1:8787/"), localEnv), true);
	assert.equal(isLocalDevelopment(new Request("http://[::1]:8787/"), localEnv), true);
	assert.equal(isLocalDevelopment(new Request("http://localhost.:8787/"), localEnv), false);
	assert.equal(isLocalDevelopment(new Request("http://127.0.0.2:8787/"), localEnv), false);
	assert.equal(
		isLocalDevelopment(
			new Request("http://localhost:8787/"),
			env({ ACCESS_LOCAL_DEV: "TRUE" }),
		),
		false,
	);
	assert.equal(
		isLocalDevelopment(
			new Request("http://localhost:8787/"),
			env({ ACCESS_LOCAL_DEV: "false" }),
		),
		false,
	);
});

test("requests without a Cloudflare Access assertion are rejected", async () => {
	const response = await accessRejection(
		new Request("https://worker.example/mcp"),
		env(),
		async () => {},
	);

	assert.equal(response?.status, 401);
	assert.equal(await response?.text(), "Unauthorized: missing Cloudflare Access assertion");
});

test("invalid Access assertions are rejected and valid assertions continue", async () => {
	const rejected = await accessRejection(
		new Request("https://worker.example/mcp", {
			headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
		}),
		env(),
		async () => {
			throw new Error("invalid");
		},
	);

	assert.equal(rejected?.status, 403);
	assert.equal(await rejected?.text(), "Forbidden: invalid Cloudflare Access assertion");

	const accepted = await accessRejection(
		new Request("https://worker.example/mcp", {
			headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
		}),
		env(),
		async () => {},
	);
	assert.equal(accepted, undefined);
});
