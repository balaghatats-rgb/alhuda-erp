/**
 * AI FEATURE: Duplicate PNR detection.
 *
 * Two checks:
 *  1. Exact duplicate — the same PNR already booked on the same block
 *     (also enforced at the DB level by uq_pnr_per_block, this gives a
 *     friendlier error before hitting the constraint).
 *  2. Near-duplicate elsewhere — the same PNR appears on a *different*
 *     open block within the last 14 days, which usually means a staff
 *     member re-entered a booking against the wrong block by mistake.
 *     This is a heuristic, not a hard block — it returns a warning so a
 *     human can decide.
 */
async function checkDuplicatePnr(pool, { pnr, block_id }) {
  const exact = block_id
    ? await pool.query(
        'SELECT id FROM bookings WHERE pnr = $1 AND block_id = $2 AND booking_status = $3',
        [pnr, block_id, 'confirmed']
      )
    : { rows: [] };

  const elsewhere = await pool.query(
    `SELECT b.id, b.block_id, ab.block_ref, ab.flight_number, ab.travel_date
     FROM bookings b
     LEFT JOIN airline_blocks ab ON ab.id = b.block_id
     WHERE b.pnr = $1
       AND b.block_id IS DISTINCT FROM $2
       AND b.booking_status = 'confirmed'
       AND b.created_at >= now() - interval '14 days'`,
    [pnr, block_id || null]
  );

  return {
    exactDuplicate: exact.rows.length > 0,
    similarPnrElsewhere: elsewhere.rows.length > 0,
    matches: elsewhere.rows,
  };
}

module.exports = { checkDuplicatePnr };
