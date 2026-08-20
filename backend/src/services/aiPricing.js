/**
 * AI FEATURE: Sell-price suggestion for a new block.
 *
 * v1 approach (transparent, no external ML dependency, works from day one
 * with only your own historical data):
 *   - Look at the average realized margin (sale_price - cost_price) on
 *     bookings for the same sector over the last 90 days.
 *   - Apply that margin to the new block's cost_per_seat.
 *   - Fall back to a flat 18% margin if there's no history for the sector yet.
 *
 * This function is intentionally isolated so it can later be swapped for a
 * call to a hosted forecasting model (e.g. a small regression/gradient-boost
 * model trained on seasonality, days-to-departure, and load factor) without
 * touching the route that calls it.
 */
async function suggestSellPrice(client, { sector_from, sector_to, cost_per_seat }) {
  const { rows } = await client.query(
    `SELECT AVG(bk.sale_price_per_seat - bk.cost_price_per_seat) AS avg_margin
     FROM bookings bk
     JOIN airline_blocks ab ON ab.id = bk.block_id
     WHERE ab.sector_from = $1 AND ab.sector_to = $2
       AND bk.created_at >= now() - interval '90 days'
       AND bk.booking_status = 'confirmed'`,
    [sector_from, sector_to]
  );

  const historicalMargin = rows[0]?.avg_margin;
  const margin = historicalMargin != null ? Number(historicalMargin) : cost_per_seat * 0.18;

  return Math.round((Number(cost_per_seat) + margin) * 100) / 100;
}

module.exports = { suggestSellPrice };
