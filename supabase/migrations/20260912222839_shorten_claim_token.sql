CREATE OR REPLACE FUNCTION public.handle_pending_user_updates()
RETURNS trigger AS $$
DECLARE
  v_secret_key text;
  v_edge_url text;
BEGIN
  -- Se foi aprovado agora
  IF NEW.is_approved = true AND OLD.is_approved = false THEN
    -- Gera token alfanumérico de 8 caracteres em maiúsculo
    NEW.claim_token := upper(substr(md5(random()::text), 1, 8));
    NEW.claim_token_expires_at := now() + interval '7 days';
    
    -- Busca os segredos no Vault
    SELECT decrypted_secret INTO v_secret_key FROM vault.decrypted_secrets WHERE name = 'edge_api_key';
    SELECT decrypted_secret INTO v_edge_url FROM vault.decrypted_secrets WHERE name = 'edge_base_url';
    
    -- Dispara a Edge Function approve-pending-user que vai enviar o email usando Resend
    IF v_secret_key IS NOT NULL AND v_edge_url IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_edge_url || '/approve-pending-user?pending_user_id=' || NEW.id,
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
