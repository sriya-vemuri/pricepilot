import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const CACHE_TTL_MS        = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_TTL_SHORT_MS  = 15 * 60 * 1000;       // 15 min for low-quality results

function buildCacheKey(product_name, category, target_market, pricing_mode) {
  const normalize = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return [normalize(product_name), category, normalize(target_market), pricing_mode].join('|');
}

const TAVILY_API_KEY = Deno.env.get("TAVILY_API_KEY");

// ── pricing_mode mapping ──────────────────────────────────────────────────────

const CATEGORY_TO_MODE = {
  health_beauty:  'retail',
  food_beverage:  'retail',
  clothing:       'retail',
  electronics:    'retail',
  home_garden:    'retail',
  software:       'retail',
  automotive:     'retail',
  services:       'service',
  other:          'retail',
};

function getPricingMode(category) {
  return CATEGORY_TO_MODE[category] || 'retail';
}

// ── Retailer domains (retail mode only) ──────────────────────────────────────

const RETAILER_DOMAINS_BY_CATEGORY = {
  health_beauty:  ["sephora.com", "ulta.com", "amazon.com", "walmart.com", "target.com", "dermstore.com"],
  clothing:       ["amazon.com", "walmart.com", "target.com", "macys.com", "nordstrom.com"],
  electronics:    ["amazon.com", "bestbuy.com", "walmart.com", "target.com", "newegg.com"],
  food_beverage:  ["amazon.com", "walmart.com", "target.com", "instacart.com", "kroger.com"],
  home_garden:    ["amazon.com", "homedepot.com", "lowes.com", "wayfair.com", "walmart.com"],
  automotive:     ["amazon.com", "autozone.com", "walmart.com", "target.com"],
  software:       ["amazon.com", "bestbuy.com", "walmart.com", "target.com"],
  other:          ["amazon.com", "walmart.com", "target.com", "ebay.com"],
};

function getRetailerDomains(category) {
  return RETAILER_DOMAINS_BY_CATEGORY[category] || RETAILER_DOMAINS_BY_CATEGORY.other;
}

// ── Query builders ────────────────────────────────────────────────────────────

function buildRetailPricingQueries(product_name, category) {
  const isBeauty = category === 'health_beauty';
  const queries = [
    `${product_name} price US USD`,
    `${product_name} retail price United States`,
    `${product_name} Amazon price`,
    `${product_name} Walmart price`,
    `${product_name} Target price`,
  ];
  if (isBeauty) {
    queries.push(`${product_name} Sephora price`);
    queries.push(`${product_name} Ulta price`);
  }
  return queries;
}

function buildServicePricingQueries(product_name) {
  return [
    `${product_name} cost US`,
    `${product_name} average cost US`,
    `${product_name} treatment price US`,
    `${product_name} cost range US`,
    `${product_name} pricing United States`,
  ];
}

function buildTrendQuery(product_name, category) {
  const cat = category.replace(/_/g, ' ');
  return `${product_name} ${cat} US market trend`;
}

function buildDemandQuery(product_name, category) {
  const cat = category.replace(/_/g, ' ');
  return `${product_name} ${cat} consumer demand United States`;
}

// Stage 2 fallback
function buildStage2Queries(product_name, category, pricing_mode) {
  if (pricing_mode === 'service') {
    return [
      `${product_name} provider cost US`,
      `${product_name} fee United States`,
      `${product_name} price per session US`,
    ];
  }
  const isBeauty = category === 'health_beauty';
  if (isBeauty) {
    return [
      `${product_name} Sephora price`,
      `${product_name} Ulta price`,
      `${product_name} drugstore price US`,
    ];
  }
  const retailers = getRetailerDomains(category).slice(0, 3).map(d => d.split('.')[0]);
  return retailers.map(r => `${product_name} ${r} price`);
}

// Stage 3 fallback
function buildStage3Queries(product_name, category, pricing_mode) {
  const cat = category.replace(/_/g, ' ');
  if (pricing_mode === 'service') {
    return [
      `${cat} cost US`,
      `${cat} average price US`,
      `${product_name} starting price`,
    ];
  }
  return [
    `${cat} price US`,
    `drugstore ${cat} price US`,
    `${product_name} price`,
  ];
}

// ── Tavily fetch ──────────────────────────────────────────────────────────────

async function tavilySearch(query, category, pricing_mode) {
  const body = {
    api_key: TAVILY_API_KEY,
    query,
    search_depth: "advanced",
    max_results: 8,
    include_answer: true,
  };
  // Only restrict to retailer domains in retail mode
  if (pricing_mode === 'retail') {
    body.include_domains = getRetailerDomains(category);
  }
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function runQueries(queries, category, pricing_mode) {
  const results = await Promise.all(queries.map(q => tavilySearch(q, category, pricing_mode)));
  const allText = results.flatMap(r => [
    r.answer || "",
    ...(r.results || []).map(x => x.content || ""),
  ]).join(" ");
  const primaryAnswer = results[0]?.answer || "";
  return { allText, primaryAnswer };
}

// ── Price extraction ──────────────────────────────────────────────────────────

const NON_USD_CURRENCY_RE = /[€£¥₹₩₽]|(?:\b(?:EUR|GBP|INR|CNY|JPY|KRW|AUD|CAD)\b)/;
const MARKET_SIZE_RE = /\b(market size|market value|industry revenue|global market|total revenue|market cap|billion.?dollar market|cagr|market forecast|market growth rate|market report)\b/i;
const PRODUCT_PAGE_RE = /\b(buy|shop|add to cart|add to bag|sephora|ulta|walmart|target|amazon|product details|oz|ml|shade|color|ounce|each|in stock|free shipping|per item|per bottle|per tube)\b/i;
const SERVICE_CONTEXT_RE = /\b(treatment|procedure|session|package|case|consultation|visit|appointment|per month|starting from|starting at|as low as|provider|clinic|office|practice)\b/i;

function extractUSDPrices(text, category, pricing_mode) {
  const isBeauty = category === 'health_beauty';
  const results = [];
  const re = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    const price = parseFloat(match[1].replace(/,/g, ""));
    if (price <= 0) continue;

    // Services can have much higher prices — allow up to $100k
    if (pricing_mode === 'service' && price >= 100000) continue;
    if (pricing_mode === 'retail' && price >= 50000) continue;

    const ctxStart = Math.max(0, match.index - 250);
    const ctxEnd   = Math.min(text.length, match.index + match[0].length + 250);
    const ctx      = text.slice(ctxStart, ctxEnd).toLowerCase();

    // Always reject non-USD currency nearby
    if (NON_USD_CURRENCY_RE.test(ctx)) continue;

    // Always reject market-size/revenue context
    if (MARKET_SIZE_RE.test(ctx)) continue;

    if (pricing_mode === 'service') {
      // For services: accept if service context signal is present or price seems reasonable
      const hasServiceContext = SERVICE_CONTEXT_RE.test(ctx);
      // Reject suspiciously small prices (< $10) for services unless explicitly "per session"
      if (price < 10 && !hasServiceContext) continue;
      results.push({ price, source: hasServiceContext ? 'service_context' : 'editorial' });
    } else {
      // Retail mode: same logic as before
      const isProductPage = PRODUCT_PAGE_RE.test(ctx);
      const source = isProductPage ? 'product_page' : 'editorial';
      if (isBeauty) {
        if (isProductPage) {
          results.push({ price, source });
        } else if (price < 1000) {
          results.push({ price, source });
        }
      } else {
        results.push({ price, source });
      }
    }
  }

  return results;
}

// ── Outlier filtering ─────────────────────────────────────────────────────────

const LOW_TICKET_CATEGORIES = ['clothing', 'food_beverage', 'health_beauty', 'other'];

function filterOutliers(priceObjects, baseline, category, pricing_mode) {
  if (priceObjects.length === 0) return [];

  let prices = priceObjects.map(p => p.price);

  // For retail low-ticket: apply baseline cap
  if (pricing_mode === 'retail' && baseline && LOW_TICKET_CATEGORIES.includes(category)) {
    const cap = category === 'health_beauty' ? 10 : 5;
    prices = prices.filter(p => p <= baseline * cap);
    if (prices.length === 0) return [];
  }

  if (prices.length <= 2) return [...prices].sort((a, b) => a - b);

  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Services: use wider IQR multiplier (3x vs 1.5x) to tolerate pricing variance
  const coarseMultiplier = pricing_mode === 'service' ? 5 : 3;
  const iqrMultiplier    = pricing_mode === 'service' ? 3.0 : 1.5;

  const coarse = sorted.filter(p => p >= median / coarseMultiplier && p <= median * coarseMultiplier);
  if (coarse.length < 2) return [median];

  const q1 = coarse[Math.floor(coarse.length * 0.25)];
  const q3 = coarse[Math.floor(coarse.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr === 0) return coarse;

  const lo = q1 - iqr * iqrMultiplier;
  const hi = q3 + iqr * iqrMultiplier;
  const filtered = coarse.filter(p => p >= lo && p <= hi);
  return filtered.length >= 2 ? filtered : coarse;
}

// ── Signal detection ──────────────────────────────────────────────────────────

function detectTrend(text) {
  const t = text.toLowerCase();
  if (/surging|skyrocket|rapid.?growth|booming/.test(t)) return "surging";
  if (/growing|increas|rising|uptick|upward/.test(t)) return "growing";
  if (/declin|decreas|falling|drop|shrink/.test(t)) return "declining";
  return "stable";
}

function detectDemand(text) {
  const t = text.toLowerCase();
  if (/very high demand|extremely popular|selling fast|huge demand/.test(t)) return "very_high";
  if (/high demand|popular|strong demand|widely sought/.test(t)) return "high";
  if (/low demand|niche|limited demand|slow/.test(t)) return "low";
  if (/very low demand|little interest|minimal demand/.test(t)) return "very_low";
  return "moderate";
}

function buildSummary(pricingAnswer, trendAnswer, demandAnswer) {
  const parts = [];
  if (pricingAnswer) parts.push(`Pricing: ${pricingAnswer.trim()}`);
  if (trendAnswer)   parts.push(`Trend: ${trendAnswer.trim()}`);
  if (demandAnswer)  parts.push(`Demand: ${demandAnswer.trim()}`);
  return parts.join(' | ');
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { product_name, category, target_market, baseline_price } = await req.json();
    if (!product_name || !category) {
      return Response.json({ error: "product_name and category are required" }, { status: 400 });
    }

    const pricing_mode = getPricingMode(category);
    const cacheKey = buildCacheKey(product_name, category, target_market, pricing_mode);
    console.log(`[tavilyMarketResearch] pricing_mode=${pricing_mode} category=${category} product=${product_name} cache_key=${cacheKey}`);

    // ── Cache lookup ──────────────────────────────────────────────────────────
    try {
      const cached = await base44.asServiceRole.entities.MarketCache.filter({ cache_key: cacheKey });
      if (cached.length > 0) {
        const entry = cached[0];
        const now = Date.now();
        const expiresAt = new Date(entry.expires_at).getTime();
        if (now < expiresAt) {
          console.log(`[tavilyMarketResearch] CACHE HIT for key=${cacheKey}`);
          return Response.json({ ...entry, cache_hit: true });
        }
        console.log(`[tavilyMarketResearch] CACHE EXPIRED for key=${cacheKey}`);
      }
    } catch (e) {
      console.warn(`[tavilyMarketResearch] Cache read failed (continuing): ${e.message}`);
    }

    // ── Stage 1: Primary queries + trend/demand in parallel ──
    const stage1Queries = pricing_mode === 'service'
      ? buildServicePricingQueries(product_name)
      : buildRetailPricingQueries(product_name, category);

    const [stage1Result, trendRes, demandRes] = await Promise.all([
      runQueries(stage1Queries, category, pricing_mode),
      tavilySearch(buildTrendQuery(product_name, category), category, pricing_mode),
      tavilySearch(buildDemandQuery(product_name, category), category, pricing_mode),
    ]);

    let allPriceObjects = extractUSDPrices(stage1Result.allText, category, pricing_mode);
    let filteredPrices = filterOutliers(allPriceObjects, baseline_price, category, pricing_mode);
    filteredPrices.sort((a, b) => a - b);
    let retrieval_mode = 'primary';
    let usedQuery = stage1Queries[0];
    let primaryAnswer = stage1Result.primaryAnswer;

    // ── Stage 2 fallback ──
    if (filteredPrices.length < 3) {
      const stage2Queries = buildStage2Queries(product_name, category, pricing_mode);
      const stage2Result = await runQueries(stage2Queries, category, pricing_mode);
      const stage2Objects = extractUSDPrices(stage2Result.allText, category, pricing_mode);
      const merged2 = filterOutliers([...allPriceObjects, ...stage2Objects], baseline_price, category, pricing_mode);
      merged2.sort((a, b) => a - b);

      if (merged2.length > filteredPrices.length) {
        allPriceObjects = [...allPriceObjects, ...stage2Objects];
        filteredPrices = merged2;
        retrieval_mode = filteredPrices.length >= 3 ? 'stage2_success' : 'stage2_insufficient';
        usedQuery = stage2Queries[0];
        primaryAnswer = stage2Result.primaryAnswer || primaryAnswer;
      }
    }

    // ── Stage 3 fallback ──
    if (filteredPrices.length < 3) {
      const stage3Queries = buildStage3Queries(product_name, category, pricing_mode);
      const stage3Result = await runQueries(stage3Queries, category, pricing_mode);
      const stage3Objects = extractUSDPrices(stage3Result.allText, category, pricing_mode);
      const merged3 = filterOutliers([...allPriceObjects, ...stage3Objects], baseline_price, category, pricing_mode);
      merged3.sort((a, b) => a - b);

      if (merged3.length > filteredPrices.length) {
        filteredPrices = merged3;
        retrieval_mode = filteredPrices.length >= 3 ? 'stage3_success' : 'exhausted';
        usedQuery = stage3Queries[0];
      } else {
        retrieval_mode = 'exhausted';
      }
    }

    const rawPriceCount = allPriceObjects.length;
    const hasReliableData = filteredPrices.length >= 3;

    const competitor_price_1 = hasReliableData ? filteredPrices[0] : null;
    const competitor_price_2 = hasReliableData ? filteredPrices[Math.floor(filteredPrices.length / 2)] : null;
    const competitor_price_3 = hasReliableData ? filteredPrices[filteredPrices.length - 1] : null;
    const filtered_range_low  = hasReliableData ? filteredPrices[0] : null;
    const filtered_range_high = hasReliableData ? filteredPrices[filteredPrices.length - 1] : null;
    // Pass the full filtered price list so generatePricing can compute avg/variance directly
    const comparable_prices = hasReliableData ? filteredPrices : [];

    const trendDemandText = [
      trendRes.answer || "",
      demandRes.answer || "",
      ...(trendRes.results  || []).map(r => r.content || ""),
      ...(demandRes.results || []).map(r => r.content || ""),
    ].join(" ");

    const market_trend = detectTrend(trendDemandText);
    const demand_level = detectDemand(trendDemandText);
    const summary = buildSummary(primaryAnswer, trendRes.answer, demandRes.answer);

    const result = {
      pricing_mode,
      cache_key: cacheKey,
      competitor_price_1,
      competitor_price_2,
      competitor_price_3,
      comparable_prices,
      filtered_range_low,
      filtered_range_high,
      outliers_removed: rawPriceCount - filteredPrices.length,
      raw_prices_found: rawPriceCount,
      filtered_prices_count: filteredPrices.length,
      has_reliable_data: hasReliableData,
      retrieval_mode,
      market_trend,
      demand_level,
      summary,
      tavily_query: usedQuery,
      fetched_at: new Date().toISOString(),
      cache_hit: false,
    };

    // ── Cache write ───────────────────────────────────────────────────────────
    // Use short TTL for low-quality results (< 3 prices), full 24h for reliable data
    const ttl = hasReliableData ? CACHE_TTL_MS : CACHE_TTL_SHORT_MS;
    const expires_at = new Date(Date.now() + ttl).toISOString();
    try {
      const existing = await base44.asServiceRole.entities.MarketCache.filter({ cache_key: cacheKey });
      const cachePayload = { ...result, expires_at };
      if (existing.length > 0) {
        await base44.asServiceRole.entities.MarketCache.update(existing[0].id, cachePayload);
      } else {
        await base44.asServiceRole.entities.MarketCache.create(cachePayload);
      }
      console.log(`[tavilyMarketResearch] CACHE WRITE key=${cacheKey} ttl=${ttl / 60000}min reliable=${hasReliableData}`);
    } catch (e) {
      console.warn(`[tavilyMarketResearch] Cache write failed (non-fatal): ${e.message}`);
    }

    return Response.json(result);
  } catch (error) {
    console.error('[tavilyMarketResearch] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});