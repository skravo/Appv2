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

// Look up the HAZCHEM / Emergency Action Code for a UN number. Many SDSs (especially
// US-manufacturer ones) never state a HAZCHEM code even when they give a UN number --
// it's a UK/Australia-centric convention held in separate official reference lists
// (e.g. the HSE Emergency Action Code List, or the ADG Code appendices), not something
// derivable by formula from the UN number alone.
async function lookupHazchem(unNumber, dangerousGoodsClass) {
  const cls = dangerousGoodsClass ? ` (dangerous goods class ${dangerousGoodsClass})` : '';
  const prompt =
    `Search official dangerous goods reference sources (such as the UK HSE Emergency Action ` +
    `Code List, or the Australian ADG Code appendices) for the HAZCHEM code, also called the ` +
    `Emergency Action Code, for the substance with UN number ${unNumber}${cls}. ` +
    'A UN number can carry more than one HAZCHEM code depending on packing group or concentration -- ' +
    'if the source lists more than one, pick the most commonly cited one and say so in "notes". ' +
    'Respond with your FINAL message containing ONLY a JSON object, no markdown fences and no other ' +
    'commentary, in this exact shape: {"hazchem_code": "", "notes": ""}. ' +
    'Set hazchem_code to an empty string if you cannot find a reliable match -- do not guess.';

  const text = await callClaude({
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    maxTokens: 700
  });
  return extractJson(text);
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

// Look up a HAZCHEM code directly from a UN number (used both automatically after an
// SDS search, and as a manual "look up" action if the person edits the UN number by hand)
app.post('/api/hazchem-lookup', async (req, res) => {
  try {
    const { unNumber, dangerousGoodsClass } = req.body;
    if (!unNumber) return res.status(400).json({ error: 'unNumber is required.' });
    res.json(await lookupHazchem(unNumber, dangerousGoodsClass));
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
      `Search the web for the official Safety Data Sheet (SDS) for the product "${query}", for use in ` +
      'an Australian workplace.\n\n' +
      'Source priority -- follow this order:\n' +
      '1. The Australian arm of the manufacturer\'s own website first (e.g. a .com.au domain, or an ' +
      '"Australia" region/country selector on the manufacturer\'s global site). This matters because SDS ' +
      'content -- classifications, and especially whether a HAZCHEM code is given -- can genuinely differ ' +
      'by country, and an Australian workplace register should reflect the Australian version.\n' +
      '2. Only if no Australian-specific SDS exists, use the manufacturer\'s international/global SDS.\n' +
      '3. Only if neither exists, use a reputable third-party source (e.g. a distributor or chemical ' +
      'database), and say so plainly in "notes".\n\n' +
      'Open whichever document you use and read its hazard identification and transport information ' +
      'sections. Then respond with your FINAL message containing ONLY a JSON object, no markdown fences ' +
      'and no other commentary, in this exact shape: ' +
      '{"sds_found": true|false, "sds_url": "", "sds_region": "Australia|International|Unknown", ' +
      '"hazardous_substance": "Yes|No|Unknown", "dangerous_good": "Yes|No|Unknown", ' +
      '"dangerous_goods_class": "", "un_number": "", "hazchem_code": "", "notes": ""}.\n\n' +
      'Set sds_region to "Australia" only if the document you actually used is the Australian version. ' +
      'Set it to "International" if you had to fall back to a non-Australian document -- and in that case, ' +
      'say so in "notes" so it\'s clear this should be double-checked against a local version if one ' +
      'surfaces later.\n\n' +
      'Fill dangerous_goods_class, un_number and hazchem_code following these rules exactly:\n' +
      '- If dangerous_good is "No": set all three to "N/A" -- they do not apply to a non-dangerous-good.\n' +
      '- If dangerous_good is "Yes" but the SDS does not clearly state one of these three: set that one ' +
      'field to "Unknown", not blank.\n' +
      '- If dangerous_good itself is "Unknown" (you could not determine it): set all three to "Unknown".\n' +
      '- Only use an empty string "" if none of the above applies and you have no basis to say anything at all.\n' +
      'Never guess a code or number -- use "Unknown" or "N/A" per the rules above instead.';

    const text = await callClaude({
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      maxTokens: 1500
    });

    const result = extractJson(text);
    result.sds_region = result.sds_region || 'Unknown';

    // The SDS itself often won't state a HAZCHEM code even when it gives a real UN number --
    // fall back to a dedicated lookup so the field still gets populated where possible.
    const hasRealUnNumber = result.un_number && !['N/A', 'Unknown', ''].includes(result.un_number);
    const hazchemMissing = !result.hazchem_code || ['Unknown', ''].includes(result.hazchem_code);
    if (hasRealUnNumber && hazchemMissing) {
      try {
        const hazchem = await lookupHazchem(result.un_number, result.dangerous_goods_class);
        if (hazchem.hazchem_code) {
          result.hazchem_code = hazchem.hazchem_code;
          result.notes = [result.notes, hazchem.notes].filter(Boolean).join(' ');
        } else {
          result.hazchem_code = 'Unknown';
        }
      } catch (err) {
        console.error('HAZCHEM lookup failed:', err.message);
        // Non-fatal -- the SDS result still stands, just without a HAZCHEM code.
      }
    }

    res.json(result);
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
      sds_region: (req.body.sds_region || 'Unknown').trim(),
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
      sds_region: (req.body.sds_region ?? entries[idx].sds_region ?? 'Unknown').trim(),
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
    const headers = ['Product name', 'Brand', 'Hazardous substance', 'Dangerous good', 'DG class', 'UN number', 'HAZCHEM code', 'SDS link', 'SDS region', 'Notes', 'Date added'];
    const rows = entries.map((e) => [
      e.product_name, e.brand, e.hazardous_substance, e.dangerous_good,
      e.dangerous_goods_class, e.un_number, e.hazchem_code, e.sds_url, e.sds_region, e.notes, e.date_added
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
