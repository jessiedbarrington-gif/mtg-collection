// Barrington MTG Collection — Cloudflare Worker
// Serves the API under /api/*. Static front-end is served by Cloudflare Assets.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: err.message || "Server error" }, 500);
      }
    }
    // Non-API requests fall through to static assets (handles /view/<token> too).
    return env.ASSETS.fetch(request);
  },
};

/* ----------------------------- helpers ----------------------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Call the Anthropic Messages API, retrying on transient overload / rate-limit / 5xx.
// Returns { ok:true, data } or { ok:false, status, errText }.
async function anthropicJSON(env, payload, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (attempt < maxRetries) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
      return { ok: false, status: 0, errText: String((e && e.message) || e) };
    }
    if (res.ok) return { ok: true, data: await res.json() };
    const t = await res.text();
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    return { ok: false, status: res.status, errText: t };
  }
  return { ok: false, status: 0, errText: "exhausted retries" };
}

// Friendly error when the AI service is unavailable after retries.
function aiBusyError() {
  return json({ error: "The AI is very busy right now (high demand). Please wait a moment and try again." }, 503);
}

// Controlled role vocabulary (spec §3.2) — keep fixed so counts compare across decks.
const ROLE_VOCAB = [
  "ramp", "fixing", "card_draw", "card_advantage", "spot_removal", "board_wipe",
  "counterspell", "protection", "recursion", "tutor", "wincon", "combo_piece",
  "stax", "graveyard_hate", "artifact_hate", "land", "payoff", "filler",
];

function safeRoles(v) {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((r) => ROLE_VOCAB.includes(r)) : [];
  } catch (_) {
    return [];
  }
}

function safeDirections(v) {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x) => x && x.text) : [];
  } catch (_) {
    return [];
  }
}

// Normalize a card name for fuzzy matching: lowercase, DFC front face only,
// strip accents and punctuation, collapse whitespace.
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .split("//")[0]
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Constant-time-ish string compare.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isOwner(request, env) {
  const key = request.headers.get("X-Owner-Key");
  return !!env.OWNER_KEY && safeEqual(key || "", env.OWNER_KEY);
}

function shareOk(request, env, url) {
  const token =
    url.searchParams.get("t") || request.headers.get("X-Share-Token") || "";
  return !!env.SHARE_TOKEN && safeEqual(token, env.SHARE_TOKEN);
}

function canRead(request, env, url) {
  return isOwner(request, env) || shareOk(request, env, url);
}

function requireOwner(request, env) {
  if (!isOwner(request, env)) {
    return json({ error: "Not authorized — owner key required." }, 403);
  }
  return null;
}

/* ----------------------------- router ----------------------------- */

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, ""); // trim trailing slash
  const method = request.method;

  // Tells the front-end who it's talking to.
  if (path === "/api/me" && method === "GET") {
    return json({
      owner: isOwner(request, env),
      ownerConfigured: !!env.OWNER_KEY,
      aiConfigured: !!env.ANTHROPIC_API_KEY,
    });
  }

  // Owner-only: the read-only share link to send to a second viewer.
  if (path === "/api/share" && method === "GET") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return json({ token: env.SHARE_TOKEN, path: `/view/${env.SHARE_TOKEN}` });
  }

  // Full collection.
  if (path === "/api/state" && method === "GET") {
    if (!canRead(request, env, url)) return json({ error: "Forbidden" }, 403);
    return json(await getState(env));
  }

  // One-time DB migration — call once after deploying new columns.
  if (path === "/api/migrate" && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    const stmts = [
      "ALTER TABLE cards ADD COLUMN foil TEXT DEFAULT 'nonfoil'",
      "ALTER TABLE cards ADD COLUMN condition TEXT DEFAULT 'NM'",
      "ALTER TABLE cards ADD COLUMN acquisition_price REAL",
      "ALTER TABLE cards ADD COLUMN price_foil REAL",
      "ALTER TABLE decks ADD COLUMN tag_sig TEXT",
      "ALTER TABLE analysis ADD COLUMN analysis_sig TEXT",
    ];
    const results = [];
    for (const sql of stmts) {
      try { await env.DB.prepare(sql).run(); results.push({ ok: true, sql }); }
      catch (e) { results.push({ ok: false, sql, err: e.message }); }
    }
    return json({ ok: true, results });
  }

  // Add a card.
  if (path === "/api/cards" && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return json(await addCard(env, await request.json()));
  }

  // Bulk import a pasted decklist.
  if (path === "/api/cards/bulk" && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return json(await bulkAddCards(env, await request.json()));
  }

  // Identify a card from a photo (Claude vision).
  if (path === "/api/scan" && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return await scanCard(env, await request.json());
  }

  // Draft a deck from a natural-language concept (AI).
  if (path === "/api/build-idea" && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return await buildIdea(env, await request.json());
  }

  // Create a new deck.
  if (path === "/api/decks" && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return json(await createDeck(env, await request.json()));
  }

  // Edit / delete a deck: /api/decks/:id
  const deckMatch = path.match(/^\/api\/decks\/([a-z0-9_-]+)$/i);
  if (deckMatch) {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    const id = deckMatch[1];
    if (method === "PATCH") return json(await editDeck(env, id, await request.json()));
    if (method === "DELETE") return json(await deleteDeck(env, id));
  }

  // Move ONE copy of a card: /api/cards/:id/move
  const moveMatch = path.match(/^\/api\/cards\/(\d+)\/move$/);
  if (moveMatch && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return json(await moveOneCard(env, Number(moveMatch[1]), await request.json()));
  }

  // Edit / delete a single card: /api/cards/:id
  const cardMatch = path.match(/^\/api\/cards\/(\d+)$/);
  if (cardMatch) {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    const id = Number(cardMatch[1]);
    if (method === "PATCH") return json(await editCard(env, id, await request.json()));
    if (method === "DELETE") return json(await deleteCard(env, id));
  }

  // Refresh prices + card types for the whole collection (Scryfall / TCGplayer).
  if (path === "/api/prices/refresh" && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const offset = Number.isFinite(body.offset) ? body.offset : 0;
    const limit = Number.isFinite(body.limit) ? body.limit : null;
    return json(await enrichAll(env, offset, limit));
  }

  // Deck analysis: /api/decks/:id/analysis
  const analysisMatch = path.match(/^\/api\/decks\/([a-z0-9_-]+)\/analysis$/i);
  if (analysisMatch) {
    const deckId = analysisMatch[1];
    if (method === "GET") {
      if (!canRead(request, env, url)) return json({ error: "Forbidden" }, 403);
      return json(await getAnalysis(env, deckId));
    }
    if (method === "POST") {
      const guard = requireOwner(request, env);
      if (guard) return guard;
      return await generateAnalysis(env, deckId);
    }
  }

  // Collection (loose-card) recommendations: /api/decks/:id/collection
  const collectionMatch = path.match(/^\/api\/decks\/([a-z0-9_-]+)\/collection$/i);
  if (collectionMatch && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return await generateCollection(env, collectionMatch[1]);
  }

  // Save the deck's direction + generate a one-line summary: /api/decks/:id/goal
  const goalMatch = path.match(/^\/api\/decks\/([a-z0-9_-]+)\/goal$/i);
  if (goalMatch && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return await saveGoalWithSummary(env, goalMatch[1], await request.json());
  }

  // Generate 3 AI direction options: /api/decks/:id/directions
  const dirMatch = path.match(/^\/api\/decks\/([a-z0-9_-]+)\/directions$/i);
  if (dirMatch && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return await generateDirections(env, dirMatch[1]);
  }

  // AI tagging pass — assign roles + weight to every card in a deck: /api/decks/:id/tag
  const tagMatch = path.match(/^\/api\/decks\/([a-z0-9_-]+)\/tag$/i);
  if (tagMatch && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return await tagDeck(env, tagMatch[1]);
  }

  // Deterministic numbers dashboard (no AI): /api/decks/:id/numbers
  const numbersMatch = path.match(/^\/api\/decks\/([a-z0-9_-]+)\/numbers$/i);
  if (numbersMatch && method === "GET") {
    if (!canRead(request, env, url)) return json({ error: "Forbidden" }, 403);
    return json(await computeNumbers(env, numbersMatch[1]));
  }

  // Refresh prices for just this deck's cards (no AI): /api/decks/:id/prices
  const deckPricesMatch = path.match(/^\/api\/decks\/([a-z0-9_-]+)\/prices$/i);
  if (deckPricesMatch && method === "POST") {
    const guard = requireOwner(request, env);
    if (guard) return guard;
    return json(await refreshDeckPrices(env, deckPricesMatch[1]));
  }

  return json({ error: "Not found" }, 404);
}

/* ----------------------------- state ----------------------------- */

async function getState(env) {
  const [decksRes, cardsRes, analysisRes] = await Promise.all([
    env.DB.prepare("SELECT * FROM decks ORDER BY position, id").all(),
    env.DB.prepare(
      "SELECT * FROM cards ORDER BY location, deck_id, position, id"
    ).all(),
    env.DB.prepare("SELECT deck_id FROM analysis").all(),
  ]);

  const cards = cardsRes.results || [];
  const hasAnalysis = new Set((analysisRes.results || []).map((r) => r.deck_id));

  const mapCard = (c) => ({
    id: c.id,
    n: c.name,
    s: c.set_code,
    q: c.qty,
    p: c.price_usd,
    t: c.type_cat || null,
    cmc: c.cmc,
    mc: c.mana_cost || "",
    prod: c.produced || "",
    fs: c.for_sale === 1,
    cmd: c.is_commander === 1,
    img: c.image || null,
    roles: safeRoles(c.roles),
    weight: c.weight || null,
    pc: c.potential_commander === 1,
    pu: c.price_updated_at || null,
    foil: c.foil || 'nonfoil',
    cond: c.condition || 'NM',
    acq: c.acquisition_price || null,
    pf: c.price_foil || null,
  });

  const decks = (decksRes.results || []).map((d) => ({
    id: d.id,
    title: d.title,
    theme: d.theme,
    commander: d.commander,
    alt: d.alt_commander,
    pips: d.pips ? d.pips.split(",") : [],
    owner: d.owner || null,
    power: d.power || null,
    reliance: d.reliance || null,
    goal: d.goal || "",
    goalSummary: d.goal_summary || "",
    directions: safeDirections(d.directions),
    hasAnalysis: hasAnalysis.has(d.id),
    cards: cards.filter((c) => c.deck_id === d.id).map(mapCard),
  }));

  const loose = cards.filter((c) => c.location === "loose").map(mapCard);

  const forsale = cards
    .filter((c) => c.for_sale === 1)
    .map((c) => ({
      id: c.id,
      n: c.name,
      s: c.set_code,
      q: c.qty,
      price: c.price_usd,
      priceUpdated: c.price_updated_at,
      foil: c.foil || 'nonfoil',
      cond: c.condition || 'NM',
      acq: c.acquisition_price || null,
      pf: c.price_foil || null,
    }));

  const wishlist = cards.filter((c) => c.location === 'wishlist').map(mapCard);

  return { decks, loose, forsale, wishlist };
}

/* ----------------------------- mutations ----------------------------- */

async function addCard(env, body) {
  const location = ['deck','loose','wishlist'].includes(body.location) ? body.location : 'loose';
  const deckId = location === "deck" ? (body.deckId || null) : null;
  const name = (body.name || "").trim();
  if (!name) return { error: "Card name required" };
  const set = (body.set || "").trim().toUpperCase() || null;
  const qty = Math.max(1, parseInt(body.qty, 10) || 1);
  const forSale = body.forSale ? 1 : 0;
  const foil = ['nonfoil','foil','etched','glossy'].includes(body.foil) ? body.foil : 'nonfoil';
  const condition = ['NM','LP','MP','HP','DMG'].includes(body.condition) ? body.condition : 'NM';
  const acqPrice = body.acquisitionPrice != null ? parseFloat(body.acquisitionPrice) || null : null;

  const posRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM cards WHERE location = ? AND (deck_id IS ? OR deck_id = ?)"
  )
    .bind(location, deckId, deckId)
    .first();

  const res = await env.DB.prepare(
    "INSERT INTO cards (deck_id, location, name, set_code, qty, for_sale, foil, condition, acquisition_price, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(deckId, location, name, set, qty, forSale, foil, condition, acqPrice, posRow ? posRow.pos : 0)
    .run();

  try { await enrichByNames(env, [name]); } catch (_) {}
  await autoTagLands(env, deckId);
  return { ok: true, id: res.meta.last_row_id };
}

async function editCard(env, id, body) {
  const existing = await env.DB.prepare("SELECT * FROM cards WHERE id = ?")
    .bind(id)
    .first();
  if (!existing) return { error: "Card not found" };

  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  const set =
    body.set !== undefined
      ? String(body.set).trim().toUpperCase() || null
      : existing.set_code;
  const qty =
    body.qty !== undefined
      ? Math.max(1, parseInt(body.qty, 10) || 1)
      : existing.qty;
  const forSale =
    body.forSale !== undefined ? (body.forSale ? 1 : 0) : existing.for_sale;

  // Optional move between loose <-> a deck.
  let location = existing.location;
  let deckId = existing.deck_id;
  let position = existing.position;
  if (body.location !== undefined) {
    location = body.location === "deck" ? "deck" : "loose";
    deckId = location === "deck" ? body.deckId || null : null;
    const posRow = await env.DB.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM cards WHERE location = ? AND (deck_id IS ? OR deck_id = ?)"
    )
      .bind(location, deckId, deckId)
      .first();
    position = posRow ? posRow.pos : 0;
  }

  let isCmd =
    body.isCommander !== undefined ? (body.isCommander ? 1 : 0) : existing.is_commander;
  if (location === "loose") isCmd = 0; // a loose card can't be a commander

  let typeCat = existing.type_cat;
  if (body.typeCat !== undefined) {
    const t = String(body.typeCat).trim();
    typeCat = t === "" ? null : normalizeCategory(t);
  }

  let manaCost = existing.mana_cost;
  if (body.manaCost !== undefined) manaCost = String(body.manaCost).trim() || null;

  let roles = existing.roles;
  if (body.roles !== undefined) {
    const clean = Array.isArray(body.roles) ? body.roles.filter((r) => ROLE_VOCAB.includes(r)) : [];
    roles = clean.length ? JSON.stringify([...new Set(clean)]) : null;
  }
  let weight = existing.weight;
  if (body.weight !== undefined) {
    weight = ["core", "flex", "filler"].includes(body.weight) ? body.weight : null;
  }
  const pc = body.potentialCommander !== undefined
    ? (body.potentialCommander ? 1 : 0)
    : existing.potential_commander;

  const foil = body.foil !== undefined
    ? (['nonfoil','foil','etched','glossy'].includes(body.foil) ? body.foil : 'nonfoil')
    : (existing.foil || 'nonfoil');
  const condition = body.condition !== undefined
    ? (['NM','LP','MP','HP','DMG'].includes(body.condition) ? body.condition : 'NM')
    : (existing.condition || 'NM');
  const acqPrice = body.acquisitionPrice !== undefined
    ? (body.acquisitionPrice != null ? parseFloat(body.acquisitionPrice) || null : null)
    : existing.acquisition_price;

  await env.DB.prepare(
    "UPDATE cards SET name=?, set_code=?, qty=?, for_sale=?, location=?, deck_id=?, position=?, is_commander=?, type_cat=?, mana_cost=?, roles=?, weight=?, potential_commander=?, foil=?, condition=?, acquisition_price=? WHERE id=?"
  )
    .bind(name, set, qty, forSale, location, deckId, position, isCmd, typeCat, manaCost, roles, weight, pc, foil, condition, acqPrice, id)
    .run();

  // Re-fetch from Scryfall when the name changed or the user asked to auto-detect (blank type).
  const wantsAuto = body.typeCat !== undefined && String(body.typeCat).trim() === "";
  if (name !== existing.name || wantsAuto) {
    try { await enrichByNames(env, [name]); } catch (_) {}
  }
  if (location === "deck") await autoTagLands(env, deckId);

  return { ok: true };
}

async function deleteCard(env, id) {
  await env.DB.prepare("DELETE FROM cards WHERE id = ?").bind(id).run();
  return { ok: true };
}

// Move a single copy of a card to another location. If qty > 1, split one off
// (source decremented, a new qty-1 copy created at the destination, carrying its
// identification data). If qty <= 1, the whole card moves.
async function moveOneCard(env, id, body) {
  const existing = await env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
  if (!existing) return { error: "Card not found" };
  const location = ['deck','loose','wishlist'].includes(body.location) ? body.location : 'loose';
  const deckId = location === "deck" ? body.deckId || null : null;

  const posRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM cards WHERE location = ? AND (deck_id IS ? OR deck_id = ?)"
  )
    .bind(location, deckId, deckId)
    .first();
  const pos = posRow ? posRow.pos : 0;

  if ((existing.qty || 1) <= 1) {
    await env.DB.prepare(
      "UPDATE cards SET location=?, deck_id=?, position=?, is_commander=0 WHERE id=?"
    )
      .bind(location, deckId, pos, id)
      .run();
    await autoTagLands(env, deckId);
    return { ok: true, moved: 1 };
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE cards SET qty = qty - 1 WHERE id = ?").bind(id),
    env.DB.prepare(
      "INSERT INTO cards (deck_id, location, name, set_code, qty, for_sale, is_commander, price_usd, price_updated_at, type_cat, cmc, mana_cost, produced, image, foil, condition, acquisition_price, position) " +
        "VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      deckId,
      location,
      existing.name,
      existing.set_code,
      existing.price_usd,
      existing.price_updated_at,
      existing.type_cat,
      existing.cmc,
      existing.mana_cost,
      existing.produced,
      existing.image,
      existing.foil || 'nonfoil',
      existing.condition || 'NM',
      existing.acquisition_price || null,
      pos
    ),
  ]);
  await autoTagLands(env, deckId);
  return { ok: true, moved: 1 };
}

// Deterministically tag any land in a deck as 'land' (no AI). Lands are the only role
// we can assign with certainty from card data, so newly-added basics never sit untagged.
async function autoTagLands(env, deckId) {
  if (!deckId) return;
  await env.DB.prepare(
    "UPDATE cards SET roles = ? WHERE deck_id = ? AND type_cat = 'Land' AND (roles IS NULL OR roles = '' OR roles = '[]')"
  ).bind(JSON.stringify(["land"]), deckId).run();
}

/* ----------------------------- decks + bulk import ----------------------------- */

// Parse a pasted decklist. Each line: optional "N" / "Nx" quantity, the card name,
// optional trailing "[SET]", and an optional "-- note" we ignore.
function parseDecklist(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;

    // leading quantity: "1", "1x", "12 x"
    let qty = 1;
    const qm = line.match(/^(\d+)\s*[xX]?\s+(.*)$/);
    if (qm) { qty = parseInt(qm[1], 10) || 1; line = qm[2].trim(); }

    // strip foil/treatment markers like *F*, *E*, *etched* (Moxfield) and "-- note"
    line = line.replace(/\s*\*[^*]*\*\s*$/g, "").trim();
    line = line.replace(/\s+--\s.*$/, "").trim();

    let set = null;
    let m;
    if ((m = line.match(/^(.*?)\s*\(([A-Za-z0-9]{1,6})\)\s+\S+\s*$/)) && /[A-Za-z]/.test(m[2])) {
      // Moxfield: "Name (SET) <collector#>"  — drop the collector number
      line = m[1].trim();
      set = m[2].toUpperCase();
    } else if ((m = line.match(/^(.*?)\s*\[([A-Za-z0-9]{1,6})\]\s+\S+\s*$/)) && /[A-Za-z]/.test(m[2])) {
      // "Name [SET] <collector#>"  — square-bracket variant, drop the collector number
      line = m[1].trim();
      set = m[2].toUpperCase();
    } else if ((m = line.match(/^(.*?)\s*\[([^\]]+)\]\s*$/))) {
      // "Name [SET]"
      line = m[1].trim();
      set = m[2].trim().toUpperCase();
    } else if ((m = line.match(/^(.*?)\s*\(([A-Za-z0-9]{1,6})\)\s*$/)) && /[A-Za-z]/.test(m[2])) {
      // "Name (SET)" with no collector number
      line = m[1].trim();
      set = m[2].toUpperCase();
    }

    if (!line) continue;
    out.push({ n: line, s: set, q: Math.max(1, qty) });
  }
  return out;
}

async function bulkAddCards(env, body) {
  const location = body.location === "deck" ? "deck" : "loose";
  const deckId = location === "deck" ? body.deckId || null : null;
  if (location === "deck" && !deckId) return { error: "Missing deck" };
  const cards = parseDecklist(body.text);
  if (!cards.length) return { error: "No cards found in the pasted text." };

  const posRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM cards WHERE location = ? AND (deck_id IS ? OR deck_id = ?)"
  )
    .bind(location, deckId, deckId)
    .first();
  let pos = posRow ? posRow.pos : 0;

  const stmt = env.DB.prepare(
    "INSERT INTO cards (deck_id, location, name, set_code, qty, for_sale, position) VALUES (?, ?, ?, ?, ?, 0, ?)"
  );
  const batch = cards.map((c) => stmt.bind(deckId, location, c.n, c.s, c.q, pos++));
  await env.DB.batch(batch);
  try { await enrichByNames(env, cards.map((c) => c.n)); } catch (_) {}
  await autoTagLands(env, deckId);
  return { ok: true, added: cards.length };
}

function normalizePips(input) {
  let pips = Array.isArray(input) ? input : String(input || "").split(",");
  return pips
    .map((p) => String(p).trim().toLowerCase())
    .filter((p) => ["w", "u", "k", "r", "g"].includes(p));
}

function normalizeOwner(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "jessie") return "Jessie";
  if (s === "marcus") return "Marcus";
  return null;
}

async function createDeck(env, body) {
  const title = (body.title || "").trim();
  if (!title) return { error: "Deck name required" };
  const commander = (body.commander || "").trim() || "Unknown";
  const alt = (body.alt || "").trim() || null;
  const pips = normalizePips(body.pips);
  const theme = (body.theme || "").trim() || (pips.length >= 5 ? "five" : "custom");
  const owner = normalizeOwner(body.owner);

  let base =
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "deck";
  let id = base, n = 1;
  while (await env.DB.prepare("SELECT 1 FROM decks WHERE id = ?").bind(id).first()) {
    id = base + "-" + ++n;
  }

  const posRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM decks"
  ).first();
  await env.DB.prepare(
    "INSERT INTO decks (id,title,theme,commander,alt_commander,pips,owner,position) VALUES (?,?,?,?,?,?,?,?)"
  )
    .bind(id, title, theme, commander, alt, pips.join(","), owner, posRow ? posRow.pos : 0)
    .run();
  return { ok: true, id };
}

async function editDeck(env, id, body) {
  const d = await env.DB.prepare("SELECT * FROM decks WHERE id = ?").bind(id).first();
  if (!d) return { error: "Deck not found" };
  const title = body.title !== undefined ? String(body.title).trim() || d.title : d.title;
  const commander =
    body.commander !== undefined ? String(body.commander).trim() || d.commander : d.commander;
  const alt =
    body.alt !== undefined ? String(body.alt).trim() || null : d.alt_commander;
  const pipStr = body.pips !== undefined ? normalizePips(body.pips).join(",") : d.pips;
  const theme = body.theme !== undefined ? String(body.theme).trim() || d.theme : d.theme;
  const owner = body.owner !== undefined ? normalizeOwner(body.owner) : d.owner;
  const goal = body.goal !== undefined ? String(body.goal).trim() || null : d.goal;
  const reliance = body.reliance !== undefined
    ? (["high", "medium", "low"].includes(body.reliance) ? body.reliance : null)
    : d.reliance;
  let benchmarks = d.benchmarks;
  if (body.benchmarks !== undefined) {
    benchmarks = body.benchmarks && typeof body.benchmarks === "object"
      ? JSON.stringify(body.benchmarks)
      : null;
  }
  await env.DB.prepare(
    "UPDATE decks SET title=?, commander=?, alt_commander=?, pips=?, theme=?, owner=?, goal=?, reliance=?, benchmarks=? WHERE id=?"
  )
    .bind(title, commander, alt, pipStr, theme, owner, goal, reliance, benchmarks, id)
    .run();
  return { ok: true };
}

async function deleteDeck(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM analysis WHERE deck_id = ?").bind(id),
    env.DB.prepare("DELETE FROM cards WHERE deck_id = ?").bind(id),
    env.DB.prepare("DELETE FROM decks WHERE id = ?").bind(id),
  ]);
  return { ok: true };
}

// Save the deck's direction and (if the AI key is set) generate a one-line summary of it.
async function saveGoalWithSummary(env, deckId, body) {
  const deck = await env.DB.prepare("SELECT * FROM decks WHERE id = ?").bind(deckId).first();
  if (!deck) return json({ error: "Deck not found" }, 404);
  const goal = String(body.goal || "").trim();

  if (!goal) {
    await env.DB.prepare("UPDATE decks SET goal = NULL, goal_summary = NULL WHERE id = ?")
      .bind(deckId)
      .run();
    return json({ ok: true, goal: "", summary: "" });
  }

  let summary = "";
  if (env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 80,
          system:
            "You distill a Magic: The Gathering Commander deck's strategic direction into ONE short, punchy sentence (about 12 words or fewer). Reply with ONLY that sentence — no preamble, no quotes.",
          messages: [
            {
              role: "user",
              content: `Deck: ${deck.title} (commander ${deck.commander}).\nDirection: ${goal}`,
            },
          ],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const tb = (data.content || []).find((b) => b.type === "text");
        if (tb) summary = String(tb.text || "").trim();
      }
    } catch (_) {}
  }

  await env.DB.prepare("UPDATE decks SET goal = ?, goal_summary = ? WHERE id = ?")
    .bind(goal, summary || null, deckId)
    .run();
  return json({ ok: true, goal, summary });
}

// Generate 3 distinct potential upgrade directions for a deck (the user picks one to make active).
const DIRECTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    directions: {
      type: "array",
      description: "Exactly 3 DISTINCT, genuinely different strategic directions this deck could be built toward.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "A short 2-4 word name for the direction, e.g. 'Go-wide tokens' or 'Hard control'." },
          text: { type: "string", description: "1-2 sentences describing the direction and what kinds of cards it would prioritize." },
        },
        required: ["title", "text"],
      },
    },
  },
  required: ["directions"],
};

async function generateDirections(env, deckId) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "AI is not configured." }, 503);
  const deck = await env.DB.prepare("SELECT * FROM decks WHERE id = ?").bind(deckId).first();
  if (!deck) return json({ error: "Deck not found" }, 404);
  const cards = (
    await env.DB.prepare("SELECT name FROM cards WHERE deck_id = ? ORDER BY position, id").bind(deckId).all()
  ).results || [];
  const list = cards.map((c) => c.name).join(", ");

  const out = await anthropicJSON(env, {
    model: "claude-sonnet-5",
    max_tokens: 1200,
    system:
      "You are an expert Magic: The Gathering Commander deck advisor. Given a deck, propose exactly 3 DISTINCT directions the " +
      "player could realistically take it, each meaningfully different (e.g. a budget-friendly route, a higher-power competitive route, " +
      "and a theme/archetype pivot). Each must fit the commander's color identity and build on cards already present. Be specific and practical.",
    messages: [{
      role: "user",
      content: `Deck: ${deck.title}\nCommander: ${deck.commander}${deck.alt_commander ? " / " + deck.alt_commander : ""}\n\nCurrent cards: ${list}\n\nPropose 3 distinct directions.`,
    }],
    output_config: { format: { type: "json_schema", schema: DIRECTIONS_SCHEMA } },
  });
  if (!out.ok) return aiBusyError();
  const data = out.data;
  const tb = (data.content || []).find((b) => b.type === "text");
  let parsed;
  try { parsed = JSON.parse(tb.text); } catch (_) { return json({ error: "Malformed AI output." }, 502); }
  const directions = (parsed.directions || []).slice(0, 3).map((d) => ({ title: String(d.title || "").trim(), text: String(d.text || "").trim() }));
  await env.DB.prepare("UPDATE decks SET directions = ? WHERE id = ?")
    .bind(JSON.stringify(directions), deckId)
    .run();
  return json({ ok: true, directions });
}

// Identify a Magic card from a photo using Claude's vision model.
const SCAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "The exact printed card name, or empty string if not a readable MTG card." },
    set: { type: "string", description: "The 3-5 letter set code if legible (often near the bottom), else empty string." },
    collector: { type: "string", description: "The collector number if visible, else empty string." },
  },
  required: ["name", "set", "collector"],
};

async function scanCard(env, body) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "AI is not configured." }, 503);
  const dataB64 = String(body.image || "").replace(/^data:[^,]+,/, "");
  if (!dataB64) return json({ error: "No image provided." }, 400);
  const media = body.media || "image/jpeg";

  const out = await anthropicJSON(env, {
    model: "claude-sonnet-5",
    max_tokens: 300,
    system:
      "You identify Magic: The Gathering cards from a photo. Return the EXACT printed card name. " +
      "If the set code (a 3-5 letter code, usually bottom-left near the collector number) and collector number are clearly legible, include them; otherwise leave them as empty strings. " +
      "If the image is not a readable Magic card, return an empty name.",
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: media, data: dataB64 } },
        { type: "text", text: "Identify this Magic: The Gathering card." },
      ],
    }],
    output_config: { format: { type: "json_schema", schema: SCAN_SCHEMA } },
  });
  if (!out.ok) return aiBusyError();
  const tb = (out.data.content || []).find((b) => b.type === "text");
  let parsed;
  try { parsed = JSON.parse(tb.text); } catch (_) { return json({ error: "Could not read the card." }, 502); }
  return json({
    name: String(parsed.name || "").trim(),
    set: String(parsed.set || "").trim().toUpperCase(),
    collector: String(parsed.collector || "").trim(),
  });
}

// Draft a Commander deck concept from a natural-language description.
const BUILD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    deck_name: { type: "string", description: "A short, catchy name for the deck." },
    commander: { type: "string", description: "The exact name of a legal commander that fits the concept." },
    colors: { type: "array", items: { type: "string", enum: ["W", "U", "B", "R", "G"] }, description: "The commander's color identity." },
    strategy: { type: "string", description: "2-4 sentence game plan: how the deck wins and what it does." },
    cards: {
      type: "array",
      description: "About 25-40 KEY cards for the deck (not a full 100), the most important picks across roles.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Exact real Magic card name, in the commander's colors." },
          role: { type: "string", description: "Short category: Ramp, Fixing, Card Draw, Removal, Board Wipe, Protection, Payoff, Wincon, Synergy, or Land." },
          why: { type: "string", description: "One short clause on why it's included." },
        },
        required: ["name", "role", "why"],
      },
    },
  },
  required: ["deck_name", "commander", "colors", "strategy", "cards"],
};

const BUILD_SYSTEM =
  "You are an expert Magic: The Gathering Commander (EDH) deck builder. Given a player's concept and (optionally) a target " +
  "Commander Bracket (1 Exhibition, 2 Core, 3 Upgraded, 4 Optimized, 5 cEDH), design a deck: choose a legal commander that genuinely " +
  "fits the theme, give its color identity, a concise game plan, and ~25-40 of the most important cards across roles (ramp, fixing, " +
  "card draw, removal, wipes, protection, payoffs, wincons, key synergy pieces, and a few signature lands). Use only real, " +
  "format-legal cards within the commander's color identity. Match the requested power/bracket. Be specific and practical. " +
  "CRITICAL CONSISTENCY RULES: Decide on ONE commander first and commit to it. The 'colors' MUST be exactly that commander's " +
  "color identity, and every single card MUST fit within those colors. Do NOT change your commander choice partway through. " +
  "The 'strategy' field must contain ONLY the final game plan as polished prose — never include reasoning, second-guessing, " +
  "or words like 'wait' or 'actually'.";

async function buildIdea(env, body) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "AI is not configured." }, 503);
  const concept = String(body.concept || "").trim();
  if (!concept) return json({ error: "Describe the deck you want." }, 400);
  const bracket = body.bracket ? ` Target power level: Bracket ${body.bracket}.` : "";

  const out = await anthropicJSON(env, {
    model: "claude-opus-4-8",
    max_tokens: 3500,
    system: BUILD_SYSTEM,
    messages: [{ role: "user", content: `Design a Commander deck for this idea: ${concept}.${bracket}` }],
    output_config: { format: { type: "json_schema", schema: BUILD_SCHEMA } },
  });
  if (!out.ok) return aiBusyError();
  const tb = (out.data.content || []).find((b) => b.type === "text");
  let p;
  try { p = JSON.parse(tb.text); } catch (_) { return json({ error: "Could not parse the deck idea." }, 502); }

  const cmap = { W: "w", U: "u", B: "k", R: "r", G: "g" };
  const colors = (p.colors || []).map((c) => cmap[c]).filter(Boolean);

  // Cross-reference suggested cards against the loose pile to flag what the player owns.
  const loose = (await env.DB.prepare("SELECT id, name FROM cards WHERE location = 'loose'").all()).results || [];
  const looseByNorm = new Map();
  for (const l of loose) { const k = normName(l.name); if (!looseByNorm.has(k)) looseByNorm.set(k, l.id); }
  const cards = (p.cards || []).map((c) => {
    const id = looseByNorm.get(normName(c.name));
    return { name: String(c.name || "").trim(), role: String(c.role || "Other").trim(), why: String(c.why || "").trim(), owned: !!id, looseId: id || null };
  });

  return json({
    deckName: String(p.deck_name || "").trim() || String(p.commander || "").trim(),
    commander: String(p.commander || "").trim(),
    colors,
    strategy: String(p.strategy || "").trim(),
    cards,
  });
}

/* ----------------------------- analysis engine ----------------------------- */

// AI tagging pass (spec §1 phase 1): assign controlled-vocab roles + a weight
// (core/flex/filler) to every card in the deck. Stored on each card row.
const TAG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    cards: {
      type: "array",
      description: "One entry per card in the decklist, in any order. Cover every card.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "The card name, copied verbatim from the decklist." },
          roles: {
            type: "array",
            description:
              "All roles this card fills (a card may hold several). Use ONLY these tags: " +
              ROLE_VOCAB.join(", ") +
              ". Lands get 'land' (plus 'fixing'/'ramp' if they fix colors or ramp). 'card_advantage' is the umbrella for card_draw plus engines/impulse/selection. Use 'filler' only for cards with no real function.",
            items: { type: "string", enum: ROLE_VOCAB },
          },
          weight: {
            type: "string",
            enum: ["core", "flex", "filler"],
            description: "core = key strategy piece; flex = useful but swappable; filler = weakest, first to cut.",
          },
        },
        required: ["name", "roles", "weight"],
      },
    },
  },
  required: ["cards"],
};

const TAG_SYSTEM =
  "You are an expert Magic: The Gathering Commander deck analyst. You tag each card in a deck with its functional " +
  "roles (from a fixed controlled vocabulary) and a weight (core/flex/filler). Tag based on what the card actually " +
  "does in THIS deck given its commander and strategy. A card can have multiple roles — capture double-duty (e.g. a " +
  "card that draws and ramps gets both card_draw and ramp). Every card must appear exactly once. Be accurate, not generous.";

async function tagDeck(env, deckId) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "AI is not configured. Add ANTHROPIC_API_KEY." }, 503);
  }
  const deck = await env.DB.prepare("SELECT * FROM decks WHERE id = ?").bind(deckId).first();
  if (!deck) return json({ error: "Deck not found" }, 404);
  const cards = (
    await env.DB.prepare(
      "SELECT id, name, type_cat, mana_cost, cmc, roles FROM cards WHERE deck_id = ? ORDER BY position, id"
    ).bind(deckId).all()
  ).results || [];
  if (!cards.length) return json({ error: "This deck has no cards yet." }, 400);

  // Skip the AI call entirely if the decklist + direction haven't changed since the last tag pass.
  const sig = tagSig(cards, deck.goal);
  if (deck.tag_sig === sig && cards.every((c) => c.roles != null)) {
    return json({ ok: true, tagged: cards.length, total: cards.length, taggedAt: deck.tagged_at, cached: true });
  }

  const list = cards
    .map((c) => `${c.name} — ${c.type_cat || "?"}${c.mana_cost ? " " + c.mana_cost : ""}`)
    .join("\n");
  const userText =
    `Deck: ${deck.title}\nCommander: ${deck.commander}${deck.alt_commander ? " / " + deck.alt_commander : ""}\n` +
    (deck.goal ? `Strategy / direction: ${deck.goal}\n` : "") +
    `\nTag every card below with its roles and weight.\n\nDecklist:\n${list}`;

  const out = await anthropicJSON(env, {
    model: "claude-sonnet-5",
    max_tokens: 8000,
    system: TAG_SYSTEM,
    messages: [{ role: "user", content: userText }],
    output_config: { format: { type: "json_schema", schema: TAG_SCHEMA } },
  });
  if (!out.ok) return aiBusyError();
  const data = out.data;
  const tb = (data.content || []).find((b) => b.type === "text");
  let parsed;
  try {
    parsed = JSON.parse(tb.text);
  } catch (_) {
    return json({ error: "AI returned malformed tagging output." }, 502);
  }

  // Match AI results back to card rows by NORMALIZED name (handles case, punctuation,
  // accents, and DFC "Front // Back" front-face matching).
  const byName = new Map();
  for (const c of cards) byName.set(normName(c.name), c);
  const updates = [];
  const matched = new Set();
  for (const entry of parsed.cards || []) {
    const c = byName.get(normName(entry.name || ""));
    if (!c || matched.has(c.id)) continue;
    let roles = Array.isArray(entry.roles) ? entry.roles.filter((r) => ROLE_VOCAB.includes(r)) : [];
    if (c.type_cat === "Land" && !roles.includes("land")) roles.push("land");
    roles = [...new Set(roles)];
    const weight = ["core", "flex", "filler"].includes(entry.weight) ? entry.weight : "flex";
    updates.push(
      env.DB.prepare("UPDATE cards SET roles = ?, weight = ? WHERE id = ?").bind(JSON.stringify(roles), weight, c.id)
    );
    matched.add(c.id);
  }
  // Fallback: the AI commonly omits basic/extra lands. Tag any land it skipped as 'land'
  // so nothing land-shaped is ever left untagged.
  for (const c of cards) {
    if (matched.has(c.id)) continue;
    if (c.type_cat === "Land") {
      updates.push(
        env.DB.prepare("UPDATE cards SET roles = ?, weight = COALESCE(weight,'flex') WHERE id = ?")
          .bind(JSON.stringify(["land"]), c.id)
      );
      matched.add(c.id);
    }
  }
  for (let i = 0; i < updates.length; i += 100) await env.DB.batch(updates.slice(i, i + 100));
  const now = new Date().toISOString();
  try {
    await env.DB.prepare("UPDATE decks SET tagged_at = ?, tag_sig = ? WHERE id = ?").bind(now, sig, deckId).run();
  } catch (_) {
    // tag_sig column not migrated yet — still record tagged_at so tagging succeeds (caching kicks in post-migrate).
    await env.DB.prepare("UPDATE decks SET tagged_at = ? WHERE id = ?").bind(now, deckId).run();
  }
  return json({ ok: true, tagged: matched.size, total: cards.length, taggedAt: now });
}

// Deterministic numbers layer (spec §4) — exact, no AI. Reads stored roles + cmc + type.
// Standard benchmark bands; each deck may override the green [lo,hi] (spec §8).
const DEFAULT_BANDS = {
  lands: { label: "Lands", lo: 36, hi: 38, aLo: 2, aHi: 2 },
  ramp: { label: "Ramp", lo: 10, hi: 999, aLo: 3, aHi: 0 },
  cardAdvantage: { label: "Card advantage", lo: 10, hi: 999, aLo: 3, aHi: 0 },
  spotRemoval: { label: "Targeted removal", lo: 8, hi: 10, aLo: 2, aHi: 2 },
  boardWipes: { label: "Board wipes", lo: 2, hi: 3, aLo: 1, aHi: 1 },
};
function bandLabel(b) {
  return b.hi >= 999 ? b.lo + "+" : b.lo + "–" + b.hi;
}
function statusFromBand(value, b) {
  if (value >= b.lo && value <= b.hi) return "ok";
  if ((value >= b.lo - b.aLo && value < b.lo) || (b.hi < 999 && value > b.hi && value <= b.hi + b.aHi)) return "low";
  return "red";
}
// Merge a deck's saved overrides (just the green [lo,hi] per bucket) onto the defaults.
function effectiveBands(deckBenchmarks) {
  let over = {};
  try { over = deckBenchmarks ? JSON.parse(deckBenchmarks) : {}; } catch (_) {}
  const out = {};
  for (const key of Object.keys(DEFAULT_BANDS)) {
    const d = DEFAULT_BANDS[key];
    const o = over[key];
    let lo = d.lo, hi = d.hi;
    if (Array.isArray(o) && o.length >= 1 && Number.isFinite(o[0])) {
      lo = Math.max(0, Math.round(o[0]));
      hi = o.length >= 2 && Number.isFinite(o[1]) ? Math.max(lo, Math.round(o[1])) : 999;
    }
    out[key] = { label: d.label, lo, hi, aLo: d.aLo, aHi: d.aHi };
  }
  return out;
}

async function computeNumbers(env, deckId) {
  const deck = await env.DB.prepare("SELECT * FROM decks WHERE id = ?").bind(deckId).first();
  if (!deck) return { error: "Deck not found" };
  const cards = (
    await env.DB.prepare(
      "SELECT name, qty, type_cat, mana_cost, cmc, roles FROM cards WHERE deck_id = ? ORDER BY position, id"
    ).bind(deckId).all()
  ).results || [];

  const tagged = cards.filter((c) => c.roles).length;
  const has = (c, role) => safeRoles(c.roles).includes(role);
  const qty = (c) => c.qty || 1;
  const sum = (pred) => cards.reduce((s, c) => s + (pred(c) ? qty(c) : 0), 0);

  const isLand = (c) => c.type_cat === "Land" || has(c, "land");
  const lands = sum(isLand);
  const counts = {
    lands,
    ramp: sum((c) => has(c, "ramp")),
    cardAdvantage: sum((c) => has(c, "card_draw") || has(c, "card_advantage")),
    spotRemoval: sum((c) => has(c, "spot_removal")),
    boardWipes: sum((c) => has(c, "board_wipe")),
    counterspells: sum((c) => has(c, "counterspell")),
    tutors: sum((c) => has(c, "tutor")),
    protection: sum((c) => has(c, "protection")),
    recursion: sum((c) => has(c, "recursion")),
    wincons: sum((c) => has(c, "wincon")),
  };

  // Benchmarks (spec §4.1) — default bands merged with this deck's overrides.
  const bands = effectiveBands(deck.benchmarks);
  const benchmarks = ["lands", "ramp", "cardAdvantage", "spotRemoval", "boardWipes"].map((key) => ({
    key,
    label: bands[key].label,
    value: counts[key],
    target: bandLabel(bands[key]),
    status: statusFromBand(counts[key], bands[key]),
    band: [bands[key].lo, bands[key].hi >= 999 ? null : bands[key].hi],
  }));

  // Curve + mana value (spec §4.2), nonland only
  const nonland = cards.filter((c) => !isLand(c));
  const curve = [0, 0, 0, 0, 0, 0, 0, 0]; // buckets 0,1,2,3,4,5,6,7+
  let mvSum = 0, nonlandCount = 0;
  for (const c of nonland) {
    const n = qty(c);
    const mv = typeof c.cmc === "number" ? c.cmc : 0;
    const b = Math.min(7, Math.floor(mv));
    curve[b] += n;
    mvSum += mv * n;
    nonlandCount += n;
  }
  const avgManaValue = nonlandCount ? +(mvSum / nonlandCount).toFixed(1) : 0;
  const earlyPlays = sum((c) => !isLand(c) && (typeof c.cmc === "number" ? c.cmc : 9) <= 2 &&
    (has(c, "ramp") || has(c, "fixing") || has(c, "spot_removal") || has(c, "counterspell") || has(c, "card_draw")));

  // Color pips (spec §4.3): count colored symbols across the decklist
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const c of cards) {
    const toks = String(c.mana_cost || "").match(/\{[^}]+\}/g) || [];
    for (const t of toks) for (const col of ["W", "U", "B", "R", "G"]) if (t.includes(col)) pips[col] += qty(c);
  }

  const totalCards = cards.reduce((s, c) => s + qty(c), 0);
  return {
    tagged, total: cards.length, totalCards, taggedAt: deck.tagged_at || null,
    counts, benchmarks, curve, avgManaValue, earlyPlays, pips,
  };
}

/* ----------------------------- Scryfall prices ----------------------------- */

// Map a Scryfall type_line to a single display category (Moxfield-style).
function categoryFromTypeLine(t) {
  t = (t || "").toLowerCase();
  if (!t) return "Other";
  if (t.includes("creature")) return "Creature";
  if (t.includes("planeswalker")) return "Planeswalker";
  if (t.includes("land")) return "Land";
  if (t.includes("instant")) return "Instant";
  if (t.includes("sorcery")) return "Sorcery";
  if (t.includes("artifact")) return "Artifact";
  if (t.includes("enchantment")) return "Enchantment";
  if (t.includes("battle")) return "Battle";
  return "Other";
}

// Validate a hand-typed category against the known set (else null).
function normalizeCategory(v) {
  const cats = ["Creature", "Planeswalker", "Instant", "Sorcery", "Artifact", "Enchantment", "Battle", "Land", "Other"];
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  return cats.find((c) => c.toLowerCase() === s) || null;
}

// Fetch price + type + mana data for the given card names via Scryfall's
// collection endpoint (75 per request) and update every matching card row.
async function enrichByNames(env, names) {
  const originals = [...new Set((names || []).filter(Boolean))];
  if (!originals.length) return { matched: 0 };
  const clean = (n) => String(n).replace(/\s*\([^)]*\)\s*$/, "").trim();

  // Pricing is printing-specific, so we need each row's set. Load the actual rows
  // for these names and group by (cleaned name + set).
  const origSet = new Set(originals);
  const allRows = (await env.DB.prepare("SELECT id, name, set_code FROM cards").all()).results || [];
  const rows = allRows.filter((r) => origSet.has(r.name));
  if (!rows.length) return { matched: 0 };

  const groups = new Map(); // key -> { cname, setLower, ids: [] }
  for (const r of rows) {
    const cname = clean(r.name);
    const setLower = String(r.set_code || "").trim().toLowerCase();
    const key = cname.toLowerCase() + "|" + setLower;
    if (!groups.has(key)) groups.set(key, { cname, setLower, ids: [] });
    groups.get(key).ids.push(r.id);
  }
  const entries = [...groups.values()];
  const now = new Date().toISOString();
  const HEADERS = {
    "content-type": "application/json",
    Accept: "application/json",
    "User-Agent": "BarringtonMTGCollection/1.0",
  };

  // Update one row (by id) from a Scryfall card. set_code is filled only when blank,
  // so a printing the user typed is preserved.
  const buildUpdate = (card, id) => {
    const usd =
      card.prices && (card.prices.usd || card.prices.usd_foil)
        ? parseFloat(card.prices.usd || card.prices.usd_foil)
        : null;
    const usdFoil = card.prices && card.prices.usd_foil ? parseFloat(card.prices.usd_foil) : null;
    const face = card.card_faces && card.card_faces[0];
    const mc = card.mana_cost || (face && face.mana_cost) || "";
    const img =
      (card.image_uris && (card.image_uris.art_crop || card.image_uris.normal)) ||
      (face && face.image_uris && (face.image_uris.art_crop || face.image_uris.normal)) ||
      null;
    const setCode = card.set ? String(card.set).toUpperCase() : null;
    return env.DB.prepare(
      "UPDATE cards SET price_usd = ?, price_foil = ?, type_cat = ?, cmc = ?, mana_cost = ?, produced = ?, image = ?, price_updated_at = ?, " +
        "set_code = CASE WHEN set_code IS NULL OR set_code = '' THEN ? ELSE set_code END WHERE id = ?"
    ).bind(
      usd,
      usdFoil,
      categoryFromTypeLine(card.type_line),
      typeof card.cmc === "number" ? card.cmc : null,
      mc,
      Array.isArray(card.produced_mana) ? card.produced_mana.join(",") : null,
      img,
      now,
      setCode,
      id
    );
  };

  const updates = [];
  const matchedIds = new Set();
  for (let i = 0; i < entries.length; i += 75) {
    const chunk = entries.slice(i, i + 75);
    // Use {name,set} when the set is known (exact printing → exact price), else {name}.
    const identifiers = chunk.map((e) => (e.setLower ? { name: e.cname, set: e.setLower } : { name: e.cname }));
    // Retry the batch on a Scryfall rate-limit/5xx so a fast full sweep never leaves gaps.
    // Patient exponential backoff (honoring Retry-After) rides out sustained 429s.
    let data = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ identifiers }),
        });
        if (res.ok) { data = await res.json(); break; }
        if (res.status === 429 || res.status >= 500) {
          const ra = parseInt(res.headers.get("retry-after") || "0", 10);
          const wait = ra > 0 ? Math.min(20000, ra * 1000) : Math.min(12000, 800 * Math.pow(2, attempt));
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        break; // other errors: give up on this batch
      } catch (_) {
        await new Promise((r) => setTimeout(r, Math.min(12000, 800 * Math.pow(2, attempt))));
      }
    }
    if (data) {
      const cards = data.data || [];
      for (const e of chunk) {
        let card = null;
        if (e.setLower) card = cards.find((cd) => cd.name.toLowerCase() === e.cname.toLowerCase() && String(cd.set || "").toLowerCase() === e.setLower);
        if (!card) card = cards.find((cd) => cd.name.toLowerCase() === e.cname.toLowerCase());
        if (!card) continue;
        for (const id of e.ids) { updates.push(buildUpdate(card, id)); matchedIds.add(id); }
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  // Fuzzy fallback (by name) for groups the exact lookup missed — wrong/odd set codes,
  // misspellings, DFC front-only names. Bounded to stay within the subrequest budget.
  const unmatched = entries.filter((e) => !e.ids.some((id) => matchedIds.has(id)));
  const FUZZY_CAP = 30;
  for (const e of unmatched.slice(0, FUZZY_CAP)) {
    const seed = e.cname.split(/\s+[\[(]/)[0].trim();
    if (!seed) continue;
    try {
      const res = await fetch(
        "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(seed),
        { headers: HEADERS }
      );
      if (res.ok) {
        const card = await res.json();
        if (card && card.name) for (const id of e.ids) { updates.push(buildUpdate(card, id)); matchedIds.add(id); }
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  for (let i = 0; i < updates.length; i += 100) {
    await env.DB.batch(updates.slice(i, i + 100));
  }
  return { matched: matchedIds.size };
}

// Re-price + re-type the whole collection.
// Re-price + re-type just one deck's cards (fast — no AI).
async function refreshDeckPrices(env, deckId) {
  const rows = (await env.DB.prepare("SELECT DISTINCT name FROM cards WHERE deck_id = ?").bind(deckId).all()).results || [];
  if (!rows.length) return { ok: true, matched: 0, total: 0 };
  const r = await enrichByNames(env, rows.map((x) => x.name));
  return { ok: true, matched: r.matched, total: rows.length, updatedAt: new Date().toISOString() };
}

async function enrichAll(env, offset = 0, limit = null) {
  const rows = (await env.DB.prepare("SELECT DISTINCT name FROM cards ORDER BY name").all()).results || [];
  const total = rows.length;
  const slice = limit ? rows.slice(offset, offset + limit) : rows;
  const r = await enrichByNames(env, slice.map((x) => x.name));
  const processed = limit ? Math.min(total, offset + slice.length) : total;
  return { ok: true, matched: r.matched, total, processed, done: processed >= total, updatedAt: new Date().toISOString() };
}

/* ----------------------------- AI analysis ----------------------------- */

async function getAnalysis(env, deckId) {
  const row = await env.DB.prepare(
    "SELECT content, model, generated_at, collection, collection_at FROM analysis WHERE deck_id = ?"
  )
    .bind(deckId)
    .first();
  if (!row) return { exists: false, collection: { exists: false } };
  const hasMain = !!row.content;
  return {
    exists: hasMain,
    analysis: hasMain ? JSON.parse(row.content) : null,
    model: row.model,
    generatedAt: row.generated_at,
    collection: row.collection
      ? { exists: true, recs: JSON.parse(row.collection), generatedAt: row.collection_at }
      : { exists: false },
  };
}

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "2-4 sentence summary of the deck's game plan." },
    strengths: { type: "string", description: "2-4 sentences on the deck's strengths." },
    weaknesses: { type: "string", description: "2-4 sentences on what shuts this deck down (e.g. artifact/graveyard hate, stax, counters, land destruction)." },
    win_conditions: { type: "string", description: "The distinct paths to victory, how many there are, and the earliest realistic turn it can close. Flag if it relies on a single fragile path." },
    interaction: { type: "string", description: "Quality and speed of the removal/counters, and whether the deck is racing (aggressive) or controlling." },
    synergy_redundancy: { type: "string", description: "Core strategy pieces vs filler, and where functional redundancy is too thin or excessive." },
    speed: { type: "string", description: "Estimated goldfish turn (turn it can win uninterrupted) and what power level that implies." },
    budget_swaps: {
      type: "array",
      description: "Exactly 5 budget upgrade suggestions (roughly under $10 each).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          add: { type: "string", description: "Real MTG card to add (fits color identity)." },
          remove: { type: "string", description: "A card from the provided list to cut." },
          reason: { type: "string", description: "1-2 sentences on why this helps." },
          price: { type: "string", description: "Estimated USD range, e.g. '$2-4'." },
        },
        required: ["add", "remove", "reason", "price"],
      },
    },
    premium_swaps: {
      type: "array",
      description: "Exactly 5 high-impact upgrade suggestions (roughly $15+ each).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          add: { type: "string" },
          remove: { type: "string" },
          reason: { type: "string" },
          price: { type: "string" },
        },
        required: ["add", "remove", "reason", "price"],
      },
    },
    bracket: {
      type: "integer",
      description: "The deck's official Commander Bracket, an integer 1-5: 1=Exhibition (ultra-casual), 2=Core (precon-level), 3=Upgraded (well-tuned, strong cards, no fast/early combos), 4=Optimized (high-power, very efficient, may include combos), 5=cEDH (competitive, fast and resilient).",
    },
    bracket_note: { type: "string", description: "One sentence justifying the bracket." },
  },
  required: ["summary", "strengths", "weaknesses", "win_conditions", "interaction", "synergy_redundancy", "speed", "budget_swaps", "premium_swaps", "bracket", "bracket_note"],
};

const ANALYSIS_SYSTEM =
  "You are an expert Magic: The Gathering Commander (EDH) deck analyst. " +
  "You will be given a deck's commander, color identity, and full decklist. " +
  "Produce a concise strategy summary, its strengths, its weaknesses, and card-swap suggestions. " +
  "Rules for swaps: the 'remove' card MUST be a card that actually appears in the provided decklist; " +
  "the 'add' card MUST be a real Magic: The Gathering card that legally fits the deck's color identity and improves it. " +
  "Provide exactly 5 budget swaps (affordable upgrades, roughly under $10 each) and exactly 5 premium swaps " +
  "(high-impact upgrades, roughly $15 or more each). These swaps ARE the deck's upgrade path: the 'remove' side should be " +
  "the deck's weakest/most cuttable cards, the 'add' side the replacements that shore up whatever the numbers show is thin. " +
  "Never suggest adding a card the deck already runs. " +
  "Keep each reason to 1-2 sentences. Prices are estimated USD market ranges like '$2-4' or '$25-35'. " +
  "Also write 'win_conditions', 'interaction', 'synergy_redundancy', and 'speed' (estimated goldfish turn + implied power level). " +
  "Also provide 'bracket' (the deck's official Commander Bracket, an integer 1-5: 1 Exhibition, 2 Core, 3 Upgraded, 4 Optimized, 5 cEDH) and 'bracket_note' (one sentence justifying it). " +
  "CRITICAL: You will be given VERIFIED counts (lands, ramp, card advantage, removal, wipes), the mana curve, average mana value, and color pips that were computed exactly from the deck data. " +
  "TREAT THESE NUMBERS AS GROUND TRUTH — do NOT recompute or contradict them. Your job is interpretation and judgment, not arithmetic. " +
  "Whenever you state a count in your text (lands, ramp, card advantage, removal, board wipes, etc.), you MUST use the EXACT number provided — e.g. if removal is 24, write 24, never an estimate like 20. Reference these numbers when you explain strengths, weaknesses, and what the swaps fix.";

async function generateAnalysis(env, deckId) {
  if (!env.ANTHROPIC_API_KEY) {
    return json(
      {
        error:
          "AI analysis is not configured yet. Add your Anthropic API key with: wrangler secret put ANTHROPIC_API_KEY",
      },
      503
    );
  }

  const deck = await env.DB.prepare("SELECT * FROM decks WHERE id = ?")
    .bind(deckId)
    .first();
  if (!deck) return json({ error: "Deck not found" }, 404);

  const cardsRes = await env.DB.prepare(
    "SELECT name, set_code, qty FROM cards WHERE deck_id = ? ORDER BY position, id"
  )
    .bind(deckId)
    .all();
  const cards = cardsRes.results || [];
  if (cards.length === 0) {
    return json(
      { error: "This deck has no cards yet — add the decklist first." },
      400
    );
  }

  // Skip the AI call entirely if the decklist + direction haven't changed since the last analysis.
  const sig = analysisSig(cards, deck);
  let existingRow = null;
  try {
    existingRow = await env.DB.prepare(
      "SELECT content, analysis_sig, model, generated_at FROM analysis WHERE deck_id = ?"
    ).bind(deckId).first();
  } catch (_) {
    // analysis_sig column not migrated yet — skip the cache lookup (caching kicks in post-migrate).
    existingRow = null;
  }
  if (existingRow && existingRow.content && existingRow.analysis_sig === sig) {
    return json({
      exists: true,
      analysis: JSON.parse(existingRow.content),
      model: existingRow.model,
      generatedAt: existingRow.generated_at,
      cached: true,
    });
  }

  const colorNames = {
    w: "White",
    u: "Blue",
    k: "Black",
    r: "Red",
    g: "Green",
  };
  const colors = (deck.pips || "")
    .split(",")
    .filter(Boolean)
    .map((c) => colorNames[c] || c)
    .join(", ");

  // Ensure the deck is role-tagged so the verified numbers are meaningful (spec §5),
  // then compute them deterministically and feed them to the AI as ground truth.
  const taggedCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM cards WHERE deck_id = ? AND roles IS NOT NULL"
  ).bind(deckId).first();
  if (!taggedCount || !taggedCount.n) {
    await tagDeck(env, deckId); // best effort; writes roles onto the card rows
  }
  const num = await computeNumbers(env, deckId);

  const list = cards.map((c) => `${c.qty} ${c.name}`).join("\n");
  const relianceLine = deck.reliance ? `\nCommander reliance on the player: ${deck.reliance}` : "";
  const numbersText =
    `\n\nVERIFIED NUMBERS (computed exactly from the deck — treat as ground truth, do NOT recompute):\n` +
    `Lands: ${num.counts.lands} (target 36-38)\n` +
    `Ramp: ${num.counts.ramp} (target 10+)\n` +
    `Card advantage: ${num.counts.cardAdvantage} (target 10+)\n` +
    `Targeted removal: ${num.counts.spotRemoval} (target 8-10)\n` +
    `Board wipes: ${num.counts.boardWipes} (target 2-3)\n` +
    `Counterspells: ${num.counts.counterspells} · Tutors: ${num.counts.tutors} · Protection: ${num.counts.protection} · Recursion: ${num.counts.recursion} · Wincons: ${num.counts.wincons}\n` +
    `Mana curve, nonland (MV 0,1,2,3,4,5,6,7+): ${num.curve.join(", ")}\n` +
    `Average mana value (nonland): ${num.avgManaValue} · early plays on turns 1-3: ${num.earlyPlays}\n` +
    `Color pips W/U/B/R/G: ${num.pips.W}/${num.pips.U}/${num.pips.B}/${num.pips.R}/${num.pips.G}`;
  const goalLine = deck.goal
    ? `\n\nThe player's intended direction / upgrade path for this deck — tailor the strategy summary, strengths, weaknesses, and ALL swap suggestions to support this direction:\n${deck.goal}`
    : "";
  const userText =
    `Deck name: ${deck.title}\n` +
    `Commander: ${deck.commander}${deck.alt_commander ? " / " + deck.alt_commander : ""}\n` +
    `Color identity: ${colors}${relianceLine}\n\n` +
    `Decklist:\n${list}` +
    numbersText +
    goalLine;

  const ANALYSIS_MODEL = "claude-sonnet-5";
  const body = {
    model: ANALYSIS_MODEL,
    max_tokens: 4000,
    system: ANALYSIS_SYSTEM,
    messages: [{ role: "user", content: userText }],
    output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
  };

  const out = await anthropicJSON(env, body);
  if (!out.ok) return aiBusyError();
  const data = out.data;
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) return json({ error: "No analysis returned by the model." }, 502);

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (_) {
    return json({ error: "Could not parse the model's response." }, 502);
  }

  const analysis = {
    summary: parsed.summary,
    strengths: parsed.strengths,
    weaknesses: parsed.weaknesses,
    winConditions: parsed.win_conditions,
    interaction: parsed.interaction,
    synergyRedundancy: parsed.synergy_redundancy,
    speed: parsed.speed,
    low: (parsed.budget_swaps || []).map((s) => ({
      i: s.add,
      o: s.remove,
      r: s.reason,
      p: s.price,
    })),
    high: (parsed.premium_swaps || []).map((s) => ({
      i: s.add,
      o: s.remove,
      r: s.reason,
      p: s.price,
    })),
    power: parsed.bracket,
    powerNote: parsed.bracket_note,
  };

  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO analysis (deck_id, content, model, generated_at, analysis_sig) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(deck_id) DO UPDATE SET content = excluded.content, model = excluded.model, generated_at = excluded.generated_at, analysis_sig = excluded.analysis_sig"
    )
      .bind(deckId, JSON.stringify(analysis), ANALYSIS_MODEL, now, sig)
      .run();
  } catch (_) {
    // analysis_sig column not migrated yet — save without it so analysis still works (caching kicks in post-migrate).
    await env.DB.prepare(
      "INSERT INTO analysis (deck_id, content, model, generated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(deck_id) DO UPDATE SET content = excluded.content, model = excluded.model, generated_at = excluded.generated_at"
    )
      .bind(deckId, JSON.stringify(analysis), ANALYSIS_MODEL, now)
      .run();
  }
  try {
    await env.DB.prepare("UPDATE decks SET power = ? WHERE id = ?")
      .bind(parsed.bracket || null, deckId)
      .run();
  } catch (_) {}

  return json({ exists: true, analysis, model: ANALYSIS_MODEL, generatedAt: now });
}

const COLLECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    recommendations: {
      type: "array",
      description:
        "Only genuinely good upgrades drawn ONLY from the owned loose-card list. Return an empty array if none are worth recommending — do NOT pad to a fixed count.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          add: { type: "string", description: "Card to add — MUST be one of the owned loose-card names, verbatim." },
          remove: { type: "string", description: "For a SWAP: a card from the decklist to cut. For a pure ADD that fills an open slot (deck under 100 cards), use an empty string." },
          reason: { type: "string", description: "1-2 sentences on why this owned card improves the deck." },
        },
        required: ["add", "remove", "reason"],
      },
    },
  },
  required: ["recommendations"],
};

const COLLECTION_SYSTEM =
  "You are an expert Magic: The Gathering Commander deck advisor. You are given a deck and a list of loose cards the " +
  "player already OWNS. Recommend ONLY owned cards that would genuinely improve this specific deck. The 'add' field must " +
  "be exactly one of the owned card names copied verbatim. " +
  "Each recommendation is EITHER a swap (set 'remove' to a card currently in the decklist to cut) OR a pure addition to " +
  "fill an open slot (set 'remove' to an empty string). Only use pure additions when the deck has open slots — i.e. it " +
  "currently has fewer than 100 cards; if the deck is already at 100, every recommendation must be a swap with a real " +
  "'remove'. When there are open slots, prioritize filling them with pure additions before suggesting swaps. " +
  "BE STRICT AND CONSERVATIVE. Only recommend an owned card when it is a CLEAR, confident upgrade that a thoughtful player " +
  "would actually make — something that should or genuinely could be swapped in. If a card is only a marginal, sideways, or " +
  "'maybe' change, DO NOT recommend it. When in doubt, leave it out. Returning an EMPTY list is the correct and expected " +
  "answer for a well-built deck — do not invent recommendations just to have something to show, and never pad to a fixed number. " +
  "Never recommend a card that is not in the owned list, NEVER recommend a card already in the decklist, and NEVER recommend " +
  "the same card more than once. If the player gives a direction or upgrade path, only recommend owned cards that clearly support it. " +
  "Keep each reason to 1-2 sentences and state concretely why it is better than what it replaces. " +
  "Make the list COMPLETE: include EVERY owned card that is a genuine, clear upgrade — do not stop at a 'top few' or any fixed number. " +
  "The count is whatever it honestly is — zero, a handful, or many — but every entry must be a real value-add to THIS commander; quality over quantity, never filler. " +
  "The player's saved Strategy & Direction is the PRIMARY measure of 'better' — judge every swap by how well the incoming card serves that direction. " +
  "Treat this as the deck's FINAL upgrade pass against the current owned pool: recommend every swap where a loose card is clearly better for the direction than a card in the deck, each paired with the single weakest deck card it beats. " +
  "The list MUST CONVERGE: after the player applies ALL of these swaps, no remaining loose card should be better than any card left in the deck — so regenerating would then correctly return an EMPTY list. " +
  "Never recommend a lateral or marginal change, and NEVER recommend adding a card that is weaker than the one it would replace (no churn or back-and-forth). If the deck is already the best it can be from the owned cards, return an empty list.";

async function generateCollection(env, deckId) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "AI analysis is not configured. Add ANTHROPIC_API_KEY." }, 503);
  }
  const deck = await env.DB.prepare("SELECT * FROM decks WHERE id = ?").bind(deckId).first();
  if (!deck) return json({ error: "Deck not found" }, 404);
  const cardsRes = await env.DB.prepare(
    "SELECT name, qty, mana_cost FROM cards WHERE deck_id = ? ORDER BY position, id"
  ).bind(deckId).all();
  const cards = cardsRes.results || [];
  if (!cards.length) return json({ error: "This deck has no cards yet." }, 400);

  const looseRes = await env.DB.prepare(
    "SELECT name, type_cat, mana_cost FROM cards WHERE location = 'loose'"
  ).all();
  const costColors = (mc) => {
    const set = new Set();
    (String(mc || "").match(/\{[^}]+\}/g) || []).forEach((tok) => {
      ["W", "U", "B", "R", "G"].forEach((c) => { if (tok.includes(c)) set.add(c); });
    });
    return set;
  };
  // The deck's mana pool (color identity). Authoritative source is the COMMANDER's
  // real color identity from Scryfall — saved pips can be wrong and must not be trusted.
  const SCRY_HEADERS = { Accept: "application/json", "User-Agent": "BarringtonMTGCollection/1.0" };
  const fetchIdentity = async (nm) => {
    const seed = String(nm || "").split(/\s+[[(]/)[0].trim();
    if (!seed) return null;
    try {
      const res = await fetch(
        "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(seed),
        { headers: SCRY_HEADERS }
      );
      if (res.ok) {
        const c = await res.json();
        if (Array.isArray(c.color_identity)) return c.color_identity;
      }
    } catch (_) {}
    return null;
  };
  const ident = new Set();
  let identFromCommander = false;
  for (const nm of [deck.commander, deck.alt_commander]) {
    if (!nm) continue;
    const ci = await fetchIdentity(nm);
    if (ci) {
      identFromCommander = true;
      ci.forEach((c) => ident.add(c));
    }
  }
  // Fallbacks only if the commander lookup failed: saved pips, then the deck's own cards.
  if (!identFromCommander) {
    (deck.pips || "").split(",").filter(Boolean).forEach((p) => ident.add(p === "k" ? "B" : p.toUpperCase()));
    if (ident.size === 0) cards.forEach((c) => costColors(c.mana_cost).forEach((col) => ident.add(col)));
  }
  const ownedNames = [
    ...new Set(
      (looseRes.results || [])
        .filter((c) => {
          if (c.type_cat === "Land") return true; // lands are colorless identity
          for (const col of costColors(c.mana_cost)) if (!ident.has(col)) return false;
          return true;
        })
        .map((c) => c.name)
    ),
  ].slice(0, 300);

  const now = new Date().toISOString();
  const saveRecs = async (recs, sig) => {
    await env.DB.prepare(
      "INSERT INTO analysis (deck_id, content, collection, collection_at, collection_sig) VALUES (?, '', ?, ?, ?) " +
        "ON CONFLICT(deck_id) DO UPDATE SET collection = excluded.collection, collection_at = excluded.collection_at, collection_sig = excluded.collection_sig"
    ).bind(deckId, JSON.stringify(recs), now, sig).run();
  };

  // Signature of the inputs that determine the recommendations. If nothing relevant
  // changed since last time, return the SAME saved list instead of re-rolling new swaps.
  const sig = collectionSig(cards.map((c) => c.name), ownedNames, deck.goal || "");
  const existing = await env.DB.prepare(
    "SELECT collection, collection_sig, collection_at FROM analysis WHERE deck_id = ?"
  ).bind(deckId).first();
  if (existing && existing.collection != null && existing.collection_sig === sig) {
    let recs = [];
    try { recs = JSON.parse(existing.collection); } catch (_) {}
    return json({ exists: true, recs, generatedAt: existing.collection_at || now, cached: true });
  }

  if (!ownedNames.length) {
    await saveRecs([], sig);
    return json({ exists: true, recs: [], generatedAt: now });
  }

  const colorFull = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
  const colors = [...ident].map((c) => colorFull[c] || c).join(", ") || "Colorless";
  const list = cards.map((c) => `${c.qty} ${c.name}`).join("\n");
  const total = cards.reduce((s, c) => s + (c.qty || 1), 0);
  const openSlots = Math.max(0, 100 - total);
  const goalLine = deck.goal
    ? `\n\nThe player's intended direction / upgrade path for this deck — only recommend owned cards that support it:\n${deck.goal}`
    : "";
  const userText =
    `Deck name: ${deck.title}\n` +
    `Commander: ${deck.commander}${deck.alt_commander ? " / " + deck.alt_commander : ""}\n` +
    `Color identity (STRICT — never recommend a card that needs any other color of mana): ${colors}\n` +
    `Deck size: ${total} of 100 cards (${openSlots} open slot${openSlots !== 1 ? "s" : ""} to fill — use pure additions for these).\n\n` +
    `Decklist:\n${list}` +
    goalLine +
    `\n\nLoose cards the player OWNS (recommend ONLY from these, each at most once, and never a card already in the decklist):\n${ownedNames.join("\n")}`;

  const body = {
    model: "claude-sonnet-5",
    max_tokens: 5000,
    system: COLLECTION_SYSTEM,
    messages: [{ role: "user", content: userText }],
    output_config: { format: { type: "json_schema", schema: COLLECTION_SCHEMA } },
  };
  const out = await anthropicJSON(env, body);
  if (!out.ok) return aiBusyError();
  const data = out.data;
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) return json({ error: "No response from the model." }, 502);
  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch (_) {
    return json({ error: "Could not parse the model's response." }, 502);
  }
  const ownedSet = new Set(ownedNames.map((n) => n.toLowerCase()));
  const deckSet = new Set(cards.map((c) => c.name.toLowerCase()));
  const seen = new Set();
  const recs = [];
  for (const s of parsed.recommendations || []) {
    const add = String(s.add || "").trim();
    const key = add.toLowerCase();
    // owned, not already in the deck, and not a duplicate of another recommendation
    if (!add || seen.has(key) || deckSet.has(key) || !ownedSet.has(key)) continue;
    seen.add(key);
    recs.push({ i: add, o: s.remove, r: s.reason });
  }
  await saveRecs(recs, sig);
  return json({ exists: true, recs, generatedAt: now });
}

// djb2 hash — stable, cheap signature for cache-key strings.
function sigHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return String(h);
}

// Stable signature of the inputs that determine collection recommendations.
function collectionSig(deckNames, ownedNames, goal) {
  return sigHash(deckNames.slice().sort().join("|") + "##" + ownedNames.slice().sort().join("|") + "##" + (goal || ""));
}

// Stable signature of the inputs that determine card tagging (roles/weight).
function tagSig(cards, goal) {
  const s = cards.map((c) => `${c.name}|${c.type_cat || ""}|${c.cmc ?? ""}`).sort().join("##") + "::" + (goal || "");
  return sigHash(s);
}

// Stable signature of the inputs that determine the main AI analysis.
function analysisSig(cards, deck) {
  const s =
    cards.map((c) => `${c.qty}x${c.name}`).sort().join("|") +
    "::" + (deck.goal || "") +
    "::" + deck.commander + "|" + (deck.alt_commander || "") + "|" + (deck.reliance || "");
  return sigHash(s);
}
