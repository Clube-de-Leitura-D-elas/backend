-- Seed SQL para ambiente de desenvolvimento local
-- Fornece 2 usuários de teste com login via E-mail e Senha (Senha padrão: Senha123!)

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- =========================================================
-- 1. DADOS DE SUPORTE (Cidade e Zona)
-- =========================================================
INSERT INTO public.cities (id, name, uf)
VALUES ('11111111-1111-1111-1111-111111111111', 'Porto Alegre', 'RS')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.zones (id, name, city_id)
VALUES ('22222222-2222-2222-2222-222222222222', 'Centro', '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

-- =========================================================
-- 2. USUÁRIO 1: Já Cadastrado (auth.users + public.users)
-- Email: cadastrado@example.com
-- Senha: Senha123!
-- =========================================================

-- Insert auth.users
INSERT INTO auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  recovery_sent_at,
  last_sign_in_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'cadastrado@example.com',
  extensions.crypt('Senha123!', extensions.gen_salt('bf')),
  now(),
  NULL,
  now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  '{"name": "Usuário Cadastrado"}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
) ON CONFLICT (id) DO NOTHING;

-- Insert auth.identities
INSERT INTO auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at,
  provider_id
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  jsonb_build_object('sub', '00000000-0000-0000-0000-000000000001', 'email', 'cadastrado@example.com'),
  'email',
  now(),
  now(),
  now(),
  'cadastrado@example.com'
) ON CONFLICT (id) DO NOTHING;

-- Insert public.users
INSERT INTO public.users (
  id,
  user_id,
  name,
  email,
  phone,
  birth_date,
  job,
  level_of_education,
  instagram,
  app_role,
  city_id,
  zone_id,
  is_active,
  created_at
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Usuário Cadastrado',
  'cadastrado@example.com',
  '(51) 99999-9999',
  '1995-05-15',
  'Engenheira de Software',
  'UNDERGRADUATE',
  '@cadastrado.test',
  'READER',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  true,
  now()
) ON CONFLICT (id) DO NOTHING;

-- =========================================================
-- 3. USUÁRIO 2: Pendente de Claim (auth.users + public.pending_users)
-- Email: claim@example.com
-- Senha: Senha123!
-- Claim Token: CLAIM123
-- =========================================================

-- Insert auth.users para o usuário de claim poder realizar login
INSERT INTO auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  recovery_sent_at,
  last_sign_in_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'claim@example.com',
  extensions.crypt('Senha123!', extensions.gen_salt('bf')),
  now(),
  NULL,
  now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  '{"name": "Usuário Claim"}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
) ON CONFLICT (id) DO NOTHING;

-- Insert auth.identities
INSERT INTO auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at,
  provider_id
) VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000002',
  jsonb_build_object('sub', '00000000-0000-0000-0000-000000000002', 'email', 'claim@example.com'),
  'email',
  now(),
  now(),
  now(),
  'claim@example.com'
) ON CONFLICT (id) DO NOTHING;

-- Insert public.pending_users (Aprovado e pronto para receber claim)
INSERT INTO public.pending_users (
  id,
  name,
  email,
  phone_number,
  is_approved,
  claim_token,
  token_used_at,
  claim_token_expires_at,
  birthday,
  job,
  level_of_education,
  instagram_user,
  book_name,
  city,
  zone,
  created_at
) VALUES (
  'b0000000-0000-0000-0000-000000000002',
  'Usuário Pendente Claim',
  'claim@example.com',
  '(51) 98888-8888',
  true,
  'CLAIM123',
  NULL,
  now() + interval '30 days',
  '1998-10-20',
  'Designer',
  'Ensino Superior Incompleto',
  '@claim.test',
  'O Alquimista',
  'Porto Alegre',
  'Centro',
  now()
) ON CONFLICT (id) DO NOTHING;