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

**Pré-requisitos:** [Docker](https://www.docker.com/products/docker-desktop/) instalado e rodando.

```bash
# 1. Instala as dependências
npm install

# 2. Sobe o Supabase local (Postgres, Auth, Storage e Studio)
npx supabase start

# 3. Aplica as migrations em um banco limpo
npx supabase db reset
```

O Studio fica em `http://127.0.0.1:54323`.

Após o `supabase start`, o terminal exibe a URL e as chaves locais. Use esses valores para preencher manualmente o `.env` do app mobile:

| Variável | Campo no terminal |
|---|---|
| `SUPABASE_URL` | `Project URL` |
| `SUPABASE_PUBLISHABLE_KEY` | `Publishable` |

As credenciais também estão no **GitHub Secrets** do repositório.

---

## 🧪 Como testar uma edge function localmente

Com o Supabase local rodando (`npx supabase start` + `npx supabase db reset`, que também aplica o
`seed.sql`):

```bash
# 1. Sobe as edge functions (hot reload ao salvar o arquivo)
npx supabase functions serve

# 2. Em outro terminal, faz login com uma usuária do seed para pegar um JWT
#    (senha de todas as usuárias do seed: ClubeDelas@123)
TOKEN=$(curl -s -X POST "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: <Publishable key do supabase start>" \
  -H "Content-Type: application/json" \
  -d '{"email":"local.user.reader@gmail.com","password":"ClubeDelas@123"}' | jq -r .access_token)

# 3. Pega um id para testar direto no banco
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "select id, number from groups order by number"

# 4. Chama a função
curl -s "http://127.0.0.1:54321/functions/v1/get-group-next-event?group_id=<id>" \
  -H "Authorization: Bearer $TOKEN" | jq
```

As funções declaradas com `verify_jwt = true` no `config.toml` recusam chamadas sem o header
`Authorization` (401). Os logs (`console.error`) aparecem no terminal do `functions serve`.

Vale testar, além do caminho feliz: id inexistente (404), id inválido (400), sem token (401) e os
cenários que o seed já cobre (ver comentários na seção de encontros do `seed.sql`).

### Funções do painel web (sufixo `-web`)

O app mobile e o painel web pedem recortes diferentes dos mesmos dados. Quando as duas telas
precisam do mesmo assunto, a função do painel leva o sufixo `-web` — `get-group-details` serve o
app, `get-group-details-web` serve o painel — para que mudar o contrato de uma não quebre a outra.

As funções do painel também leem a query string em camelCase (`groupId`, `pageSize`, `cityId`),
que é o formato que o front envia, e devolvem listas paginadas como `{ items, total }`.

### Criação de grupo

`create-group` exige JWT de uma usuária `FOUNDER` e aceita somente `POST` com o formato do modal
do painel: `{ "name": "43", "cityId": "<uuid>", "coordinatorId": "<uuid>" | null }`.

- `name` é o número do grupo (`"43"` ou `"Grupo 43"`) e precisa ser único em todo o clube (409).
- `cityId` pode ser o id de uma cidade ou de uma zona; com zona, a cidade vem da zona. A descrição
  do grupo é o nome do lugar escolhido.
- `coordinatorId` é opcional e precisa ser uma participante ativa (`users.id`).

Grupo e coordenadora são criados numa transação só (`public.create_group`). Responde `201` com
`{ id, number, description, cityId, zoneId, coordinatorId, createdAt }`.

### Resposta de presença

`set-meeting-attendance-response` exige JWT e aceita somente `POST` com
`{ "meeting_id": "<uuid>", "presence_status": "PRESENT" | "ABSENT" }`. A função confirma que
a usuária autenticada pertence ao grupo e que o encontro possui data e ainda está elegível
(`CREATED`, `SCHEDULED` futuro ou `IN_PROGRESS`) antes de registrar ou atualizar sua resposta.

---

## 🔄 Fluxo de mudança de schema

```bash
# 1. Cria o arquivo de migration
npx supabase migration new <descricao_curta>

# 2. Escreve o SQL no arquivo gerado em supabase/migrations/

# 3. Aplica em um banco limpo para validar que roda do zero
npx supabase db reset

# 4. Commita a migration e abre o PR
```

**Ao criar ou alterar tabela que guarda dados de participantes, revisar a política de RLS na mesma
migration.** O clube tem cerca de 900 participantes reais; tabela sem RLS é dado pessoal exposto.

Migrations são imutáveis depois de mergeadas. Para corrigir algo, criar uma nova migration — nunca
editar uma já aplicada.

---

## 🔐 Segredos

Nenhuma chave do Supabase é commitada. As credenciais ficam no **GitHub Secrets** do repositório e devem ser adicionadas manualmente no `.env` do app mobile.

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
