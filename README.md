# Vector ATC — dados

Cartas do DECEA e os dados derivados delas que o
[Vector ATC](https://github.com/sluucke/vector-atc) consome: catálogo de
cartas, geometria das *coding tables*, procedimentos SID/STAR, metadados dos
aeródromos, aerovias do AIP, planos regulares da CGNA e o georreferenciamento
das cartas em escala.

> Material de apoio para simulação. **Não use para navegação real.**

## Como os dados são publicados

| Onde | O quê |
|---|---|
| `content/` (git) | JSON de cada aeródromo e os nacionais (`airways.json`, `rpl.json`). Versionado para que cada ciclo AIRAC vire um diff legível. |
| `charts/` (fora do git) | PDFs das cartas, ~280 MB. |
| [Releases](https://github.com/sluucke/vector-atc-data/releases) | Um release por sincronização com mudança: `content.tar.gz`, `charts.tar` e `manifest.json`. |

O Vector ATC baixa o release mais recente durante o build
(`npm run data:pull`) e desempacota em `content/` e `public/charts/`. O
endereço estável é:

```
https://github.com/sluucke/vector-atc-data/releases/latest/download/manifest.json
https://github.com/sluucke/vector-atc-data/releases/latest/download/content.tar.gz
https://github.com/sluucke/vector-atc-data/releases/latest/download/charts.tar
```

### Sincronização automática

O workflow [`Sync`](.github/workflows/sync.yml) roda toda quinta-feira (o dia
em que os ciclos AIRAC entram em vigor) e pode ser disparado à mão:

1. `npm run sync:all` refaz tudo a partir do AISWEB, do AIP e da CGNA;
2. `npm run check:changed` compara com o último commit, ignorando as datas de
   sincronização;
3. havendo mudança, faz commit de `content/`, publica um release
   `data-AAAA-MM-DD-rN` e chama o deploy hook do Vector ATC.

Segredos opcionais do repositório:

| Segredo | Para quê |
|---|---|
| `AISWEB_API_KEY`, `AISWEB_API_PASS` | Par próprio da API do AISWEB. Sem eles, os scripts usam o par público do site do AISWEB. |
| `VERCEL_DEPLOY_HOOK` | URL de um *deploy hook* do projeto na Vercel, para o Vector ATC reconstruir assim que um release sai. |

## Rodando localmente

Requer Node.js 20.9 ou mais recente.

```bash
npm install
npm run sync:all                 # tudo, ~30 min
npm run sync:airport -- SBGR     # ou um aeródromo
npm run release:package          # gera dist/ como o workflow faria
```

Para trabalhar só no georreferenciamento sem baixar tudo do AISWEB, puxe os
PDFs do último release:

```bash
mkdir -p charts && curl -L https://github.com/sluucke/vector-atc-data/releases/latest/download/charts.tar | tar -x -C charts
```

| Comando | Faz |
|---|---|
| `npm run sync:all` | Pipeline inteiro, na ordem certa, para todos os aeródromos de `content/` |
| `npm run sync:airport -- <ICAO>` | Baixa as cartas e lê as *coding tables* de um aeródromo |
| `npm run build:content -- <ICAO>` | Deriva procedimentos e o esqueleto do `meta.json` |
| `npm run sync:tma` | Cartas por TMA (ARC, ATCSMAC, REA) |
| `npm run sync:airways` | Aerovias, fixos e auxílios-rádio do AIP |
| `npm run sync:rpl` | Planos de voo regulares da CGNA |
| `npm run sync:frequencies` | Frequências das posições da divisão IVAO Brasil |
| `npm run georef:charts [ICAO]` | Posiciona no mapa as cartas desenhadas em escala |
| `npm run check:changed` | Diz se algo mudou além das datas |
| `npm run release:package [tag]` | Empacota `dist/` para um release |

Para adicionar um aeródromo, veja
[docs/adicionando-aerodromos.md](docs/adicionando-aerodromos.md).

## Contrato com o Vector ATC

O formato de cada arquivo está em [`src/types.ts`](src/types.ts). O Vector ATC
tem a própria cópia desses tipos; mudar um campo aqui é mudar o contrato, e a
mudança precisa entrar nos dois repositórios. Campos novos e opcionais não
quebram nada. Renomear ou remover exige publicar o Vector ATC adaptado antes do
release.

Nunca invente dado aeronáutico. Se o DECEA ou o MOPS da TMA não publica um
valor, deixe vazio; a interface mostra `—` com o motivo.

## Licença e dados

Os scripts estão sob a [licença MIT](LICENSE).

As cartas e as informações derivadas delas são publicações do **DECEA**
(Departamento de Controle do Espaço Aéreo), obtidas no
[AISWEB](https://aisweb.decea.mil.br). Os planos de voo regulares vêm do
[CGNA](https://portal.cgna.decea.mil.br). Esse conteúdo não é coberto pela
licença MIT e pertence ao DECEA. Este projeto não é afiliado ao DECEA nem à
IVAO.

Desenvolvido por **The Duck Corporation**.
