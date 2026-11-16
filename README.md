# Rotina — gestão diária de analistas

Ferramenta interna para o gestor acompanhar, atividade por atividade, o que cada analista fez, se fez no prazo e se fez direito. O ponto central é impedir o "marquei feito sem ter feito". Para isso existem perguntas-gate, campos de evidência obrigatórios e revisão por amostragem, e as três regras são garantidas no banco.

## Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Front | React 18 + TypeScript + Vite + Tailwind (tokens próprios) | Gera site estático, publicado no GitHub Pages como o hub. Tipado e rápido. |
| Dados | TanStack Query | Cache, revalidação e estados de carregamento sem código repetido. |
| Back | Supabase (Postgres + Auth + RLS) | Banco relacional, login criado pelo admin e controle de acesso **no banco**. Plano gratuito atende. |
| Regras | Funções SQL `security definer` | Gate, prazo, revisão e auditoria não dependem da interface. Uma chamada direta à API passa pelas mesmas regras. |
| Testes | Vitest (lógica pura) + pgTAP (banco) | Os testes do banco rodam sem Docker, num Postgres embutido (PGlite). |

## Direção visual

**Quadro de partidas.** O dia é uma lista de blocos em ordem, e cada bloco (ou marco) é numerado em uma **placa**, inspirada na sinalização de trânsito brasileira. É a marca do app, e o resto fica quieto. **Não há horários**: o prazo vale até o fim do dia de vencimento.

- **Paleta (claro):** concreto `#E8E9E4` (fundo), chapa `#F6F6F2` (superfície), asfalto `#1A1C1E` (tinta). O verde da marca `#0F7B3F` é **só preenchimento**: placa aberta, botão principal, seleção. Texto, gráficos e links usam a tinta.
- **Paleta (escuro):** fundo `#121315`, superfície `#1B1C1F`, tinta `#EDEDE8`, verde `#34C26B`.
- **Estados:** atraso `#B35A00`, bloqueio `#BE2A1F`, ok `#0E7A47`, sempre com ícone e texto, nunca só cor.
- **Placa numerada:** verde = em aberto, vermelha = prazo vencido, cinza = concluída ou bloqueada.
- **Tipografia:** Barlow, uma família em larguras diferentes. A Barlow Condensed vai nas placas, títulos e números; a Barlow, no texto. Números tabulares.
- **Estrutura:** menu lateral em asfalto com marcador verde, títulos de seção com linha grossa de tinta e tabelas com cabeçalho em frase.
- **Sem rótulos em caixa-alta, sem cartões iguais e sem gradientes.**
- **Ícones:** Lucide com traço de 1,75.
- **Movimento:** só para mudança de estado, em no máximo 140 ms. `prefers-reduced-motion` é respeitado.
- **Teclado:**
  - `g 0…9` navega entre telas, `j/k` percorre a lista e `Enter` abre o item.
  - `Ctrl+Enter` envia e `Ctrl+S` salva rascunho.
  - Na revisão, `v` valida e `c` contesta.
  - `?` lista todos os atalhos.

## Etapas, sequência e progresso

- **Etapas:** cada atividade tem etapas (as "instruções" do modelo). O analista marca **uma a uma, em ordem**: só a próxima pode ser marcada, e só a última marcada pode ser desmarcada. Cada marcação grava **data, horário e usuário** (`task_steps`) e entra na auditoria. Só o gestor vê o horário do registro, no painel da atividade, na Revisão e na Auditoria; o analista vê só a data.
- **Sequência:** as atividades marcadas como "sequenciais" formam blocos (diário) ou marcos (semanal e mensal) em ordem. Cada período tem a sua sequência: cada atividade só libera quando a anterior do mesmo dia, semana ou mês estiver concluída, mesmo que com atraso. Quem garante é o banco (`task_lock_reason`), não a tela.
- **Progresso (%):** `(etapas marcadas + 1 se o bloco foi enviado e aceito) ÷ (etapas + 1)`. Marcar todas as etapas dá `n ÷ (n+1)`; o bloco só chega a **100% depois do envio aceito**. O progresso do dia soma os pontos de todos os blocos.
- **Envio:** exige todas as etapas marcadas, os campos obrigatórios e as verificações (gates) satisfeitas.
- **Frequências:** o painel do analista tem as abas Diário (4 blocos), Semanal (1 marco: pedido de compras) e Mensal (3 marcos: importação, pesquisa de mercado e testes). O mensal abre no dia 1 e vence no último dia do mês.
- **Aprovação de testes:** no marco de testes do mês, cada referência leva a sua sugestão de teste. O gestor aprova ou reprova **cada referência de forma independente**, em *Aprovação de testes*. Aprovado: o analista vê "teste aprovado". Reprovado: vê o motivo e pode corrigir e reenviar só aquela referência.
- **Para o admin:** "Avanço de hoje" na visão geral mostra, por analista, o progresso de cada bloco e quem está bloqueado. As análises do check de produtos com giro aparecem em "Análises de produtos com giro".
- **Solicitar teste (opcional):** na tela Hoje e no menu Testes, o analista pede um teste para uma referência (o que testar, explicação, início e data final prevista). Vai para a aprovação do gestor em *Aprovação de testes*; reprovado volta com a justificativa e pode ser corrigido e reenviado (tabela `test_requests`).
- **Testes (menu do analista):** cada referência enviada para aprovação no marco mensal de testes, com motivo, início e data final prevista (preenchidos no envio), a decisão do gestor e se o teste ainda não começou, está em andamento ou já passou do prazo.
- **Links:** página com cards (nome, link e para que serve) das ferramentas usadas nas atividades. Todos veem; só o gestor cria, edita e remove (tabela `useful_links`, garantido por RLS).
- **Rotação de curvas:** segunda A, terça B, quarta C, quinta e sexta D (editável em Parâmetros).

## Modelo de dados

```
profiles ─┬─< task_instances >── activity_templates ──< template_assignments
          │        │  (template_snapshot: cópia do modelo no dia)
          │        ├─< task_steps (quem marcou e quando)
          │        ├─< task_submissions ──< gate_answers
          │        └─< reviews
settings (chave/valor) · holidays · audit_log (append-only)
v_task_facts (view, security_invoker) → base de TODAS as métricas
```

- **Snapshot por tarefa:** campos, gates e peso são copiados para a tarefa no dia em que ela é gerada. Editar um modelo não muda o passado.
- **Tentativas de envio:** cada envio fica em `task_submissions`, inclusive os barrados pelo gate. A taxa de bloqueio sai dali.
- **Métricas:** são calculadas em `src/lib/metrics.ts` a partir das linhas de `v_task_facts`. Não existe contador guardado, então qualquer número da tela pode ser refeito a partir dos dados brutos. Exporte "Tarefas" em CSV para conferir.

## Geração das tarefas

A função `generate_tasks(de, até)` cria as tarefas. Ela é **idempotente**: a tabela tem `unique (modelo, analista, período)` e a inserção usa `on conflict do nothing`.

**Regras de geração:**
- Só gera para modelo ativo, dentro da vigência e em dia útil (Parâmetros → expediente, menos os feriados).
- Só gera para analistas ativos e atribuídos ao modelo.
- Não cria tarefa cujo prazo já tinha passado quando o modelo ou o analista foi criado.

**Vencimento por frequência:**
- Diária: no próprio dia.
- Semanal: no último dia útil até o dia configurado.
- Mensal: no último dia útil do mês.

**Quando roda:**
- **pg_cron às 00:05 (São Paulo):** gera a semana corrente. A cada 15 min, marca as vencidas como "Não feita".
- **Ao abrir o app:** `refresh_tasks()` faz o mesmo. Se o job falhar, nada se perde.
- **Ao editar, pausar ou reatribuir um modelo, ou mudar feriado, expediente ou curva:** as tarefas futuras ainda intocadas são recriadas com a regra nova. As já iniciadas ficam como estão; se o modelo for pausado, viram "Pausada" e saem das métricas.

## Regras de negócio no banco

- **`submit_task`:**
  - Exige todas as verificações respondidas.
  - Se alguma resposta for diferente da esperada, a tarefa fica **Bloqueada pelo gate** e é obrigatório informar os SKUs em desvio e a ação tomada.
  - Com tudo certo, valida os campos obrigatórios (inclusive o mínimo de itens, como 2 produtos no D3) e grava **no prazo** ou **com atraso** comparando o horário de envio com o prazo.
- **`review_task`:**
  - Só admin executa. Contestar exige motivo.
  - A tarefa contestada volta para o analista. O reenvio mantém a pontualidade original, e a contestação continua contando na qualidade.
- **Escrita do analista:** o analista **não tem permissão de UPDATE/INSERT** em nenhuma tabela de tarefa. Toda escrita passa pelas funções acima.
- **Auditoria:** `audit_log` é preenchido por trigger e não aceita UPDATE, DELETE nem TRUNCATE, nem do dono da tabela.

## Setup

### 1. Banco (Supabase)

**Opção A, sem instalar nada:**
1. Abra **SQL Editor**, cole o conteúdo de `supabase/setup.sql` e rode. Em um banco **já criado antes das etapas**, rode só `supabase/atualizar_banco.sql` (atualizações 0007 a 0010, numa transação). Se você já rodou a versão anterior desse arquivo (0007 a 0009), rode só `supabase/migrations/20261113001000_user_admin_in_db.sql`.
2. Em **Database → Extensions**, ative `pg_cron` antes, se possível. Se você ativar depois, rode de novo só o trecho de `20261113000500_cron.sql`.

**Opção B, com a CLI:**

```bash
npx supabase login
npx supabase link --project-ref SEU_REF
npx supabase db push --remote   # CLI v3: sem --remote o alvo é o banco local
```

### 2. Autenticação

Em **Authentication**:
- **Sign In / Providers → Email:** deixe ativo e **desative "Allow new users to sign up"**. Só entra quem for convidado.
- **URL Configuration:**
  - Site URL: a URL publicada (ex.: `https://SEU-USUARIO.github.io/rotina/`).
  - Redirect URLs: `http://localhost:5173/**` e `https://SEU-USUARIO.github.io/rotina/**`.

### 3. Usuários e papéis

Não há Edge Function: logins e papéis são geridos direto no banco.

- **Papel:** coluna `public.profiles.role` (tipo `user_role`: `analista` ou `admin`). Dá para alterar em **Usuários e acessos** ou direto no **Table Editor → profiles → role**. O login (`auth.users`) acompanha sozinho.
- **Ativo:** `profiles.active = false` bloqueia o login sem apagar o histórico.
- **Criar login:** o gestor cria em **Usuários e acessos → Novo usuário**, com nome, e-mail, papel e senha inicial (`admin_create_user`). Também dá para criar em **Authentication → Users → Add user**: o usuário nasce como analista e o papel é trocado na tabela `profiles`.
- **Senha:** o gestor define uma nova senha pelo painel (`admin_set_password`). A pessoa também pode usar "Esqueci a senha".
- **Proteção:** o último gestor ativo não pode ser rebaixado nem desativado.

### 4. Variáveis de ambiente

Copie `.env.example` para `.env.local` e preencha com os valores de **Project Settings → API**:

```
VITE_SUPABASE_URL=https://SEU_REF.supabase.co
VITE_SUPABASE_ANON_KEY=...   # chave "anon public"
VITE_BASE=/                  # em GitHub Pages: /nome-do-repo/
```

### 5. Primeiro gestor

1. Em **Authentication → Users → Add user**, crie o usuário com e-mail e senha, marcando "Auto confirm".
2. No SQL Editor, promova esse usuário:

```sql
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}' where email = 'voce@empresa.com';
update public.profiles set role = 'admin' where email = 'voce@empresa.com';
```

Depois disso, o gestor cria os demais logins em **Usuários e acessos → Novo usuário**.

### 6. Remover os dados de demonstração

Se você rodou uma carga de exemplo (usuários `@demo.rotina`), crie o seu usuário em **Authentication → Users → Add user** (marque *Auto Confirm User*), coloque o e-mail dele no topo de `supabase/maintenance/remove_demo_data.sql` e rode o arquivo no SQL Editor. Ele:

- promove esse usuário a gestor;

- apaga os usuários de demonstração e tudo o que é deles (tarefas, etapas, envios, revisões, aprovações de teste e a auditoria ligada a eles);
- **não mexe** nos modelos de atividade, nos parâmetros nem nos usuários reais;
- **só roda se já existir um gestor real**, fora de `@demo.rotina`. Sem ele, para com erro e não apaga nada;
- é tudo ou nada: se algo falhar, nada é apagado.

O projeto não traz mais nenhum dado de exemplo. Os analistas reais são convidados em **Usuários e acessos** e recebem as tarefas automaticamente.

### 7. Rodar

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # regras em TypeScript (gate, prazo, eficiência, datas)
npm run test:db    # migrations + 54 testes pgTAP + teste da limpeza de demonstração, em Postgres embutido
npm run build      # gera dist/ (com 404.html para rotas no GitHub Pages)
```

## Migrations sem colar no SQL Editor

**Pelo computador (uma vez):**

```bash
npm run db:login            # abre o navegador para autorizar a CLI do Supabase
npm run db:link             # pede a senha do banco (Project Settings > Database)
npm run db:marcar-aplicadas # SÓ na primeira vez: avisa que as migrations atuais já foram coladas à mão
npm run db:status           # confere: tudo "applied" local e remoto
```

**Depois, a cada mudança:** `npm run db:push`. Roda os testes do banco e aplica só o que é novo.

**Automático pelo GitHub:** o workflow `.github/workflows/db-migrations.yml` faz o mesmo a cada push na `main` que mude `supabase/migrations/`. Em **Settings → Secrets and variables → Actions**, crie:

| Segredo | Onde achar |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens |
| `SUPABASE_DB_PASSWORD` | Project Settings → Database → senha do banco |
| `SUPABASE_PROJECT_ID` | Project Settings → General → Reference ID |

Regras: nunca edite uma migration já aplicada; crie um arquivo novo com número maior.

## Deploy

O workflow `.github/workflows/deploy.yml` publica no GitHub Pages a cada push na `main`.

1. Em **Settings → Pages**, escolha *Source: GitHub Actions*.
2. Em **Settings → Secrets → Actions**, crie `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
3. Inclua a URL do Pages em Redirect URLs no Supabase.

A anon key é pública por natureza. Quem protege os dados é o RLS.

## Estrutura

```
supabase/migrations/   esquema, regras, auditoria, modelos iniciais, cron
supabase/maintenance/  remove_demo_data.sql (limpeza dos dados de demonstração)
supabase/tests/        pgTAP
scripts/db-test.mjs    roda tudo em PGlite
src/lib/               regras puras (status, campos, métricas, datas) + testes
src/features/          formulário de atividade, grade semanal, métricas e gráficos
src/pages/analyst/     Hoje, Minha semana, Histórico, Desempenho
src/pages/admin/       Visão geral, Equipe, Revisão, Modelos, Usuários, Parâmetros, Auditoria, Exportar
src/adapters/          interface para integrações futuras (hub), sem uso na v1
```
