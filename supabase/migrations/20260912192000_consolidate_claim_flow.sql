ALTER TABLE public.pending_users ALTER COLUMN token_used_at DROP DEFAULT;

-- Drop old redundant triggers and functions
DROP TRIGGER IF EXISTS on_pending_user_approval ON public.pending_users;
DROP FUNCTION IF EXISTS public.pending_user_approval_edge_fn();

DROP TRIGGER IF EXISTS on_pending_user_created ON public.pending_users;
DROP FUNCTION IF EXISTS public.pending_user_notify_edge_fn();

-- We'll create a single function and trigger for when a pending user is created or approved.
-- Actually, the PRD says: 
-- 1. Criação do registro em public.pending_users.
-- 2. Status aguardando aprovação (manual).
-- 3. Ao ser aprovado (is_approved = true), gerar automaticamente um claim token.
-- 4. Disparar e-mail com o token para o usuário.

CREATE OR REPLACE FUNCTION public.handle_pending_user_updates()
RETURNS trigger AS $$
DECLARE
  v_secret_key text;
  v_edge_url text;
  v_claim_token text;
BEGIN
  -- If approved now
  IF NEW.is_approved = true AND OLD.is_approved = false THEN
    -- Generate claim token natively in Postgres or Edge function?
    -- PRD says "gerar automaticamente um claim token. Disparar e-mail com o token"
    -- Let's generate a simple UUID token in the DB and then trigger an edge function to email it.
    NEW.claim_token := gen_random_uuid()::text;
    NEW.claim_token_expires_at := now() + interval '7 days';
    
    -- Call Edge Function via pg_net to send email, using Vault secrets
    -- We assume the vault has 'edge_api_key' and 'edge_base_url'
    SELECT decrypted_secret INTO v_secret_key FROM vault.decrypted_secrets WHERE name = 'edge_api_key';
    SELECT decrypted_secret INTO v_edge_url FROM vault.decrypted_secrets WHERE name = 'edge_base_url';
    
    IF v_secret_key IS NOT NULL AND v_edge_url IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_edge_url || '/approve-pending-user',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_secret_key
        ),
        body := jsonb_build_object(
          'id', NEW.id,
          'email', NEW.email,
          'claim_token', NEW.claim_token
        ),
        timeout_milliseconds := 5000
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_pending_user_updated
  BEFORE UPDATE ON public.pending_users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_pending_user_updates();
