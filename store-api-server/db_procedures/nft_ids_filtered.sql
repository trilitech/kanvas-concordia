CREATE OR REPLACE FUNCTION nft_ids_filtered(
    address TEXT, categories INTEGER[],
    price_at_least NUMERIC, price_at_most NUMERIC,
    availability TEXT[], proxies_folded BOOLEAN,
    ending_soon_duration INTERVAL,
    order_by TEXT, order_direction TEXT,
    "offset" INTEGER, "limit" INTEGER,
    until TIMESTAMP WITHOUT TIME ZONE,
    minter_address TEXT,
    ledger_address_column TEXT, ledger_token_column TEXT, ledger_amount_column TEXT)
  RETURNS TABLE(nft_id nft.id%TYPE, total_nft_count bigint)
STABLE PARALLEL SAFE
AS $$
BEGIN
  IF order_direction NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'nft_ids_filtered(): invalid order_direction';
  END IF;
  IF NOT (availability <@ '{soldOut, onSale, upcoming, endingSoon}'::text[]) THEN
    RAISE EXCEPTION 'nft_ids_filtered(): invalid availability';
  END IF;
  RETURN QUERY EXECUTE '
    SELECT
      nft_id,
      total_nft_count
    FROM (
      SELECT
        nft.id as nft_id,
        nft.created_at as nft_created_at,
        COUNT(1) OVER () AS total_nft_count
      FROM nft
      JOIN mtm_nft_category
        ON mtm_nft_category.nft_id = nft.id
      LEFT JOIN mtm_kanvas_user_nft
        ON mtm_kanvas_user_nft.nft_id = nft.id
      LEFT JOIN kanvas_user
        ON mtm_kanvas_user_nft.kanvas_user_id = kanvas_user.id
      LEFT JOIN kanvas_user AS usr
        ON usr.address = $2
      LEFT JOIN mtm_kanvas_user_nft AS purchased
        ON  purchased.nft_id = nft.id
        AND purchased.kanvas_user_id = usr.id
      WHERE ($1 IS NULL OR nft.created_at <= $1)
        AND ($2 IS NULL OR (
              EXISTS (
                SELECT 1
                FROM onchain_kanvas."storage.ledger_live"
                WHERE ' || quote_ident(ledger_address_column) || ' = $2
                  AND ' || quote_ident(ledger_token_column) || ' = nft.id
                  AND ' || quote_ident(ledger_amount_column) || ' > 0
              ) OR (
                purchased_editions_pending_transfer(purchased.nft_id, $2, $10) > 0
              )
            ))
        AND ($3 IS NULL OR nft_category_id = ANY($3))
        AND ($4 IS NULL OR nft.price >= $4)
        AND ($5 IS NULL OR nft.price <= $5)
        AND ($6 IS NULL OR (
              (' || quote_literal('onSale') || ' = ANY($6) AND (
                    (nft.onsale_from IS NULL OR nft.onsale_from <= now() AT TIME ZONE ' || quote_literal('UTC') || ')
                AND (nft.onsale_until IS NULL OR nft.onsale_until > now())
                AND ((SELECT reserved + owned FROM nft_editions_locked(nft.id)) < nft.editions_size)
              )) OR
              (' || quote_literal('soldOut') || ' = ANY($6) AND (
                (
                  SELECT reserved + owned FROM nft_editions_locked(nft.id)
                ) >= nft.editions_size
              )) OR
              (' || quote_literal('upcoming') || ' = ANY($6) AND (
                nft.onsale_from > now() AT TIME ZONE ' || quote_literal('UTC') || '
              )) OR
              (' || quote_literal('endingSoon') || ' = ANY($6) AND (
                  nft.onsale_until BETWEEN (now() AT TIME ZONE ' || quote_literal('UTC') || ') AND (now() AT TIME ZONE ' || quote_literal('UTC') || ' + $7)
              ))
            ))
        AND ($11 IS NULL OR (
              ($11 AND nft.proxy_nft_id IS NULL) OR
              ((NOT $11) AND NOT EXISTS (SELECT 1 FROM proxy_unfold WHERE proxy_nft_id = nft.id))
            ))
      GROUP BY nft.id, nft.created_at
      ORDER BY ' || quote_ident(order_by) || ' ' || order_direction || '
      OFFSET $8
      LIMIT  $9
    ) q'
    USING until, address, categories, price_at_least, price_at_most, availability, ending_soon_duration, "offset", "limit", minter_address, proxies_folded;
END
$$
LANGUAGE plpgsql;
