# AGENTS.md — Backend

Instruções para agentes de IA (Claude Code, Copilot, Cursor) e para o revisor automático
(CodeRabbit). É a fonte única das regras do repositório: o `CLAUDE.md` e o
`.github/copilot-instructions.md` só apontam para cá. O `README.md` continua sendo o guia de setup
para pessoas.

Quem revisa um PR usa as seções **Regras** e **Checklist de review** como critério. Uma regra
quebrada é achado de review, mesmo que o código "funcione".

Parte do código antigo não segue estas regras (functions sem checagem de método, erro de banco
como 400, `error.message` cru na resposta, function sem `deno.json`). **Não copie a function
vizinha sem conferir:** as referências atuais são `set-profile-photo` e `add-meeting-photo`. As
regras valem para o código novo ou alterado no PR; quem revisa não exige refactor de código que o
PR não tocou.

## O que é este repositório

Backend do Clube de Leitura D'Elas sobre **Supabase**. Não há servidor próprio: o que se versiona
aqui é o banco e as Edge Functions consumidas pelo app [`mobile`](https://github.com/Clube-de-Leitura-D-elas/mobile)
e pelo painel [`web`](https://github.com/Clube-de-Leitura-D-elas/web).

| Caminho | Conteúdo |
|---|---|
| `supabase/migrations/` | Migrations SQL, uma por mudança de schema |
| `supabase/functions/<nome>/index.ts` | Edge Functions em TypeScript (Deno) |
| `supabase/functions/_shared/` | Helpers compartilhados entre as functions |
| `supabase/config.toml` | Configuração do projeto e registro das functions |
| `supabase/seed.sql` | Dados de exemplo para desenvolvimento local |

O clube tem cerca de 900 participantes reais. Tabela, bucket ou resposta que expõe dado de
participante é incidente, não detalhe.

**Merge em `develop` é deploy em produção.** O workflow `supabase-deploy.yml` roda
`supabase db push --include-all` e `supabase functions deploy` a cada push em `develop`. Migration
quebrada ou contrato de function mudado chega às usuárias no mesmo minuto, e o `--include-all`
aplica até migration com timestamp mais antigo que a última aplicada.

## Comandos

```bash
npm install
npx supabase start                 # Postgres, Auth, Storage e Studio locais
npx supabase db reset              # aplica todas as migrations e o seed do zero
npx supabase functions serve --env-file supabase/functions/.env.local
npx supabase migration new <descricao_curta>
deno fmt <arquivos alterados>      # formatação (requer o Deno instalado)
```

O repositório não tem suíte de testes nem CI de PR, então os itens do template sobre testes e
pipeline não se aplicam aqui. A validação é o `db reset` sem erro e o roteiro de **Como testar** do
PR, com `curl` reproduzível. Rode o `deno fmt` só nos arquivos que você mudou: o código antigo
não está formatado e o diretório inteiro geraria um diff enorme.

## Regras

### Migrations

- Nenhuma mudança de schema pelo dashboard. Toda mudança entra como migration criada com
  `npx supabase migration new` e passa por PR.
- Migration mergeada é imutável. Para corrigir, crie outra.
- A migration precisa rodar do zero: `npx supabase db reset` termina sem erro, inclusive o seed.
  Se o schema mudou, atualize o `seed.sql` no mesmo PR.
- Comece a migration com um comentário em pt-BR explicando o porquê da mudança e qualquer decisão
  não óbvia (o que acontece com dados existentes, por que algo é nullable etc.).
- **Tabela nova:** `GRANT` explícito só para `service_role` (o projeto foi criado com a exposição
  automática desligada; veja `20261006130000_grant_data_api_access.sql`) e
  `ENABLE ROW LEVEL SECURITY`. Acesso de `anon`/`authenticated` só com justificativa no PR; hoje
  apenas `cities`, `zones` e `users` têm leitura para `authenticated`.
- **Coluna `NOT NULL` em tabela com dados:** adicione nullable, faça o backfill e só então aplique
  o `NOT NULL`.
- **`UNIQUE` em tabela com dados:** remova as duplicatas antes, deixando explícito qual linha fica
  e por quê. Se alguma combinação de duplicatas não for removida pela limpeza, a migration aborta
  em produção: inclua no PR a consulta que confirma que isso não acontece.
- **Dado denormalizado** (a mesma informação em duas colunas, como `group_id` e
  `group_user_id → group_users.group_id`) precisa de garantia no banco de que as duas batem, por
  exemplo uma FK composta. Sem isso, uma function futura grava valores divergentes.
- Escolha o `ON DELETE` de cada FK de propósito (`CASCADE` para dado que só existe junto do pai).

### Edge Functions

- **Function nova:** pasta `supabase/functions/<nome>/` com `index.ts` e `deno.json`, e entrada
  `[functions.<nome>]` no `config.toml` com `enabled = true`, `verify_jwt = true` e `import_map`.
  Functions usadas só pelo painel web terminam em `-web`.
- Use `withSupabase<Database>({ auth: "user" }, ...)`. Algumas functions antigas são chamadas por
  trigger, link de e-mail ou serviço externo e não usam autenticação de usuário
  (`approve-user`, `approve-pending-user`, `send-user-to-approval`, `claim-user-profile`,
  `email-confirmed`, `process-google-form`). Cada uma se autentica de um jeito diferente, e nem
  todas de forma suficiente: não as use como modelo. Function nova sem `auth: "user"` precisa
  explicar no PR como garante quem pode chamá-la, e quem revisa confere isso no código.
- Siga esta ordem: método HTTP (405) → leitura e validação da entrada (400) → autorização
  (401/403) → existência do recurso (404) → trabalho.
- Valide entrada com os helpers de `_shared/` (`isUuid`, `readGroupIdParam`, `readMeetingIdParam`,
  `readParticipantIdParam`, `parseListParams` etc.) e autorize com os de lá também (`requireRole`,
  `requireFounder`, `requireGroupMemberProfile`, `requireMeetingRecordManager`). Procure em
  `_shared/` antes de escrever um helper novo.
- **Erro de banco ou de storage responde 500, não 400.** Logue com
  `console.error("<nome-da-function> <etapa>", oneLine(error.message))` e devolva ao cliente uma
  mensagem genérica, sem a mensagem crua do Postgres (nomes de tabela e constraint vazam).
- **Escrita em mais de uma etapa** (storage + tabela, duas tabelas) não tem transação: desfaça as
  etapas anteriores quando uma falhar, ou leve a operação para uma função SQL chamada por RPC.
- **Regra de negócio validada só no cliente não é regra.** Se o fluxo tem etapa de confirmação
  (ex.: `draw-meeting-raffle` → `confirm-meeting-raffle-winner`), a mesma validação roda nas duas
  functions, porque o cliente pode chamar a confirmação direto.
- Código novo precisa ser chamado. Função exportada em `_shared/` sem nenhum chamador é achado de
  review, principalmente quando é ela que implementa o que o PR promete.
- Datas e "hoje" sempre em `America/Sao_Paulo`, pelos helpers de `_shared/date.ts`, sem redefinir
  o fuso na function.

### Fotos e storage

- Os buckets são privados. `photos.url` guarda o **path** do objeto, não uma URL.
- Nenhuma resposta devolve o path cru: assine com `resolveProfilePhotoUrls`
  (`_shared/profilePhoto.ts`) ou `signMeetingPhotos` (`_shared/meetingPhoto.ts`). URLs absolutas
  (seed) passam direto.
- Ao adicionar um novo jeito de gravar foto, confira todas as functions que leem aquele campo
  (`grep -rn "photos(url)" supabase/functions`) e garanta que elas assinam o path.
- `toPublicUrl` (`_shared/signedUrl.ts`) troca o host interno `kong:8000` do runtime local pela
  origem da requisição. Não remova esse rewrite.

### Estilo

- `deno fmt` nos arquivos alterados: indentação de 2 espaços, aspas duplas, newline no fim do
  arquivo.
- Comentários em pt-BR e só quando essenciais: o porquê que o código não mostra ou a armadilha que
  quebra em silêncio. O que mudou e por quê vai na descrição do PR.
- Identificadores e mensagens de erro da API em inglês, como no código existente.

## Checklist de review

Além das regras acima, quem revisa confere:

1. O PR faz o que a descrição promete? O código novo é de fato chamado pelo fluxo?
2. Toda leitura nova de `photos.url` assina o path?
3. Os status HTTP seguem 400/401/403/404/405/500 como acima, sem `error.message` cru no corpo?
4. Escritas em várias etapas desfazem o que já foi feito quando uma etapa falha?
5. A migration roda do zero, tem `GRANT` + RLS nas tabelas novas e trata os dados existentes?
   Lembre que o merge aplica a migration em produção na hora.
6. Mudou nome ou contrato de function? O PR avisa o que precisa mudar no `mobile` e no `web`.
7. O roteiro de **Como testar** permite reproduzir o caminho feliz e os erros.

## Branches, commits e PR

- Branch base `develop`, que faz deploy em produção a cada merge. `main` fica para as versões
  apresentadas aos stakeholders.
- Branch: `<type>/CLU-<numero>-<descricao-curta>` (o Linear vincula branch, PR e issue).
- Commits em [Conventional Commits](https://www.conventionalcommits.org/), em inglês e no
  imperativo: `feat(group): add reading group table with RLS policies`. Types: `feat`, `fix`,
  `refactor`, `test`, `chore`, `docs`, `ci`.
- PR com o template do repositório preenchido: issue `CLU-<n>`, o que foi feito, por quê e como
  testar.
