-- Aparelhos das leitoras para o push (CLU-300). A edge function send-push
-- precisa saber para quais tokens do FCM mandar cada notificação, e hoje nada
-- guarda isso.
--
-- fcm_token é UNIQUE porque o token identifica o aparelho, não a conta: se
-- outra leitora entra no mesmo aparelho, a register-device faz upsert por token
-- e a linha passa para a conta atual, sem duplicar nem continuar entregando
-- avisos da conta anterior. A tabela nasce vazia, então o UNIQUE não encontra
-- duplicatas.
--
-- ON DELETE CASCADE em user_id: o token só existe junto da usuária. platform
-- usa CHECK em vez de enum para poder mudar a lista sem ALTER TYPE.
--
-- updated_at é gravado pela register-device a cada registro (o app renova o
-- token de tempos em tempos), por isso não há trigger.
--
-- O índice em user_id atende a consulta do send-push, que busca os tokens das
-- destinatárias de uma notificação.
CREATE TABLE public.user_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES public.users (id) ON DELETE CASCADE,
  fcm_token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ANDROID', 'IOS')),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX user_devices_user_id_idx
  ON public.user_devices (user_id);

-- Só as edge functions (service_role) leem e escrevem; anon e authenticated
-- não têm acesso, o token de push não pode vazar pela Data API.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_devices
TO service_role;

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
