# Clube de Leitura D'Elas — Backend

Banco de dados e regras de acesso da plataforma do Clube de Leitura D'Elas.

Consumido pelo app [`mobile`](https://github.com/Clube-de-Leitura-D-elas/mobile).

---

## 🧱 O que vive aqui

O backend do projeto é **Supabase**, usado como backend-as-a-service — não há um servidor de
aplicação próprio. O que este repositório versiona é tudo aquilo que define o banco:

| Caminho | Conteúdo |
|---|---|
| `supabase/migrations/` | Migrations SQL, uma por mudança de schema |
| `supabase/config.toml` | Configuração do projeto Supabase |
| `supabase/seed.sql` | Dados de exemplo para desenvolvimento local |

> **Regra principal do repositório: nenhuma mudança de schema é feita pelo dashboard.**
>
> Toda alteração de banco entra como migration versionada e passa por Pull Request. Sem isso não
> há revisão de mudança de banco, histórico, rollback nem ambiente reproduzível — e o trabalho de
> modelagem fica invisível fora da máquina de quem fez.

---

## 🚀 Como rodar localmente

**Pré-requisitos:** [Docker](https://www.docker.com/products/docker-desktop/) e o
[Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
# 1. Variáveis de ambiente
cp .env.example .env

# 2. Sobe o Supabase local (Postgres, Auth, Storage e Studio)
supabase start

# 3. Aplica as migrations em um banco limpo
supabase db reset
```

O Studio fica em `http://localhost:54323`. O `supabase start` imprime a URL da API e as chaves
locais — use esses valores no `.env` do app durante o desenvolvimento.

---

## 🔄 Fluxo de mudança de schema

```bash
# 1. Cria o arquivo de migration
supabase migration new <descricao_curta>

# 2. Escreve o SQL no arquivo gerado em supabase/migrations/

# 3. Aplica em um banco limpo para validar que roda do zero
supabase db reset

# 4. Commita a migration e abre o PR
```

**Ao criar ou alterar tabela que guarda dados de participantes, revisar a política de RLS na mesma
migration.** O clube tem cerca de 900 participantes reais; tabela sem RLS é dado pessoal exposto.

Migrations são imutáveis depois de mergeadas. Para corrigir algo, criar uma nova migration — nunca
editar uma já aplicada.

---

## 🔐 Segredos

Nenhuma chave do Supabase é commitada. O `.env.example` lista apenas os **nomes** das variáveis;
os valores ficam no `.env` local, que está no `.gitignore`.

---

## 🌿 Branches e commits

Branch padrão: **`develop`**. `main` fica reservada para versões apresentadas aos stakeholders.

Nomeie a branch com o identificador da issue do Linear — assim o Linear vincula branch, PR e issue
automaticamente:

```
<type>/CLU-<numero>-<descricao-curta>
```

Commits seguem [Conventional Commits](https://www.conventionalcommits.org/), em inglês e no
imperativo:

```
feat(group): add reading group table with RLS policies
fix(auth): correct member lookup policy
```

Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `ci`.

---

## 📚 Links

- Board de tarefas: [Linear — Clube de Leitura D'Elas](https://linear.app/clube-de-leitura-d-elas)
- Wiki do projeto: https://tools.ages.pucrs.br/clube-de-leitura-d-elas/wiki/-/wikis/home

---

## 🎓 Semestre

AGES 2026/2 — Turma 3JK5JK
