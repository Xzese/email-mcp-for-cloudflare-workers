import { z } from "zod";
import type { MailAccount } from "./types.ts";

type SenderAccount = Pick<MailAccount, "email" | "aliases" | "defaultFrom">;

export function senderSettings(account: SenderAccount) {
	const email = z.email().parse(account.email.trim());
	const seen = new Set([email.toLowerCase()]);
	const aliases = (account.aliases ?? [])
		.map((alias) => z.email().parse(alias.trim()))
		.filter((alias) => {
			const key = alias.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	const defaultFrom = configuredSender({ email, aliases }, account.defaultFrom ?? email);
	return { aliases, defaultFrom };
}

export function configuredSender(account: SenderAccount, from?: string): string {
	const requested = z.email().parse((from ?? account.defaultFrom ?? account.email).trim());
	const configured = [account.email, ...(account.aliases ?? [])].find(
		(address) => address.toLowerCase() === requested.toLowerCase(),
	);
	if (!configured)
		throw new Error(
			"From address is not configured for this account; add it to aliases using email_update_account_sender or the account settings page first",
		);
	return configured;
}

export function isAccountAddress(account: SenderAccount, address: string): boolean {
	const normalized = (address.match(/<([^>]+)>/)?.[1] ?? address).trim().toLowerCase();
	return [account.email, ...(account.aliases ?? [])].some(
		(candidate) => candidate.toLowerCase() === normalized,
	);
}
