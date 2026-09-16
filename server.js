import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Point DATA_DIR at a mounted persistent disk in production (see README) --
// otherwise the register is lost every time the host restarts the app.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'register.json');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const PORT = process.env.PORT || 3000;

if (!ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // photos as base64 need headroom
app.use(express.static(path.join(__dirname, 'public')));

// ---------- tiny JSON-file "database" with a write queue ----------
let writeChain = Promise.resolve();

await fs.mkdir(DATA_DIR, { recursive: true });

async function readRegister() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function writeRegister(entries) {
  // Serialize writes so concurrent requests can't clobber each other.
  writeChain = writeChain.then(() =>
    fs.writeFile(DATA_FILE, JSON.stringify(entries, null, 2), 'utf8')
  );
  return writeChain;
}

// ---------- Anthropic API helper ----------
async function callClaude({ messages, tools, maxTokens = 1200 }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('Server is missing ANTHROPIC_API_KEY.');
    err.status = 500;
    throw err;
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages,
      ...(tools ? { tools } : {})
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Anthropic API error (${res.status}): ${text}`);
    err.status = res.status === 401 || res.status === 403 ? 500 : 502;
    throw err;
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return text;
}

function extractJson(text) {
  let cleaned = text.trim()
    .replace(/^```json/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------- Routes ----------

// Identify a product from a photo
app.post('/api/identify', async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64 || !mediaType) {
      return res.status(400).json({ error: 'imageBase64 and mediaType are required.' });
    }
    const prompt =
      'Look at this photo of a product label, taken for a workplace chemical/safety register. ' +
      'Identify the product name and the brand or manufacturer exactly as printed on the label. ' +
      'Respond with ONLY a JSON object, no other text and no markdown fences, in this exact shape: ' +
      '{"product_name": "", "brand": "", "confidence": "high|medium|low"}. ' +
      'If the label is unclear, give your best reading and set confidence to "low".';

    const text = await callClaude({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }],
      maxTokens: 400
    });

    res.json(extractJson(text));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Live web search for the SDS, then extract hazard fields
app.post('/api/find-sds', async (req, res) => {
  try {
    const { productName, brand } = req.body;
    if (!productName) return res.status(400).json({ error: 'productName is required.' });

    const query = `${brand ? brand + ' ' : ''}${productName}`.trim();
    const prompt =
      `Search the web for the official Safety Data Sheet (SDS) for the product "${query}". ` +
      'Prefer the manufacturer\'s own SDS PDF over third-party aggregators. Open it and read the ' +
      'hazard identification and transport information sections. Then respond with your FINAL message ' +
      'containing ONLY a JSON object, no markdown fences and no other commentary, in this exact shape: ' +
      '{"sds_found": true|false, "sds_url": "", "hazardous_substance": "Yes|No|Unknown", ' +
      '"dangerous_good": "Yes|No|Unknown", "dangerous_goods_class": "", "un_number": "", ' +
      '"hazchem_code": "", "notes": ""}. Use "Unknown" rather than guessing if the SDS does not clearly ' +
      'state something. Leave a field as an empty string if not applicable or not found.';

    const text = await callClaude({
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      maxTokens: 1500
    });

    res.json(extractJson(text));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Register CRUD
app.get('/api/register', async (req, res) => {
  try {
    res.json(await readRegister());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not read the register.' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const entries = await readRegister();
    const entry = {
      id: crypto.randomUUID(),
      product_name: (req.body.product_name || '').trim() || '(unnamed product)',
      brand: (req.body.brand || '').trim(),
      hazardous_substance: req.body.hazardous_substance || 'Unknown',
      dangerous_good: req.body.dangerous_good || 'Unknown',
      dangerous_goods_class: (req.body.dangerous_goods_class || '').trim(),
      un_number: (req.body.un_number || '').trim(),
      hazchem_code: (req.body.hazchem_code || '').trim(),
      sds_url: (req.body.sds_url || '').trim(),
      notes: (req.body.notes || '').trim(),
      date_added: new Date().toISOString()
    };
    entries.push(entry);
    await writeRegister(entries);
    res.status(201).json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the entry.' });
  }
});

app.put('/api/register/:id', async (req, res) => {
  try {
    const entries = await readRegister();
    const idx = entries.findIndex((e) => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found.' });
    entries[idx] = {
      ...entries[idx],
      product_name: (req.body.product_name || entries[idx].product_name).trim(),
      brand: (req.body.brand ?? entries[idx].brand).trim(),
      hazardous_substance: req.body.hazardous_substance || entries[idx].hazardous_substance,
      dangerous_good: req.body.dangerous_good || entries[idx].dangerous_good,
      dangerous_goods_class: (req.body.dangerous_goods_class ?? entries[idx].dangerous_goods_class).trim(),
      un_number: (req.body.un_number ?? entries[idx].un_number).trim(),
      hazchem_code: (req.body.hazchem_code ?? entries[idx].hazchem_code).trim(),
      sds_url: (req.body.sds_url ?? entries[idx].sds_url).trim(),
      notes: (req.body.notes ?? entries[idx].notes).trim()
    };
    await writeRegister(entries);
    res.json(entries[idx]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update the entry.' });
  }
});

app.delete('/api/register/:id', async (req, res) => {
  try {
    const entries = await readRegister();
    const filtered = entries.filter((e) => e.id !== req.params.id);
    await writeRegister(filtered);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete the entry.' });
  }
});

app.get('/api/register/export.csv', async (req, res) => {
  try {
    const entries = await readRegister();
    const headers = ['Product name', 'Brand', 'Hazardous substance', 'Dangerous good', 'DG class', 'UN number', 'HAZCHEM code', 'SDS link', 'Notes', 'Date added'];
    const rows = entries.map((e) => [
      e.product_name, e.brand, e.hazardous_substance, e.dangerous_good,
      e.dangerous_goods_class, e.un_number, e.hazchem_code, e.sds_url, e.notes, e.date_added
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => '"' + String(v || '').replace(/"/g, '""') + '"').join(','))
      .join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="chemical-register.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not export the register.' });
  }
});

app.listen(PORT, () => {
  console.log(`Chemical register server running on http://localhost:${PORT}`);
});
