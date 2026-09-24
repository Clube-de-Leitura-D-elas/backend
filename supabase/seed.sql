-- =========================================================
-- SEED DE DESENVOLVIMENTO / DEMONSTRAÇÃO
-- =========================================================
-- Como rodar:
--   supabase/seed.sql  -> `npx supabase db reset` já executa
--
-- Idempotência:
--   * Todos os IDs são determinísticos (md5 de "seed:<tipo>:<chave>"), então
--     rodar de novo cai em ON CONFLICT e não duplica nada.
--   * Exceção proposital: `meetings` faz UPSERT. As datas são relativas a hoje,
--     então rodar o seed de novo "re-ancora" os encontros (o próximo encontro
--     volta a ser futuro, os passados continuam no passado).
--
-- Login (todas as contas seed, mesma senha): ClubeDelas@123
--   FOUNDER: local.user.admin@gmail.com
--   MANAGER: local.user.manager@gmail.com
--   READER:  local.user.reader@gmail.com
--   Demais participantes: <nome.sobrenome>@example.com (ex.: fernanda.vargas@example.com)
--

-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 0. HELPERS (vivem só nesta sessão, em pg_temp)
-- ---------------------------------------------------------

-- ID determinístico a partir de tipo + chave
CREATE OR REPLACE FUNCTION pg_temp.sid(kind text, key text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('seed:' || kind || ':' || key)::uuid $$;

-- E-mail da participante: slug sem '@' vira <slug>@example.com
CREATE OR REPLACE FUNCTION pg_temp.email(slug text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN slug LIKE '%@%' THEN slug ELSE slug || '@example.com' END $$;

-- Data/hora relativa a hoje, no fuso de São Paulo (day_offset em dias)
CREATE OR REPLACE FUNCTION pg_temp.slot(day_offset int, hour int) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT (((now() AT TIME ZONE 'America/Sao_Paulo')::date + day_offset) + make_time(hour, 0, 0))
         AT TIME ZONE 'America/Sao_Paulo'
$$;

-- Valores de texto assumidos para colunas varchar (AJUSTAR AQUI)
DROP TABLE IF EXISTS s_const;
CREATE TEMP TABLE s_const (k text PRIMARY KEY, v text NOT NULL);
INSERT INTO s_const (k, v) VALUES
  ('registration_active', 'ACTIVE'),   -- group_users.registration_status
  ('presence_present',    'PRESENT'),  -- meeting_group_users.presence_status
  ('presence_absent',     'ABSENT'),
  ('suggestion_active',   'ACTIVE'),   -- book_suggestions.book_status (indicação concorrendo)
  ('suggestion_drawn',    'DRAWN');    -- book_suggestions.book_status (já sorteado)

CREATE OR REPLACE FUNCTION pg_temp.k(key text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT v FROM pg_temp.s_const WHERE k = key $$;

-- ---------------------------------------------------------
-- 1. CIDADES E ZONAS
--    Se a cidade/zona já existir (mesmo nome), reaproveita o id existente.
-- ---------------------------------------------------------

DROP TABLE IF EXISTS s_city;
CREATE TEMP TABLE s_city (key text PRIMARY KEY, name text, uf text, id uuid);
INSERT INTO s_city (key, name, uf, id)
SELECT v.key, v.name, v.uf,
       COALESCE((SELECT c.id FROM public.cities c
                 WHERE c.name = v.name AND c.uf = v.uf ORDER BY c.id LIMIT 1),
                pg_temp.sid('city', v.key))
FROM (VALUES
  ('poa', 'Porto Alegre',   'RS'),
  ('sp',  'São Paulo',      'SP'),
  ('bh',  'Belo Horizonte', 'MG'),
  ('rec', 'Recife',         'PE')
) AS v(key, name, uf);

INSERT INTO public.cities (id, name, uf)
SELECT id, name, uf FROM s_city
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.cid(k text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT id FROM pg_temp.s_city WHERE key = k $$;

DROP TABLE IF EXISTS s_zone;
CREATE TEMP TABLE s_zone (key text PRIMARY KEY, name text, city_key text, id uuid);
INSERT INTO s_zone (key, name, city_key, id)
SELECT v.key, v.name, v.city_key,
       COALESCE((SELECT z.id FROM public.zones z
                 WHERE z.name = v.name AND z.city_id = pg_temp.cid(v.city_key)
                 ORDER BY z.id LIMIT 1),
                pg_temp.sid('zone', v.key))
FROM (VALUES
  ('poa-sul',     'Zona Sul',        'poa'),
  ('poa-centro',  'Centro Histórico','poa'),
  ('poa-norte',   'Zona Norte',      'poa'),
  ('sp-oeste',    'Zona Oeste',      'sp'),
  ('sp-sul',      'Zona Sul',        'sp'),
  ('bh-savassi',  'Savassi',         'bh'),
  ('bh-pampulha', 'Pampulha',        'bh')
) AS v(key, name, city_key);

INSERT INTO public.zones (id, name, city_id)
SELECT id, name, pg_temp.cid(city_key) FROM s_zone
ON CONFLICT (id) DO NOTHING;

-- devolve NULL quando a chave é NULL (usuária/grupo sem zona)
CREATE OR REPLACE FUNCTION pg_temp.zid(k text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT id FROM pg_temp.s_zone WHERE key = k $$;

-- ---------------------------------------------------------
-- 2. DEFINIÇÕES (tabelas temporárias com os dados-base)
-- ---------------------------------------------------------

-- Participantes -------------------------------------------
DROP TABLE IF EXISTS s_users;
CREATE TEMP TABLE s_users (
  key int PRIMARY KEY, slug text, name text, phone text, instagram text,
  birth date, job text, edu text, role text, city text, zone text
);
INSERT INTO s_users VALUES
  ( 1, 'local.user.admin@gmail.com',   'Admin Local',         '(51) 90000-0000', NULL,                 '1990-01-01', 'Administradora',              'UNDERGRADUATE',            'FOUNDER', 'poa', 'poa-sul'),
  ( 2, 'local.user.manager@gmail.com', 'Gerente Local',       '(51) 99734-1182', 'local.user.manager', '1990-07-02', 'Professora',                  'MASTERS',                  'MANAGER', 'poa', 'poa-sul'),
  ( 3, 'local.user.reader@gmail.com',  'Leitora Local',       '(51) 99655-4720', NULL,                 '1994-11-23', 'Designer',                    'UNDERGRADUATE',            'READER',  'poa', 'poa-sul'),
  ( 4, 'fernanda.vargas',     'Fernanda Vargas',     '(51) 99903-2216', 'fernandavargas',     '1988-01-30', 'Enfermeira',                  'POSTGRADUATE',             'READER',  'poa', 'poa-sul'),
  ( 5, 'patricia.menezes',    'Patrícia Menezes',    '(51) 99581-7743', 'pati.menezes',       '1983-09-08', 'Jornalista',                  'UNDERGRADUATE',            'READER',  'poa', 'poa-centro'),
  ( 6, 'luciana.bortoluzzi',  'Luciana Bortoluzzi',  '(51) 99476-0958', 'lu.bortoluzzi',      '1979-05-19', 'Arquiteta',                   'MASTERS',                  'READER',  'poa', 'poa-centro'),
  ( 7, 'renata.fontoura',     'Renata Fontoura',     '(51) 99820-6634', NULL,                 '1992-12-11', 'Psicóloga',                   'POSTGRADUATE',             'READER',  'poa', 'poa-sul'),
  ( 8, 'aline.kunzler',       'Aline Kunzler',       '(51) 99317-8825', 'aline.kunzler',      '1995-04-27', 'Analista de sistemas',        'UNDERGRADUATE',            'READER',  'poa', 'poa-norte'),
  ( 9, 'beatriz.cardoso',     'Beatriz Cardoso',     '(51) 99688-3097', 'bea.cardoso',        '1989-08-16', 'Bibliotecária',               'UNDERGRADUATE',            'READER',  'poa', 'poa-centro'),
  (10, 'tatiana.ferraz',      'Tatiana Ferraz',      '(51) 99245-5581', NULL,                 '1981-02-05', 'Médica',                      'POSTGRADUATE',             'READER',  'poa', 'poa-norte'),
  (11, 'simone.dalpozzo',     'Simone Dal Pozzo',    '(51) 99772-4460', 'si.dalpozzo',        '1976-10-21', 'Contadora',                   'UNDERGRADUATE',            'READER',  'poa', 'poa-sul'),
  (12, 'gabriela.lemos',      'Gabriela Lemos',      '(51) 99531-2079', 'gabi.lemos',         '2001-06-09', 'Estudante de Letras',         'INCOMPLETE_UNDERGRADUATE', 'READER',  'poa', 'poa-centro'),
  (13, 'isabela.nogueira',    'Isabela Nogueira',    '(11) 98842-1306', 'isa.nogueira',       '1985-01-17', 'Editora',                     'MASTERS',                  'MANAGER', 'sp',  'sp-oeste'),
  (14, 'larissa.tavares',     'Larissa Tavares',     '(11) 97653-8214', 'lari.tavares',       '1993-03-25', 'Publicitária',                'UNDERGRADUATE',            'READER',  'sp',  'sp-oeste'),
  (15, 'bruna.yamamoto',      'Bruna Yamamoto',      '(11) 98127-5539', 'bruyamamoto',        '1991-09-30', 'Engenheira civil',            'UNDERGRADUATE',            'READER',  'sp',  'sp-oeste'),
  (16, 'carolina.duarte',     'Carolina Duarte',     '(11) 99461-0872', NULL,                 '1987-12-03', 'Advogada',                    'POSTGRADUATE',             'READER',  'sp',  'sp-oeste'),
  (17, 'daniela.marques',     'Daniela Marques',     '(11) 97390-6645', 'dani.marques.nutri', '1990-05-12', 'Nutricionista',               'UNDERGRADUATE',            'READER',  'sp',  'sp-oeste'),
  (18, 'vanessa.pacheco',     'Vanessa Pacheco',     '(11) 98236-9014', 'van.pacheco',        '1984-07-28', 'Fisioterapeuta',              'POSTGRADUATE',             'READER',  'sp',  'sp-sul'),
  (19, 'priscila.andrade',    'Priscila Andrade',    '(11) 97718-3358', 'pri.andrade.doces',  '1980-11-14', 'Confeiteira e empreendedora', 'HIGH_SCHOOL',              'READER',  'sp',  'sp-sul'),
  (20, 'amanda.rezende',      'Amanda Rezende',      '(11) 99054-4127', 'amanda.traduz',      '1988-04-06', 'Tradutora',                   'MASTERS',                  'READER',  'sp',  'sp-oeste'),
  (21, 'leticia.barbosa',     'Letícia Barbosa',     '(11) 98570-2683', NULL,                 '1992-08-22', 'Analista financeira',         'POSTGRADUATE',             'READER',  'sp',  'sp-sul'),
  (22, 'natalia.ribeiro',     'Natália Ribeiro',     '(11) 97946-1590', 'nati.ribeiro',       '1986-10-01', 'Professora',                  'MASTERS',                  'READER',  'sp',  'sp-oeste'),
  (23, 'claudia.ventura',     'Cláudia Ventura',     '(31) 99184-7702', 'claudia.ventura',    '1978-02-13', 'Historiadora',                'DOCTORATE',                'MANAGER', 'bh',  'bh-savassi'),
  (24, 'rafaela.guimaraes',   'Rafaela Guimarães',   '(31) 98865-3319', 'rafa.guimaraes',     '1991-06-18', 'Designer gráfica',            'UNDERGRADUATE',            'READER',  'bh',  'bh-savassi'),
  (25, 'helena.drummond',     'Helena Drummond',     '(31) 99627-0446', 'helena.drummond',    '1984-09-27', 'Arquiteta',                   'MASTERS',                  'READER',  'bh',  'bh-pampulha'),
  (26, 'sabrina.coelho',      'Sabrina Coelho',      '(31) 98413-5871', NULL,                 '1989-12-15', 'Dentista',                    'POSTGRADUATE',             'READER',  'bh',  'bh-savassi'),
  (27, 'monica.peixoto',      'Mônica Peixoto',      '(31) 99752-2238', 'monica.peixoto',     '1975-04-04', 'Servidora pública',           'POSTGRADUATE',             'READER',  'bh',  'bh-pampulha'),
  (28, 'talita.resende',      'Talita Resende',      '(31) 98098-6113', 'talita.rsd',         '2000-01-29', 'Estudante de Psicologia',     'INCOMPLETE_UNDERGRADUATE', 'READER',  'bh',  'bh-savassi'),
  (29, 'debora.cavalcanti',   'Débora Cavalcanti',   '(81) 99835-2764', 'debora.cavalcanti',  '1982-05-07', 'Jornalista',                  'MASTERS',                  'MANAGER', 'rec', NULL),
  (30, 'elisa.montenegro',    'Elisa Montenegro',    '(81) 98764-4092', NULL,                 '1987-03-31', 'Médica',                      'POSTGRADUATE',             'READER',  'rec', NULL),
  (31, 'veronica.lins',       'Verônica Lins',       '(81) 99521-8846', 'vero.lins',          '1979-10-10', 'Professora',                  'DOCTORATE',                'READER',  'rec', NULL),
  (32, 'ingrid.bezerra',      'Ingrid Bezerra',      '(81) 98207-3375', 'ingrid.bezerra',     '1996-07-24', 'Designer',                    'TECHNICAL',                'READER',  'rec', NULL);
  (33, 'mariana.souza',       'Mariana Souza',       '(51) 99111-2233', NULL,                 '1993-05-14', 'Professora',                  'UNDERGRADUATE',            'READER',  'poa', 'poa-sul');
-- Vínculos grupo x participante ---------------------------
-- (grp, usr, coordenadora?, ausências consecutivas mais recentes)
-- Quem está em mais de um grupo: 1 (g1,g2), 5 (g1,g2,g7), 9 (g1,g2), 21 (g3,g4)
DROP TABLE IF EXISTS s_members;
CREATE TEMP TABLE s_members (grp int, usr int, coord boolean, last_abs smallint, PRIMARY KEY (grp, usr));
INSERT INTO s_members VALUES
  (1,  2, true,  0), (1,  1, true,  0), (1,  3, false, 0), (1,  4, false, 0),
  (1,  5, false, 0), (1,  7, false, 0), (1,  9, false, 1), (1, 11, false, 0),
  (2,  6, true,  0), (2,  1, false, 0), (2,  5, false, 0), (2,  9, false, 0), (2, 12, false, 2),
  (3, 13, true,  0), (3, 14, false, 0), (3, 15, false, 0), (3, 16, false, 0),
  (3, 17, false, 0), (3, 20, false, 0), (3, 21, false, 1), (3, 22, false, 0),
  (4, 18, true,  0), (4, 19, false, 1), (4, 21, false, 0),
  (5, 23, true,  0), (5, 24, false, 0), (5, 25, false, 0), (5, 26, false, 0), (5, 27, false, 0), (5, 28, false, 3),
  (6, 29, true,  0), (6, 30, false, 0), (6, 31, false, 1), (6, 32, false, 0),
  (7,  8, true,  0), (7,  5, false, 0), (7, 10, false, 1);

-- Livros --------------------------------------------------
DROP TABLE IF EXISTS s_books;
CREATE TEMP TABLE s_books (key int PRIMARY KEY, name text, author text, publisher text, genre text, cover boolean);
INSERT INTO s_books VALUES
  ( 1, 'Torto Arado',                                   'Itamar Vieira Junior',      'Todavia',              'Romance',           true),
  ( 2, 'Dom Casmurro',                                  'Machado de Assis',          'Companhia das Letras', 'Clássico',          true),
  ( 3, 'A Hora da Estrela',                             'Clarice Lispector',         'Rocco',                'Romance',           true),
  ( 4, 'Grande Sertão: Veredas',                        'João Guimarães Rosa',       'Nova Fronteira',       'Clássico',          true),
  ( 5, 'Úrsula',                                        'Maria Firmina dos Reis',    'Penguin-Companhia',    'Romance',           true),
  ( 6, 'Quarto de Despejo',                             'Carolina Maria de Jesus',   'Ática',                'Diário',            true),
  ( 7, 'Vidas Secas',                                   'Graciliano Ramos',          'Record',               'Clássico',          true),
  ( 8, 'Capitães da Areia',                             'Jorge Amado',               'Companhia das Letras', 'Romance',           true),
  ( 9, 'A Paixão Segundo G.H.',                         'Clarice Lispector',         'Rocco',                'Romance',           true),
  (10, 'Ponciá Vicêncio',                               'Conceição Evaristo',        'Pallas',               'Romance',           true),
  (11, 'Olhos d''água',                                 'Conceição Evaristo',        'Pallas',               'Contos',            false),
  (12, 'Memórias Póstumas de Brás Cubas',               'Machado de Assis',          'Companhia das Letras', 'Clássico',          true),
  (13, 'O Avesso da Pele',                              'Jeferson Tenório',          'Companhia das Letras', 'Romance',           true),
  (14, 'Solitária',                                     'Eliana Alves Cruz',         'Companhia das Letras', 'Romance',           true),
  (15, 'Tudo é Rio',                                    'Carla Madeira',             'Record',               'Romance',           true),
  (16, 'Extraordinário',                                'R. J. Palacio',             'Intrínseca',           'Infantojuvenil',    true),
  (17, 'A Vegetariana',                                 'Han Kang',                  'Todavia',              'Romance',           true),
  (18, 'Mulheres que Correm com os Lobos',              'Clarissa Pinkola Estés',    'Rocco',                'Ensaio',            true),
  (19, 'Sapiens: Uma Breve História da Humanidade',     'Yuval Noah Harari',         'L&PM',                 'Não ficção',        true),
  (20, 'A Redoma de Vidro',                             'Sylvia Plath',              'Biblioteca Azul',      'Romance',           true),
  (21, 'A Casa dos Espíritos',                          'Isabel Allende',            'Bertrand Brasil',      'Romance',           true),
  (22, 'Cem Anos de Solidão',                           'Gabriel García Márquez',    'Record',               'Romance',           true),
  (23, 'O Conto da Aia',                                'Margaret Atwood',           'Rocco',                'Ficção distópica',  true),
  (24, 'Pequeno Manual Antirracista',                   'Djamila Ribeiro',           'Companhia das Letras', 'Ensaio',            true),
  (25, 'Os Sete Maridos de Evelyn Hugo',                'Taylor Jenkins Reid',       'Paralela',             'Romance',           true),
  (26, 'A Cor Púrpura',                                 'Alice Walker',              'José Olympio',         'Romance',           true),
  (27, 'Dias de Abandono',                              'Elena Ferrante',            'Biblioteca Azul',      'Romance',           true),
  (28, 'A Amiga Genial',                                'Elena Ferrante',            'Biblioteca Azul',      'Romance',           false);

-- Encontros -----------------------------------------------
-- status/estado:
--   CONCLUDED               -> realizado (histórico)
--   SCHEDULED + data + local -> completo
--   CREATED  + data, sem local -> pendência de local
--   CREATED  sem data        -> rascunho (livro já sorteado)
-- day_offset: dias a partir de hoje (negativo = passado)
DROP TABLE IF EXISTS s_meetings;
CREATE TEMP TABLE s_meetings (
  key text PRIMARY KEY, grp int, book int, host int, loc int,
  day_offset int, hour int, status text
);
INSERT INTO s_meetings VALUES
  -- Grupo 1 (Porto Alegre / Zona Sul): 4 passados + próximo completo
  ('g1-m1', 1,  2,  2,  1, -140, 19, 'CONCLUDED'),
  ('g1-m2', 1,  7,  5,  1, -105, 19, 'CONCLUDED'),
  ('g1-m3', 1,  6,  7,  1,  -70, 19, 'CONCLUDED'),
  ('g1-m4', 1,  1,  3,  1,  -35, 19, 'CONCLUDED'),
  ('g1-m5', 1, 10,  4,  2,   12, 19, 'SCHEDULED'),
  -- Grupo 2 (Porto Alegre / Centro): 3 passados + próximo com data e SEM local
  ('g2-m1', 2,  3,  6,  3, -118, 19, 'CONCLUDED'),
  ('g2-m2', 2,  5,  9,  3,  -83, 19, 'CONCLUDED'),
  ('g2-m3', 2,  9,  5,  3,  -48, 19, 'CONCLUDED'),
  ('g2-m4', 2, 13, 12, NULL,  9, 19, 'CREATED'),
  -- Grupo 3 (São Paulo / Zona Oeste): 4 passados + próximo completo + rascunho sem data
  ('g3-m1', 3, 18, 13,  4, -150, 19, 'CONCLUDED'),
  ('g3-m2', 3, 23, 14,  5, -115, 19, 'CONCLUDED'),
  ('g3-m3', 3, 25, 16,  4,  -80, 19, 'CONCLUDED'),
  ('g3-m4', 3, 17, 20,  4,  -45, 19, 'CONCLUDED'),
  ('g3-m5', 3, 24, 15,  4,    6, 19, 'SCHEDULED'),
  ('g3-m6', 3, 22, 22, NULL, NULL, NULL, 'CREATED'),
  -- Grupo 4 (São Paulo / Zona Sul): 2 passados + próximo completo
  ('g4-m1', 4, 16, 18,  6,  -92, 19, 'CONCLUDED'),
  ('g4-m2', 4, 26, 19,  6,  -52, 19, 'CONCLUDED'),
  ('g4-m3', 4, 27, 21,  6,   20, 19, 'SCHEDULED'),
  -- Grupo 5 (Belo Horizonte): 4 passados + próximo completo + rascunho sem data
  ('g5-m1', 5,  4, 23,  7, -130, 19, 'CONCLUDED'),
  ('g5-m2', 5, 28, 24,  7,  -95, 19, 'CONCLUDED'),
  ('g5-m3', 5, 15, 25,  8,  -60, 19, 'CONCLUDED'),
  ('g5-m4', 5, 11, 26,  7,  -28, 19, 'CONCLUDED'),
  ('g5-m5', 5, 20, 27,  7,   10, 19, 'SCHEDULED'),
  ('g5-m6', 5, 19, 28, NULL, NULL, NULL, 'CREATED'),
  -- Grupo 6 (Recife): 3 passados + próximo com data e SEM local
  ('g6-m1', 6,  8, 30,  9, -100, 19, 'CONCLUDED'),
  ('g6-m2', 6, 12, 29, 10,  -60, 19, 'CONCLUDED'),
  ('g6-m3', 6, 14, 31,  9,  -25, 19, 'CONCLUDED'),
  ('g6-m4', 6,  3, 32, NULL, 16, 19, 'CREATED'),
  -- Grupo 7 (Porto Alegre / Zona Norte, INATIVO): só histórico
  ('g7-m1', 7, 22,  8,  3, -200, 19, 'CONCLUDED'),
  ('g7-m2', 7, 21, 10,  3, -170, 19, 'CONCLUDED');

-- Ausências (todo o resto dos encontros realizados = presença)
DROP TABLE IF EXISTS s_absences;
CREATE TEMP TABLE s_absences (meeting text, usr int);
INSERT INTO s_absences VALUES
  ('g1-m2', 7), ('g1-m4', 9),
  ('g2-m2', 12), ('g2-m3', 12),
  ('g3-m1', 16), ('g3-m4', 21),
  ('g4-m2', 19),
  ('g5-m1', 25), ('g5-m2', 28), ('g5-m3', 28), ('g5-m4', 28),
  ('g6-m3', 31),
  ('g7-m2', 10);

-- Indicações ativas para o próximo sorteio (nenhum livro aqui foi sorteado no mesmo grupo)
DROP TABLE IF EXISTS s_sugs;
CREATE TEMP TABLE s_sugs (grp int, usr int, book int, days_ago int);
INSERT INTO s_sugs VALUES
  (1,  3, 15, 18), (1,  9, 20, 12), (1,  1, 13,  9), (1, 11, 25,  5),
  (2,  5,  6, 20), (2, 12, 14, 14), (2,  1,  1,  8), (2,  6, 28,  3),
  (3, 17,  1, 25), (3, 20, 27, 17), (3, 22, 11, 10), (3, 21, 15,  6), (3, 16, 10,  2),
  (4, 19, 25, 15), (4, 18, 15,  9), (4, 21, 23,  4),
  (5, 24,  1, 22), (5, 28, 24, 11), (5, 26, 22,  7), (5, 23,  2,  3),
  (6, 30,  1, 19), (6, 31, 17, 13), (6, 32, 18,  8), (6, 29, 23,  2);

-- ---------------------------------------------------------
-- 3. FOTOS (grupos, capas de livros, fotos de encontros)
--    Imagens determinísticas do picsum.photos (troque por assets locais se preferir)
-- ---------------------------------------------------------

INSERT INTO public.photos (id, url, file_extension, uploaded_at, uploaded_by)
SELECT pg_temp.sid('photo', 'group-' || g),
       'https://picsum.photos/seed/clube-grupo-' || g || '/800/600',
       'jpg',
       (now() AT TIME ZONE 'America/Sao_Paulo')::date - 200,
       pg_temp.sid('user', '1')
FROM generate_series(1, 7) AS g
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.photos (id, url, file_extension, uploaded_at, uploaded_by)
SELECT pg_temp.sid('photo', 'book-' || b.key),
       'https://picsum.photos/seed/livro-' || b.key || '/400/600',
       'jpg',
       (now() AT TIME ZONE 'America/Sao_Paulo')::date - 180,
       pg_temp.sid('user', '1')
FROM s_books b
WHERE b.cover
ON CONFLICT (id) DO NOTHING;

-- Fotos dos encontros: (encontro, índice, é capa?)
DROP TABLE IF EXISTS s_meeting_photos;
CREATE TEMP TABLE s_meeting_photos (meeting text, idx int, is_cover boolean);
INSERT INTO s_meeting_photos VALUES
  ('g1-m3', 1, true), ('g1-m4', 1, true), ('g1-m4', 2, false),
  ('g3-m3', 1, true), ('g3-m4', 1, true), ('g3-m4', 2, false),
  ('g5-m3', 1, true);

INSERT INTO public.photos (id, url, file_extension, uploaded_at, uploaded_by)
SELECT pg_temp.sid('photo', 'meeting-' || mp.meeting || '-' || mp.idx),
       'https://picsum.photos/seed/encontro-' || mp.meeting || '-' || mp.idx || '/1200/800',
       'jpg',
       pg_temp.slot(m.day_offset, 22)::date,
       pg_temp.sid('user', m.host::text)
FROM s_meeting_photos mp
JOIN s_meetings m ON m.key = mp.meeting
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------
-- 4. LOCAIS E LIVROS
-- ---------------------------------------------------------

-- google_place_id é fictício (não resolve na API do Google Places)
INSERT INTO public.locations (id, address, google_place_id, name, latitude, longitude) VALUES
  (pg_temp.sid('loc', '1'),  'Av. Wenceslau Escobar, 1450 - Cristal, Porto Alegre - RS',            'seed-place-01', 'Café Vento Sul',         '-30.0862', '-51.2379'),
  (pg_temp.sid('loc', '2'),  'Rua Dr. Armando Barbedo, 320 - Tristeza, Porto Alegre - RS',          'seed-place-02', 'Casa da Fernanda',       '-30.1102', '-51.2436'),
  (pg_temp.sid('loc', '3'),  'Rua Riachuelo, 780 - Centro Histórico, Porto Alegre - RS',            'seed-place-03', 'Sebo Entrelinhas',       '-30.0338', '-51.2301'),
  (pg_temp.sid('loc', '4'),  'Rua Wisard, 305 - Vila Madalena, São Paulo - SP',                     'seed-place-04', 'Livraria Página Dois',   '-23.5566', '-46.6915'),
  (pg_temp.sid('loc', '5'),  'Rua dos Pinheiros, 1120 - Pinheiros, São Paulo - SP',                 'seed-place-05', 'Casa da Larissa',        '-23.5672', '-46.6889'),
  (pg_temp.sid('loc', '6'),  'Rua Vieira de Morais, 1050 - Campo Belo, São Paulo - SP',             'seed-place-06', 'Café Jabuticaba',        '-23.6231', '-46.6712'),
  (pg_temp.sid('loc', '7'),  'Rua Pernambuco, 1000 - Savassi, Belo Horizonte - MG',                 'seed-place-07', 'Café Saudade',           '-19.9372', '-43.9351'),
  (pg_temp.sid('loc', '8'),  'Av. Otacílio Negrão de Lima, 2200 - Pampulha, Belo Horizonte - MG',   'seed-place-08', 'Casa da Helena',         '-19.8512', '-43.9641'),
  (pg_temp.sid('loc', '9'),  'Rua do Bom Jesus, 150 - Recife Antigo, Recife - PE',                   'seed-place-09', 'Cafeteria Maré Alta',    '-8.0631',  '-34.8712'),
  (pg_temp.sid('loc', '10'), 'Rua da Aurora, 520 - Boa Vista, Recife - PE',                         'seed-place-10', 'Casa da Débora',         '-8.0592',  '-34.8834')
ON CONFLICT (id) DO NOTHING;

-- external_id é fictício (seed-livro-NN)
INSERT INTO public.books (id, name, author, publisher, genre, external_id, photo_id)
SELECT pg_temp.sid('book', b.key::text), b.name, b.author, b.publisher, b.genre,
       'seed-livro-' || lpad(b.key::text, 2, '0'),
       CASE WHEN b.cover THEN pg_temp.sid('photo', 'book-' || b.key) END
FROM s_books b
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------
-- 5. USUÁRIAS (auth.users -> auth.identities -> public.users)
--    Se houver trigger em auth.users que já cria public.users, ajuste aqui.
-- ---------------------------------------------------------

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
SELECT '00000000-0000-0000-0000-000000000000',
       pg_temp.sid('auth', u.key::text),
       'authenticated', 'authenticated',
       pg_temp.email(u.slug),
       extensions.crypt('ClubeDelas@123', extensions.gen_salt('bf')),
       now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('name', u.name),
       now(), now(),
       '', '', '', ''
FROM s_users u
ON CONFLICT DO NOTHING;

INSERT INTO auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT pg_temp.sid('identity', u.key::text),
       pg_temp.sid('auth', u.key::text)::text,
       pg_temp.sid('auth', u.key::text),
       jsonb_build_object('sub', pg_temp.sid('auth', u.key::text)::text,
                          'email', pg_temp.email(u.slug),
                          'email_verified', true),
       'email', now(), now(), now()
FROM s_users u
ON CONFLICT DO NOTHING;

INSERT INTO public.users (
  id, name, created_at, phone, instagram, email, birth_date, job,
  level_of_education, app_role, city_id, zone_id, is_active, user_id
)
SELECT pg_temp.sid('user', u.key::text),
       u.name,
       now() - (200 + u.key * 5) * interval '1 day',
       u.phone, u.instagram,
       pg_temp.email(u.slug),
       u.birth, u.job,
       u.edu::public.levels_of_education,
       u.role::public.app_roles,
       pg_temp.cid(u.city),
       pg_temp.zid(u.zone),
       CASE
          WHEN u.key = 8 THEN false
          ELSE true
      END,
       pg_temp.sid('auth', u.key::text)
FROM s_users u
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------
-- 6. GRUPOS E VÍNCULOS
-- ---------------------------------------------------------

INSERT INTO public.groups (id, number, description, photo_id, city_id, zone_id, active, whatsapp_link) VALUES
  (pg_temp.sid('group', '1'), 1,
   'Porto Alegre',
   pg_temp.sid('photo', 'group-1'), pg_temp.cid('poa'), pg_temp.zid('poa-sul'), true,
   'https://chat.whatsapp.com/seedgrupo01'),
  (pg_temp.sid('group', '2'), 2,
   'Porto Alegre',
   pg_temp.sid('photo', 'group-2'), pg_temp.cid('poa'), pg_temp.zid('poa-centro'), true,
   'https://chat.whatsapp.com/seedgrupo02'),
  (pg_temp.sid('group', '3'), 3,
   'São Paulo',
   pg_temp.sid('photo', 'group-3'), pg_temp.cid('sp'), pg_temp.zid('sp-oeste'), true,
   'https://chat.whatsapp.com/seedgrupo03'),
  (pg_temp.sid('group', '4'), 4,
   'São Paulo',
   pg_temp.sid('photo', 'group-4'), pg_temp.cid('sp'), pg_temp.zid('sp-sul'), true,
   NULL),
  (pg_temp.sid('group', '5'), 5,
   'Belo Horizonte',
   pg_temp.sid('photo', 'group-5'), pg_temp.cid('bh'), pg_temp.zid('bh-savassi'), true,
   'https://chat.whatsapp.com/seedgrupo05'),
  (pg_temp.sid('group', '6'), 6,
   'Recife',
   pg_temp.sid('photo', 'group-6'), pg_temp.cid('rec'), NULL, true,
   'https://chat.whatsapp.com/seedgrupo06'),
  (pg_temp.sid('group', '7'), 7,
   'Porto Alegre',
   pg_temp.sid('photo', 'group-7'), pg_temp.cid('poa'), pg_temp.zid('poa-norte'), false,
   NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.group_users (id, group_id, user_id, is_coordinator, registration_status, last_consecutive_absences)
SELECT pg_temp.sid('gu', m.grp::text || ':' || m.usr::text),
       pg_temp.sid('group', m.grp::text),
       pg_temp.sid('user', m.usr::text),
       m.coord,
       pg_temp.k('registration_active'),
       m.last_abs
FROM s_members m
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------
-- 7. ENCONTROS (UPSERT: re-ancora as datas relativas a hoje)
-- ---------------------------------------------------------

INSERT INTO public.meetings (id, date, location_id, group_id, host_id, book_id, status)
SELECT pg_temp.sid('meeting', m.key),
       CASE WHEN m.day_offset IS NULL THEN NULL ELSE pg_temp.slot(m.day_offset, m.hour) END,
       CASE WHEN m.loc IS NULL THEN NULL ELSE pg_temp.sid('loc', m.loc::text) END,
       pg_temp.sid('group', m.grp::text),
       pg_temp.sid('gu', m.grp::text || ':' || m.host::text),
       pg_temp.sid('book', m.book::text),
       m.status::public.meeting_status
FROM s_meetings m
ON CONFLICT (id) DO UPDATE SET
  date        = EXCLUDED.date,
  location_id = EXCLUDED.location_id,
  group_id    = EXCLUDED.group_id,
  host_id     = EXCLUDED.host_id,
  book_id     = EXCLUDED.book_id,
  status      = EXCLUDED.status;

-- ---------------------------------------------------------
-- 8. INDICAÇÕES DE LIVROS
-- ---------------------------------------------------------

-- 8a. Livros já sorteados (um por encontro): saem da concorrência
INSERT INTO public.book_suggestions (id, book_id, group_user_id, suggested_at, book_status)
SELECT pg_temp.sid('sug', 'drawn:' || m.key),
       pg_temp.sid('book', m.book::text),
       pg_temp.sid('gu', m.grp::text || ':' || m.host::text),
       COALESCE(pg_temp.slot(m.day_offset, 9), now()) - interval '40 days',
       pg_temp.k('suggestion_drawn')
FROM s_meetings m
ON CONFLICT (id) DO NOTHING;

-- 8b. Indicações ativas para o próximo sorteio
INSERT INTO public.book_suggestions (id, book_id, group_user_id, suggested_at, book_status)
SELECT pg_temp.sid('sug', 'active:' || s.grp::text || ':' || s.book::text),
       pg_temp.sid('book', s.book::text),
       pg_temp.sid('gu', s.grp::text || ':' || s.usr::text),
       now() - s.days_ago * interval '1 day',
       pg_temp.k('suggestion_active')
FROM s_sugs s
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------
-- 9. PRESENÇAS, FOTOS, CONVIDADAS E AVALIAÇÕES
-- ---------------------------------------------------------

-- Presença: só nos encontros realizados
INSERT INTO public.meeting_group_users (id, group_user_id, meeting_id, presence_status)
SELECT pg_temp.sid('mgu', m.key || ':' || mem.usr::text),
       pg_temp.sid('gu', mem.grp::text || ':' || mem.usr::text),
       pg_temp.sid('meeting', m.key),
       CASE WHEN EXISTS (SELECT 1 FROM s_absences a WHERE a.meeting = m.key AND a.usr = mem.usr)
            THEN pg_temp.k('presence_absent')
            ELSE pg_temp.k('presence_present') END
FROM s_meetings m
JOIN s_members mem ON mem.grp = m.grp
WHERE m.status = 'CONCLUDED'
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.meeting_photos (photo_id, meeting_id, is_cover)
SELECT pg_temp.sid('photo', 'meeting-' || mp.meeting || '-' || mp.idx),
       pg_temp.sid('meeting', mp.meeting),
       mp.is_cover
FROM s_meeting_photos mp
ON CONFLICT (photo_id) DO NOTHING;

-- Convidadas (participantes de outro grupo que foram como convidadas)
INSERT INTO public.meeting_guests (id, meeting_id, user_id) VALUES
  (pg_temp.sid('guest', 'g1-m4:6'),  pg_temp.sid('meeting', 'g1-m4'), pg_temp.sid('user', '6')),
  (pg_temp.sid('guest', 'g3-m4:18'), pg_temp.sid('meeting', 'g3-m4'), pg_temp.sid('user', '18')),
  (pg_temp.sid('guest', 'g1-m5:12'), pg_temp.sid('meeting', 'g1-m5'), pg_temp.sid('user', '12'))
ON CONFLICT (id) DO NOTHING;

-- Avaliações dos encontros realizados: ~3/4 das presentes avaliam, ~1/3 com texto.
-- Nota entre 3.0 e 5.0 (passo 0.5), determinística por encontro+participante.
INSERT INTO public.book_reviews (id, meeting_id, user_id, book_rating, book_review, evaluated_at, book_id)
SELECT pg_temp.sid('review', m.key || ':' || mem.usr::text),
       pg_temp.sid('meeting', m.key),
       pg_temp.sid('user', mem.usr::text),
       (3 + ((x.h / 7) % 5) * 0.5)::real,
       CASE WHEN x.h % 3 = 0 THEN (ARRAY[
         'Gostei muito, li em poucos dias e não consegui largar.',
         'Demorei para entrar na história, mas o final compensou cada página.',
         'A discussão do grupo me fez enxergar o livro de outro jeito.',
         'Não era o que eu esperava, mas fico feliz de ter lido.',
         'Personagens muito bem construídas, dessas que ficam com a gente.',
         'Uma leitura densa, que pede calma. Valeu a pena cada página.',
         'Achei arrastado no meio, mas o encontro foi ótimo.',
         'Prosa linda e cheia de trechos que eu quis sublinhar.',
         'Fazia tempo que um livro não me tocava assim. Recomendo para quem gosta de histórias que ficam na cabeça depois de terminar de ler.',
         'Me identifiquei demais com a protagonista.',
         'Leitura necessária, principalmente pelo debate que gerou no grupo.',
         'Não gostei do estilo, mas reconheço a importância da obra.'
       ])[1 + (x.h / 11) % 12] END,
       pg_temp.slot(m.day_offset + 1, 8 + x.h % 12),
       pg_temp.sid('book', m.book::text)
FROM s_meetings m
JOIN s_members mem ON mem.grp = m.grp
CROSS JOIN LATERAL (SELECT abs(hashtext(m.key || ':' || mem.usr::text)) AS h) x
WHERE m.status = 'CONCLUDED'
  AND x.h % 4 <> 0
  AND NOT EXISTS (SELECT 1 FROM s_absences a WHERE a.meeting = m.key AND a.usr = mem.usr)
ON CONFLICT (id) DO NOTHING;

-- Avaliações avulsas (sem encontro), incluindo um texto longo para testar quebra de linha
INSERT INTO public.book_reviews (id, meeting_id, user_id, book_rating, book_review, evaluated_at, book_id) VALUES
  (pg_temp.sid('review', 'manual-1'), NULL, pg_temp.sid('user', '1'),  4.5,
   'Li antes de indicar para o grupo e já sabia que ia render conversa.',
   now() - interval '30 days', pg_temp.sid('book', '15')),
  (pg_temp.sid('review', 'manual-2'), NULL, pg_temp.sid('user', '14'), 5.0,
   'Um livro curto, direto e que deveria ser leitura obrigatória. Terminei em uma tarde, mas voltei a ele várias vezes nos dias seguintes para reler trechos e anotar perguntas para levar ao grupo. Já emprestei meu exemplar para três amigas e todas quiseram comprar o próprio.',
   now() - interval '20 days', pg_temp.sid('book', '24')),
  (pg_temp.sid('review', 'manual-3'), NULL, pg_temp.sid('user', '23'), 5.0,
   NULL,
   now() - interval '55 days', pg_temp.sid('book', '1'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.pending_users (id, created_at, name, email, address, phone_number, is_approved, claim_token, token_used_at, claim_token_expires_at, birthday, job, level_of_education, instagram_user, book_name)VALUES
  (pg_temp.sid('pending_user', 'waiting'), now() - interval '3 days', 'Juliana Martins', 'juliana.martins@example.com', 'Rua das Flores, 120 - Porto Alegre - RS',
    '(51) 98888-1001', false, NULL, NULL, NULL, '1991-08-12', 'Professora', 'UNDERGRADUATE', 'juliana.martins', 'Torto Arado'),
  (pg_temp.sid('pending_user', 'approved'), now() - interval '2 days', 'Camila Rocha', 'camila.rocha@example.com', 'Rua da Praia, 450 - Porto Alegre - RS',
    '(51) 98888-1002', true, 'seed-claim-token-approved', NULL, now() + interval '7 days', '1987-03-21', 'Designer', 'POSTGRADUATE', 'camilarocha', 'A Hora da Estrela'),
  (pg_temp.sid('pending_user', 'used'), now() - interval '10 days', 'Renata Almeida', 'renata.almeida@example.com', 'Rua Independência, 780 - Porto Alegre - RS',
    '(51) 98888-1003', true, 'seed-claim-token-used', now() - interval '4 days', now() - interval '3 days', '1985-11-06', 'Jornalista', 'MASTERS', 'renata.almeida', 'Quarto de Despejo')
  ON CONFLICT (id) DO NOTHING;

COMMIT;
