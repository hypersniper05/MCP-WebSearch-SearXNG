// ENHANCED: new module (not part of upstream mcp-searxng). Mounted at /app/dist/enhanced-search.js.
//
// Structured-JSON web search on top of upstream 2.4.0 performWebSearch():
//   - our searxng_web_search tool definition (description + schema) and argument guard
//   - one call per query to upstream performWebSearch(..., "json", "full"), so upstream's
//     timeout, response byte cap, /config category normalisation, search cache,
//     credential guard and multi-instance failover all still apply
//   - reshaped into our output: answers / corrections / suggestions / infoboxes /
//     unresponsive_engines / engine_coverage / pagination / per-category results
//   - multi-query: "a | b | c" runs the queries two at a time
//
// index.js imports WEB_SEARCH_TOOL, isSearXNGWebSearchArgs and searchArgsProblem from here
// instead of types.js, and passes the help://usage-guide text through withEnhancedHelp().
import { WEB_SEARCH_TOOL as UPSTREAM_WEB_SEARCH_TOOL, isSearXNGWebSearchArgs as isUpstreamWebSearchArgs } from "./types.js";
import { performWebSearch, getSearchTimeoutMs } from "./search.js";
import { MCPSearXNGError } from "./error-handler.js";
import { logMessage } from "./logging.js";
import { parseBoundedInteger } from "./env-int.js";

// Multi-query searches used to fan out with an unbounded Promise.all. Each query hits
// every engine in the category at once, so N queries meant N simultaneous requests per
// engine from a single IP -- enough to trip rate limits and exhaust SearXNG's outgoing
// connection pool. Run them a couple at a time instead.
// MCP_MULTI_QUERY_CONCURRENCY overrides the default (1-4).
export const MAX_CONCURRENT_QUERIES = (() => {
    const { value, invalid } = parseBoundedInteger(process.env.MCP_MULTI_QUERY_CONCURRENCY, 2, 1, 4);
    if (invalid)
        console.warn("Ignoring invalid MCP_MULTI_QUERY_CONCURRENCY (expected an integer from 1 to 4); using 2.");
    return value;
})();
// Upper bound on " | " sub-queries per call. Extra queries are reported, not run.
export const MAX_QUERIES_PER_CALL = 10;
const MAX_RESULTS_CAP = 50;
const DEFAULT_LIMITS = { images: 10, videos: 10, general: 20 };

export const WEB_SEARCH_TOOL = {
    ...UPSTREAM_WEB_SEARCH_TOOL,
    name: "searxng_web_search",
    description: "Search the web using SearXNG metasearch engine. Returns structured JSON with results, suggestions, corrections, answers, and infoboxes. " +
        "The required parameter name is exactly `query`.\n\n" +
        "## Categories\n" +
        "Use 'categories' to search different types of content:\n" +
        "- 'general' (default) — web search aggregated from several search engines\n" +
        "- 'images' — image search with URLs, thumbnails, and resolution info\n" +
        "- 'videos' — video search with duration and thumbnails\n" +
        "- 'news' — recent news articles with publication dates\n" +
        "- 'science' — academic papers and research publications\n" +
        "- 'files' — torrent search (magnet links, seeders/leechers, file sizes)\n" +
        "- 'it' — developer/IT site engines: package registries, documentation, code repositories, tech Q&A\n" +
        "- 'music' — music and audio\n" +
        "- 'social media' — posts and profiles from social platforms\n" +
        "Other SearXNG categories such as 'map', 'packages', 'repos' or 'q&a' also work. Separate several categories with commas.\n\n" +
        "## Special features\n" +
        "- **Multiple queries**: separate queries with ' | ' to run several searches in one call; each result set is returned with its query\n" +
        "- **Currency conversion**: Query like '1 USD to EUR' — the answer appears in the 'answers' field\n" +
        "- **Spell corrections**: Misspelled queries return corrections in the 'corrections' field\n" +
        "- **Search suggestions**: Related queries appear in the 'suggestions' field\n" +
        "- **Knowledge panels**: Wikipedia infoboxes appear in the 'infoboxes' field with summaries and images\n\n" +
        "## Pagination\n" +
        "Results are paginated. Default: 10 for images/videos, 20 for general. Max 50 per call via 'max_results'.\n" +
        "Use 'offset' to page through results (e.g., offset=10 for results 11-20).\n" +
        "Check 'has_more' in the response to know if more results are available on this page; use 'pageno' for the next batch from the engines.\n\n" +
        "## Tips\n" +
        "- For image results, use web_url_read on image URLs to view them\n" +
        "- Check 'suggestions' for alternative queries if results are poor\n" +
        "- Check 'corrections' if the query might have typos\n" +
        "- The 'engines' array on each result shows which search engines found it (higher overlap = more relevant)\n" +
        "- 'engine_coverage' lists the engines that answered this search and how many did not respond",
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query string. Supports:\n" +
                    "- Single query: 'latest AI news'\n" +
                    "- Search operators: '\"exact phrase\"', 'site:reddit.com', 'filetype:pdf', '+required -excluded', 'term1 OR term2'\n" +
                    "- Multiple queries in one call: separate with ' | ' (pipe) e.g. 'trump news | bitcoin price | iran latest' — each runs as a separate search and results are returned together. This is efficient for gathering info on multiple topics at once.",
            },
            categories: {
                type: "string",
                description: "Search category. Options: general, images, videos, news, science, music, files (torrents), it (developer/IT sites), social media. Default: general. Can be comma-separated for multiple categories.",
                default: "general",
            },
            pageno: {
                type: "integer",
                description: "Search page number (starts at 1). Each page fetches a new batch from search engines. Use this together with offset for deep pagination.",
                minimum: 1,
                default: 1,
            },
            time_range: {
                type: "string",
                description: "Filter results by time range. 'day' = last 24h, 'week' = last 7 days, 'month' = last 30 days, 'year' = last 12 months. Useful for news and recent content.",
                enum: ["day", "week", "month", "year"],
            },
            language: {
                type: "string",
                description: "Language code for search results (e.g., 'en', 'es', 'fr', 'de', 'ja'). Use 'all' for no language filter. Default: 'all'.",
                default: "all",
            },
            max_results: {
                type: "number",
                description: "Maximum number of results to return per request. Default: 10 for images/videos, 20 for general/news. Max: 50.",
                minimum: 1,
                maximum: MAX_RESULTS_CAP,
            },
            offset: {
                type: "number",
                description: "Number of results to skip for pagination. Use offset=10 to get results 11-20, offset=20 for 21-30, etc.",
                minimum: 0,
                default: 0,
            },
            safesearch: {
                type: "number",
                description: "Safe search filter level. 0: Off (default), 1: Moderate, 2: Strict.",
                enum: [0, 1, 2],
                default: 0,
            },
            engines: {
                type: "string",
                description: "Optional comma-separated SearXNG engine names to query instead of the category defaults (e.g. 'bing,wikipedia'). Omit to use every engine in the category. If you also set time_range, every listed engine must support time ranges (searxng_instance_info shows which do), or the search is refused.",
            },
            min_score: {
                type: "number",
                description: "Optional minimum relevance score (0.0-1.0). Results below it are dropped.",
                minimum: 0,
                maximum: 1,
            },
        },
        required: ["query"],
    },
};

// Accepts a number or a numeric string (older clients send "10"); returns NaN otherwise.
function toNumber(value) {
    if (typeof value === "number")
        return value;
    if (typeof value === "string" && value.trim() !== "")
        return Number(value);
    return Number.NaN;
}

const VALID_TIME_RANGES = ["day", "week", "month", "year"];
const VALID_SAFESEARCH = [0, 1, 2, "0", "1", "2"];
const VALID_RESPONSE_FORMATS = ["text", "json"];
const VALID_RESULT_DETAILS = ["compact", "full"];
// Optional arguments where null or "" means "not set". Clients that fill every optional
// field (OpenAI-style strict tool calling, LM Studio, n8n) send these. language "" is kept:
// upstream reads it as "no language filter", while a missing language uses SEARXNG_DEFAULT_LANGUAGE.
const OPTIONAL_SEARCH_ARGS = ["pageno", "time_range", "language", "safesearch", "categories", "engines", "min_score", "num_results", "response_format", "result_detail", "max_results", "offset"];

// Bring loosely-typed calls to the form upstream's strict guard accepts, in place. The pre-2.4
// server only checked `query` and ignored optional values it could not use, so these calls
// must keep working. Idempotent: the guard runs once before admission and again in the handler.
function normalizeSearchArgs(args) {
    for (const key of OPTIONAL_SEARCH_ARGS) {
        const value = args[key];
        if (value === null || (typeof value === "string" && value.trim() === "" && key !== "language"))
            delete args[key];
    }
    // ["news", "it"] -> "news,it"
    for (const key of ["categories", "engines"]) {
        const value = args[key];
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
            const joined = value.map((v) => v.trim()).filter((v) => v !== "").join(",");
            if (joined === "")
                delete args[key];
            else
                args[key] = joined;
        }
    }
    // "2" -> 2 for the numeric arguments upstream checks with typeof === "number".
    for (const key of ["pageno", "min_score", "num_results"]) {
        if (typeof args[key] === "string" && /^\s*\d+(\.\d+)?\s*$/.test(args[key]))
            args[key] = Number(args[key]);
    }
    // 0 is a common filler for "not set"; SearXNG pages start at 1.
    if (args.pageno === 0)
        delete args.pageno;
    // Unusable values were ignored before (no time_range / safesearch sent), so drop them.
    if (args.time_range !== undefined) {
        const range = typeof args.time_range === "string" ? args.time_range.trim().toLowerCase() : undefined;
        if (VALID_TIME_RANGES.includes(range))
            args.time_range = range;
        else
            delete args.time_range;
    }
    if (args.safesearch !== undefined && !VALID_SAFESEARCH.includes(args.safesearch))
        delete args.safesearch;
    if (args.response_format !== undefined && !VALID_RESPONSE_FORMATS.includes(args.response_format))
        delete args.response_format;
    if (args.result_detail !== undefined && !VALID_RESULT_DETAILS.includes(args.result_detail))
        delete args.result_detail;
    // max_results below 1 means "default" (the old server treated 0 that way); a negative offset means 0.
    if (args.max_results !== undefined) {
        const n = toNumber(args.max_results);
        if (Number.isFinite(n) && n < 1)
            delete args.max_results;
    }
    if (args.offset !== undefined) {
        const n = toNumber(args.offset);
        if (Number.isFinite(n) && n < 0)
            delete args.offset;
    }
    // Our output path: num_results is upstream's name for max_results (and may go up to 50 here).
    if (args.response_format === undefined && args.num_results !== undefined) {
        if (args.max_results === undefined) {
            const n = toNumber(args.num_results);
            if (Number.isFinite(n) && n >= 1)
                args.max_results = n;
        }
        delete args.num_results;
    }
    // Upstream's output path (explicit response_format) accepts num_results 1-20: clamp, as max_results is.
    else if (args.num_results !== undefined) {
        const n = Math.floor(toNumber(args.num_results));
        if (Number.isFinite(n)) {
            if (n < 1)
                delete args.num_results;
            else
                args.num_results = Math.min(n, 20);
        }
    }
}

// Returns undefined when the arguments are usable, otherwise a short reason that names the
// argument, so a model can correct the call instead of repeating it. Normalises args first.
export function searchArgsProblem(args) {
    if (typeof args !== "object" || args === null || Array.isArray(args))
        return "arguments must be an object with a string `query`";
    if (typeof args.query !== "string")
        return "`query` is required and must be a string";
    normalizeSearchArgs(args);
    if (args.pageno !== undefined && (typeof args.pageno !== "number" || !Number.isInteger(args.pageno) || args.pageno < 1))
        return "`pageno` must be a whole number of 1 or more";
    if (args.language !== undefined && typeof args.language !== "string")
        return "`language` must be a string such as \"en\" or \"all\"";
    if (args.categories !== undefined && typeof args.categories !== "string")
        return "`categories` must be a string; separate several categories with commas";
    if (args.engines !== undefined && typeof args.engines !== "string")
        return "`engines` must be a string of comma-separated engine names";
    if (args.max_results !== undefined && !Number.isFinite(toNumber(args.max_results)))
        return `\`max_results\` must be a number from 1 to ${MAX_RESULTS_CAP}`;
    if (args.offset !== undefined && !Number.isFinite(toNumber(args.offset)))
        return "`offset` must be a number of 0 or more";
    if (args.min_score !== undefined && (typeof args.min_score !== "number" || !(args.min_score >= 0 && args.min_score <= 1)))
        return "`min_score` must be a number from 0 to 1";
    if (args.num_results !== undefined && (typeof args.num_results !== "number" || !Number.isInteger(args.num_results) || args.num_results < 1 || args.num_results > 20))
        return "`num_results` must be a number; prefer `max_results` (1 to 50)";
    if (!isUpstreamWebSearchArgs(args))
        return "an argument has an unsupported type or value; check the tool's input schema";
    return undefined;
}

// Upstream guard plus our leniency and our two parameters (max_results, offset).
// Failing here gives the isError "Invalid arguments for web search: <reason>" result.
export function isSearXNGWebSearchArgs(args) {
    return searchArgsProblem(args) === undefined;
}

export async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length)
                return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

function engineNames(item) {
    if (Array.isArray(item?.engines))
        return item.engines.filter((e) => typeof e === "string" && e !== "");
    return typeof item?.engine === "string" && item.engine !== "" ? [item.engine] : [];
}

// Which engines contributed to this SearXNG page, and how many did not respond.
function engineCoverage(data) {
    const answered = new Set();
    for (const r of data.results ?? [])
        for (const e of engineNames(r)) answered.add(e);
    for (const ib of data.infoboxes ?? [])
        for (const e of engineNames(ib)) answered.add(e);
    for (const a of data.answers ?? [])
        if (a && typeof a === "object")
            for (const e of engineNames(a)) answered.add(e);
    return {
        answered: [...answered].sort(),
        failed_count: Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines.length : 0,
    };
}

function formatImageResult(r) {
    const item = { title: r.title || "" };
    if (r.img_src) item.img_src = r.img_src;
    if (r.thumbnail_src || r.thumbnail) item.thumbnail = r.thumbnail_src || r.thumbnail;
    if (r.url) item.page_url = r.url;
    if (r.resolution) item.resolution = r.resolution;
    if (r.source) item.source = r.source;
    if (r.content) item.description = r.content;
    if (r.engines) item.engines = r.engines;
    item.score = r.score || 0;
    return item;
}

function formatVideoResult(r) {
    const item = { title: r.title || "" };
    if (r.url) item.url = r.url;
    if (r.thumbnail_src || r.thumbnail || r.img_src) item.thumbnail = r.thumbnail_src || r.thumbnail || r.img_src;
    if (r.length) item.duration = r.length;
    if (r.source) item.source = r.source;
    if (r.publishedDate) item.published = r.publishedDate;
    if (r.content) item.description = r.content;
    if (r.engines) item.engines = r.engines;
    item.score = r.score || 0;
    return item;
}

// General, news, science, files, it, music, social media, ...
// Template-specific fields (torrents, papers, packages) are added only when SearXNG sends them.
const EXTRA_RESULT_FIELDS = [
    // torrents ('files')
    "magnetlink", "seed", "leech", "filesize", "files",
    // papers ('science')
    "authors", "journal", "doi", "pdf_url", "publisher",
    // packages ('it')
    "package_name", "version", "maintainer", "license_name", "homepage", "source_code_url",
];
function formatGeneralResult(r) {
    const item = { title: r.title || "" };
    if (r.url) item.url = r.url;
    if (r.content) item.description = r.content;
    if (r.publishedDate) item.published = r.publishedDate;
    if (r.engines) item.engines = r.engines;
    if (r.category && r.category !== "general") item.category = r.category;
    if (r.metadata) item.metadata = r.metadata;
    if (r.author) item.author = r.author;
    for (const key of EXTRA_RESULT_FIELDS) {
        const value = r[key];
        if (value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
            item[key] = value;
    }
    item.score = r.score || 0;
    return item;
}

function resolveLimit(args, isImageSearch, isVideoSearch) {
    const fallback = isImageSearch ? DEFAULT_LIMITS.images : isVideoSearch ? DEFAULT_LIMITS.videos : DEFAULT_LIMITS.general;
    // num_results is upstream's name for the same thing; honour it when max_results is absent.
    const requested = args.max_results ?? args.num_results;
    if (requested === undefined || requested === null)
        return fallback;
    const n = Math.floor(toNumber(requested));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_RESULTS_CAP) : fallback;
}

function resolveOffset(args) {
    if (args.offset === undefined || args.offset === null)
        return 0;
    const n = Math.floor(toNumber(args.offset));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// Reshape upstream's raw SearXNG JSON envelope into our structured output.
function structureSearchData(data, query, args) {
    const categories = args.categories ?? "general";
    const categoriesLower = String(categories).toLowerCase();
    const isImageSearch = categoriesLower.includes("images");
    const isVideoSearch = categoriesLower.includes("videos");
    const allResults = Array.isArray(data.results) ? data.results : [];
    const limit = resolveLimit(args, isImageSearch, isVideoSearch);
    const offset = resolveOffset(args);
    const totalResults = allResults.length;
    const start = Math.min(offset, totalResults);
    const end = Math.min(start + limit, totalResults);
    const slicedResults = allResults.slice(start, end);

    const output = {
        query: data.query || query,
        categories,
        total_results: totalResults,
    };
    // Only include number_of_results if engines actually report it
    if (data.number_of_results && data.number_of_results > 0) {
        output.estimated_total = data.number_of_results;
    }
    if (Array.isArray(data.answers) && data.answers.length > 0) {
        output.answers = data.answers.map((a) => typeof a === "string" ? a : (a.answer || a));
    }
    if (Array.isArray(data.corrections) && data.corrections.length > 0) {
        output.corrections = data.corrections;
    }
    if (Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        output.suggestions = data.suggestions;
    }
    if (Array.isArray(data.infoboxes) && data.infoboxes.length > 0) {
        output.infoboxes = data.infoboxes.map((ib) => {
            const box = { title: ib.infobox || "", content: ib.content || "" };
            if (ib.img_src) box.image = ib.img_src;
            if (ib.urls && ib.urls.length > 0) box.urls = ib.urls;
            if (ib.attributes && ib.attributes.length > 0) box.attributes = ib.attributes;
            return box;
        });
    }
    if (Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length > 0) {
        output.unresponsive_engines = data.unresponsive_engines.map((entry) => Array.isArray(entry)
            ? { engine: entry[0], reason: entry[1] }
            : { engine: entry?.engine ?? String(entry), reason: entry?.reason ?? "" });
    }
    // Computed over the whole SearXNG page (after min_score), before offset/max_results.
    output.engine_coverage = engineCoverage({ ...data, results: allResults });
    output.pagination = {
        showing: end > start ? `${start + 1}-${end}` : "none",
        has_more: end < totalResults,
        next_offset: end < totalResults ? end : null,
    };
    output.results = slicedResults.map(isImageSearch ? formatImageResult : isVideoSearch ? formatVideoResult : formatGeneralResult);

    if (output.results.length === 0 && !output.answers && !output.infoboxes) {
        if (totalResults > 0 && start >= totalResults) {
            const pageno = args.pageno ?? 1;
            output.message = `No more results on this page (offset ${offset}, ${totalResults} results). Use pageno=${pageno + 1} for the next batch.`;
        }
        else if (!output.suggestions && !output.corrections) {
            // Do not tell the model to rephrase when the emptiness may come from engines failing.
            output.message = output.engine_coverage.failed_count > 0
                ? "No results found."
                : "No results found. Try different keywords or a broader query.";
        }
    }
    // Upstream extras, passed through when present.
    if (Array.isArray(data.warnings) && data.warnings.length > 0) output.warnings = data.warnings;
    if (Array.isArray(data.servedBy) && data.servedBy.length > 0) output.served_by = data.servedBy;
    if (data.sourceFormat === "html") output.source_format = "html";
    if (data.cached === true) output.cached = true;
    return output;
}

function upstreamCategories(categories) {
    if (typeof categories !== "string")
        return undefined;
    const trimmed = categories.trim();
    // 'general' was never sent to SearXNG (it is SearXNG's own default); keep that wire behaviour.
    return trimmed === "" || trimmed.toLowerCase() === "general" ? undefined : trimmed;
}

async function searchOne(mcpServer, query, args) {
    const startTime = Date.now();
    const safesearch = args.safesearch === undefined || args.safesearch === null ? undefined : Number(args.safesearch);
    // num_results undefined -> whole SearXNG page (we slice ourselves); json + full -> raw envelope.
    let raw;
    try {
        raw = await performWebSearch(mcpServer, query, args.pageno ?? 1, args.time_range, args.language, safesearch, args.min_score, undefined, upstreamCategories(args.categories), args.engines, "json", "full");
    }
    catch (error) {
        // Upstream reports its own SEARXNG_TIMEOUT_MS abort as "Network Error: This operation was aborted".
        if (error instanceof MCPSearXNGError && /operation was aborted/i.test(error.message))
            throw new MCPSearXNGError(`⏱️ Timeout Error: SearXNG did not respond within ${getSearchTimeoutMs(mcpServer)} ms (SEARXNG_TIMEOUT_MS)`);
        throw error;
    }
    const output = structureSearchData(JSON.parse(raw), query, args);
    output.search_time_ms = Date.now() - startTime;
    return output;
}

// "a | b" -> ["a", "b"]. A query made only of separators (" | ") gives [], as before: no search.
export function splitQueries(query) {
    if (!query.includes(" | "))
        return [query];
    return query.split(" | ").map((q) => q.trim()).filter((q) => q.length > 0);
}

// Returns the JSON text for the tool result.
export async function enhancedWebSearch(mcpServer, args, signal) {
    const queries = splitQueries(args.query);
    if (queries.length === 0)
        return JSON.stringify({ multi_query: true, queries: [], results: [] }, null, 2);
    if (queries.length === 1) {
        return JSON.stringify(await searchOne(mcpServer, queries[0], args), null, 2);
    }
    const runnable = queries.slice(0, MAX_QUERIES_PER_CALL);
    logMessage(mcpServer, "info", `Multi-query search: ${runnable.length} queries, ${MAX_CONCURRENT_QUERIES} at a time`);
    const failures = [];
    const results = await mapWithConcurrency(runnable, MAX_CONCURRENT_QUERIES, async (q) => {
        signal?.throwIfAborted();
        try {
            return await searchOne(mcpServer, q, args);
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            // One failing sub-query no longer fails the whole batch.
            failures.push(error);
            logMessage(mcpServer, "warning", `Multi-query sub-search failed: "${q}": ${error?.message ?? error}`);
            return { error: error?.message ?? String(error) };
        }
    });
    // Every sub-query failed (e.g. SearXNG unreachable): surface it as a tool error, as a single query would.
    if (failures.length === runnable.length)
        throw failures[0];
    for (const q of queries.slice(MAX_QUERIES_PER_CALL)) {
        results.push({ error: `Skipped: at most ${MAX_QUERIES_PER_CALL} queries run per call.` });
    }
    const combined = {
        multi_query: true,
        queries,
        results: queries.map((q, i) => ({ query: q, ...results[i] })),
    };
    return JSON.stringify(combined, null, 2);
}

// help://usage-guide comes from upstream resources.js and documents upstream's search tool
// (text output by default, num_results 1-20). Swap in this server's searxng_web_search section
// and the web_url_read `detail` parameter. If upstream reworks the text, it is returned unchanged.
const HELP_SEARCH_SECTION = `### 1. searxng_web_search
Searches the web through SearXNG and returns structured JSON.

**Parameters:**
- \`query\` (required): The search query. Supports operators such as "exact phrase", site:example.com, -excluded and OR. Separate several queries with " | " to run them in one call.
- \`categories\` (optional): general (default), images, videos, news, science, files (torrent search), it (developer/IT site engines), music, social media. Separate several with commas.
- \`pageno\` (optional): SearXNG page number (default: 1). Each page is a new batch from the engines.
- \`time_range\` (optional): "day", "week", "month" or "year"
- \`language\` (optional): Language code like "en", "fr", "de" (default: "all")
- \`safesearch\` (optional): 0 (off), 1 (moderate), 2 (strict)
- \`max_results\` (optional): Results returned per call, 1 to 50 (default: 20; 10 for images and videos)
- \`offset\` (optional): Results to skip within the current SearXNG page (default: 0)
- \`engines\` (optional): Comma-separated SearXNG engine names to use instead of the category defaults. With \`time_range\`, every listed engine must support time ranges, or the search is refused.
- \`min_score\` (optional): Drop results with a relevance score below this value (0.0 to 1.0)

**Output:** JSON with \`results\` (title, url, description, published, engines, score, plus image, video, torrent, paper or package fields where they apply), \`answers\`, \`corrections\`, \`suggestions\`, \`infoboxes\`, \`unresponsive_engines\`, \`engine_coverage\` (\`answered\` engine names and \`failed_count\`) and \`pagination\` (\`showing\`, \`has_more\`, \`next_offset\`). A multi-query call returns \`{multi_query, queries, results: [{query, ...}]}\`. Leave \`response_format\` unset: an explicit value returns upstream's plain text or raw JSON format instead of this structure, and sends a " | " query to SearXNG as one literal query instead of splitting it.

`;
const HELP_DETAIL_LINE = "- `detail` (optional): For image URLs: \"low\" (448 px), \"medium\" (768 px, default) or \"high\" (1280 px). Image URLs return an image block.\n";
export function withEnhancedHelp(text) {
    if (typeof text !== "string")
        return text;
    const start = text.indexOf("### 1. searxng_web_search");
    const end = text.indexOf("### 2. searxng_search_suggestions");
    let out = start >= 0 && end > start ? text.slice(0, start) + HELP_SEARCH_SECTION + text.slice(end) : text;
    const headingsLine = "- `readHeadings` (optional): Return only headings\n";
    const urlStart = out.indexOf("### 4. web_url_read");
    const at = urlStart >= 0 ? out.indexOf(headingsLine, urlStart) : -1;
    if (at >= 0)
        out = out.slice(0, at + headingsLine.length) + HELP_DETAIL_LINE + out.slice(at + headingsLine.length);
    return out;
}
