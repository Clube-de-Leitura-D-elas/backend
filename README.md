# Clube de Leitura D'Elas — Backend

Banco de dados e regras de acesso da plataforma do Clube de Leitura D'Elas.

Consumido pelo app [`mobile`](https://github.com/Clube-de-Leitura-D-elas/mobile) e pelo painel [`web`](https://github.com/Clube-de-Leitura-D-elas/web).

> Regras de código e de review (para pessoas, agentes de IA e o CodeRabbit): [`AGENTS.md`](AGENTS.md).

---

## 🧱 O que vive aqui

O backend do projeto é **Supabase**, usado como backend-as-a-service — não há um servidor de
aplicação próprio. O que este repositório versiona é tudo aquilo que define o banco e as funções de negócio:

| Caminho | Conteúdo |
|---|---|
| `supabase/migrations/` | Migrations SQL, uma por mudança de schema |
| `supabase/functions/` | Edge Functions em TypeScript (Deno runtime) |
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

## ⚡ Executando as Edge Functions localmente

Com o Supabase local rodando (`npx supabase start` + `npx supabase db reset`, que também aplica o
`seed.sql`):

### Variáveis de ambiente das Edge Functions

Algumas funções dependem de chaves externas para funcionar localmente. Crie o arquivo
`supabase/functions/.env.local` (já está no `.gitignore`) e adicione as variáveis necessárias:

```env
GOOGLE_PLACES_API_KEY=<sua chave da Google Places API>
GOOGLE_BOOKS_API_KEY=<sua chave da Google Books API>

# E-mail do fluxo de aprovação. Em desenvolvimento, `mailpit` entrega no
# Mailpit do próprio `supabase start` — não precisa de chave.
EMAIL_DRIVER=mailpit
EMAIL_FROM=nao-responda@clubedeleitura.local
# Em produção o driver é `resend` (default) e exige:
# RESEND_API_KEY=<sua chave da Resend>
# EMAIL_FROM=<remetente verificado na Resend>
```

> A `GOOGLE_PLACES_API_KEY` é usada pelas funções `search-places` e `update-meeting` para
> buscar e resolver endereços via Google Places API. Sem ela, essas funções retornam erro 500
> (`place search is not configured`). As demais funções continuam funcionando normalmente.
>
> A `GOOGLE_BOOKS_API_KEY` é usada pelo helper `_shared/googleBooks.ts` (busca e cadastro de
> livros a partir do Google Books). **Ela é obrigatória**: sem chave, o Google atribui a chamada a
> um projeto anônimo com cota zero, e a busca devolve o erro tratado `quota_exceeded`.
>
> Para desenvolver, crie uma chave própria (gratuita, não exige faturamento):
> 1. No [Google Cloud Console](https://console.cloud.google.com/), crie ou selecione um projeto.
> 2. Em **APIs e serviços → Biblioteca**, ative a **Books API**.
> 3. Em **Credenciais → Criar credenciais → Chave de API**, restrinja a chave à **Books API**.
> 4. Coloque a chave no `supabase/functions/.env.local`. Nunca commite a chave.
>
> O envio de e-mail passa por `_shared/email.ts`, que escolhe o canal por `EMAIL_DRIVER`:
>
> - `resend` (default, produção): exige `RESEND_API_KEY` e `EMAIL_FROM`, com remetente verificado
>   na [Resend](https://resend.com).
> - `mailpit` (desenvolvimento): entrega no **Mailpit que o `supabase start` já sobe**, sem chave.
>   A mensagem aparece em `http://127.0.0.1:54324`, junto dos e-mails do Auth — é onde se lê o
>   código de ativação. O hostname usado é interno do stack (`supabase_inbucket_backend:8025`),
>   porque as functions rodam em container; para apontar para outro lugar, use `MAILPIT_URL`.
>
> A aprovação é **tudo-ou-nada**: se o canal falhar (chave inválida, Mailpit fora do ar), o envio
> falha, a aprovação é desfeita e a rota responde 500 — a solicitação continua pendente no painel.
> Ou seja: em dev, sem `EMAIL_DRIVER=mailpit` e sem chave do Resend, não se aprova.

```bash
# Sobe as edge functions com as variáveis de ambiente locais
npx supabase functions serve --env-file supabase/functions/.env.local
```

> **Dica:** Para desativar a verificação de token durante testes manuais de desenvolvimento, você pode adicionar a flag `--no-verify-jwt`.

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

## 🔔 Como criar um novo aviso

Todo aviso é gravado pela função SQL `public.create_notification`, que cria a notificação e uma
linha por destinatária em `notifications_targets` na mesma transação. O app lê pela
`get-my-notifications` e marca como lido pela `mark-notification-read`; nenhuma das duas muda para
um aviso novo.

1. **Escolha o `type`** em `notification_type`. Se nenhum servir, adicione o valor numa migration
   no mesmo PR do fluxo que grava o aviso
   (`ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS '<NOVO_TIPO>';`): valor de enum não
   sai mais do banco depois do deploy. O Postgres não deixa usar o valor novo na mesma migration em
   que ele foi criado: grave avisos com ele em outra migration ou só a partir das functions. Avise
   no PR que o `mobile` precisa mapear o tipo; até lá, o app mostra o aviso com o ícone genérico.
2. **Monte a `dedup_key`** no formato `<TYPE>:<id do evento>[:<marco>]`, por exemplo
   `DRAW_RESULT:<meeting_raffle_id>` ou `MEETING_REMINDER:<meeting_id>:1d`. Com a mesma chave, uma
   segunda chamada não cria outro aviso e devolve o id do primeiro, mesmo que a nova lista de
   destinatárias venha vazia, então o evento ou o job pode rodar de novo sem duplicar. Título,
   mensagem e destinatárias não mudam. Se a segunda chamada informa `p_scheduled_for` e o aviso
   ainda não apareceu, passa a valer a nova data (útil para encontro remarcado); sem
   `p_scheduled_for`, a data existente fica. Deixe a chave `NULL` só quando repetir o aviso for o
   comportamento desejado.
3. **Decida as destinatárias** e passe os ids de `public.users` (não de `auth.users`). Para avisos
   de grupo, filtre como o resto do código: `group_users.registration_status = 'ACTIVE'` e
   `users.is_active`. Ids repetidos e `NULL` são ignorados. Ids que não existem em `public.users`
   são descartados com um `WARNING` no log do Postgres, sem desfazer o evento; sem nenhuma
   destinatária válida, nada é criado e a função devolve `NULL`.
4. **Chame `create_notification` no ponto do evento.** Se o evento já é uma função SQL, chame lá
   dentro, para o aviso existir só se o evento for gravado:

   ```sql
   PERFORM public.create_notification(
     'DRAW_RESULT',
     'Resultado do sorteio',
     'Saiu o resultado do sorteio do próximo encontro.',
     ARRAY(
       SELECT gu.user_id
       FROM public.group_users gu
       JOIN public.users u ON u.id = gu.user_id
       WHERE gu.group_id = v_group_id
         AND gu.registration_status = 'ACTIVE'
         AND u.is_active
     ),
     p_meeting_id => v_meeting_id,
     p_dedup_key => 'DRAW_RESULT:' || v_raffle_id
   );
   ```

   Numa edge function, chame por RPC com o client de service role:

   ```ts
   const { error } = await ctx.supabaseAdmin.rpc("create_notification", {
     p_type: "MEETING_REMINDER",
     p_title: "Encontro amanhã",
     p_message: "Seu encontro é amanhã.",
     p_user_ids: recipientIds,
     p_meeting_id: meetingId,
     p_scheduled_for: reminderAt,
     p_dedup_key: `MEETING_REMINDER:${meetingId}:1d`,
   });
   ```

   Sem `p_scheduled_for`, o aviso novo aparece na hora. Para lembretes, um agendador pode chamar a
   função antes com `p_scheduled_for` no futuro: o aviso só aparece (e só conta no `unread_count`)
   quando essa data chega. Como uma nova chamada com a mesma chave atualiza só a data, não escreva a
   data do encontro em `title` nem `message`.

A função só pode ser executada pela service role. `title` e `message` são o texto que a leitora vê,
em pt-BR. Com `p_meeting_id`, o grupo vem do encontro e não precisa ser passado. No banco, uma FK
composta e um `CHECK` em `notifications_targets` garantem que todo alvo com encontro tem o grupo
desse encontro.

Referência: CLU-296, que criou esta base (`create_notification`, `dedup_key` e `unread_count`).
Exemplo completo de um aviso por evento: CLU-299 (`DRAW_RESULT`), que chama `create_notification`
dentro da `record_meeting_raffle`, na mesma transação do sorteio
(`supabase/migrations/20261109213455_notify_draw_result.sql`). Copie esse caminho para avisos novos.

### Lembretes agendados

Lembretes que dependem de tempo ("encontro amanhã", "ainda sem local") rodam pelo job
`run-scheduled-notifications` do pg_cron, todo dia às 09:00 de São Paulo (`0 12 * * *` em UTC). O
job chama `public.run_scheduled_notifications()`, que executa cada passo registrado em
`public.scheduled_notification_steps`, em ordem alfabética.

Para adicionar um lembrete, na migration da story:

1. Crie uma função SQL sem argumentos, por exemplo `public.notify_meeting_reminders()`, que
   decide quem recebe e chama `create_notification` com `dedup_key`. Ela roda todo dia: a chave é o
   que impede o aviso de duplicar quando o job roda de novo.
2. Registre o passo:

   ```sql
   INSERT INTO public.scheduled_notification_steps (function_name)
   VALUES ('notify_meeting_reminders');
   ```

Não recrie `run_scheduled_notifications` para adicionar a chamada: duas stories em paralelo
apagariam o passo uma da outra. Cada passo roda isolado: se falhar, o que ele gravou é desfeito, a
falha é gravada em `public.scheduled_notification_failures` (e no log do Postgres como
`WARNING run_scheduled_notifications <passo>: ...`) e os outros passos rodam normalmente.

Para rodar o job na mão (SQL Editor do Studio ou `psql`):

```sql
SELECT public.run_scheduled_notifications();
```

Para conferir o agendamento e as últimas execuções:

```sql
SELECT jobid, jobname, schedule, active FROM cron.job;

SELECT status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'run-scheduled-notifications')
ORDER BY start_time DESC
LIMIT 10;
```

Um passo que falhou não muda o `status` da execução, que continua `succeeded`. Para ver as falhas
dos passos:

```sql
SELECT function_name, sqlstate, message, failed_at
FROM public.scheduled_notification_failures
WHERE failed_at > now() - interval '7 days'
ORDER BY failed_at DESC;
```

O job tem limite de 5 minutos (`statement_timeout` no comando do cron). Se a execução inteira passar
disso, ela é cancelada, aparece como `failed` e nada do que os passos gravaram fica; no dia
seguinte eles rodam de novo. Nomes em `scheduled_notification_steps` são só o nome da função, sem
schema (`notify_meeting_reminders`, não `public.notify_meeting_reminders`).

### Push (FCM)

Toda notificação criada por `create_notification` também vira push no celular da leitora (CLU-300).
O caminho é:

1. Um gatilho em `notifications_targets` (`notifications_targets_push`, por instrução) junta os
   alvos cuja notificação já é devida (`scheduled_for <= now()`) e chama a edge function
   `send-push` por `pg_net`, com a chave secreta do projeto no header `apikey`.
2. A `send-push` busca os tokens da leitora em `user_devices` e envia pela API HTTP v1 do FCM
   (`_shared/fcm.ts`). Token que o FCM devolve como inexistente (`UNREGISTERED`) é apagado de
   `user_devices`. Qualquer falha de envio só gera log: a notificação in-app já está gravada.
3. Avisos agendados para o futuro saem pelo passo diário `send_pending_pushes`, registrado em
   `scheduled_notification_steps`, que roda no job das 09:00 de São Paulo.

Limites que valem conhecer:

- Um aviso agendado para as 15h aparece no app às 15h, mas o push só sai no dia seguinte às 09:00.
  Avisos criados já devidos saem na hora.
- `notifications_targets.push_sent_at` marca o envio **enfileirado** no `pg_net`, não entregue.
  Se o gatilho não conseguir enfileirar (secret ausente), o passo diário tenta de novo; avisos
  devidos há mais de 2 dias são descartados do push.
- Erro temporário do FCM (`UNAVAILABLE`, `QUOTA_EXCEEDED`, `INTERNAL`) é só logado, não há nova
  tentativa: aquele push se perde, a notificação in-app continua.
- `register-device` e `unregister-device` são as functions que o app chama (auth de leitora). A
  `send-push` só aceita a chave secreta do projeto (`auth: "secret"`); leitora, chave `anon` e
  chamada sem credencial recebem 401.

#### Configurar a credencial do Firebase

1. No [console do Firebase](https://console.firebase.google.com/), abra o projeto do app, vá em
   **Configurações do projeto → Contas de serviço** e clique em **Gerar nova chave privada**. O
   arquivo `.json` baixado é a credencial e só pode ser baixado uma vez. Nunca o commite.
2. Cadastre o **conteúdo inteiro** do JSON como o secret `FIREBASE_SERVICE_ACCOUNT` das edge
   functions. O caminho mais simples é o Dashboard do Supabase (**Edge Functions → Secrets**), colando
   o JSON no valor. Pela CLI é `npx supabase secrets set FIREBASE_SERVICE_ACCOUNT=...`, mas o JSON
   tem aspas e quebras de linha e o quoting muda de shell para shell.
3. Cadastre os dois secrets do Vault usados pelo gatilho (SQL Editor do Studio ou `psql`):

   ```sql
   SELECT vault.create_secret('https://<projeto>.supabase.co/functions/v1', 'edge_base_url');
   SELECT vault.create_secret('<chave secreta sb_secret_...>', 'edge_api_key');
   ```

   Sem eles nenhum push sai, e o gatilho só registra um `WARNING` no log do Postgres. A
   `edge_api_key` precisa ser a chave `sb_secret_...`: o JWT antigo de `service_role` não é aceito
   pela `send-push`. Para ver se já existem, sem mostrar o valor:
   `SELECT name FROM vault.decrypted_secrets WHERE name IN ('edge_base_url', 'edge_api_key');`

#### Testar localmente

1. Coloque a credencial no `supabase/functions/.env.local` (fora do commit), numa linha só e entre
   aspas simples: `FIREBASE_SERVICE_ACCOUNT='{"type":"service_account", ...}'`. Sem ela a
   `send-push` loga `FIREBASE_SERVICE_ACCOUNT missing or invalid` e não envia nada.
2. Suba as functions com `npx supabase functions serve --env-file supabase/functions/.env.local`.
3. Cadastre os secrets do Vault local. Dentro do Docker, as functions respondem em
   `http://kong:8000/functions/v1`, e a chave é a `SECRET_KEY` de `npx supabase status -o env`:

   ```sql
   SELECT vault.create_secret('http://kong:8000/functions/v1', 'edge_base_url');
   SELECT vault.create_secret('<SECRET_KEY local>', 'edge_api_key');
   ```

4. Registre um aparelho e crie uma notificação (o token abaixo é de mentira; com um token real do
   app, o push chega no celular):

   ```sql
   INSERT INTO public.user_devices (user_id, fcm_token, platform)
   VALUES ('<users.id da leitora>', '<token do FCM>', 'ANDROID');

   SELECT public.create_notification(
     'DRAW_RESULT'::public.notification_type, 'Título', 'Mensagem',
     ARRAY['<users.id da leitora>'::uuid]
   );
   ```

5. Veja o que a `send-push` respondeu (o log dela aparece no terminal do `functions serve`):

   ```sql
   SELECT status_code, content FROM net._http_response ORDER BY id DESC LIMIT 5;
   ```

---

## 🔐 Segredos

Nenhuma chave do Supabase é commitada. As credenciais ficam no **GitHub Secrets** do repositório e devem ser adicionadas manualmente no `.env` do app mobile.

| Variável | Onde configurar (remoto) | Onde configurar (local) |
|---|---|---|
| Credenciais Supabase | GitHub Secrets | `.env` do app mobile |
| `GOOGLE_PLACES_API_KEY` | `npx supabase secrets set GOOGLE_PLACES_API_KEY=...` | `supabase/functions/.env.local` |
| `GOOGLE_BOOKS_API_KEY` | `npx supabase secrets set GOOGLE_BOOKS_API_KEY=...` | `supabase/functions/.env.local` |
| `RESEND_API_KEY` | `npx supabase secrets set RESEND_API_KEY=...` | `supabase/functions/.env.local` |
| `EMAIL_FROM` | `npx supabase secrets set EMAIL_FROM=...` | `supabase/functions/.env.local` |
| `FIREBASE_SERVICE_ACCOUNT` | Dashboard (Edge Functions → Secrets) ou `npx supabase secrets set` | `supabase/functions/.env.local` |
| `edge_base_url` e `edge_api_key` | `vault.create_secret(...)`, ver [Push (FCM)](#push-fcm) | `vault.create_secret(...)` no banco local |

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
