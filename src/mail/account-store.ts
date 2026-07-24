import type { MailAccount } from "./types";
import { decrypt, encrypt } from "../crypto";

const STORAGE_KEY = "mail/accounts/v1";

export class AccountStore {
	constructor(
		private kv: KVNamespace,
		private encryptionKey: string,
	) {}

	async list(): Promise<MailAccount[]> {
		const encoded = await this.kv.get(STORAGE_KEY, "arrayBuffer");
		if (!encoded) return [];
		const plaintext = await decrypt(encoded, this.encryptionKey);
		return JSON.parse(new TextDecoder().decode(plaintext)) as MailAccount[];
	}

	async get(id?: string): Promise<MailAccount> {
		const accounts = await this.list();
		if (id) {
			const account = accounts.find((candidate) => candidate.id === id);
			if (!account) throw new Error(`Account ${id} not found`);
			return account;
		}
		if (accounts.length === 1) return accounts[0];
		if (accounts.length === 0) throw new Error("No email accounts configured");
		throw new Error("Multiple accounts configured; accountId is required");
	}

	async add(account: Omit<MailAccount, "id">): Promise<MailAccount> {
		const accounts = await this.list();
		const created = { ...account, id: crypto.randomUUID() };
		accounts.push(created);
		await this.save(accounts);
		return created;
	}

	async update(account: MailAccount): Promise<void> {
		const accounts = await this.list();
		const index = accounts.findIndex((candidate) => candidate.id === account.id);
		if (index < 0) throw new Error(`Account ${account.id} not found`);
		accounts[index] = account;
		await this.save(accounts);
	}

	async remove(id: string): Promise<void> {
		const accounts = await this.list();
		const remaining = accounts.filter((account) => account.id !== id);
		if (remaining.length === accounts.length) throw new Error(`Account ${id} not found`);
		await this.save(remaining);
	}

	private async save(accounts: MailAccount[]): Promise<void> {
		const plaintext = new TextEncoder().encode(JSON.stringify(accounts));
		await this.kv.put(STORAGE_KEY, await encrypt(plaintext, this.encryptionKey));
	}
}
