import assert from "node:assert/strict";
import test from "node:test";
import { observeTool, safeErrorCategory } from "../src/observability.ts";

test("error categories never include upstream error text", () => {
	const sensitive =
		"SMTP rejected password short7 for private.person@example.invalid: confidential body";
	assert.equal(safeErrorCategory(new Error(sensitive)), "Error");
	assert.equal(safeErrorCategory(sensitive), "UnknownError");
});

test("failed tool logs contain metadata but no sensitive error content", async () => {
	const sensitive =
		"token=very-secret-token-value private.person@example.invalid confidential body";
	const entries: unknown[] = [];
	const original = console.error;
	console.error = (...values: unknown[]) => entries.push(...values);

	try {
		await assert.rejects(
			observeTool("email_test_connection", async () => {
				throw new Error(sensitive);
			}),
			new RegExp(sensitive),
		);
	} finally {
		console.error = original;
	}

	assert.equal(entries.length, 1);
	const serialized = JSON.stringify(entries[0]);
	assert.match(serialized, /email_test_connection/);
	assert.match(serialized, /"error":"Error"/);
	assert.doesNotMatch(serialized, /very-secret|private\.person|confidential body/);
});

test("successful tool logs contain only operational metadata", async () => {
	const entries: unknown[] = [];
	const original = console.log;
	console.log = (...values: unknown[]) => entries.push(...values);

	try {
		assert.equal(await observeTool("email_list_accounts", async () => "ok"), "ok");
	} finally {
		console.log = original;
	}

	assert.equal(entries.length, 1);
	assert.deepEqual(Object.keys(entries[0] as object).sort(), [
		"durationMs",
		"event",
		"status",
		"tool",
	]);
});
