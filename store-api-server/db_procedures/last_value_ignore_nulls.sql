-- credits: https://patternmatchers.wordpress.com/2021/06/11/ignore-nulls-in-postgres/

DROP AGGREGATE IF EXISTS last_value_ignore_nulls(anyelement);
DROP FUNCTION IF EXISTS coalesce_r_sfunc(anyelement, anyelement);

CREATE FUNCTION coalesce_r_sfunc(state anyelement, value anyelement)
  RETURNS anyelement
  immutable parallel safe
AS $$
  SELECT COALESCE(value, state);
$$ language sql;

CREATE AGGREGATE last_value_ignore_nulls(anyelement) (
  sfunc = coalesce_r_sfunc,
  stype = anyelement
);
