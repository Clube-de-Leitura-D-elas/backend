-- Permite que usuárias autenticadas leiam as tabelas de referência necessárias
-- para o modal de criação de grupo no painel web:
--
--   cities  → dropdown "Cidade ou Zona"
--   zones   → dropdown "Cidade ou Zona" (zonas dentro de cada cidade)
--   users   → dropdown "Coordenadora inicial" (participantes ativas)
--
-- Nenhuma dessas tabelas contém dados sensíveis que justifiquem restrição de
-- leitura para usuárias já autenticadas no painel de gestão.

GRANT SELECT ON TABLE public.cities TO authenticated;
GRANT SELECT ON TABLE public.zones TO authenticated;
GRANT SELECT ON TABLE public.users TO authenticated;
