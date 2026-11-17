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
  SELECT failures, first_failure_at
  INTO v_failures, v_first_failure_at
  FROM public.password_check_failures
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_failures >= v_max_failures AND v_first_failure_at > now() - v_window THEN
    RETURN 'locked';
  END IF;

  SELECT encrypted_password
  INTO v_hash
  FROM auth.users
  WHERE id = p_user_id;

  IF coalesce(v_hash, '') <> '' AND extensions.crypt(p_password, v_hash) = v_hash THEN
    DELETE FROM public.password_check_failures WHERE user_id = p_user_id;
    RETURN 'ok';
  END IF;

  INSERT INTO public.password_check_failures AS attempt (user_id, failures, first_failure_at)
  VALUES (p_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE
  SET failures = CASE
        WHEN attempt.first_failure_at > now() - v_window THEN attempt.failures + 1
        ELSE 1
      END,
      first_failure_at = CASE
        WHEN attempt.first_failure_at > now() - v_window THEN attempt.first_failure_at
        ELSE now()
      END;

  RETURN 'wrong';
END;
$$;

REVOKE ALL ON FUNCTION public.check_user_password(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_user_password(uuid, text) TO service_role;
