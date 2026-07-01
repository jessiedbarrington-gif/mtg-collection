-- Barrington MTG Collection — database schema (Cloudflare D1 / SQLite)
-- Safe to re-run: drops and recreates the tables.

DROP TABLE IF EXISTS analysis;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS decks;

CREATE TABLE decks (
  id            TEXT PRIMARY KEY,           -- slug, e.g. "ool"
  title         TEXT NOT NULL,
  theme         TEXT NOT NULL,              -- css class: jund/simic/five/kilo/jeskai/mardu/tmnt
  commander     TEXT NOT NULL,
  alt_commander TEXT,                       -- nullable
  pips          TEXT NOT NULL,              -- comma list of color codes, e.g. "k,r,g"
  owner         TEXT,                       -- 'Jessie' | 'Marcus' | NULL
  power         INTEGER,                    -- AI Commander Bracket 1-5
  reliance      TEXT,                       -- commander reliance: 'high' | 'medium' | 'low'
  goal          TEXT,                       -- active upgrade path / direction (guides AI)
  goal_summary  TEXT,                       -- AI one-line summary of the active direction
  position      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id          TEXT,                    -- NULL for loose cards
  location         TEXT NOT NULL,           -- 'deck' | 'loose'
  name             TEXT NOT NULL,
  set_code         TEXT,
  qty              INTEGER NOT NULL DEFAULT 1,
  for_sale         INTEGER NOT NULL DEFAULT 0,   -- 0/1
  is_commander     INTEGER NOT NULL DEFAULT 0,   -- 0/1 — designated commander of its deck
  price_usd        REAL,                    -- last fetched Scryfall / TCGplayer price
  price_updated_at TEXT,                    -- ISO timestamp
  type_cat         TEXT,                    -- card category: Creature/Land/Instant/...
  cmc              REAL,                    -- mana value
  mana_cost        TEXT,                    -- e.g. "{1}{R}{R}"
  produced         TEXT,                    -- colors a land taps for, e.g. "R,G"
  roles            TEXT,                    -- JSON array of role tags (controlled vocab)
  weight           TEXT,                    -- 'core' | 'flex' | 'filler'
  image            TEXT,                    -- Scryfall art_crop image URL
  position         INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
);

CREATE INDEX idx_cards_deck     ON cards(deck_id);
CREATE INDEX idx_cards_location ON cards(location);
CREATE INDEX idx_cards_forsale  ON cards(for_sale);

CREATE TABLE analysis (
  deck_id       TEXT PRIMARY KEY,
  content       TEXT,                       -- JSON {summary,strengths,weaknesses,low[],high[],power}
  model         TEXT,
  generated_at  TEXT,
  collection    TEXT,                       -- JSON [{add,remove,reason}] from loose cards
  collection_at TEXT,
  FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
);
