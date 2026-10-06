-- Criação de grupos pelo painel web (edge function `create-group`).
--
-- 1. `photo_id` deixa de ser obrigatório: o modal de criação não pede foto, e
--    o app e o painel já tratam grupo sem foto (capa nula).
-- 2. O número do grupo passa a ser único em todo o clube: cada grupo tem um
--    número só seu, em qualquer cidade. Se a migration falhar aqui, existem
--    grupos com número repetido e eles precisam ser renumerados antes.
-- 3. `create_group` cria o grupo e, se informada, a coordenadora inicial numa
--    transação só, para não sobrar grupo sem a coordenadora pedida.
--
-- RLS: `groups` e `group_users` seguem sem RLS, como o resto do schema (o
-- acesso é feito pelas edge functions com service role). A função SQL só pode
-- ser executada pela service role.

ALTER TABLE public.groups
ALTER COLUMN photo_id DROP NOT NULL;

ALTER TABLE public.groups
ADD CONSTRAINT groups_number_key UNIQUE (number);

CREATE OR REPLACE FUNCTION public.create_group(
  p_number integer,
  p_description varchar,
  p_city_id uuid,
  p_zone_id uuid,
  p_coordinator_id uuid
)
RETURNS public.groups
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  new_group public.groups;
BEGIN
  INSERT INTO public.groups (number, description, city_id, zone_id)
  VALUES (p_number, p_description, p_city_id, p_zone_id)
  RETURNING * INTO new_group;

  IF p_coordinator_id IS NOT NULL THEN
    INSERT INTO public.group_users (group_id, user_id, is_coordinator, registration_status)
    VALUES (new_group.id, p_coordinator_id, true, 'ACTIVE');
  END IF;

  RETURN new_group;
END;
$$;

REVOKE ALL ON FUNCTION public.create_group(integer, varchar, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_group(integer, varchar, uuid, uuid, uuid)
TO service_role;
