/**
 * dsh-tavily-search: a Tavily-backed search provider for the dsh web
 * capability seam (ctx.web). Registers the `tavily` provider so the
 * model-facing web_search tool runs against the Tavily Search API
 * (POST https://api.tavily.com/search). The provider holds no credential
 * value: the key is resolved per operation through the credentials service
 * (ref, default TAVILY_API_KEY), the launch environment, or a literal
 * `apiKey` config, in that order.
 *
 * The bundle additionally registers `http-trusted`, a proxy-friendly HTTP(S)
 * fetch provider: it reuses the official @deepseek-ai/dsh-web-fetch-http
 * transport (same-origin redirects, content-type allowlist, byte caps,
 * timeout, no credentials, address pinning) but relaxes the public-IP precheck
 * to also admit the proxy fake-IP range 198.18.0.0/15 (Clash-style DNS), which
 * the stock provider rejects as non-public and which breaks web_fetch under a
 * fake-IP DNS proxy. IPv6 answers are dropped entirely (never trust a
 * link-local/ULA answer for routing), and every other non-public IPv4
 * destination — loopback, RFC1918, link-local, CGNAT, multicast, reserved —
 * is still rejected with WEB_BLOCKED_URL.
 *
 * @module dsh-tavily-search
 */
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";
import { HttpFetchProvider } from "@deepseek-ai/dsh-web-fetch-http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { diag } from "./diag.js";
import { applySettingsCard } from "./settings-card.js";
import ipaddr from "ipaddr.js";

// Import-time breadcrumb: the only evidence a host that never mounts `ctx.web`
// can give that this file was read at all (see ./diag.js).
try {
    diag(undefined, `module imported pid=${process.pid} node=${process.version}`);
}
catch {
    // Diagnostics must never be the reason a module fails to load.
}

//#region identity & defaults
/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-tavily-search";
/** The web seam this provider registers into. */
const inject = ["web"];
/** Stable id this provider registers under. */
const TAVILY_PROVIDER_ID = "tavily";
/** Default Tavily API origin; the `/search` path is appended per call. */
const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
/** Default environment variable naming the credential reference. */
const DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";
/** Environment variable that overrides the API origin. */
const BASE_URL_ENV = "TAVILY_BASE_URL";
/** Settings namespace carrying this provider's endpoint and behavior options. */
const SETTINGS_NAMESPACE = "dsh-tavily-search";
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "dsh-tavily-search/0.3.0";
/** Fallback result cap when the caller sends no maxResults. */
const DEFAULT_MAX_RESULTS = 10;
/** Tavily's documented per-request result cap. */
const TAVILY_MAX_RESULTS_CAP = 20;
/** Accepted search_depth values. */
const SEARCH_DEPTHS = ["basic", "advanced"];
/** Accepted topic values. */
const TOPICS = ["general", "news"];
/** Stable id this bundle's proxy-friendly fetch provider registers under. */
const TRUSTED_FETCH_PROVIDER_ID = "http-trusted";
/** Resource limits for the trusted fetch provider (mirror dsh-web-fetch-http defaults). */
const TRUSTED_FETCH_LIMITS = {
	maxResponseBytes: 5e6,
	maxBodyChars: 1e5,
	timeoutMs: 3e4,
	maxRedirects: 5,
	userAgent: USER_AGENT
};
//#endregion

//#region config
const Config = z.object({
	apiKey: z.string().role("secret"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string(),
	searchDepth: z.string().default("basic"),
	topic: z.string().default("general"),
	includeAnswer: z.boolean().default(true),
	maxResults: z.number().step(1).min(1).default(DEFAULT_MAX_RESULTS)
});
//#endregion

//#region abort & error helpers
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Tavily search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}
/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}
/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable(operation, signal) {
	if (signal === undefined) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(searchAborted(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}
/** Race a non-cancellable OS lookup without letting it delay tool cancellation. */
function raceWithSignal(promise, signal) {
	const abortError = () => new Error("web fetch aborted during hostname resolution", { cause: signal.reason });
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const abort = () => {
			reject(abortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", abort);
		});
	});
}
/** Collapse newlines in a text field so a snippet never breaks the markdown list. */
function flattenInline(text) {
	return text.replace(/\s*\n+\s*/g, " ");
}
/** Extract a human message from a Tavily error body (several documented shapes). */
function parseErrorDetail(parsed) {
	if (typeof parsed === "string" && parsed.length > 0) return parsed;
	if (parsed == null || typeof parsed !== "object") return undefined;
	if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
	if (typeof parsed.error?.message === "string" && parsed.error.message.length > 0) return parsed.error.message;
	if (typeof parsed.detail === "string" && parsed.detail.length > 0) return parsed.detail;
	if (parsed.detail != null && typeof parsed.detail === "object" && typeof parsed.detail.error === "string" && parsed.detail.error.length > 0) return parsed.detail.error;
	if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
	return undefined;
}
//#endregion

//#region trusted fetch resolver
/**
 * Whether an IPv4 address is inside the proxy fake-IP range 198.18.0.0/15
 * (RFC 2544 benchmarking block commonly used by Clash-style DNS proxies as
 * fake answers). This is the ONLY non-public range the trusted fetcher admits.
 */
function isFakeIpRange(address) {
	try {
		const parsed = ipaddr.parse(address);
		if (!(parsed instanceof ipaddr.IPv4)) return false;
		const [a, b] = parsed.toByteArray();
		return a === 198 && (b === 18 || b === 19);
	} catch {
		return false;
	}
}
/** Whether an address is a globally reachable public unicast (mirrors dsh-web-fetch-http). */
function isPublicUnicast(address) {
	try {
		const parsed = ipaddr.parse(address);
		if (parsed instanceof ipaddr.IPv4) return parsed.range() === "unicast";
		if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === "unicast";
		return parsed.range() === "unicast";
	} catch {
		return false;
	}
}
/** WHATWG URL retains brackets around IPv6 hostnames; IP parsers do not. */
function stripIpv6Brackets(hostname) {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
/**
 * Proxy-friendly destination resolution: accepts public IPv4 unicasts plus the
 * fake-IP range 198.18.0.0/15, drops every IPv6 answer (a ULA/link-local answer
 * is never trusted for routing), and rejects any other IPv4 answer set with
 * `WEB_BLOCKED_URL`. The returned addresses are the only ones the transport may
 * use (pinned connection, same as the official provider).
 *
 * @param hostname - URL hostname, including brackets when it is an IPv6 literal.
 * @param signal - aborts the wait for system resolution.
 * @returns the validated, non-empty address set.
 */
async function resolveProxyFriendly(hostname, signal) {
	const unbracketed = stripIpv6Brackets(hostname);
	const literalFamily = isIP(unbracketed);
	const resolved = literalFamily === 0
		? await raceWithSignal(lookup(unbracketed, { all: true, order: "verbatim" }), signal)
		: [{ address: unbracketed, family: literalFamily }];
	if (resolved.length === 0) throw new WebError(`hostname "${hostname}" resolved to no addresses`, "WEB_PROVIDER_ERROR");
	const addresses = [];
	for (const entry of resolved) {
		if (entry.family !== 4 && entry.family !== 6 || isIP(entry.address) !== entry.family) continue;
		if (entry.family === 6) continue;
		if (!isPublicUnicast(entry.address) && !isFakeIpRange(entry.address)) {
			throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, "WEB_BLOCKED_URL");
		}
		addresses.push({ address: entry.address, family: 4 });
	}
	if (addresses.length === 0) throw new WebError(`hostname "${hostname}" resolved to no usable addresses`, "WEB_PROVIDER_ERROR");
	return addresses;
}
/**
 * The proxy-friendly fetch provider: identical transport to
 * @deepseek-ai/dsh-web-fetch-http with permissive destination resolution.
 */
class TrustedHttpFetchProvider extends HttpFetchProvider {
	id = TRUSTED_FETCH_PROVIDER_ID;
}
//#endregion

//#region provider
/**
 * The Tavily-backed search provider. HTTP redirects fail as `WEB_PROVIDER_ERROR`;
 * failures after dispatch name the endpoint so the user can fix configuration.
 */
class TavilySearchProvider {
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	id = TAVILY_PROVIDER_ID;
	/** True when a key can be resolved and the endpoint parses. */
	available() {
		const options = this.resolveOptions();
		return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined) && URL.canParse(options.baseURL);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.apiKey(options, signal);
		throwIfAborted(signal);
		assertEnum("searchDepth", options.searchDepth, SEARCH_DEPTHS);
		assertEnum("topic", options.topic, TOPICS);
		const endpoint = `${options.baseURL}/search`;
		const requested = request.maxResults ?? options.maxResults;
		const maxResults = Math.min(Number.isInteger(requested) && requested > 0 ? requested : options.maxResults, TAVILY_MAX_RESULTS_CAP);
		const body = {
			query: request.query,
			max_results: maxResults,
			search_depth: options.searchDepth,
			topic: options.topic,
			include_answer: options.includeAnswer
		};
		let response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
					accept: "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify(body),
				...(signal !== undefined ? { signal } : {})
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Tavily search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Tavily API error (HTTP ${response.status})`;
			try {
				const detail = parseErrorDetail(await response.json());
				if (detail !== undefined && detail.length > 0) message += `: ${detail}`;
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			}
			throw new WebError(`${message}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. Only the user should choose or change the endpoint (Settings > Plugins > Plugin configuration > Web search Tavily, or the ${BASE_URL_ENV} environment variable).`, "WEB_PROVIDER_ERROR");
		}
		try {
			const data = await response.json();
			const sources = (Array.isArray(data.results) ? data.results : [])
				.filter((item) => item?.url != null && item.url.length > 0)
				.map((item) => ({
					url: item.url,
					...(item.title != null && item.title.length > 0 ? { title: flattenInline(item.title) } : {}),
					...(item.content != null && item.content.length > 0 ? { snippet: flattenInline(item.content) } : {}),
					...(item.published_date != null && item.published_date.length > 0 ? { publishedAt: item.published_date } : {})
				}));
			return {
				...(typeof data.answer === "string" && data.answer.length > 0 ? { content: data.answer } : {}),
				sources,
				truncated: false
			};
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(error instanceof WebError ? error.message : `Tavily returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	/**
	 * Resolve one operation's credential without retaining it on the provider.
	 * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
	 * @param signal - abort signal for the surrounding search.
	 * @returns the resolved key.
	 */
	async apiKey(options, signal) {
		throwIfAborted(signal);
		if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Tavily search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== undefined && resolved.length > 0) return resolved;
		throw new WebError(`Tavily search has no API key for "${options.apiKeyEnv ?? DEFAULT_API_KEY_ENV}"; store it through the credentials service (refs: TAVILY_API_KEY in ~/.dsh/.credentials.yaml), export it in the launching environment, or set a literal "apiKey" in the dsh-tavily-search config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
}
/** Reject a config value outside the provider's accepted set with a friendly message. */
function assertEnum(field, value, accepted) {
	if (!accepted.includes(value)) throw new WebError(`Tavily search config "${field}" must be one of ${accepted.map((item) => JSON.stringify(item)).join(", ")} (got ${JSON.stringify(value)})`, "WEB_PROVIDER_ERROR");
}
//#endregion

//#region registration
/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined;
	return {
		...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
		},
		apiKeyEnv,
		baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value ?? TAVILY_DEFAULT_BASE_URL,
		searchDepth: config.searchDepth ?? "basic",
		topic: config.topic ?? "general",
		includeAnswer: config.includeAnswer ?? true,
		maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS
	};
}
/** Register the Tavily search provider and the proxy-friendly fetch provider. */
function apply(ctx, config) {
	diag(ctx, `apply started pid=${process.pid} file=${import.meta.url}`);
	// The localized card lives on the optional TUI seam (see ./settings-card.js);
	// the namespace/schema registration above stays authoritative for storage.
	applySettingsCard(ctx, diag);
	let current = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {}
		});
		diag(ctx, "settings namespace registered");
	});
	// The web seam is the one thing this plugin cannot work without. It is
	// injected (see `inject`), but a host that answers with a shadow instance or
	// refuses the registration must degrade to a logged warning instead of taking
	// the boot down.
	try {
		ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, current())));
		ctx.web.registerFetchProvider(new TrustedHttpFetchProvider(TRUSTED_FETCH_LIMITS, resolveProxyFriendly));
		diag(ctx, `providers registered search=${TAVILY_PROVIDER_ID} fetch=${TRUSTED_FETCH_PROVIDER_ID}`);
	}
	catch (error) {
		diag(ctx, `provider registration failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	ctx.effect(() => () => {
		diag(ctx, "unloaded");
	});
}
//#endregion

export { Config, DEFAULT_API_KEY_ENV, SETTINGS_NAMESPACE, TAVILY_DEFAULT_BASE_URL, TAVILY_PROVIDER_ID, TRUSTED_FETCH_LIMITS, TRUSTED_FETCH_PROVIDER_ID, TavilySearchProvider, TrustedHttpFetchProvider, apply, inject, isFakeIpRange, name, resolveProxyFriendly };
