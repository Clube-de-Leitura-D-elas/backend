-- Torna o resgate do cadastro atômico para que uma falha não deixe a
-- leitora criada com o token ainda disponível para novas tentativas.
--
-- A linha de pending_users é bloqueada antes das validações para serializar
-- dois cliques simultâneos no mesmo token. A função só é chamada pela
-- service_role, que já ignora RLS nas tabelas envolvidas.

CREATE OR REPLACE FUNCTION public.claim_user_profile(
  p_claim_token text,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pending_user public.pending_users;
  resolved_city_id uuid;
  resolved_zone_id uuid;
  new_user_id uuid;
  education_level public.levels_of_education;
BEGIN
  SELECT *
  INTO pending_user
  FROM public.pending_users
  WHERE claim_token = p_claim_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'CL001',
      MESSAGE = 'claim token is invalid or already used';
  END IF;

  IF pending_user.is_approved IS NOT TRUE OR
    pending_user.token_used_at IS NOT NULL OR
    pending_user.claim_token_expires_at IS NULL OR
    pending_user.claim_token_expires_at <= now() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'CL001',
      MESSAGE = 'claim token is invalid or already used';
  END IF;

  IF coalesce(pending_user.city, '') <> '' THEN
    SELECT id
    INTO resolved_city_id
    FROM public.cities
    WHERE name ILIKE pending_user.city
    LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO public.cities (name, uf)
      VALUES (pending_user.city, 'RS')
      RETURNING id INTO resolved_city_id;
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = 'CL003',
      MESSAGE = 'pending user city is required';
  END IF;

  IF coalesce(pending_user.zone, '') <> '' AND resolved_city_id IS NOT NULL THEN
    SELECT id
    INTO resolved_zone_id
    FROM public.zones
    WHERE name ILIKE pending_user.zone
      AND public.zones.city_id = resolved_city_id
    LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO public.zones (name, city_id)
      VALUES (pending_user.zone, resolved_city_id)
      RETURNING id INTO resolved_zone_id;
    END IF;
  END IF;

  education_level := CASE
    WHEN lower(coalesce(pending_user.level_of_education, '')) LIKE '%superior%'
      THEN 'UNDERGRADUATE'
    WHEN lower(coalesce(pending_user.level_of_education, '')) LIKE '%fundamental%'
      THEN 'ELEMENTARY'
    WHEN lower(coalesce(pending_user.level_of_education, '')) LIKE '%médio%'
      THEN 'HIGH_SCHOOL'
    WHEN lower(coalesce(pending_user.level_of_education, '')) LIKE '%pós%'
      OR lower(coalesce(pending_user.level_of_education, '')) LIKE '%pos%'
      THEN 'POSTGRADUATE'
    WHEN lower(coalesce(pending_user.level_of_education, '')) LIKE '%técnico%'
      THEN 'TECHNICAL'
    ELSE 'HIGH_SCHOOL'
  END::public.levels_of_education;

  INSERT INTO public.users (
    name,
    email,
    phone,
    birth_date,
    job,
    level_of_education,
    instagram,
    city_id,
    zone_id,
    is_active,
    user_id
  )
  VALUES (
    pending_user.name,
    pending_user.email,
    pending_user.phone_number,
    pending_user.birthday,
    pending_user.job,
    education_level,
    coalesce(pending_user.instagram_user, ''),
    resolved_city_id,
    resolved_zone_id,
    true,
    p_user_id
  )
  ON CONFLICT (user_id) DO NOTHING
  RETURNING id INTO new_user_id;

  IF new_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'CL002',
      MESSAGE = 'user profile already exists';
  END IF;

  IF coalesce(pending_user.book_name, '') <> '' THEN
    INSERT INTO public.onboarding_book_suggestions (name, user_id)
    VALUES (pending_user.book_name, new_user_id);
  END IF;

  UPDATE public.pending_users
  SET token_used_at = now()
  WHERE id = pending_user.id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_user_profile(text, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_user_profile(text, uuid)
TO service_role;
