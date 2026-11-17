-- CLU-306: o fim do cadastro volta a conseguir salvar o perfil, sem inventar
-- cidade e zona.
--
-- A function `update-user-profile` não existia neste repositório: a versão em
-- produção foi publicada de uma máquina local e gravava `users.book_name`,
-- coluna que só existe naquela branch. Como o app sempre envia o campo, todo
-- save do onboarding falhava com 42703. A indicação de livro passa a ficar em
-- `onboarding_book_suggestions`, uma linha por leitora (upsert por `user_id`).
--
-- `claim-user-profile` e `update-user-profile` criavam cidade e zona quando o
-- texto digitado não casava, com UF fixa 'RS'. Isso já gravou lixo no projeto
-- hospedado (cidade `hgfa`, zona `fegd`). Agora o texto só casa com o cadastro
-- de cidades e zonas do painel, ignorando acento e caixa; sem correspondência,
-- a coluna fica NULL. `users.city_id` deixa de ser NOT NULL para isso, e o
-- resgate não falha mais quando `pending_users.city` está vazio.
--
-- Dados existentes:
--   * `onboarding_book_suggestions` pode ter mais de uma linha por leitora:
--     nada garantia a unicidade até aqui. Fica a mais recente, por
--     `created_at` (id desempata), antes de criar o UNIQUE.
--   * Leitoras com cidade/zona já gravadas não mudam; cidade/zona inventadas
--     continuam existindo (a limpeza é do painel, CLU-219).
--
-- `claim_user_profile` é substituída sem mudar assinatura nem grants;
-- `update_user_profile` é nova. As duas só podem ser executadas pela
-- service_role.

-- ---------------------------------------------------------
-- Cidade passa a ser opcional
-- ---------------------------------------------------------
ALTER TABLE public.users
  ALTER COLUMN city_id DROP NOT NULL;

-- ---------------------------------------------------------
-- Uma indicação de livro por leitora
-- ---------------------------------------------------------
DELETE FROM public.onboarding_book_suggestions suggestion
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id
           ORDER BY created_at DESC, id DESC
         ) AS position
  FROM public.onboarding_book_suggestions
) ranked
WHERE suggestion.id = ranked.id
  AND ranked.position > 1;

ALTER TABLE public.onboarding_book_suggestions
  ADD CONSTRAINT onboarding_book_suggestions_user_id_key UNIQUE (user_id);

-- ---------------------------------------------------------
-- Correspondência de cidade e zona pelo nome do painel
-- ---------------------------------------------------------
-- Mesmo mapa de `normalize_book_search`: sem acento e em caixa baixa. Nomes
-- repetidos em `cities` (o cadastro não tem UNIQUE) resolvem sempre para o
-- mesmo id, o menor, para a escolha não variar entre chamadas.
CREATE OR REPLACE FUNCTION public.normalize_location_name(
  value text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT translate(
    lower(btrim(value)),
    'áàâãäéèêëíìîïóòôõöúùûüçñ',
    'aaaaaeeeeiiiiooooouuuucn'
  );
$$;

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
  ORDER BY city.id
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
  ORDER BY zone.id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.normalize_location_name(text)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.resolve_city_id(text)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.resolve_zone_id(uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.normalize_location_name(text)
TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_city_id(text)
TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_zone_id(uuid, text)
TO service_role;

-- ---------------------------------------------------------
-- Resgate do cadastro: só casa, nunca cria
-- ---------------------------------------------------------
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

  resolved_city_id := public.resolve_city_id(pending_user.city);
  resolved_zone_id := public.resolve_zone_id(
    resolved_city_id,
    pending_user.zone
  );

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

-- ---------------------------------------------------------
-- Revisão do perfil: usuária e indicação numa transação só
-- ---------------------------------------------------------
-- `users` e `onboarding_book_suggestions` precisam mudar juntas: sem
-- transação, uma falha na segunda escrita deixaria o perfil salvo pela metade.
--
-- Cidade e zona só mudam quando o nome chega preenchido; texto vazio não apaga
-- o que o resgate resolveu (o app ainda não mostra a cidade no formulário). Se
-- a cidade mudou ou não casou, a zona antiga deixa de valer e é resolvida na
-- cidade nova (ou vira NULL). Indicação vazia também não apaga a existente.
CREATE OR REPLACE FUNCTION public.update_user_profile(
  p_user_id uuid,
  p_name varchar,
  p_phone varchar,
  p_birth_date date,
  p_job varchar,
  p_level_of_education public.levels_of_education,
  p_city_name text,
  p_zone_name text,
  p_suggested_book text
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
      zone_id = CASE WHEN update_zone THEN resolved_zone_id ELSE zone_id END
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
  text
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
  text
) TO service_role;
