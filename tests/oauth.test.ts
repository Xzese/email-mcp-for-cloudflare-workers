import assert from "node:assert/strict";
import test from "node:test";
import {
	assertValidOutlookOAuthCallback,
	createOutlookOAuthState,
	type OutlookOAuthState,
} from "../src/outlook-oauth.ts";

function validState(overrides: Partial<OutlookOAuthState> = {}): OutlookOAuthState {
	const value = Buffer.alloc(32, 7).toString("base64url");
	return {
		state: value,
		nonce: value,
		codeVerifier: value,
		displayName: "Example mailbox",
		createdAt: Date.now(),
		...overrides,
	};
}

test("Outlook authorization creates state, nonce, and an S256 PKCE challenge", async () => {
	let byte = 1;
	const { oauthState, codeChallenge } = await createOutlookOAuthState(
		"Example mailbox",
		1234,
		() => new Uint8Array(32).fill(byte++),
	);
	const expectedChallenge = Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(oauthState.codeVerifier)),
	).toString("base64url");

	assert.match(oauthState.state, /^[A-Za-z0-9_-]{43}$/);
	assert.match(oauthState.nonce, /^[A-Za-z0-9_-]{43}$/);
	assert.match(oauthState.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(oauthState.state, oauthState.nonce);
	assert.notEqual(oauthState.nonce, oauthState.codeVerifier);
	assert.equal(oauthState.createdAt, 1234);
	assert.equal(codeChallenge, expectedChallenge);
});

test("Outlook callback accepts only its exact, unexpired state", () => {
	const state = validState();
	assert.doesNotThrow(() => assertValidOutlookOAuthCallback(state, state.state));
	assert.throws(
		() => assertValidOutlookOAuthCallback(state, Buffer.alloc(32, 8).toString("base64url")),
		/invalid or expired/,
	);
	assert.throws(
		() =>
			assertValidOutlookOAuthCallback(
				validState({ createdAt: 1_000 }),
				state.state,
				1_000 + 10 * 60_000 + 1,
			),
		/invalid or expired/,
	);
});

test("Outlook callback rejects malformed PKCE state", () => {
	for (const state of [
		validState({ state: "too-short" }),
		validState({ nonce: "too-short" }),
		validState({ codeVerifier: "too-short" }),
		validState({ displayName: "" }),
		validState({ createdAt: Number.NaN }),
	]) {
		assert.throws(
			() => assertValidOutlookOAuthCallback(state, state.state),
			/invalid or expired/,
		);
	}
});
