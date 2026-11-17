ALTER TABLE public.cities
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

ALTER TABLE public.zones
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

UPDATE public.cities
SET name = regexp_replace(btrim(name), '\s+', ' ', 'g'),
    uf = upper(btrim(uf))
WHERE name <> regexp_replace(btrim(name), '\s+', ' ', 'g')
   OR uf <> upper(btrim(uf));

UPDATE public.zones
SET name = regexp_replace(btrim(name), '\s+', ' ', 'g')
WHERE name <> regexp_replace(btrim(name), '\s+', ' ', 'g');

CREATE TEMP TABLE city_merge AS
SELECT ranked.id AS duplicate_id,
       ranked.keeper_id
FROM (
  SELECT city.id,
         first_value(city.id) OVER (
           PARTITION BY public.normalize_location_name(city.name), city.uf
           ORDER BY
             (SELECT count(*) FROM public.groups g WHERE g.city_id = city.id) DESC,
             (SELECT count(*) FROM public.users u WHERE u.city_id = city.id) DESC,
             city.id
         ) AS keeper_id
  FROM public.cities city
) ranked
WHERE ranked.id <> ranked.keeper_id;

UPDATE public.groups
SET city_id = city_merge.keeper_id
FROM city_merge
WHERE groups.city_id = city_merge.duplicate_id;

UPDATE public.users
SET city_id = city_merge.keeper_id
FROM city_merge
WHERE users.city_id = city_merge.duplicate_id;

UPDATE public.zones
SET city_id = city_merge.keeper_id
FROM city_merge
WHERE zones.city_id = city_merge.duplicate_id;

DELETE FROM public.cities
USING city_merge
WHERE cities.id = city_merge.duplicate_id;

DROP TABLE city_merge;

CREATE TEMP TABLE zone_merge AS
SELECT ranked.id AS duplicate_id,
       ranked.keeper_id
FROM (
  SELECT zone.id,
         first_value(zone.id) OVER (
           PARTITION BY zone.city_id, public.normalize_location_name(zone.name)
           ORDER BY
             (SELECT count(*) FROM public.groups g WHERE g.zone_id = zone.id) DESC,
             (SELECT count(*) FROM public.users u WHERE u.zone_id = zone.id) DESC,
             zone.id
         ) AS keeper_id
  FROM public.zones zone
) ranked
WHERE ranked.id <> ranked.keeper_id;

UPDATE public.groups
SET zone_id = zone_merge.keeper_id
FROM zone_merge
WHERE groups.zone_id = zone_merge.duplicate_id;

UPDATE public.users
SET zone_id = zone_merge.keeper_id
FROM zone_merge
WHERE users.zone_id = zone_merge.duplicate_id;

DELETE FROM public.zones
USING zone_merge
WHERE zones.id = zone_merge.duplicate_id;

DROP TABLE zone_merge;

CREATE UNIQUE INDEX cities_name_uf_key
  ON public.cities (public.normalize_location_name(name), uf);

CREATE UNIQUE INDEX zones_city_id_name_key
  ON public.zones (city_id, public.normalize_location_name(name));

ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Management reads cities"
  ON public.cities
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.jwt() ->> 'app_role') IN ('MANAGER', 'FOUNDER'));

CREATE POLICY "Management reads zones"
  ON public.zones
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.jwt() ->> 'app_role') IN ('MANAGER', 'FOUNDER'));

CREATE OR REPLACE FUNCTION public.resolve_city_id(
  p_name text
)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT city.id
  FROM public.cities city
  WHERE public.normalize_location_name(city.name)
    = public.normalize_location_name(p_name)
  ORDER BY city.is_active DESC, city.id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.resolve_zone_id(
  p_city_id uuid,
  p_name text
)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT zone.id
  FROM public.zones zone
  WHERE zone.city_id = p_city_id
    AND public.normalize_location_name(zone.name)
      = public.normalize_location_name(p_name)
  ORDER BY zone.is_active DESC, zone.id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.list_cities(
  p_search text,
  p_uf text,
  p_is_active boolean,
  p_limit integer,
  p_offset integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH search AS (
    SELECT public.normalize_location_name(nullif(btrim(p_search), '')) AS term
  ),
  filtered AS (
    SELECT city.id,
           city.name,
           city.uf,
           city.is_active,
           public.normalize_location_name(city.name) AS sort_name
    FROM public.cities city
    CROSS JOIN search
    WHERE (p_uf IS NULL OR city.uf = p_uf)
      AND (p_is_active IS NULL OR city.is_active = p_is_active)
      AND (
        search.term IS NULL
        OR strpos(public.normalize_location_name(city.name), search.term) > 0
        OR EXISTS (
          SELECT 1
          FROM public.zones zone
          WHERE zone.city_id = city.id
            AND strpos(public.normalize_location_name(zone.name), search.term) > 0
        )
      )
  ),
  page AS (
    SELECT filtered.*
    FROM filtered
    ORDER BY filtered.sort_name, filtered.uf, filtered.id
    LIMIT p_limit
    OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM filtered),
    'items', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', page.id,
          'name', page.name,
          'uf', page.uf,
          'isActive', page.is_active,
          'groups', (
            SELECT count(*) FROM public.groups g WHERE g.city_id = page.id
          ),
          'activeGroups', (
            SELECT count(*)
            FROM public.groups g
            WHERE g.city_id = page.id AND g.is_active
          ),
          'zones', coalesce((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', zone.id,
                'name', zone.name,
                'isActive', zone.is_active,
                'activeGroups', (
                  SELECT count(*)
                  FROM public.groups g
                  WHERE g.zone_id = zone.id AND g.is_active
                )
              )
              ORDER BY public.normalize_location_name(zone.name), zone.id
            )
            FROM public.zones zone
            WHERE zone.city_id = page.id
          ), '[]'::jsonb)
        )
        ORDER BY page.sort_name, page.uf, page.id
      )
      FROM page
    ), '[]'::jsonb),
    'ufs', coalesce((
      SELECT jsonb_agg(DISTINCT city.uf ORDER BY city.uf)
      FROM public.cities city
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'activeCities', (
        SELECT count(*) FROM public.cities city WHERE city.is_active
      ),
      'activeZones', (
        SELECT count(*)
        FROM public.zones zone
        JOIN public.cities city ON city.id = zone.city_id
        WHERE zone.is_active AND city.is_active
      )
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.save_city(
  p_city_id uuid,
  p_name text,
  p_uf text,
  p_zones jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_city_id uuid;
  v_zone jsonb;
  v_zone_id uuid;
  v_zone_name text;
  v_zone_active boolean;
  v_was_active boolean;
  v_constraint text;
BEGIN
  IF p_city_id IS NULL THEN
    INSERT INTO public.cities (name, uf)
    VALUES (btrim(p_name), p_uf)
    RETURNING id INTO v_city_id;
  ELSE
    UPDATE public.cities
    SET name = btrim(p_name),
        uf = p_uf
    WHERE id = p_city_id
    RETURNING id INTO v_city_id;

    IF v_city_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'CZ001',
        MESSAGE = 'city not found';
    END IF;
  END IF;

  FOR v_zone IN
    SELECT value FROM jsonb_array_elements(coalesce(p_zones, '[]'::jsonb))
  LOOP
    v_zone_id := (v_zone ->> 'id')::uuid;
    v_zone_name := btrim(v_zone ->> 'name');
    v_zone_active := coalesce((v_zone ->> 'is_active')::boolean, true);

    IF v_zone_id IS NULL THEN
      INSERT INTO public.zones (name, city_id, is_active)
      VALUES (v_zone_name, v_city_id, v_zone_active);
      CONTINUE;
    END IF;

    SELECT zone.is_active
    INTO v_was_active
    FROM public.zones zone
    WHERE zone.id = v_zone_id
      AND zone.city_id = v_city_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'CZ003',
        MESSAGE = 'zone does not belong to city';
    END IF;

    IF v_was_active AND NOT v_zone_active AND EXISTS (
      SELECT 1
      FROM public.groups g
      WHERE g.zone_id = v_zone_id AND g.is_active
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'CZ005',
        MESSAGE = 'zone has active groups',
        DETAIL = v_zone_name;
    END IF;

    UPDATE public.zones
    SET name = v_zone_name,
        is_active = v_zone_active
    WHERE id = v_zone_id;
  END LOOP;

  RETURN v_city_id;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

    IF v_constraint = 'cities_name_uf_key' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'CZ002',
        MESSAGE = 'city already exists in this state';
    ELSIF v_constraint = 'zones_city_id_name_key' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'CZ004',
        MESSAGE = 'zone name repeated in this city';
    END IF;

    RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_city_active(
  p_city_id uuid,
  p_is_active boolean
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_active_groups integer;
BEGIN
  PERFORM 1
  FROM public.cities
  WHERE id = p_city_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'CZ001',
      MESSAGE = 'city not found';
  END IF;

  IF NOT p_is_active THEN
    SELECT count(*)
    INTO v_active_groups
    FROM public.groups
    WHERE city_id = p_city_id
      AND is_active;

    IF v_active_groups > 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'CZ006',
        MESSAGE = 'city has active groups',
        DETAIL = v_active_groups::text;
    END IF;
  END IF;

  UPDATE public.cities
  SET is_active = p_is_active
  WHERE id = p_city_id;
END;
$$;

REVOKE ALL ON FUNCTION public.list_cities(text, text, boolean, integer, integer)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.save_city(uuid, text, text, jsonb)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.set_city_active(uuid, boolean)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_cities(text, text, boolean, integer, integer)
TO service_role;

GRANT EXECUTE ON FUNCTION public.save_city(uuid, text, text, jsonb)
TO service_role;

GRANT EXECUTE ON FUNCTION public.set_city_active(uuid, boolean)
TO service_role;
