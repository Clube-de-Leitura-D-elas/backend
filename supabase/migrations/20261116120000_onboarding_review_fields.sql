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
