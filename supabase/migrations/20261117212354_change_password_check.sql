-- Conferência da senha atual no servidor para a troca de senha do painel
-- (change-password-web), sem criar sessão nem gastar o limite de login do Auth.
--
-- password_check_failures conta os erros por usuária numa janela de 15 minutos. Tem RLS ligada
-- e nenhuma policy nem GRANT: só check_user_password (SECURITY DEFINER) lê e grava.
--
-- check_user_password cria a linha da usuária antes do SELECT ... FOR UPDATE. Sem isso, chamadas
-- em paralelo de quem ainda não tem linha não travariam nada e passariam do limite de 5 erros.
--
-- Conta sem hash de senha (criada por convite, magic link ou OAuth) devolve 'no_password' e não
-- conta como erro: ela precisa definir a senha pelo fluxo de recuperação.
CREATE TABLE public.password_check_failures (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  failures integer NOT NULL DEFAULT 0,
  first_failure_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.password_check_failures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.password_check_failures FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_user_password(p_user_id uuid, p_password text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window CONSTANT interval := interval '15 minutes';
  v_max_failures CONSTANT integer := 5;
  v_hash text;
  v_failures integer;
  v_first_failure_at timestamptz;
BEGIN
  SELECT encrypted_password
  INTO v_hash
  FROM auth.users
  WHERE id = p_user_id;

  IF coalesce(v_hash, '') = '' THEN
    RETURN 'no_password';
  END IF;

  INSERT INTO public.password_check_failures (user_id, failures, first_failure_at)
  VALUES (p_user_id, 0, now())
  ON CONFLICT (user_id) DO NOTHING;

  SELECT failures, first_failure_at
  INTO v_failures, v_first_failure_at
  FROM public.password_check_failures
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_failures >= v_max_failures AND v_first_failure_at > now() - v_window THEN
    RETURN 'locked';
  END IF;

  IF extensions.crypt(p_password, v_hash) = v_hash THEN
    DELETE FROM public.password_check_failures WHERE user_id = p_user_id;
    RETURN 'ok';
  END IF;

  IF v_failures > 0 AND v_first_failure_at > now() - v_window THEN
    UPDATE public.password_check_failures
    SET failures = v_failures + 1
    WHERE user_id = p_user_id;
  ELSE
    UPDATE public.password_check_failures
    SET failures = 1, first_failure_at = now()
    WHERE user_id = p_user_id;
  END IF;

  RETURN 'wrong';
END;
$$;

REVOKE ALL ON FUNCTION public.check_user_password(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_user_password(uuid, text) TO service_role;
