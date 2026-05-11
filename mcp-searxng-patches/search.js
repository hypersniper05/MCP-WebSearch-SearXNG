import { tavily } from "@tavily/core";
import { createProxyAgent } from "./proxy.js";
import { logMessage } from "./logging.js";
import { createConfigurationError, createNetworkError, createServerError, createJSONError, createDataError, createNoResultsMessage } from "./error-handler.js";

// Default result limits per category
const DEFAULT_LIMITS = { images: 10, videos: 10, general: 20 };

export async function performWebSearch(server, query, pageno = 1, time_range, language = "all", safesearch, categories = "general", max_results, offset = 0) {
    const startTime = Date.now();
    const searchParams = [
        `page ${pageno}`,
        `lang: ${language}`,
        `categories: ${categories}`,
        time_range ? `time: ${time_range}` : null,
        safesearch ? `safesearch: ${safesearch}` : null
    ].filter(Boolean).join(", ");
    logMessage(server, "info", `Starting web search: "${query}" (${searchParams})`);

    const searxngUrl = process.env.SEARXNG_URL;
    if (!searxngUrl) {
        logMessage(server, "error", "SEARXNG_URL not configured");
        throw createConfigurationError("SEARXNG_URL not set. Set it to your SearXNG instance (e.g., http://localhost:8080 or https://search.example.com)");
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(searxngUrl.endsWith('/') ? searxngUrl : searxngUrl + '/');
    } catch (error) {
        throw createConfigurationError(`Invalid SEARXNG_URL format: ${searxngUrl}. Use format: http://localhost:8080`);
    }

    const url = new URL('search', parsedUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", pageno.toString());

    if (categories && categories !== "general") {
        url.searchParams.set("categories", categories);
    }
    if (time_range !== undefined && ["day", "month", "year"].includes(time_range)) {
        url.searchParams.set("time_range", time_range);
    }
    if (language && language !== "all") {
        url.searchParams.set("language", language);
    }
    if (safesearch !== undefined && [0, 1, 2].includes(safesearch)) {
        url.searchParams.set("safesearch", safesearch.toString());
    }

    const requestOptions = { method: "GET" };
    const proxyAgent = createProxyAgent(url.toString());
    if (proxyAgent) {
        requestOptions.dispatcher = proxyAgent;
    }

    const username = process.env.AUTH_USERNAME;
    const password = process.env.AUTH_PASSWORD;
    if (username && password) {
        const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
        requestOptions.headers = { ...requestOptions.headers, 'Authorization': `Basic ${base64Auth}` };
    }

    const userAgent = process.env.USER_AGENT;
    if (userAgent) {
        requestOptions.headers = { ...requestOptions.headers, 'User-Agent': userAgent };
    }

    let response;
    try {
        logMessage(server, "info", `Making request to: ${url.toString()}`);
        response = await fetch(url.toString(), requestOptions);
    } catch (error) {
        logMessage(server, "error", `Network error during search request: ${error.message}`, { query, url: url.toString() });
        throw createNetworkError(error, { url: url.toString(), searxngUrl, proxyAgent: !!proxyAgent, username });
    }

    if (!response.ok) {
        let responseBody;
        try { responseBody = await response.text(); } catch { responseBody = '[Could not read response body]'; }
        throw createServerError(response.status, response.statusText, responseBody, { url: url.toString(), searxngUrl });
    }

    let data;
    try {
        data = (await response.json());
    } catch (error) {
        let responseText;
        try { responseText = await response.text(); } catch { responseText = '[Could not read response text]'; }
        throw createJSONError(responseText, { url: url.toString() });
    }

    if (!data.results) {
        throw createDataError(data, { url: url.toString(), query });
    }

    // Determine category type
    const isImageSearch = categories && categories.toLowerCase().includes("images");
    const isVideoSearch = categories && categories.toLowerCase().includes("videos");

    // Determine result limit
    const defaultLimit = isImageSearch ? DEFAULT_LIMITS.images : isVideoSearch ? DEFAULT_LIMITS.videos : DEFAULT_LIMITS.general;
    const limit = max_results ? Math.min(max_results, 50) : defaultLimit;

    // Apply offset and limit
    const totalResults = data.results.length;
    const start = Math.min(offset, totalResults);
    const end = Math.min(start + limit, totalResults);
    const slicedResults = data.results.slice(start, end);

    // Build structured JSON response
    const output = {
        query: data.query || query,
        categories: categories,
        total_results: totalResults,
    };
    // Only include number_of_results if engines actually report it
    if (data.number_of_results && data.number_of_results > 0) {
        output.estimated_total = data.number_of_results;
    }

    // Add answers (currency conversion, calculations, etc.)
    if (data.answers && data.answers.length > 0) {
        output.answers = data.answers.map(a => typeof a === 'string' ? a : (a.answer || a));
    }

    // Add spelling corrections
    if (data.corrections && data.corrections.length > 0) {
        output.corrections = data.corrections;
    }

    // Add search suggestions
    if (data.suggestions && data.suggestions.length > 0) {
        output.suggestions = data.suggestions;
    }

    // Add infoboxes (Wikipedia knowledge panels, etc.)
    if (data.infoboxes && data.infoboxes.length > 0) {
        output.infoboxes = data.infoboxes.map(ib => {
            const box = { title: ib.infobox || "", content: ib.content || "" };
            if (ib.img_src) box.image = ib.img_src;
            if (ib.urls && ib.urls.length > 0) box.urls = ib.urls;
            if (ib.attributes && ib.attributes.length > 0) box.attributes = ib.attributes;
            return box;
        });
    }

    // Add unresponsive engines for transparency
    if (data.unresponsive_engines && data.unresponsive_engines.length > 0) {
        output.unresponsive_engines = data.unresponsive_engines.map(([engine, reason]) => ({ engine, reason }));
    }

    // Pagination info
    output.pagination = {
        showing: `${start + 1}-${end}`,
        has_more: end < totalResults,
        next_offset: end < totalResults ? end : null,
    };

    // Format results based on category
    if (isImageSearch) {
        output.results = slicedResults.map(r => {
            const item = { title: r.title || "" };
            if (r.img_src) item.img_src = r.img_src;
            if (r.thumbnail_src) item.thumbnail = r.thumbnail_src;
            if (r.url) item.page_url = r.url;
            if (r.resolution) item.resolution = r.resolution;
            if (r.source) item.source = r.source;
            if (r.content) item.description = r.content;
            if (r.engines) item.engines = r.engines;
            item.score = r.score || 0;
            return item;
        });
    } else if (isVideoSearch) {
        output.results = slicedResults.map(r => {
            const item = { title: r.title || "" };
            if (r.url) item.url = r.url;
            if (r.thumbnail_src || r.img_src) item.thumbnail = r.thumbnail_src || r.img_src;
            if (r.length) item.duration = r.length;
            if (r.source) item.source = r.source;
            if (r.publishedDate) item.published = r.publishedDate;
            if (r.content) item.description = r.content;
            if (r.engines) item.engines = r.engines;
            item.score = r.score || 0;
            return item;
        });
    } else {
        // General, news, science, etc.
        output.results = slicedResults.map(r => {
            const item = { title: r.title || "" };
            if (r.url) item.url = r.url;
            if (r.content) item.description = r.content;
            if (r.publishedDate) item.published = r.publishedDate;
            if (r.engines) item.engines = r.engines;
            if (r.category && r.category !== "general") item.category = r.category;
            if (r.metadata) item.metadata = r.metadata;
            if (r.author) item.author = r.author;
            item.score = r.score || 0;
            return item;
        });
    }

    // Handle empty results
    if (output.results.length === 0 && !output.answers && !output.infoboxes) {
        logMessage(server, "info", `No results found for query: "${query}"`);
        // Still return JSON with suggestions/corrections if available
        if (!output.suggestions && !output.corrections) {
            output.message = "No results found. Try different keywords or a broader query.";
        }
    }

    const duration = Date.now() - startTime;
    logMessage(server, "info", `Search completed: "${query}" (${searchParams}) - ${output.results.length} results in ${duration}ms`);
    output.search_time_ms = duration;

    return JSON.stringify(output, null, 2);
}

export async function performTavilySearch(server, query, max_results = 10, topic = "general") {
    const startTime = Date.now();
    logMessage(server, "info", `Starting Tavily search: "${query}" (topic: ${topic}, max: ${max_results})`);

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
        logMessage(server, "error", "TAVILY_API_KEY not configured");
        throw createConfigurationError("TAVILY_API_KEY not set. Set it to your Tavily API key to enable Tavily search.");
    }

    const tvly = tavily({ apiKey });

    let response;
    try {
        response = await tvly.search(query, {
            maxResults: Math.min(max_results, 20),
            topic,
        });
    } catch (error) {
        logMessage(server, "error", `Tavily search error: ${error.message}`, { query });
        throw new Error(`Tavily search failed: ${error.message}`);
    }

    const output = {
        query: response.query || query,
        results: (response.results || []).map(r => ({
            title: r.title || "",
            url: r.url || "",
            description: r.content || "",
            score: r.score || 0,
        })),
    };

    if (response.answer) {
        output.answer = response.answer;
    }

    const duration = Date.now() - startTime;
    logMessage(server, "info", `Tavily search completed: "${query}" - ${output.results.length} results in ${duration}ms`);
    output.search_time_ms = duration;

    return JSON.stringify(output, null, 2);
}
