# Barrington MTG Collection — Claude Code Context

## What This Is
A personal Magic: The Gathering Commander collection tracker. Single-page web app, fully self-hosted on Cloudflare. **Jessie is non-technical** — explain things in plain English, give one step at a time, and run commands for her.

## Stack
- **Backend:** Cloudflare Worker (`src/worker.js`) — all API routes, DB logic, AI calls
- **Database:** Cloudflare D1 (SQLite) — `mtg-collection` database
- **Frontend:** Single vanilla JS file (`public/index.html`) — entire UI in one file, no framework
- **Deploy:** `npx wrangler deploy` from this folder
- **Live URL:** https://barrington-mtg.barrington-mtg-jessie.workers.dev

## Auth
- `OWNER_KEY` secret: `turtles123` — sent as `X-Owner-Key` header for write operations
- `SHARE_TOKEN`: `barrington-47ac9be1a4a44c54` — read-only share link at `/view/<token>`
- `ANTHROPIC_API_KEY`: stored as Cloudflare secret (set via `wrangler secret put ANTHROPIC_API_KEY`)

## Key Files
```
src/worker.js        — backend (routes, DB, AI, Scryfall)
public/index.html    — entire frontend (HTML + CSS + JS, ~2500 lines)
schema.sql           — reference schema (actual DB has extra columns added via ALTER TABLE)
wrangler.toml        — Cloudflare config
```

## Database — Cards Table Columns
The live DB has more columns than schema.sql (added via ALTER TABLE). Current full set:
`id, deck_id, location, name, set_code, qty, for_sale, is_commander, price_usd, price_foil, price_updated_at, type_cat, cmc, mana_cost, produced, roles, weight, potential_commander, image, foil, condition, acquisition_price, position`

Location values: `'deck'` | `'loose'` | `'wishlist'`

## AI — CRITICAL GOTCHA
**NEVER add `temperature` to Anthropic structured-output calls.** The `output_config.format.type="json_schema"` API rejects it with a 400 error. Use `collectionSig`/`tagSig`/`analysisSig` caching for determinism instead. All AI calls go through `anthropicJSON(env, payload, maxRetries=3)` which retries on 429/529/5xx.

## AI — Cost Control
Each AI call uses the smallest model that reliably handles its task (cost mitigation, added 2026-07). Every cached call skips the AI entirely (and shows `cached: true` in the response) when its signature is unchanged since last run:
| Call | Model | Cached via |
|---|---|---|
| `saveGoalWithSummary` (goal one-liner) | `claude-haiku-4-5-20251001` | — (tiny, always runs) |
| `generateDirections` | `claude-sonnet-5` | — |
| `scanCard` (vision) | `claude-sonnet-5` | — (per-photo, expected) |
| `tagDeck` | `claude-sonnet-5` | `decks.tag_sig` vs `tagSig(cards, goal)` |
| `generateAnalysis` | `claude-sonnet-5` | `analysis.analysis_sig` vs `analysisSig(cards, deck)` |
| `generateCollection` | `claude-sonnet-5` | `analysis.collection_sig` vs `collectionSig(...)` |
| `buildIdea` (deck builder) | `claude-opus-4-8` | — (kept on Opus: real-card legality + creative construction, highest hallucination risk) |

When adding a new AI call, pick a model deliberately rather than defaulting to Opus — reserve Opus for tasks needing deep knowledge/creativity where mistakes are costly (e.g. inventing illegal cards). Structured classification/extraction tasks (tagging, scanning, filtering) do fine on Sonnet; trivial one-liners do fine on Haiku.

## Scryfall Integration
- Batch pricing: POST `/cards/collection` (max 75 per request)
- Fuzzy fallback: GET `/cards/named?fuzzy=` (for DFC names, typos, etc.)
- 5-attempt retry with exponential backoff up to 12s
- `enrichByNames(env, names)` — set-aware pricing, updates by card ID
- `enrichAll(env, offset, limit)` — chunked full-collection refresh (150 at a time)

## Frontend Architecture
- `STATE` — global object loaded from `/api/state`, contains `{decks, loose, forsale, wishlist}`
- `load()` — fetches fresh state, re-renders current view
- `currentDeckId` / `currentView` — track which deck/tab is active
- After any card mutation: call `maybeRefreshNumbers()` to refresh Deck Analysis gauges
- Card rows use `data-img` attribute for hover image preview

## Key Frontend Functions
| Function | What it does |
|---|---|
| `renderDetail(d)` | Renders full deck view (cards + breakdown) |
| `renderBreakdown(d)` | Deck Overview panel (stats + mana analysis + legality + bracket) |
| `renderDash(n)` | Renders Deck Analysis gauges from computeNumbers result |
| `loadNumbers(deckId)` | Fetches `/api/decks/:id/numbers` and calls renderDash |
| `manaAnalysisHTML(d)` | Color breakdown + mana sources + curve |
| `computeManaBaseHTML(d)` | Frank Karsten mana base recommendations + swap suggestions |
| `computeLegalityHTML(d)` | Color identity / singleton / size checks |
| `computeBracketHTML(d)` | Rule-based bracket estimator (Game Changers list) |
| `generateAnalysis` / `genAnalysis()` | AI deck analysis |
| `generateCollection` / `genCollection()` | AI collection swap recommendations |
| `generateDirections` / `genDirections()` | AI 3 direction suggestions |
| `collectionSig()` / `tagSig()` / `analysisSig()` | djb2 hash (via `sigHash`) for caching collection recs / tagging / analysis — skips the AI call if inputs are unchanged |
| `anthropicJSON(env, payload)` | Retrying Anthropic API wrapper |

## Key Backend Routes
```
GET  /api/state                    → all decks, loose cards, for-sale, wishlist
POST /api/migrate                  → add new DB columns (safe to re-run)
POST /api/cards                    → add card (location: deck/loose/wishlist)
POST /api/cards/bulk               → bulk import from pasted decklist
PATCH /api/cards/:id               → edit card
DELETE /api/cards/:id              → remove card
POST /api/cards/:id/move           → move card between deck/loose/wishlist
POST /api/decks                    → create deck
PATCH /api/decks/:id               → edit deck (title, commander, pips, benchmarks, reliance)
DELETE /api/decks/:id              → delete deck
POST /api/decks/:id/tag            → AI tag all cards with roles+weight
GET  /api/decks/:id/numbers        → deterministic gauge computation (no AI)
POST /api/decks/:id/prices         → refresh prices for one deck
POST /api/decks/:id/goal           → save direction + AI-generate goal_summary
POST /api/decks/:id/collection     → AI collection swap recommendations (cached)
POST /api/decks/:id/directions     → AI 3 directions
GET  /api/analysis/:id             → get cached AI analysis
POST /api/analysis/:id             → generate AI deck analysis
POST /api/scan                     → AI card scanner (vision)
POST /api/build-idea               → AI deck builder from description
POST /api/refreshAll               → full collection price refresh (chunked)
```

## Features Already Built (DO NOT re-implement)
- Mana curve + color pip analysis
- Set-aware pricing via Scryfall
- Chunked price refresh with progress %
- AI deck analysis (with roles/weight/benchmarks/gauges)
- Commander roster + potential-commander toggle
- 3 AI direction suggestions per deck
- Adjustable per-deck benchmarks
- Card scanner (vision AI)
- Describe-a-deck AI builder
- Deck Overview: legality check, mana base calculator, rule-based bracket estimator
- Collection value dashboard on home page
- Global search ("where is this card")
- Deck export (plain text + Moxfield format)
- Sample hand drawer
- Wishlist tab
- Card hover image preview
- For Sale: condition-adjusted + foil-aware pricing
- Foil / condition / acquisition price fields on cards
- Mobile responsive layout

## Deck Analysis Numbers (computeNumbers)
Reads `roles` JSON from cards. Role vocab (18 tags): `ramp`, `card-draw`, `tutor`, `removal`, `wipe`, `counter`, `land`, `commander-synergy`, `protection`, `reanimation`, `graveyard`, `token`, `combo-piece`, `value-engine`, `hate`, `beater`, `utility`, `filler`.

Default benchmarks: lands 36-38, ramp 10+, card-draw 10+, removal 8-10, wipes 2-3.

## Brackets
1=Exhibition, 2=Core, 3=Upgraded, 4=Optimized, 5=cEDH. Stored as `decks.power`.

## mapCard Returns
`{id, n, s, q, p, t, cmc, mc, prod, fs, cmd, img, roles, weight, pc, pu, foil, cond, acq, pf}`

(n=name, s=set, q=qty, p=price_usd, t=type_cat, mc=mana_cost, prod=produced, fs=for_sale, cmd=is_commander, img=image, pc=potential_commander, pu=price_updated_at, pf=price_foil, cond=condition, acq=acquisition_price)

## DB Migration
New columns are added via `/api/migrate` endpoint (POST, owner-only). Safe to run multiple times — catches "column already exists" errors. Run it via the "⚙ DB Migrate" button on the home page after deploying new columns.

## Working With This Codebase
- **Always read the file before editing** — both files are large (~1700 and ~2500 lines)
- **Use targeted Edit tool calls** — don't rewrite whole sections unless necessary
- **Test by deploying** — `npx wrangler deploy` takes ~10s; the live URL updates immediately
- **No hot reload** — changes require a deploy to see in the browser
- **D1 is production** — there is no dev database separate from prod for this app; be careful with schema changes
- **DO NOT re-run seed** (`npm run db:seed`) — it wipes the database
