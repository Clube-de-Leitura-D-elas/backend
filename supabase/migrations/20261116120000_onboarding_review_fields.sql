-- CLU-352: a revisão do onboarding passa a guardar as respostas que o app já
-- enviava e o backend descartava.
--
-- `update_user_profile` recebia `expectations`, `other_group_interest` e
-- `coordinator_interest` no corpo da function, mas não havia coluna para eles;
-- a leitora respondia e o dado se perdia. As três respostas ficam em `users`,
-- que já concentra o perfil, e são nullable porque a revisão pode ser salva
-- antes de a leitora responder (o formulário não distingue "não respondeu" de
-- "não").
ALTER TABLE public.users
  ADD COLUMN expectations text,
  ADD COLUMN has_other_reading_group boolean,
  ADD COLUMN wants_to_coordinate boolean;

-- Perfil, indicação e as três respostas mudam na mesma transação. A assinatura
-- antiga é removida porque `CREATE OR REPLACE` não troca a lista de parâmetros;
-- a function continua exclusiva da service_role.
DROP FUNCTION IF EXISTS public.update_user_profile(
  uuid,
  varchar,
  varchar,
  date,
  varchar,
  public.levels_of_education,
  text,
  text,
  text
);

CREATE OR REPLACE FUNCTION public.update_user_profile(
  p_user_id uuid,
  p_name varchar,
  p_phone varchar,
  p_birth_date date,
  p_job varchar,
  p_level_of_education public.levels_of_education,
  p_city_name text,
  p_zone_name text,
  p_suggested_book text,
  p_expectations text,
  p_has_other_reading_group boolean,
  p_wants_to_coordinate boolean
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  current_profile public.users;
  resolved_city_id uuid;
  resolved_zone_id uuid;
  update_city boolean := false;
  update_zone boolean := false;
  city_name_given boolean := coalesce(btrim(p_city_name), '') <> '';
  zone_name_given boolean := coalesce(btrim(p_zone_name), '') <> '';
BEGIN
  SELECT *
  INTO current_profile
  FROM public.users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'UP001',
      MESSAGE = 'user profile not found';
  END IF;

  IF city_name_given THEN
    resolved_city_id := public.resolve_city_id(p_city_name);
    update_city := true;

    IF resolved_city_id IS DISTINCT FROM current_profile.city_id
      OR zone_name_given THEN
      resolved_zone_id := public.resolve_zone_id(
        resolved_city_id,
        p_zone_name
      );
      update_zone := true;
    END IF;
  ELSIF zone_name_given THEN
    resolved_zone_id := public.resolve_zone_id(
      current_profile.city_id,
      p_zone_name
    );
    update_zone := true;
  END IF;

  UPDATE public.users
  SET name = btrim(p_name),
      phone = btrim(p_phone),
      birth_date = p_birth_date,
      job = nullif(btrim(p_job), ''),
      level_of_education = p_level_of_education,
      city_id = CASE WHEN update_city THEN resolved_city_id ELSE city_id END,
      zone_id = CASE WHEN update_zone THEN resolved_zone_id ELSE zone_id END,
      expectations = p_expectations,
      has_other_reading_group = p_has_other_reading_group,
      wants_to_coordinate = p_wants_to_coordinate
  WHERE id = p_user_id;

  IF coalesce(btrim(p_suggested_book), '') <> '' THEN
    INSERT INTO public.onboarding_book_suggestions AS suggestion (user_id, name)
    VALUES (p_user_id, btrim(p_suggested_book))
    ON CONFLICT (user_id) DO UPDATE
    SET name = EXCLUDED.name;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_user_profile(
  uuid,
  varchar,
  varchar,
  date,
  varchar,
  public.levels_of_education,
  text,
  text,
  text,
  text,
  boolean,
  boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_user_profile(
  uuid,
  varchar,
  varchar,
  date,
  varchar,
  public.levels_of_education,
  text,
  text,
  text,
  text,
  boolean,
  boolean
) TO service_role;
