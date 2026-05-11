export function isSearXNGWebSearchArgs(args) {
    return (typeof args === "object" &&
        args !== null &&
        "query" in args &&
        typeof args.query === "string");
}
export const WEB_SEARCH_TOOL = {
    name: "searxng_web_search",
    description:
        "Search the web using SearXNG metasearch engine. Returns structured JSON with results, suggestions, corrections, answers, and infoboxes.\n\n" +
        "## Categories\n" +
        "Use 'categories' to search different types of content:\n" +
        "- 'general' (default) — web search via Bing, Startpage, Yahoo, Mojeek, DuckDuckGo, Brave, and others\n" +
        "- 'images' — image search with URLs, thumbnails, and resolution info\n" +
        "- 'videos' — video search with duration and thumbnails\n" +
        "- 'news' — recent news articles with publication dates\n" +
        "- 'science' — academic papers via Google Scholar, PubMed, and others\n" +
        "- 'files' — file/package search\n" +
        "- 'it' — IT/tech-specific results\n" +
        "- 'music' — music search via Bandcamp etc.\n" +
        "- 'social media' — social media content\n\n" +
        "## Special features\n" +
        "- **Currency conversion**: Query like '1 USD to EUR' — the answer appears in the 'answers' field\n" +
        "- **Spell corrections**: Misspelled queries return corrections in the 'corrections' field\n" +
        "- **Search suggestions**: Related queries appear in the 'suggestions' field\n" +
        "- **Knowledge panels**: Wikipedia infoboxes appear in the 'infoboxes' field with summaries and images\n\n" +
        "## Pagination\n" +
        "Results are paginated. Default: 10 for images/videos, 20 for general.\n" +
        "Use 'offset' to page through results (e.g., offset=10 for results 11-20).\n" +
        "Check 'has_more' in the response to know if more results are available.\n\n" +
        "## Tips\n" +
        "- For image results, use web_url_read on image URLs to view them\n" +
        "- Check 'suggestions' for alternative queries if results are poor\n" +
        "- Check 'corrections' if the query might have typos\n" +
        "- The 'engines' array on each result shows which search engines found it (higher overlap = more relevant)",
    annotations: {
        readOnlyHint: true,
        openWorldHint: true,
    },
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query string. Supports:\n" +
                    "- Single query: 'latest AI news'\n" +
                    "- Google-style operators: '\"exact phrase\"', 'site:reddit.com', 'filetype:pdf', '+required -excluded', 'term1 OR term2'\n" +
                    "- Multiple queries in one call: separate with ' | ' (pipe) e.g. 'trump news | bitcoin price | iran latest' — each runs as a separate search and results are returned together. This is efficient for gathering info on multiple topics at once.",
            },
            categories: {
                type: "string",
                description: "Search category. Options: general, images, videos, news, science, music, files, it, social media. Default: general. Can be comma-separated for multiple categories.",
                default: "general",
            },
            pageno: {
                type: "number",
                description: "Search page number (starts at 1). Each page fetches a new batch from search engines. Use this together with offset for deep pagination.",
                default: 1,
            },
            time_range: {
                type: "string",
                description: "Filter results by time range. 'day' = last 24h, 'month' = last 30 days, 'year' = last 12 months. Useful for news and recent content.",
                enum: ["day", "month", "year"],
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
                maximum: 50,
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
        },
        required: ["query"],
    },
};
export function isTavilyWebSearchArgs(args) {
    return (typeof args === "object" &&
        args !== null &&
        "query" in args &&
        typeof args.query === "string");
}
export const TAVILY_WEB_SEARCH_TOOL = {
    name: "tavily_web_search",
    description:
        "Search the web using the Tavily API, optimized for LLM consumption. Returns structured JSON with results and optional AI-generated answers.\n\n" +
        "## Topics\n" +
        "- 'general' (default) — broad web search\n" +
        "- 'news' — recent news articles\n" +
        "- 'finance' — financial data and news\n\n" +
        "## Tips\n" +
        "- Returns relevance-scored results with title, URL, and description\n" +
        "- Use max_results to control the number of results (1-20)",
    annotations: {
        readOnlyHint: true,
        openWorldHint: true,
    },
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query string (max 400 characters).",
            },
            max_results: {
                type: "number",
                description: "Maximum number of results to return (1-20). Default: 10.",
                minimum: 1,
                maximum: 20,
                default: 10,
            },
            topic: {
                type: "string",
                description: "Search topic. Options: general, news, finance. Default: general.",
                enum: ["general", "news", "finance"],
                default: "general",
            },
        },
        required: ["query"],
    },
};
export const READ_URL_TOOL = {
    name: "web_url_read",
    description:
        "Fetch and read content from a URL. Handles both web pages and images.\n\n" +
        "## Web pages\n" +
        "Converts HTML to clean markdown text. Supports pagination for long pages via startChar/maxLength, " +
        "section extraction by heading, and paragraph range selection.\n\n" +
        "## Images\n" +
        "Auto-detects image URLs (jpg, png, gif, webp, svg, bmp, ico, tiff, avif) and returns base64 image data.\n" +
        "Use 'detail' to control quality/token tradeoff:\n" +
        "- 'low' = 448px max, ~256 tokens — good for thumbnails and quick checks\n" +
        "- 'medium' = 768px max, ~756 tokens — good balance (default)\n" +
        "- 'high' = 1280px max, ~2048 tokens — for detailed image analysis\n\n" +
        "## Tips\n" +
        "- Use 'readHeadings: true' first to scan page structure, then 'section' to read specific parts\n" +
        "- For long pages, use startChar/maxLength to read in chunks\n" +
        "- For search result images, use 'low' detail first to preview, 'high' only if needed",
    annotations: {
        readOnlyHint: true,
        openWorldHint: true,
    },
    inputSchema: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "URL to read. Image URLs return base64 image data. Web page URLs return markdown text.",
            },
            startChar: {
                type: "number",
                description: "Starting character position for content extraction (default: 0). Use with maxLength for paginating long pages.",
                minimum: 0,
            },
            maxLength: {
                type: "number",
                description: "Maximum number of characters to return. Useful for reading long pages in chunks.",
                minimum: 1,
            },
            section: {
                type: "string",
                description: "Extract content under a specific heading. Use readHeadings first to discover available sections.",
            },
            paragraphRange: {
                type: "string",
                description: "Return specific paragraph ranges (e.g., '1-5', '3', '10-'). Useful for targeting specific content.",
            },
            readHeadings: {
                type: "boolean",
                description: "If true, returns only the list of headings/sections in the page. Useful for understanding page structure before reading specific sections.",
            },
            detail: {
                type: "string",
                description: "Image detail/quality level. Only applies to image URLs. 'low' (448px, ~256 tokens), 'medium' (768px, ~756 tokens, default), 'high' (1280px, ~2048 tokens).",
                enum: ["low", "medium", "high"],
                default: "medium",
            },
        },
        required: ["url"],
    },
};
