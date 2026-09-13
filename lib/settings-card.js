/**
 * The localized settings card for dsh-web-tavily.
 *
 * The harness-side `settings.installSection` registers the namespace and its
 * schema, and the host can always render a generic card from that schema — but a
 * generic card shows raw field keys (`apiKeyEnv`, `searchDepth`, …) with no
 * translation. A localized card is a `tuiSettingsSections` registration, the
 * same shape every other plugin in this ecosystem ships, and a plugin may
 * (and normally does) register both.
 *
 * The seam is optional and may still be activating on the first tick, so the
 * registration is probed and retried instead of being attempted once.
 */

/** Section namespace; the same one `installSection` registers. */
const NS = 'dsh-web-tavily';

/** How often the optional seam is re-probed while it has not appeared yet. */
const RETRY_MS = 400;

/** Give up after this many attempts (~12 s) and stay silent. */
const RETRY_LIMIT = 30;

/**
 * The card.
 *
 * `apiKey` is deliberately absent: a literal secret in a settings document is
 * the one thing this plugin tells users not to do — the key belongs in the
 * credentials store under the reference named below.
 */
export const SETTINGS_SECTION = Object.freeze({
    ns: NS,
    title: 'Web search (Tavily)',
    descriptions: { zh: '联网搜索（Tavily）', en: 'Web search (Tavily)' },
    fields: [
        {
            path: ['apiKeyEnv'],
            label: 'Credential reference',
            descriptions: { zh: '凭证引用', en: 'Credential reference' },
            hint: 'Environment-variable-style reference for the Tavily key: the credentials service first, then the launch environment.',
            hintDescriptions: {
                zh: 'Tavily 密钥的引用名（环境变量形式）：先查凭证服务，再查启动环境。',
                en: 'Environment-variable-style reference for the Tavily key: the credentials service first, then the launch environment.',
            },
            kind: 'text',
        },
        {
            path: ['baseURL'],
            label: 'API base URL',
            descriptions: { zh: 'API 地址', en: 'API base URL' },
            hint: 'Tavily API origin; the TAVILY_BASE_URL environment variable overrides it.',
            hintDescriptions: {
                zh: 'Tavily API 源地址；环境变量 TAVILY_BASE_URL 可覆盖。',
                en: 'Tavily API origin; the TAVILY_BASE_URL environment variable overrides it.',
            },
            kind: 'text',
        },
        {
            path: ['searchDepth'],
            label: 'Search depth',
            descriptions: { zh: '检索深度', en: 'Search depth' },
            hint: '“advanced” searches further and consumes more credits.',
            hintDescriptions: {
                zh: '「advanced」检索更深入，也消耗更多额度。',
                en: '“advanced” searches further and consumes more credits.',
            },
            kind: 'select',
            options: [
                { value: 'basic', label: 'basic', descriptions: { zh: '基础', en: 'basic' } },
                { value: 'advanced', label: 'advanced', descriptions: { zh: '深入', en: 'advanced' } },
            ],
        },
        {
            path: ['topic'],
            label: 'Topic',
            descriptions: { zh: '检索主题', en: 'Topic' },
            hint: '“news” biases the index towards recent coverage.',
            hintDescriptions: {
                zh: '「news」偏向最近的新闻报道。',
                en: '“news” biases the index towards recent coverage.',
            },
            kind: 'select',
            options: [
                { value: 'general', label: 'general', descriptions: { zh: '通用', en: 'general' } },
                { value: 'news', label: 'news', descriptions: { zh: '新闻', en: 'news' } },
            ],
        },
        {
            path: ['includeAnswer'],
            label: 'Include AI answer',
            descriptions: { zh: '附带 AI 总结', en: 'Include AI answer' },
            hint: 'Ask Tavily for its short AI summary and pass it to the tool as optional content.',
            hintDescriptions: {
                zh: '请求 Tavily 的简短 AI 总结，作为工具的可选内容返回。',
                en: 'Ask Tavily for its short AI summary and pass it to the tool as optional content.',
            },
            kind: 'boolean',
        },
        {
            path: ['maxResults'],
            label: 'Fallback result cap',
            descriptions: { zh: '兜底结果上限', en: 'Fallback result cap' },
            hint: 'Used when a call passes no limit; Tavily itself caps at 20.',
            hintDescriptions: {
                zh: '调用未指定数量时使用；Tavily 自身上限为 20。',
                en: 'Used when a call passes no limit; Tavily itself caps at 20.',
            },
            kind: 'number',
        },
    ],
});

/**
 * Register the card through the optional TUI seam.
 *
 * @param ctx - Cordis context.
 * @param diag - lifecycle logger from `./diag.js`.
 */
export function applySettingsCard(ctx, diag) {
    let attempts = 0;
    let refusalLogged = false;
    /** Consecutive refusals before the card is considered unavailable. */
    let refusals = 0;
    const tryOnce = () => {
        let sections;
        try {
            sections = ctx.get('tuiSettingsSections', false);
        }
        catch {
            sections = undefined;
        }
        if (sections !== undefined && sections !== null && typeof sections.register === 'function') {
            try {
                const dispose = sections.register(SETTINGS_SECTION);
                diag(ctx, 'settings section registered');
                ctx.effect(() => () => {
                    try {
                        if (typeof dispose === 'function') dispose();
                    }
                    catch {
                        // Best-effort teardown.
                    }
                });
                return;
            }
            catch (error) {
                // THE FIRST REFUSAL IS NOT A VERDICT. The activation context is
                // not live during the first tick, so `register` answers with
                // "requires a live Cordis activation context" and starts working
                // a few ticks later — the same behaviour every plugin in this
                // ecosystem has to tolerate. Log once, keep trying, and only give
                // up after a long run of refusals.
                refusals += 1;
                if (!refusalLogged) {
                    refusalLogged = true;
                    diag(ctx, `settings section refused (will retry): ${error instanceof Error ? error.message : String(error)}`);
                }
                if (refusals > RETRY_LIMIT) {
                    diag(ctx, `settings section unavailable after ${refusals} refusals; the namespace card stays generic`);
                    return;
                }
            }
        }
        attempts += 1;
        if (attempts > RETRY_LIMIT) return;
        const timer = setTimeout(tryOnce, RETRY_MS);
        if (typeof timer.unref === 'function') timer.unref();
    };
    try {
        tryOnce();
    }
    catch (error) {
        diag(ctx, `settings card setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
