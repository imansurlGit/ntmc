"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 5500;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "";

fs.mkdirSync(DATA_DIR, { recursive: true });
const regFile = path.join(DATA_DIR, "inscriptions.json");
const posFile = path.join(DATA_DIR, "positions.ndjson");
const keyFile = path.join(DATA_DIR, "cle-organisateur.txt");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newToken(n) {
  const bytes = crypto.randomBytes(n);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

let adminKey;
if (fs.existsSync(keyFile)) adminKey = fs.readFileSync(keyFile, "utf8").trim();
else {
  adminKey = newToken(24);
  fs.writeFileSync(keyFile, adminKey, "utf8");
}

let regs = [];
if (fs.existsSync(regFile) && fs.statSync(regFile).size > 0) {
  try { regs = JSON.parse(fs.readFileSync(regFile, "utf8")); } catch { regs = []; }
}
function saveRegs() { fs.writeFileSync(regFile, JSON.stringify(regs), "utf8"); }
function findReg(id) { return regs.find((r) => r.id === id) || null; }

const trails = new Map();
function addPoint(p) {
  if (!trails.has(p.id)) trails.set(p.id, []);
  const t = trails.get(p.id);
  t.push(p);
  if (t.length > 2000) t.shift();
}
if (fs.existsSync(posFile)) {
  for (const line of fs.readFileSync(posFile, "utf8").split("\n")) {
    if (line.trim()) { try { addPoint(JSON.parse(line)); } catch {} }
  }
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/info", (req, res) => res.json({ lanUrl: baseUrl(req) }));

app.post("/api/register", (req, res) => {
  const d = req.body && req.body.data;
  if (!d || !d.nom || !d.prenom || !d.telephone || !d.email) {
    return res.status(400).json({ error: "Champs manquants" });
  }
  if (d.photo && d.photo.length > 4 * 1024 * 1024) {
    return res.status(413).json({ error: "Photo trop lourde" });
  }
  for (const r of regs) {
    if (r.data.telephone === d.telephone || r.data.email === d.email) {
      return res.status(409).json({ error: "Une demande existe déjà avec ce numéro ou cet e-mail." });
    }
  }
  let code = String(req.body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) code = "BADGE";
  const reg = {
    id: `${code}-${newToken(6)}`,
    token: newToken(20),
    createdAt: new Date().toISOString(),
    data: d,
  };
  regs.push(reg);
  saveRegs();
  console.log(`  + Inscription ${reg.id} : ${d.prenom} ${d.nom}`);
  res.status(201).json({
    id: reg.id,
    createdAt: reg.createdAt,
    trackUrl: `${baseUrl(req)}/suivi.html?b=${reg.id}&t=${reg.token}`,
  });
});

app.get("/api/badge", (req, res) => {
  const r = findReg(req.query.b);
  if (!r || r.token !== req.query.t) return res.status(404).json({ error: "Badge inconnu" });
  res.json({
    id: r.id,
    prenom: r.data.prenom,
    nom: r.data.nom,
    type_label: r.data.type_label,
    organisation: r.data.organisation,
  });
});

app.get("/api/photo", (req, res) => {
  const r = findReg(req.query.b);
  const ok = r && ((req.query.t && r.token === req.query.t) || req.query.key === adminKey);
  if (!ok || !r.data.photo) return res.status(404).end();
  const raw = String(r.data.photo);
  const comma = raw.indexOf(",");
  res.set("Content-Type", "image/jpeg");
  res.send(Buffer.from(raw.slice(comma + 1), "base64"));
});

app.post("/api/position", (req, res) => {
  const b = req.body || {};
  const r = findReg(b.b);
  if (!r || r.token !== b.t) return res.status(401).json({ error: "Badge inconnu" });
  const now = Date.now();
  let count = 0;
  const lines = [];
  for (const p of (b.points || []).slice(0, 100)) {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    let ts = Number(p.ts);
    if (Math.abs(ts - now) > 86400000) ts = now;
    const pt = { id: r.id, lat, lng, acc: Math.round(Number(p.acc)), ts, rx: now };
    addPoint(pt);
    lines.push(JSON.stringify(pt));
    count++;
  }
  if (count) fs.appendFileSync(posFile, lines.join("\n") + "\n", "utf8");
  res.json({ ok: true, count });
});

app.get("/api/live", (req, res) => {
  if (req.query.key !== adminKey) return res.status(401).json({ error: "Clé organisateur invalide" });
  const list = regs.map((r) => {
    const t = trails.get(r.id);
    let last = null, trail = [];
    if (t && t.length) {
      const l = t[t.length - 1];
      last = { lat: l.lat, lng: l.lng, acc: l.acc, ts: l.ts };
      trail = t.slice(-120).map((p) => ({ lat: p.lat, lng: p.lng, ts: p.ts }));
    }
    return {
      id: r.id,
      prenom: r.data.prenom,
      nom: r.data.nom,
      type_label: r.data.type_label,
      organisation: r.data.organisation,
      telephone: r.data.telephone,
      zones: r.data.zones,
      hasPhoto: !!r.data.photo,
      last,
      trail,
    };
  });
  res.json({ now: Date.now(), people: list });
});

app.use((req, res) => res.status(404).json({ error: "Route inconnue" }));

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
  console.log(`Carte organisateur : /carte.html?key=${adminKey}`);
});
