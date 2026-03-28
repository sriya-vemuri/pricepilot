import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// ── Confidence & Explanation Logic ────────────────────────────────────────────

function calculateConfidenceScore(num_prices, price_variance, market_trend, demand_level, has_competitor_data) {
  let score = 50;

  // Price count boost
  if (num_prices >= 10) score += 25;
  else if (num_prices >= 5) score += 15;
  else if (num_prices >= 3) score += 5;

  // Price variance penalty
  if (price_variance <= 0.15) score += 15;
  else if (price_variance <= 0.3) score += 8;
  else if (price_variance >= 0.8) score -= 10;

  // Market signals
  if (market_trend === 'surging') score += 10;
  if (demand_level === 'very_high' || demand_level === 'high') score += 8;

  // Competitor data
  if (has_competitor_data) score += 12;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildConfidenceExplanation(score, num_prices, variance, market_trend, demand_level, competitor_avg) {
  const parts = [];

  if (num_prices >= 10) {
    parts.push('Strong price dataset');
  } else if (num_prices >= 5) {
    parts.push('Moderate price sample');
  } else if (num_prices >= 3) {
    parts.push('Limited price data');
  } else {
    parts.push('Minimal market data');
  }

  if (variance <= 0.15) {
    parts.push('consistent market pricing');
  } else if (variance <= 0.3) {
    parts.push('stable pricing');
  } else {
    parts.push('variable market pricing');
  }

  if (market_trend === 'surging') {
    parts.push('strong upward trend');
  } else if (market_trend === 'growing') {
    parts.push('positive growth signals');
  } else if (market_trend === 'declining') {
    parts.push('declining market trend');
  }

  if (demand_level === 'very_high') {
    parts.push('very high demand');
  } else if (demand_level === 'high') {
    parts.push('strong demand');
  } else if (demand_level === 'low' || demand_level === 'very_low') {
    parts.push('weak demand signals');
  }

  if (competitor_avg) {
    parts.push('validated against competitors');
  }

  return `${Math.round(score)}% confidence based on ${parts.join(', ')}`;
}

// ── Baseline Sanity Check ────────────────────────────────────────────────────

const BASELINE_SANITY_BOUNDS = {
  electronics: { min: 50, max: 10000 },
  software: { min: 20, max: 5000 },
  clothing: { min: 10, max: 500 },
  health_beauty: { min: 5, max: 300 },
  food_beverage: { min: 2, max: 100 },
  home_garden: { min: 15, max: 2000 },
  automotive: { min: 100, max: 50000 },
  services: { min: 50, max: 10000 },
  other: { min: 10, max: 5000 },
};

function checkBaselinePlausibility(baseline, category, competitor_avg) {
  const bounds = BASELINE_SANITY_BOUNDS[category] || BASELINE_SANITY_BOUNDS.other;

  if (baseline < bounds.min || baseline > bounds.max) {
    return {
      status: 'implausible',
      reason: `Baseline $${baseline.toFixed(2)} outside typical ${category} range ($${bounds.min}-$${bounds.max})`,
    };
  }

  if (competitor_avg) {
    const ratio = baseline / competitor_avg;
    if (ratio < 0.2 || ratio > 5) {
      return {
        status: 'implausible',
        reason: `Baseline is ${(ratio * 100).toFixed(0)}% of competitor average—likely cost data error`,
      };
    }
  }

  return { status: 'plausible', reason: null };
}

// ── Price Range Logic ────────────────────────────────────────────────────────

function calculatePriceRange(baseline, strategy, competitor_avg, confidence_score) {
  let low, high;

  if (strategy === 'aggressive') {
    low = baseline * 0.95;
    high = baseline * 1.4;
  } else if (strategy === 'premium') {
    low = baseline * 1.1;
    high = baseline * 1.8;
  } else {
    low = baseline * 0.98;
    high = baseline * 1.25;
  }

  if (competitor_avg && confidence_score >= 60) {
    const comp_low = competitor_avg * 0.85;
    const comp_high = competitor_avg * 1.15;
    low = Math.max(low, comp_low);
    high = Math.min(high, comp_high);
  }

  return { low: Math.round(low * 100) / 100, high: Math.round(high * 100) / 100 };
}

// ── Competitor Average Logic ─────────────────────────────────────────────────

function computeCompetitorAverage(comparable_prices) {
  if (!comparable_prices || comparable_prices.length < 3) {
    return {
      avg: null,
      status: 'unavailable_insufficient_data',
    };
  }

  const sum = comparable_prices.reduce((a, b) => a + b, 0);
  const avg = sum / comparable_prices.length;

  return {
    avg: Math.round(avg * 100) / 100,
    status: 'available',
  };
}

// ── Variance Calculation ─────────────────────────────────────────────────────

function calculateVariance(prices) {
  if (!prices || prices.length < 2) return 0;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sqDiffs = prices.map(p => (p - mean) ** 2);
  const variance = sqDiffs.reduce((a, b) => a + b, 0) / prices.length;
  const stddev = Math.sqrt(variance);
  return mean !== 0 ? stddev / mean : 0;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const {
      cost,
      target_margin,
      strategy,
      category,
      comparable_prices = [],
      competitor_price_1,
      competitor_price_2,
      competitor_price_3,
      demand_level,
      market_trend,
      raw_prices_found,
      filtered_prices_count,
      pricing_mode = 'retail',
    } = await req.json();

    if (!cost || !strategy || !category) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // ── Baseline calculation ──────────────────────────────────────────────────
    const margin = Math.min(Math.max((target_margin || 30) / 100, 0.01), 0.95);
    const baseline_price = Math.round((cost / (1 - margin)) * 100) / 100;

    // ── Baseline sanity check ──────────────────────────────────────────────────
    const compAvg = competitor_price_1 && competitor_price_2 && competitor_price_3
      ? (competitor_price_1 + competitor_price_2 + competitor_price_3) / 3
      : null;

    const baselineSanity = checkBaselinePlausibility(baseline_price, category, compAvg);
    const baseline_conflict = baselineSanity.status === 'implausible';

    // ── Competitor average ───────────────────────────────────────────────────
    const compAvgResult = computeCompetitorAverage(comparable_prices);
    const competitor_avg_price = compAvgResult.avg;
    const competitor_avg_status = competitor_avg_price
      ? 'available'
      : compAvgResult.status;

    // ── Variance ──────────────────────────────────────────────────────────────
    const price_variance = calculateVariance(comparable_prices);
    const number_of_valid_prices = comparable_prices.length;

    // ── Pricing basis & recommendation ─────────────────────────────────────────
    let recommended_price;
    let pricing_basis;
    let recommendation_mode;
    let reasoning_summary;
    let sanity_triggered = false;

    const demandHigh = demand_level === 'high' || demand_level === 'very_high';
    const demandLow = demand_level === 'low' || demand_level === 'very_low';

    if (competitor_avg_price && number_of_valid_prices >= 3) {
      // ── Market-driven ───────────────────────────────────
      const baselineToCompRatio = baseline_price / competitor_avg_price;

      if (strategy === 'aggressive') {
        if (demandHigh && baselineToCompRatio < 0.95) {
          recommended_price = Math.round(competitor_avg_price * 0.95 * 100) / 100;
          recommendation_mode = 'market_led';
          reasoning_summary = `Market-led at 95% of competitor avg ($${competitor_avg_price.toFixed(2)}). High demand justifies slightly below-market positioning.`;
        } else if (baselineToCompRatio > 1.1) {
          recommended_price = Math.round(competitor_avg_price * 0.98 * 100) / 100;
          recommendation_mode = 'market_led';
          reasoning_summary = `Baseline significantly above market. Recommending 98% of competitor avg for aggressive penetration.`;
          sanity_triggered = true;
        } else {
          recommended_price = Math.round(competitor_avg_price * 1.02 * 100) / 100;
          recommendation_mode = 'market_led';
          reasoning_summary = `Aligned with market at ${((recommended_price / competitor_avg_price) * 100).toFixed(0)}% of competitor average.`;
        }
      } else if (strategy === 'premium') {
        recommended_price = Math.round(competitor_avg_price * 1.12 * 100) / 100;
        recommendation_mode = 'market_led';
        reasoning_summary = `Premium positioning at 112% of competitor average ($${competitor_avg_price.toFixed(2)}).`;
      } else {
        const targetRatio = baselineToCompRatio < 0.9 ? 1.0 : baselineToCompRatio > 1.15 ? 0.98 : 1.0;
        recommended_price = Math.round(competitor_avg_price * targetRatio * 100) / 100;
        recommendation_mode = 'market_led';
        reasoning_summary = `Balanced with market. Competitor average is $${competitor_avg_price.toFixed(2)}.`;
      }

      pricing_basis = 'Market-driven';
    } else {
      // ── Baseline-driven (no reliable competitor data) ───────────
      if (baseline_conflict) {
        if (strategy === 'aggressive') {
          recommended_price = Math.round(baseline_price * 0.95 * 100) / 100;
        } else if (strategy === 'premium') {
          recommended_price = Math.round(baseline_price * 1.15 * 100) / 100;
        } else {
          recommended_price = baseline_price;
        }
        recommendation_mode = 'feasibility_override';
        reasoning_summary = `Baseline flagged as implausible. Using modified baseline with ${strategy} strategy adjustment.`;
      } else {
        if (strategy === 'aggressive') {
          recommended_price = Math.round(baseline_price * 0.98 * 100) / 100;
        } else if (strategy === 'premium') {
          recommended_price = Math.round(baseline_price * 1.2 * 100) / 100;
        } else {
          recommended_price = Math.round(baseline_price * 1.08 * 100) / 100;
        }
        recommendation_mode = 'baseline_led';
        reasoning_summary = `Cost-plus baseline as primary reference. Limited market data available.`;
      }

      pricing_basis = 'Baseline-driven';
    }

    // ── Confidence score ──────────────────────────────────────────────────────
    const confidence_score = calculateConfidenceScore(
      number_of_valid_prices,
      price_variance,
      market_trend,
      demand_level,
      !!competitor_avg_price
    );

    const confidence_explanation = buildConfidenceExplanation(
      confidence_score,
      number_of_valid_prices,
      price_variance,
      market_trend,
      demand_level,
      competitor_avg_price
    );

    // ── Final price range ─────────────────────────────────────────────────────
    const { low: price_range_low, high: price_range_high } = calculatePriceRange(
      baseline_price,
      strategy,
      competitor_avg_price,
      confidence_score
    );

    const result = {
      baseline_price,
      recommended_price,
      price_range_low,
      price_range_high,
      confidence_score,
      confidence_explanation,
      pricing_basis,
      reasoning_summary,
      competitor_avg_price,
      competitor_avg_status,
      baseline_status: baselineSanity.status,
      baseline_conflict,
      baseline_conflict_reason: baselineSanity.reason,
      recommendation_mode,
      filtered_prices_count,
      number_of_valid_prices,
      price_variance: Math.round(price_variance * 10000) / 10000,
      sanity_triggered,
      used_fallback: baseline_conflict,
    };

    return Response.json(result);
  } catch (error) {
    console.error('[generatePricing] Fatal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});