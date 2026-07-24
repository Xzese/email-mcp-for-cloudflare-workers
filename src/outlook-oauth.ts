import { bytesToBase64Url } from "./crypto.ts";

export interface OutlookOAuthState {
	state: string;
	nonce: string;
	codeVerifier: string;
	displayName: string;
	createdAt: number;
}

export async function createOutlookOAuthState(
	displayName: string,
	now = Date.now(),
	randomBytes = () => crypto.getRandomValues(new Uint8Array(32)),
): Promise<{ oauthState: OutlookOAuthState; codeChallenge: string }> {
	const oauthState = {
		state: bytesToBase64Url(randomBytes()),
		nonce: bytesToBase64Url(randomBytes()),
		codeVerifier: bytesToBase64Url(randomBytes()),
		displayName,
		createdAt: now,
	};
	const codeChallenge = bytesToBase64Url(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(oauthState.codeVerifier),
			),
		),
	);
	return { oauthState, codeChallenge };
}

export function assertValidOutlookOAuthCallback(
	value: OutlookOAuthState,
	returnedState: string,
	now = Date.now(),
): void {
	const base64Url256 = /^[A-Za-z0-9_-]{43}$/;
	if (
		!value ||
		!base64Url256.test(value.state) ||
		!base64Url256.test(value.nonce) ||
		!base64Url256.test(value.codeVerifier) ||
		typeof value.displayName !== "string" ||
		!value.displayName ||
		!Number.isFinite(value.createdAt) ||
		value.state !== returnedState ||
		now - value.createdAt > 10 * 60_000
	)
		throw new Error("Outlook authorization state is invalid or expired");
}
