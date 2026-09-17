import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

/**
 * Store for application settings (theme, proxy config, etc.).
 */
export class SettingsStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "settings",
			// No keyPath - uses out-of-line keys
		};
	}

	async getProxyConfig(): Promise<{ enabled: boolean; url: string }> {
		return this.getBackend().transaction(["settings"], "readonly", async tx => ({
			enabled: (await tx.get<boolean>("settings", "proxy.enabled")) ?? false,
			url: (await tx.get<string>("settings", "proxy.url")) ?? "http://localhost:3001",
		}));
	}

	async setProxyConfig(config: { enabled: boolean; url: string }): Promise<void> {
		const { enabled, url } = config;
		if (typeof enabled !== "boolean" || typeof url !== "string") throw new Error("Invalid proxy configuration");
		if (enabled && !/^https?:$/.test(new URL(url).protocol)) throw new Error("Proxy URL must use HTTP or HTTPS");
		await this.getBackend().transaction(["settings"], "readwrite", async tx => {
			await tx.set("settings", "proxy.enabled", enabled);
			await tx.set("settings", "proxy.url", url);
		});
	}

	async get<T>(key: string): Promise<T | null> {
		return this.getBackend().get("settings", key);
	}

	async set<T>(key: string, value: T): Promise<void> {
		await this.getBackend().set("settings", key, value);
	}

	async delete(key: string): Promise<void> {
		await this.getBackend().delete("settings", key);
	}

	async list(): Promise<string[]> {
		return this.getBackend().keys("settings");
	}

	async clear(): Promise<void> {
		await this.getBackend().clear("settings");
	}
}
