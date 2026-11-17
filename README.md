# ClauGPT MCP

![ClauGPT MCP](instalador/logo.png)

Servidor MCP (pasta e pacote `mcp-chatgpt`) que liga o Claude ao ChatGPT usando a **sua conta do ChatGPT** (Plus/Pro/Team), sem chave de API, e dá ao Claude ferramentas de design.

| Ferramenta | Para quê |
|---|---|
| `gerar_imagem` | O GPT gera fotos, cenas, objetos e ícones 3D, ilustrações |
| `remover_fundo` | Recorte com IA no seu computador |
| `renderizar_arte` | O Claude monta a peça em HTML/CSS (texto exato, fontes, logo real) e vira PNG no tamanho certo |
| `kit_de_marca` / `salvar_marca` | Logo, cores, fontes, tom e referências de cada marca |
| `ver_imagem` | Mostra ao Claude uma imagem salva no computador |
| `entregar_artes` | Mostra as artes finais na conversa em tamanho real, com o link do arquivo e do editável |
| `perguntar_chatgpt` | Segunda opinião do ChatGPT |
| `aguardar_resultado` | Pega o resultado de um trabalho que passou do tempo do chat |
| `diagnostico` | Confere Codex, login, modelo de recorte, navegador e pastas, e diz o que fazer |

## Como o Claude cria uma peça (post, story, anúncio)

O servidor manda ao Claude, ao conectar, um fluxo de diretor de arte. O caminho principal é o **Claude Design**:

1. **Marca:** lê o kit (`kit_de_marca`). Se a marca não existe, cria (`salvar_marca`) e pede para você colocar o logo e as referências na pasta.
2. **GPT só onde precisa:** foto, cena, comida, produto, objeto ou ícone 3D, sempre **sem texto e sem logo**. Objetos que vão por cima do layout vêm sem fundo.
3. **Recorte** do que precisar ficar sobre outro fundo.
4. **Montagem no Claude Design:** o Claude cria uma tela de design, envia para ela as imagens do GPT, o logo real e as fontes da marca, e faz uma prancheta por formato (post 1080×1350, story 1080×1920...) com o texto exato como texto de verdade.
5. **Entrega:** o link da tela. Você clica nos textos para editar, mexe em cores e posições e exporta pela própria tela.

**Quando não usa o Design**, o Claude monta com `renderizar_arte` (HTML → PNG salvo no computador, em 1 a 2 segundos, sem gastar o ChatGPT) e diz por quê. Isso acontece quando:
- o tipo Design não está disponível na conversa;
- não dá para enviar as imagens para a tela (no chat comum, a pasta Imagens precisa estar liberada na conversa);
- você pede os PNGs no computador ou um lote rápido.

Depois de aprovar no Design, dá para pedir também os PNGs no computador.

Peças que são só uma imagem (uma foto, uma ilustração, um ícone) vão direto para o GPT.

### Uma peça em vários formatos

No Design, cada formato vira uma prancheta da mesma tela. Pelo `renderizar_arte`, o Claude monta um HTML só e chama a ferramenta com `formatos: ["post_instagram", "story"]`: sai `<nome>-post_instagram.png`, `<nome>-story.png` (cada um com o seu editável). O `<html>` de cada formato recebe `data-formato="story"` etc., então o Claude reposiciona os elementos de cada um com regras como `[data-formato="story"] .titulo { ... }`.

### Editar textos depois (caminho `renderizar_arte`)

Junto com cada arte montada, o `renderizar_arte` salva:

| Arquivo | Para quê |
|---|---|
| `<nome>.png` | A arte final |
| `<nome>-editavel.html` | Abra no navegador, clique num texto, edite e aperte **Baixar PNG**. Funciona sozinho: imagens e fontes vão embutidas, até sem internet, e dá para mandar para outra pessoa. |
| `<nome>.html` | O código da arte, para o Claude ajustar depois |

### Kit de marca

Cada marca tem uma pasta em `Imagens\Marcas\<Marca>`:

| Pasta / arquivo | O que colocar |
|---|---|
| `logos\` | Logo em PNG sem fundo ou SVG (pode ter versões: clara, escura) |
| `fontes\` | Arquivos .ttf/.otf da marca, se ela tiver fonte própria |
| `referencias\` | Artes que mostram o estilo da marca |
| `marca.json` | Cores, fontes, tom de voz e regras (o Claude preenche com `salvar_marca`) |

No **chat comum**, imagens coladas não chegam ao servidor como arquivo: salve o logo e as referências nessas pastas uma vez, e o Claude passa a usá-las sempre. Na **aba Code**, imagens coladas já chegam com caminho.

`renderizar_arte` usa o Chrome ou o Edge do computador para montar a arte (o instalador avisa se não houver nenhum).

**Trabalhos demorados:** o chat comum do Claude Desktop desiste de uma ferramenta depois de 60 s, e uma imagem leva de 30 a 90 s. Por isso, se o trabalho passar de 45 s, a ferramenta responde *"Ainda trabalhando"* com um id e continua no computador; o Claude busca o resultado com `aguardar_resultado`, sem gerar de novo. Na aba Code a espera vai até 9 minutos. O tempo é a variável `CHATGPT_ESPERA_MAX_MS`, que o instalador define para cada um.

Esses trabalhos ficam também em `%USERPROFILE%\.mcp-chatgpt\tarefas` (por 2 horas). Assim outra janela do Claude, ou o Claude depois de reabrir o servidor, ainda busca o resultado. Quando o Claude fecha o servidor, o Codex que estava rodando é encerrado junto (com a árvore de processos inteira), para não ficar gastando o limite do ChatGPT escondido.

Por baixo ele usa o [Codex CLI](https://github.com/openai/codex), a ferramenta oficial da OpenAI que faz login com a conta do ChatGPT. Roda em modo somente leitura: o ChatGPT só responde e gera imagens, não mexe nos seus arquivos.

## Instalar num PC (um clique)

**Página de instalação:** https://claude.ai/artifact/KRWjyrpFuYWf3EyW2vnW1P

1. Abra o link no PC novo, logado na sua conta do Claude, e clique em **Baixar**.
2. Abra o zip e clique duas vezes em **`Instalar-ClauGPT-MCP.exe`**. Se o Windows avisar, clique em *Mais informações → Executar assim mesmo*.
3. Clique em **Instalar**. Abre uma janela preta que faz cada etapa.
4. Na etapa do login, o site da OpenAI abre sozinho e o código já fica copiado: cole com **Ctrl+V** e clique em Continuar.
5. No fim, aperte **Enter** na janela preta para reiniciar o Claude e clique em **Concluir**.

O `.exe` instala em `%LOCALAPPDATA%\mcp-chatgpt` (sem pedir administrador; só o Node.js, se faltar, pode pedir), guarda o registro em `instalacao.log` nessa pasta e aparece em *Configurações → Aplicativos* como **ClauGPT MCP**, de onde dá para desinstalar. A desinstalação tira o servidor das configurações do Claude e apaga a pasta; imagens, kits de marca e o login do ChatGPT ficam.

Se o antivírus barrar o `.exe`, a página também oferece o `Instalar-ClauGPT-MCP.cmd`, que faz a mesma instalação a partir de um arquivo de texto único.

### Gerar uma versão nova dos instaladores

Depois de mudar o código, aumente `version` no `package.json` e rode:

```bash
node empacotar.mjs
```

Precisa do NSIS 3 (`makensis`) no PATH e de `zip` (no Windows, usa o `tar` que já vem com ele). Gera em `saida\`: o `.exe`, o `.cmd` e um `.zip` de cada um para a página. Depois peça ao Claude para republicar a página no mesmo link. As imagens do instalador (ícone, painel com a logo, cabeçalho) saem de `instalador\logo.png` pelo `instalador\arte.py` (`python3 arte.py`, com Pillow); as telas estão em `instalador\instalador.nsi`.

O instalador faz, pulando o que já estiver pronto:

| Passo | O quê |
|---|---|
| 1 | Instala o Node.js (pelo winget; pode pedir permissão de administrador) |
| 2 | Instala o Codex CLI na versão testada (`$versaoCodex` no `instalar.ps1`); um Codex que já está no PC fica como está |
| 3 | Instala as bibliotecas e compila o servidor |
| 4 | Baixa o modelo de recorte de fundo (171 MB) e apaga o antigo, se houver |
| 5 | Registra o servidor no Claude daquele PC, na aba Code e no chat comum (`registrar.cjs`, com backup de cada configuração) |
| 6 | Faz o login na conta do ChatGPT (`codex login --device-auth`) |
| 7 | Testa de verdade: abre o servidor como o Claude abre e faz uma pergunta ao ChatGPT (`testar.mjs`) |

Pode rodar de novo quando quiser: depois de mover a pasta, para atualizar, ou se algo der errado.

**Antes do primeiro login por código**, a opção *login com código de dispositivo* precisa estar ativa em chatgpt.com → Configurações → Segurança. Ela vale para a conta, então basta ativar uma vez.

## Instalação manual

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g @openai/codex@0.166.0
codex login --device-auth
npm install
npm run build
node registrar.cjs
node testar.mjs
```

Para o recorte de fundo com IA, baixe também o modelo (veja *Como o recorte com IA funciona*).

## Claude Desktop (chat)

O instalador também registra o servidor no chat comum do Claude Desktop. Ele procura o `claude_desktop_config.json` onde o app o guarda, que muda conforme a instalação:

- versões novas: `AppData\Local\Claude-Data\claude_<id>\`
- instalação clássica: `AppData\Roaming\Claude\`
- Microsoft Store: `AppData\Local\Packages\Claude_<id>\LocalCache\Roaming\Claude\`

Se o Claude Desktop não estiver instalado, esse passo é pulado. Depois de instalar, feche o app por completo e abra de novo.

No chat comum, imagens coladas não chegam ao servidor como arquivo. Para usar uma imagem como referência ou remover o fundo dela, diga onde ela está salva, por exemplo *"tira o fundo de Downloads\arte.png"*.

## Usar

Peça ao Claude algo como: *"Pergunte ao ChatGPT o que ele acha deste código"*.
A resposta vem com um `conversa_id`; o Claude pode passá-lo de volta para continuar a mesma conversa.

### Com imagens

A ferramenta aceita `imagens`: uma lista de caminhos de arquivos no seu computador (PNG, JPG, GIF ou WEBP). Exemplo:

> *"Mostre ao ChatGPT a imagem C:\Users\Eu\Desktop\print.png e pergunte o que ele mudaria no layout"*

Use o caminho completo do arquivo. Uma imagem que você só colou no chat do Claude não tem caminho, então salve-a numa pasta antes.

### Gerar imagens

A ferramenta **`gerar_imagem`** usa o gerador de imagens do ChatGPT. Exemplo:

> *"Gere com o ChatGPT um logo minimalista de uma cafeteria, fundo branco"*

Opções (o Claude preenche a partir do seu pedido):

| Opção | Para quê |
|---|---|
| `descricao` | O que a imagem deve mostrar (ou, numa edição, o que mudar) |
| `formato` | `quadrado`, `paisagem` (16:9), `retrato` (2:3), `story` (9:16), `post_instagram` (4:5) |
| `uso` | `foto`, `produto`, `logo`, `marketing`, `ilustracao`, `arte_conceitual`, `interface`, `infografico`, `icone`, `personagem` |
| `estilo` | `3d`, `icone_3d`, `clay` (massinha), `vidro` (glassmorphism), `isometrico`, `realista`, `flat`, `ilustracao_digital`, `aquarela`, `line_art`, `pixel_art`, `anime` |
| `texto_exato` | Texto que deve aparecer escrito exatamente assim |
| `evitar` | Lista do que não pode aparecer |
| `fundo_transparente` | PNG sem fundo de verdade (veja abaixo) |
| `variacoes` | 1 a 4 versões geradas ao mesmo tempo |
| `imagens_referencia` | Imagens do computador (ou coladas no chat) para usar como referência |
| `modo_referencia` | `igual` (recria fielmente, muda só o pedido), `parecida` (arte nova no mesmo estilo), `inspiracao` (livre) ou `editar` (modifica a própria imagem) |
| `conversa_id` | Ajustar uma imagem gerada antes (*"agora troque o fundo para preto"*) |
| `pasta_destino` / `nome_arquivo` | Onde e com que nome salvar |

O que volta para o Claude:

- **Prévia leve** (~80 KB) de cada imagem; o arquivo salvo fica em tamanho cheio.
- **Caminho, tamanho em pixels** e se o fundo ficou mesmo transparente.
- **Prompt final** que o ChatGPT usou, para entender e ajustar o resultado.
- **`conversa_id`** de cada imagem, para editar depois.

Ao lado de cada imagem fica uma ficha `.json` com o pedido, o prompt final e o `conversa_id`. Os nomes saem da descrição (`praia-tropical-por-sol.png`); variações ganham `-v1`, `-v2`; edições, `-editada`.

Cada imagem leva de 30 a 90 segundos e conta no limite de uso da sua assinatura do ChatGPT. Recusas por política de conteúdo e limite de uso esgotado aparecem com mensagem clara.

#### Com referência

Mande a imagem e diga o que quer: *"quero uma arte igual a essa, mas escrito CAFÉ DA VÓ"* (modo `igual`) ou *"faz um carro no mesmo estilo"* (modo `parecida`). O servidor passa a referência para o próprio gerador ver, não só uma descrição dela, e mantém a proporção da referência quando você não pede outro formato.

#### Sem fundo

Com `fundo_transparente`, o resultado é **sempre PNG**. O ChatGPT gera a imagem sobre um fundo liso, e o servidor recorta aqui com IA (veja abaixo). O fundo transparente do próprio gerador não é usado: ele deixa o objeto inteiro levemente transparente, com halo nas bordas.

### Remover fundo de uma imagem pronta

A ferramenta **`remover_fundo`** recebe uma imagem e salva `<nome>-sem-fundo.png` ao lado dela. O recorte é feito com IA no seu computador (10 a 20 s), mantém os pixels originais e não gasta o limite do ChatGPT.

Se você quiser manter só uma parte (*"deixa só a palmeira da esquerda"*), o ChatGPT isola essa parte primeiro e depois a IA local faz o recorte.

### Como o recorte com IA funciona

Feito para as imagens que o GPT gera com fundo liso, mas funciona com qualquer imagem:

1. **Segmentação:** o modelo [IS-Net](https://github.com/xuebinqin/DIS) (uso geral, licença Apache 2.0) separa, de forma grosseira, o objeto do fundo. É leve: ~1 GB de memória e uns 2 a 5 segundos num PC comum.
2. **Cor do fundo:** quando o fundo é liso ou um degradê suave, a cor dele é ajustada em cada ponto da imagem (uma superfície suave, que cobre vinheta e degradê).
3. **Borda pela conta das cores:** com o fundo conhecido, a transparência de cada pixel da borda sai da mistura de cores (pixel = transparência × objeto + resto × fundo), e não do palpite do modelo. Fios, pelos, vidro e bordas finas saem com a transparência certa.
4. **Vãos e áreas claras:** uma área da cor do fundo cercada pelo objeto vira vão só se tiver exatamente a cor do fundo (o buraco da alça de uma xícara); se for só parecida (leite num copo, sobre fundo branco), continua objeto.
5. **Sombra no chão:** sai por padrão; com `manter_sombra`, fica como sombra preta semitransparente.
6. **Sem halo:** a cor do fundo é tirada de cada pixel semitransparente da borda.
7. **Limpeza:** o interior fica 100% opaco, o fundo 100% transparente, e pontinhos soltos somem.

A prévia que o Claude recebe mostra o recorte sobre um fundo escuro e um claro, lado a lado, para conferir as bordas. O recorte também avisa quando o objeto encosta na borda da imagem ou quando objeto e fundo têm cores parecidas demais (aí vale gerar de novo com outro fundo).

Num fundo que não é liso (foto, cenário), vale a máscara do modelo, ajustada às bordas da imagem.

**Comparação** em 37 casos de teste com gabarito (ícones 3D, vidro, bolhas, planta e "cabelo" com fios finos semitransparentes, sobre fundo branco, verde, escuro, degradê e com sombra):

| | 1.7 (BiRefNet) | 1.8.1 (IS-Net + cor do fundo) |
|---|---|---|
| Erro de transparência (média) | 8,4 | 2,6 |
| Halo nas bordas (média) | 5,2 | 2,4 |
| Pixels errados (média) | 0,46% | 0,03% |
| Cabelo: erro de transparência | 40–52 | 6–8 |
| Cabelo: pixels errados | 2,3–3,8% | 0,002–0,006% |
| Memória | ~7,5 GB | ~1,1 GB |
| Tempo por recorte | ~14 s | ~3 s |

Para fios (cabelo, pelo, franja), a borda é calculada fio a fio: a cor pura de cada fio fica na reta que sai da cor do fundo e passa pela cor do pixel, então a transparência sai da distância até o fundo. Bordas de objeto sólido (encostadas no miolo do objeto) usam a cor do miolo. Áreas interiores mais claras não viram transparência, porque um fio sempre tem fundo a poucos pixels e o interior não.

O modelo (171 MB) fica em `%USERPROFILE%\.mcp-chatgpt\modelos\isnet-general-use.onnx`. Para instalar em outro computador:

```powershell
New-Item -ItemType Directory -Force "$HOME\.mcp-chatgpt\modelos"
curl.exe -L -o "$HOME\.mcp-chatgpt\modelos\isnet-general-use.onnx" https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx
```

Sem o modelo, o servidor continua funcionando com o recorte simples de fundo liso, de qualidade inferior.

**Limite conhecido:** em fotos com cenário e folhagem fina (palmeiras, árvores), podem sobrar pedacinhos de fundo entre os detalhes. Para o que o GPT gera sobre fundo liso (ícones, produtos, personagens, objetos), o recorte fica limpo.

## Variáveis opcionais

| Variável | Para quê |
|---|---|
| `CODEX_BIN` | Caminho do executável do Codex, se não estiver no PATH |
| `CHATGPT_TIMEOUT_MS` | Tempo máximo de espera (padrão: 300000 = 5 min) |
| `CHATGPT_IMAGENS_DIR` | Pasta padrão das imagens geradas (padrão: `Imagens\ChatGPT`) |
| `CHATGPT_LADO_PREVIA` | Lado maior da prévia em pixels (padrão: 768) |
| `CHATGPT_MODELO_RECORTE` | Caminho do modelo de recorte .onnx (padrão: `%USERPROFILE%\.mcp-chatgpt\modelos\isnet-general-use.onnx`) |

## Testar sem o Claude

```powershell
npm run inspect
```

Abre o MCP Inspector no navegador para chamar a ferramenta manualmente.
