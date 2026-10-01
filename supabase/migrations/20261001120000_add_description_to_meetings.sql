-- Texto livre do encontro, exibido na seção "Descrição" da tela de detalhes
-- do encontro no app. Opcional: encontros antigos e rascunhos ficam sem.
ALTER TABLE public.meetings
    ADD COLUMN IF NOT EXISTS description text;
