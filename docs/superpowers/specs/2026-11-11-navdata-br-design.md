# Base aberta de navegação do Brasil — design

Data: 2026-11-11 · Repositório: `sluucke/vector-atc-data` (nome pode mudar depois)

## Objetivo

Transformar o `vector-atc-data` numa base de navegação aberta e verificável do
Brasil, no nível que um FMS de simulador consome, com o Little Navmap como
primeiro formato de saída. O Vector ATC passa a ser um dos consumidores e
continua recebendo o mesmo pacote de hoje.

Sucesso, para a v1:

- enroute nacional completo (fixos, auxílios-rádio, aerovias, espaços aéreos)
  com coordenadas oficiais;
- SID, STAR e IAC dos 11 aeródromos atuais com pernas codificadas completas;
- um banco SQLite do Little Navmap gerado a cada release, que carrega e desenha
  os procedimentos iguais à carta;
- relatório de validação com zero erro em cada release publicado;
- carta sobreposta no mapa do Vector ATC sem deslocamento visível: ARC, ENRC e
  REA pelo georreferenciamento oficial, SID/STAR/IAC só quando o ajuste é bom.

Fora da v1: procedimentos de outros aeródromos, exportadores X-Plane/MSFS/PMDG,
holdings fora de procedimento, MSA/MORA.

Material só para simulação. Nunca inventar dado aeronáutico: o que a fonte não
publica fica `null` com o motivo.

## Decisões tomadas

| Pergunta | Decisão |
|---|---|
| Público | Base de navegação para simuladores (ecossistema aberto BR) |
| Primeiro formato | Little Navmap (SQLite) |
| Cobertura v1 | Enroute nacional + procedimentos dos 11 aeródromos |
| Acesso ao GeoAISWEB | Exportação manual por ciclo agora; pedido de acesso ao ICA em paralelo |
| Onde mora | Neste repositório |
| Formato canônico | JSON/GeoJSON no git; SQLite e pacote do Vector ATC gerados no release |

## Fontes

| Dado | Fonte | Observação |
|---|---|---|
| Fixos, VOR, NDB, DME | GeoAISWEB WFS (`ICA:waypoint`, `vor`, `ndb`, `dme`) | coordenada WGS84, declinação |
| Aerovias | GeoAISWEB (`vw_aerovia_alta_v2`, `vw_aerovia_baixa_v2`) + AIP ENR 3 | rumos e limites do GeoAISWEB; paridade ímpar/par do ENR 3 |
| Espaços aéreos | GeoAISWEB (`fir`, `TMA`, `CTR`, `CTA`, `ATZ`, `eac_*`) | |
| Aeródromos, pistas, cabeceiras | GeoAISWEB (`airport`, `runway_v2`, `rwydirection`) + ROTAER | as duas cabeceiras com rumo verdadeiro e magnético |
| Pernas de procedimento | Coding tables do AISWEB (PDF) | o GeoAISWEB não publica procedimentos |
| Cartas | AISWEB (PDF) e GeoAISWEB WMS (GeoTIFF de ARC, ENRC, REA, WAC) | |
| Planos regulares | CGNA RPL | |
| Editorial | à mão (`meta.json`) | TA operacional, MOPS, observações |

O GeoAISWEB fica atrás de uma verificação anti-bot da Cloudflare. A
verificação não é contornada. Enquanto o ICA não liberar acesso automatizado,
um mantenedor roda um script de exportação no próprio navegador a cada ciclo e
envia o resultado para `sources/geoaisweb/<AIRAC>/`. O Sync semanal só lê o
que está no repositório. Quando houver acesso oficial, troca-se apenas o ingest.

## Estrutura

```
sources/geoaisweb/<AIRAC>/*.geojson   exportação crua, para auditoria; fora do release
data/
  enroute/
    waypoints.geojson
    navaids.geojson
    airways.json
    airspaces.geojson
  aerodromes/<ICAO>/
    aerodrome.json
    runways.json
    procedures.json
    charts.json
    georef.json
    meta.json                         editorial, preservado entre execuções
scripts/
  ingest/    geoaisweb, aisweb (cartas e coding tables), aip, rpl
  build/     vector-atc (gera o content/ de hoje), littlenavmap (SQLite)
  validate/  checagens e relatório
```

Regras:

- Todo registro tem `source`: tipo da fonte, ciclo AIRAC e data de efetivação.
- Uma fonte autoritativa por dado. Coordenadas sempre do GeoAISWEB; sequência
  de pernas sempre das coding tables; paridade do ENR 3; editorial à mão.
  Divergência entre fontes é reportada pela validação, nunca resolvida em
  silêncio.
- `content/` deixa de ser editado e passa a ser saída de `build/vector-atc`, com
  o mesmo formato que o Vector ATC lê hoje. Mudar esse formato continua exigindo
  mudança coordenada nos dois repositórios.

## Modelo dos procedimentos

```jsonc
{
  "id": "SID-UTMUM1A-RWY11L",
  "type": "SID",                       // SID | STAR | APPROACH
  "ident": "UTMUM1A",
  "runways": ["11L"],
  "rnav": true,
  "chartKey": "BR01P",
  "source": { "kind": "coding-table", "airac": "2611", "file": "..." },
  "transitions": {
    "RWY": [],
    "UTMUM": [
      {
        "seq": 10,
        "pathTerminator": "TF",
        "fix": { "ident": "EPDEP", "kind": "waypoint", "lat": -15.9, "lon": -47.7 },
        "flyOver": false,
        "turn": null,                  // "L" | "R"
        "course": { "true": 86.2, "magnetic": 108.2 },
        "distanceNm": 12.4,
        "altitude": { "kind": "at-or-above", "ft": [5000] },
        "speedKt": { "kind": "at-or-below", "kt": 250 },
        "recommendedNavaid": null,     // ident, theta, rho quando publicados
        "rnp": 1.0,
        "arcCenter": null              // RF: centro e raio
      }
    ]
  }
}
```

- `altitude.kind`: `at`, `at-or-above`, `at-or-below`, `between` (dois valores
  em `ft`).
- Antes de implementar o parser estendido, levantar numa amostra de coding
  tables dos 11 aeródromos quais colunas existem de fato (velocidade, RNP, VPA,
  sentido de curva, navaid recomendado, centro de RF). Campo não publicado fica
  `null`.
- A coordenada do fixo vem do GeoAISWEB; a da coding table só confere.
- Procedimento sem coding table (convencional antigo, OMNI) fica só com a carta
  e `coded: false`. Nada é desenhado à mão.

## Saída Little Navmap

SQLite no esquema de navdados do Little Navmap: aeródromos, pistas e
cabeceiras, VOR/NDB/fixos, aerovias, espaços aéreos e procedimentos
(`approach`, `transition`, `approach_leg`, `transition_leg`, com `type`,
`fix_ident`, `is_flyover`, `turn_direction`, `alt_descriptor`, `altitude1`,
`altitude2`, `speed_limit`, `rnp`, `theta`, `rho`). O esquema exato é conferido
no código-fonte do Little Navmap/atools na implementação, não de memória. O
arquivo sai como asset do release (`navdata-br-<AIRAC>.sqlite`), com instruções
de instalação no README.

## Validação

`scripts/validate/` roda no Sync antes de empacotar e grava
`dist/validation.json`, com resumo no corpo do release.

| Checagem | Severidade |
|---|---|
| Fixo de procedimento sem coordenada oficial | erro |
| Coordenada da coding table difere do GeoAISWEB em mais de 10 m | erro |
| Pista sem as duas cabeceiras | erro |
| Perna IF/TF/CF sem fixo; RF sem centro | erro |
| Transição que não liga no segmento comum | erro |
| Ponto de aerovia ausente em fixos ou auxílios | erro |
| Registro sem `source` | erro |
| Curso publicado difere do rumo entre fixos em mais de 2° | aviso |
| Trecho de aerovia sem paridade no ENR 3 | aviso |

Erro bloqueia o release: o Sync falha e abre uma issue com o relatório. Aviso
só entra no relatório. Exceções conhecidas ficam em `data/exceptions.json`, uma
por registro, sempre com motivo e fonte; a primeira rodada lista os erros de
hoje e cada um é corrigido no parser ou vira exceção justificada.

## Carta sobreposta

- **ARC, ENRC, REA:** GeoTIFF oficial do GeoAISWEB (WMS), exportado junto com o
  pacote manual, convertido em PNG com os limites geográficos e desenhado no
  Vector ATC como `ImageOverlay` do Leaflet. Sem ajuste nosso.
- **SID, STAR, IAC:** o georreferenciamento atual, com pontos de controle só de
  fixos oficiais e aceitação apertada para resíduo menor que 250 m (hoje 1 km).
  Página esquemática fica sem camada.
- Os casos de sobreposição errada relatados pelo usuário viram testes de
  aceitação.

## Testes

- **Unitários do parser** com trechos reais de coding tables como fixture:
  título quebrado, `*` de fly-over, `RWY14` contra `14`, cursos True/Mag fora de
  ordem, junção de THR e DER.
- **Golden:** SBBR inteiro comparado a um snapshot revisado; diferença exige
  revisão no PR.
- **Determinismo:** o mesmo input gera saída idêntica no Windows e no Linux do
  CI (já houve divergência por fontes do sistema).
- **Little Navmap:** carregar o SQLite e conferir três procedimentos por
  aeródromo contra a carta, por checklist no release.

## Riscos

- **Termos de redistribuição do DECEA** não estão publicados. O pedido ao ICA
  pergunta isso; até a resposta, manter atribuição clara e uso só para
  simulação.
- **Exportação manual** depende de um mantenedor por ciclo. O Sync avisa
  quando `sources/geoaisweb/` está mais velho que o AIRAC vigente.
- **Coding tables** podem trazer layouts que o parser não conhece; a validação
  impede que isso chegue ao release.
