# Barrington MTG Collection

A full-stack web app for tracking your Magic: The Gathering Commander collection.

- **7 Commander decks** with full card lists, color pips, and a per-deck **AI Analysis** button
  (strengths, weaknesses, game plan, and 5 budget + 5 premium swap suggestions, powered by Claude).
- **Loose cards** list and a **For Sale** list with live **Scryfall prices** and TCGplayer links.
- A **read-only share link** you can send to a second viewer (e.g. Marcus) — they see everything,
  but cannot edit.
- Runs on **Cloudflare** (Workers + D1 database). Free tier, no credit card required for Cloudflare.
  The only paid piece is the Claude AI Analysis (a few cents per deck, billed by Anthropic).

Everything you see is stored in a real database, so your edits persist and your viewer sees them.

---

## What's in this folder

| Path | What it is |
|---|---|
| `public/index.html` | The whole front-end (the app you see in the browser) |
| `src/worker.js` | The backend API (runs on Cloudflare) |
| `schema.sql` | Creates the database tables |
| `seed.sql` | Your starting data (decks + loose + for-sale), already generated |
| `data/*.json` | The source data; `npm run build-seed` regenerates `seed.sql` from it |
| `wrangler.toml` | Cloudflare project config |

---

## One-time setup

You'll do this once. It looks like a lot, but each step is a single copy-paste command.

### 1. Install Node.js

Download and install the **LTS** version from <https://nodejs.org>. This also installs `npm`.
After installing, **close and reopen** your terminal so it picks up the new commands.

> A "terminal" on Windows = open the Start menu, type **PowerShell**, press Enter. Then move into
> this folder by running:
> ```
> cd C:\Users\jessi\mtg-collection
> ```

### 2. Install the project's tools

```
npm install
```

This downloads **Wrangler**, Cloudflare's command-line tool (used below as `npx wrangler ...`).

### 3. Log in to Cloudflare

```
npx wrangler login
```

A browser window opens — sign in (or create a free Cloudflare account) and click **Allow**.

### 4. Create the database

```
npx wrangler d1 create mtg-collection
```

This prints a block of text that includes a line like:

```
database_id = "abc12345-6789-..."
```

Open **`wrangler.toml`** in a text editor and replace `PASTE_DATABASE_ID_HERE` with that id.

### 5. Pick your share token

Still in **`wrangler.toml`**, change the `SHARE_TOKEN` line to any long random string
(letters and numbers, no spaces). This becomes part of your private share link, so make it
hard to guess, e.g.:

```
SHARE_TOKEN = "barrington-7f3a9c1e2b8d4"
```

### 6. Create the tables and load your data

```
npm run db:schema
npm run db:seed
```

(If asked to confirm running against your remote database, type `y` and press Enter.)

### 7. Set your secrets

These are stored securely by Cloudflare — never written into the code.

```
npx wrangler secret put OWNER_KEY
```
Type a private passphrase when prompted. This is the password you'll use to **edit** the
collection. (Your viewer never needs it.)

```
npx wrangler secret put ANTHROPIC_API_KEY
```
Paste your Anthropic API key. Get one at <https://console.anthropic.com> → **API Keys**.
You'll need to add a small amount of billing credit there; each deck analysis costs roughly
1–7 cents and is cached, so you only pay again if you click **Regenerate**.

> Don't have a key yet? You can skip this for now — the app fully works, and the AI Analysis
> button will simply tell you to add a key later. Run the command above whenever you're ready.

### 8. Deploy!

```
npm run deploy
```

When it finishes it prints your live URL, something like:

```
https://barrington-mtg.YOUR-NAME.workers.dev
```

Open that URL, enter your **owner key**, and you're in. 🎉

---

## Day-to-day use

- **Your URL** (`https://barrington-mtg.YOUR-NAME.workers.dev`) is your private console.
  It asks for your owner key once and remembers it on that device.
- Click **🔗 Share link** in the top-right to copy the **read-only** link. Send that to your
  viewer. It looks like `https://barrington-mtg.YOUR-NAME.workers.dev/view/your-share-token`.
- Add / edit / delete cards from any tab. Open a deck and press **✦ Generate AI Analysis**.
- On the **For Sale** tab, press **⟳ Refresh Prices** to pull current prices from Scryfall.
- To list a loose card for sale, use the **$** button next to it (or the **+ List Card** form).

To push changes to the live site after editing the code, just run `npm run deploy` again.
(Editing cards in the app does **not** require redeploying — that's saved to the database live.)

---

## Updating later

- **Card data** changes are best done **in the app** (they save to the database immediately).
- ⚠️ **Do not re-run `npm run db:seed` after you start editing** — it wipes the database and
  reloads the original starting data. The seed step is only for first-time setup.
- If you change the starting data files in `data/`, regenerate the seed file with
  `npm run build-seed`.

---

## Running locally (optional)

To preview on your own machine before deploying:

1. Create a file named `.dev.vars` in this folder with:
   ```
   OWNER_KEY=your-passphrase
   SHARE_TOKEN=barrington-7f3a9c1e2b8d4
   ANTHROPIC_API_KEY=sk-ant-...
   ```
2. Load the schema and data into a local copy of the database:
   ```
   npm run db:schema:local
   npm run db:seed:local
   ```
3. Start the dev server:
   ```
   npm run dev
   ```
   It prints a `http://localhost:...` URL you can open.

---

## Costs summary

| Piece | Cost |
|---|---|
| Cloudflare Workers + D1 database | **Free** (well within the free tier; no card needed) |
| Scryfall prices | **Free** (no key) |
| Claude AI Analysis | **Pennies** — ~1–7¢ per deck, cached; only billed again on Regenerate |

---

## How it fits together (for the curious)

```
Browser (public/index.html)
   │  fetch /api/...
   ▼
Cloudflare Worker (src/worker.js)
   ├─ reads/writes ─► D1 database (your collection)
   ├─ GET prices  ─► Scryfall API
   └─ AI analysis ─► Anthropic API (Claude)
```

- **Editing** requires the `OWNER_KEY` (sent as a header from your browser after you unlock).
- The **share link** carries the `SHARE_TOKEN`, which grants read-only access — the backend
  rejects any write attempt that doesn't have the owner key.
