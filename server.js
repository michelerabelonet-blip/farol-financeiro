// Farol Financeiro — servidor (Node/Express) para o Render
// Guarda tudo em um único registro JSON: no Postgres (DATABASE_URL) ou, sem banco, em data.json.
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PIN = process.env.APP_PIN || '';
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
    const r = await pool.query("SELECT dados FROM farol_financeiro WHERE id = 'casa'");
    return r.rows[0] ? r.rows[0].dados : clone(seed);
  }
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return clone(seed); }
}
async function save(s) {
  if (pool) {
    await pool.query(
      "INSERT INTO farol_financeiro (id, dados) VALUES ('casa', $1) ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados",
      [JSON.stringify(s)]
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
const PUBLICOS = {
  '/': ['index.html', 'text/html; charset=utf-8', true],
  '/index.html': ['index.html', 'text/html; charset=utf-8', true],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', true],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json', true],
  '/icons/icon-192.png': ['icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icon-512.png', 'image/png'],
  '/icons/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/icons/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};
app.get(Object.keys(PUBLICOS), (req, res) => {
  const [arq, tipo, semCache] = PUBLICOS[req.path];
  res.type(tipo);
  res.setHeader('Cache-Control', semCache ? 'no-cache' : 'public, max-age=604800');
  res.sendFile(path.join(__dirname, arq));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Farol Financeiro na porta ${PORT}${pool ? ' (Postgres)' : ' (arquivo data.json)'}`));
