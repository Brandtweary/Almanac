/** Resolve application assets and services under a root or portfolio mount. */
export const APP_BASE_PATH = import.meta.env?.BASE_URL ?? "/";

export function appPath(path: string): string {
	return `${APP_BASE_PATH.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export function absoluteServiceUrl(path: string): string {
	return new URL(path, typeof location === "undefined" ? "http://127.0.0.1:8790/" : location.href).href.replace(/\/$/, "");
}

export function speechSocketUrl(): string {
	const url = new URL(absoluteServiceUrl(appPath("api/tts_streaming")));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}

/** Broker paths refer to this application, including a portfolio mount. */
export function resolveSpeechEndpoint(endpoint: string, basePath = APP_BASE_PATH, pageUrl = typeof location === "undefined" ? "http://localhost/" : location.href): string {
 const local = endpoint === "/api/tts_streaming" || endpoint === "api/tts_streaming";
 if (!local && !/^wss?:\/\//.test(endpoint)) throw new Error("invalid TTS WebSocket URL");
 const path = local
   ? `${basePath.replace(/\/$/, "")}/api/tts_streaming` : endpoint;
 const url = new URL(path, pageUrl);
 if (url.protocol === "http:") url.protocol = "ws:";
 else if (url.protocol === "https:") url.protocol = "wss:";
 if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("invalid TTS WebSocket URL");
 return url.href;
}
