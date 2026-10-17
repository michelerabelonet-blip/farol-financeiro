// Farol Financeiro — servidor (Node/Express) para o Render
// Guarda tudo em um único registro JSON: no Postgres (DATABASE_URL) ou, sem banco, em data.json.
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PIN = process.env.APP_PIN || '';
const DATA_KEY = process.env.DATA_KEY || 'casa';
let seed;
try { seed = require('./seed.json'); } catch (e) {
  seed = { config: { a: { nome: 'Ele', renda: 0 }, b: { nome: 'Ela', renda: 0 } }, itens: [], pagos: {} };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  });
}
const FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

async function load() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS farol_financeiro (id text PRIMARY KEY, dados jsonb NOT NULL)');
    const r = await pool.query("SELECT dados FROM farol_financeiro WHERE id = $1", [DATA_KEY]);
    return r.rows[0] ? r.rows[0].dados : clone(seed);
  }
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return clone(seed); }
}
async function save(s) {
  if (pool) {
    await pool.query(
      "INSERT INTO farol_financeiro (id, dados) VALUES ($2, $1) ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados",
      [JSON.stringify(s), DATA_KEY]
    );
    return;
  }
  fs.writeFileSync(FILE, JSON.stringify(s));
}

let cache = null;
let queue = Promise.resolve();
async function getState() {
  if (!cache) cache = await load();
  return cache;
}
// Uma alteração por vez, para duas pessoas salvando juntas não se atropelarem
function mutate(fn) {
  const p = queue.then(async () => {
    const s = await getState();
    fn(s);
    await save(s);
    return s;
  });
  queue = p.catch(() => {});
  return p;
}

const TIPOS = ['fixa', 'variavel', 'divida', 'investimento'];
const DIVS = ['prop', 'metade', 'a', 'b'];
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : NaN);

function limparItem(id, b) {
  const valor = num(b.valor);
  if (!TIPOS.includes(b.tipo) || typeof b.desc !== 'string' || !b.desc.trim() || !(valor > 0) || !YM.test(b.inicio || '')) return null;
  const it = {
    id,
    tipo: b.tipo,
    desc: b.desc.trim().slice(0, 120),
    valor,
    divisao: DIVS.includes(b.divisao) ? b.divisao : 'prop',
    inicio: b.inicio,
    criado: typeof b.criado === 'number' ? b.criado : Date.now(),
  };
  if (b.fim && YM.test(b.fim)) it.fim = b.fim;
  if (Number.isInteger(b.parcelas) && b.parcelas > 0 && b.parcelas <= 600) it.parcelas = b.parcelas;
  if (b.exemplo === true) it.exemplo = true;
  if (typeof b.grupo === 'string' && b.grupo.trim()) it.grupo = b.grupo.trim().slice(0, 40);
  return it;
}

const rota = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ erro: 'Falha ao salvar. Tente de novo.' }); }
};

app.get('/healthz', (req, res) => res.send('ok'));

app.use('/api', (req, res, next) => {
  if (PIN && req.get('x-pin') !== PIN) return res.status(401).json({ erro: 'codigo' });
  next();
});

app.get('/api/state', rota(async (req, res) => res.json(await getState())));

app.put('/api/config', rota(async (req, res) => {
  const pessoa = (p, padrao) => ({
    nome: typeof p?.nome === 'string' && p.nome.trim() ? p.nome.trim().slice(0, 40) : padrao,
    renda: num(p?.renda) >= 0 ? num(p.renda) : 0,
  });
  const s = await mutate((s) => { s.config = { a: pessoa(req.body.a, 'Pessoa 1'), b: pessoa(req.body.b, 'Pessoa 2') }; });
  res.json(s);
}));

app.put('/api/itens/:id', rota(async (req, res) => {
  const id = String(req.params.id).slice(0, 60);
  const it = limparItem(id, req.body || {});
  if (!it) return res.status(400).json({ erro: 'Lançamento inválido.' });
  const s = await mutate((s) => {
    s.itens = s.itens || [];
    const i = s.itens.findIndex((x) => x.id === id);
    if (i >= 0) s.itens[i] = it; else s.itens.push(it);
  });
  res.json(s);
}));

app.delete('/api/itens/:id', rota(async (req, res) => {
  const id = String(req.params.id);
  const s = await mutate((s) => {
    s.itens = (s.itens || []).filter((x) => x.id !== id);
    for (const m of Object.keys(s.pagos || {})) delete s.pagos[m][id];
  });
  res.json(s);
}));

app.put('/api/pagos/:mes', rota(async (req, res) => {
  const mes = req.params.mes;
  if (!YM.test(mes)) return res.status(400).json({ erro: 'Mês inválido.' });
  const pagos = {};
  for (const [k, v] of Object.entries(req.body || {})) if (v === true) pagos[String(k).slice(0, 60)] = true;
  const s = await mutate((s) => { s.pagos = s.pagos || {}; s.pagos[mes] = pagos; });
  res.json(s);
}));

// Arquivos do app (todos na raiz do repositório)
// Cada serviço no Render pode ter nome, modo e ícone próprios:
//   APP_NAME  (padrão "Financeiro Farol")   APP_SHORT (padrão "Fin. Farol")
//   APP_MODE  ("casal" ou "solo")          ICON_SET  ("", "pessoal" ou "michele")
const APP_NAME = process.env.APP_NAME || 'Financeiro Farol';
const APP_SHORT = process.env.APP_SHORT || 'Fin. Farol';
const SOLO = (process.env.APP_MODE || '').toLowerCase() === 'solo';
// Temas: '' = família ($ azul), 'pessoal' = gráfico verde, 'michele' = cofrinho vinho
const TEMAS = {
  '': { suf: '', cor: '#10283A' },
  pessoal: { suf: '-p', cor: '#0B2A22', night: ['#0E3A2E', '#06201A'] },
  michele: { suf: '-m', cor: '#2E0F24', night: ['#4A1838', '#1E0918'] },
};
const TEMA = TEMAS[(process.env.ICON_SET || '').toLowerCase()] || TEMAS[''];
const ICONES = TEMA.suf;
const COR = TEMA.cor;
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let paginaCache = null;
function pagina() {
  if (!paginaCache) {
    paginaCache = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      .split('Financeiro Farol').join(escHtml(APP_NAME))
      .split('#10283A">').join(COR + '">');
    if (TEMA.night) paginaCache = paginaCache.split('--night:#10283A').join('--night:' + TEMA.night[0]).split('--night:#071219').join('--night:' + TEMA.night[1]);
  }
  return paginaCache;
}
const semCache = (res) => res.setHeader('Cache-Control', 'no-cache');

app.get(['/', '/index.html'], (req, res) => { semCache(res); res.type('html').send(pagina()); });
app.get('/app-config.js', (req, res) => {
  semCache(res);
  res.type('js').send('window.APP=' + JSON.stringify({ name: APP_NAME, solo: SOLO }) + ';');
});
app.get('/manifest.webmanifest', (req, res) => {
  semCache(res);
  res.type('application/manifest+json').send(JSON.stringify({
    name: APP_NAME, short_name: APP_SHORT, description: SOLO ? 'Minhas despesas e minha renda' : 'Despesas da casa divididas pela renda de cada um',
    lang: 'pt-BR', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: COR, theme_color: COR,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});
app.get('/sw.js', (req, res) => { semCache(res); res.type('js').sendFile(path.join(__dirname, 'sw.js')); });
const ICONE = { 'icon-192.png': 1, 'icon-512.png': 1, 'icon-maskable-512.png': 1, 'apple-touch-icon.png': 1 };
app.get(['/icons/:arq', '/apple-touch-icon.png'], (req, res) => {
  const arq = req.params.arq || 'apple-touch-icon.png';
  if (!ICONE[arq]) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('png').sendFile(path.join(__dirname, arq.replace('.png', ICONES + '.png')));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Farol Financeiro na porta ${PORT}${pool ? ' (Postgres)' : ' (arquivo data.json)'}`));
