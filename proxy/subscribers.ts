/** The email sign-up store: addresses left on the About page, and nothing else.
 *
 * One table, read directly off the file by whatever collects it. The gateway
 * never sends mail, keeps no other copy of an address and exposes no read route,
 * so the file itself is the whole interface. Writes are idempotent on the
 * address: a repeated submission is not a second row, and the response is the
 * same either way, so submitting an address never reveals whether it is stored.
 */
import { Database } from "bun:sqlite";

export class Subscribers {
	private db: Database;
	private insert;
	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("CREATE TABLE IF NOT EXISTS subscribers (email TEXT PRIMARY KEY, ip TEXT, created_at TEXT NOT NULL)");
		this.insert = this.db.query<unknown, [string, string, string]>(
			"INSERT OR IGNORE INTO subscribers (email, ip, created_at) VALUES (?, ?, ?)");
	}
	/** Records an address, returning whether this one was new. */
	add(email: string, ip: string): boolean {
		return this.insert.run(email, ip, new Date().toISOString()).changes === 1;
	}
	close(): void {
		this.db.close();
	}
}
