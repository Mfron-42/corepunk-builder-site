/* ── Corepunk Builder — chargement des données ─────────────────────────
   Récupère site/data/builder.json une seule fois au démarrage et construit
   des index par clé pour un accès direct depuis share.js/app.js. Fournit
   aussi les utilitaires de repli d'icône partagés par tous les rendus :
   même mécanique que la carte communautaire soeur (glyphe posé en data-fb,
   un seul listener `error` global qui bascule toute <img> cassée). */

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/* Initiales pour les portraits sans art (héros Mercenaire/Paladin/Pain
   Reaper : aucun visuel dédié dans le client, cf. meta.gaps). */
function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.length === 1 ? words[0].slice(0, 2).toUpperCase() : (words[0][0] + words[1][0]).toUpperCase();
}

/* Glyphe de repli par nature d'objet — vocabulaire propre à l'atelier. */
const KIND_GLYPH = {
  hero: '◆', ability: '⚡', weapon: '⚔', artifact: '◈',
  chip: '▣', rune: '✦', spell: '✚', stat: '▤', generic: '⬡',
};

/* <img> avec repli intégré : le glyphe est posé en data-fb, consommé soit
   par le handler `error` global si l'image casse, soit immédiatement s'il
   n'y a pas d'URL du tout. */
function iconTag(url, cls, glyph) {
  return url
    ? `<img class="${cls}" src="${esc(url)}" alt="" data-fb="${esc(glyph)}" loading="lazy">`
    : `<span class="${cls} icon-broken" data-fb="${esc(glyph)}"></span>`;
}
document.addEventListener('error', e => {
  const t = e.target;
  if (t.tagName !== 'IMG' || t.dataset.fb === undefined) return;
  const span = document.createElement('span');
  span.className = t.className + ' icon-broken';
  span.setAttribute('data-fb', t.dataset.fb || '?');
  t.replaceWith(span);
}, true);

/* Nivellement de clé pour comparer des identifiants écrits dans des
   conventions différentes (snake_case côté mastery.id vs PascalCase côté
   weapon.spec, ex. "blast_medic" ↔ "BlastMedic"). */
const normKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* Palier de niveau minimal indicatif par tier (cf. mechanics.notes :
   T1 = niveau 1, T2 = niveau 10, T3(+) = niveau 20). */
const TIER_LEVEL = { T1: 1, T2: 10, T3: 20, 'T3+': 20 };

let DB = null; // rempli par loadData(), consommé par share.js/app.js

async function loadData() {
  const res = await fetch('data/builder.json');
  if (!res.ok) throw new Error('builder.json fetch failed: ' + res.status);
  const raw = await res.json();

  const byId = list => new Map(list.map(o => [o.id, o]));
  const byKeyField = list => new Map(list.map(o => [o.key, o]));

  /* ── Runes : regroupement base/upgraded/overclocked ──
     Le fichier livre une entrée par variante ; on les regroupe par
     (famille dérivée du préfixe de clé) + nom pour n'exposer qu'un seul
     objet "rune" au picker, avec un sous-objet `variants`. Dans ce jeu de
     données une seule rune ("Battle Cry") a réellement les 3 variantes —
     les autres n'en ont qu'une, le sélecteur de variante ne s'affichera
     donc que quand `variants` a plus d'une entrée. */
  function runeFamily(key) {
    if (key.startsWith('adv_rune')) return 'Advanced';
    if (key.startsWith('bas_rune')) return 'Basic';
    return 'Active'; // ab_rune_*, active_rune_*
  }
  const runeGroups = [];
  const runeGroupByAnyKey = new Map();
  const runeGroupById = new Map();
  for (const r of raw.runes) {
    const fam = runeFamily(r.key);
    const gid = fam + '::' + r.name;
    let g = runeGroupById.get(gid);
    if (!g) {
      g = { id: gid, name: r.name, family: fam, icon: r.icon, description: r.description, variants: {} };
      runeGroupById.set(gid, g);
      runeGroups.push(g);
    }
    g.variants[r.variant] = r;
    if (!g.icon && r.icon) g.icon = r.icon;
    if (!g.description && r.description) g.description = r.description;
    runeGroupByAnyKey.set(r.key, g);
  }
  runeGroups.sort((a, b) => a.name.localeCompare(b.name));

  const stats = raw.stats || [];
  const statsById = byId(stats);

  DB = {
    raw,                       // JSON brut complet — consommé par Engine.compute (via copie patchée)
    meta: raw.meta,
    heroes: raw.heroes,
    heroesById: byId(raw.heroes),
    weapons: raw.weapons,
    weaponsByKey: byKeyField(raw.weapons),
    artifacts: raw.artifacts,
    artifactsByKey: byKeyField(raw.artifacts),
    chips: raw.chips,
    chipsByKey: byKeyField(raw.chips),
    runeGroups,
    runeGroupByAnyKey,
    runeGroupById,
    universalSpells: raw.universal_spells,
    spellsById: byId(raw.universal_spells),
    talentTrees: raw.talent_trees,
    talentTreesById: byId(raw.talent_trees),
    stats,
    statsById,
    mainStats: stats.filter(s => s.kind === 'main'),
    secondaryStats: stats.filter(s => s.kind === 'secondary'),
    heroBaseStats: raw.hero_base_stats || {},
    mechanics: raw.mechanics,
    rarityById: byId(raw.mechanics.rarities),
    /* V3 : arbres de mastery client (7 specs construits) + modèle d'étoiles. */
    masterySystem: (raw.mastery_trees && raw.mastery_trees.system) || {},
    masterySpecs: (raw.mastery_trees && raw.mastery_trees.specs) || {},
    starModel: (raw.mechanics && raw.mechanics.star_model) || null,
  };
  return DB;
}

/* ── Armes : sélection filtrée par mastery + repli générique ──
   Seules 5/18 masteries ont des armes réellement modélisées (cf.
   meta.gaps) ; pour les 13 autres on fabrique un pseudo-objet "Generic
   <WeaponType>" qui reste configurable (tier au choix, rareté, état,
   sockets) mais ne représente aucun item réel du jeu. */
function weaponsFor(heroName, masteryId, weaponType) {
  const wantClass = normKey(heroName);
  const wantSpec = normKey(masteryId);
  const wantType = normKey(weaponType);
  return DB.weapons.filter(w =>
    normKey(w.class) === wantClass &&
    normKey(w.spec) === wantSpec &&
    normKey(w.weapon_type) === wantType);
}

function genericWeaponKey(weaponType) { return 'generic::' + normKey(weaponType); }

function genericWeapon(weaponType, tier) {
  return {
    key: genericWeaponKey(weaponType),
    name: `Generic ${weaponType}`,
    class: null, spec: null, tier: tier || 'T1', use_type: null,
    weapon_type: weaponType, icon: null, price: null, flavor: null,
    isGeneric: true,
  };
}

function resolveWeapon(key, weaponType, tier) {
  if (!key) return null;
  if (key.startsWith('generic::')) return genericWeapon(weaponType, tier || 'T1');
  return DB.weaponsByKey.get(key) || null;
}

/* ── Sockets calculés (puces d'arme / stats secondaires d'artefact) ──
   Table approximative par rareté + bonus par état, plafonnée ; un item de
   tier T3(+) échange le bonus de sockets contre un "perk" de mastery
   (mechanics.t3_grants_perks_instead) quand il est amélioré/overclocké.

   V4.2 : la vague pipeline a livré mechanics.artifact_secondary_slots.by_tier
   = { T1: {rarity: count}, T2: {...}, T3: {...} } — une clé SŒUR de `.base`
   (pas un remplacement in-place) ; `.base` reste la forme plate historique,
   explicitement gardée pour compat ("by_tier supersedes it" dans la donnée
   elle-même). Repli dégradé, du plus précis au plus sûr :
     1. by_tier[tier][rarity]        — table réelle par tier (V4.2)
     2. base[tier][rarity]           — au cas où une future clé nesterait
                                        directement sous .base
     3. base[rarity]                 — forme plate historique (weapon_chip_
                                        sockets n'a pas de by_tier et vit ici)
     4. mechanics.<clé>[tier]/elle-même — repli ultime si même `.base`
                                        venait à disparaître
   Aucune de ces formes ne doit jamais faire planter le calcul. */
function slotBaseTable(t, tier) {
  if (t && t.by_tier && typeof t.by_tier === 'object') {
    const table = t.by_tier[tier] || (tier === 'T3+' ? t.by_tier.T3 : null); // T3+ suit la table T3
    if (table && typeof table === 'object') return table;
  }
  if (t && t.base && typeof t.base === 'object') {
    if (t.base[tier] && typeof t.base[tier] === 'object') return t.base[tier];
    if (tier === 'T3+' && t.base.T3 && typeof t.base.T3 === 'object') return t.base.T3;
    return t.base; // forme plate historique {common,uncommon,rare,epic}
  }
  // Repli ultime : la clé mechanics.<x> EST directement la table (pas de wrapper .base).
  if (t && t[tier] && typeof t[tier] === 'object') return t[tier];
  return (t && typeof t === 'object') ? t : {};
}
function computeSlots(mechanicsKey, tier, rarityId, upgradeId) {
  const t = DB.mechanics && DB.mechanics[mechanicsKey];
  if (!t) return { count: 0, perk: 0 }; // absence gracieuse (données pas encore livrées)
  const base = Number(slotBaseTable(t, tier)[rarityId]) || 0;
  const isT3 = tier === 'T3' || tier === 'T3+';
  let bonus = 0, perk = 0;
  if (upgradeId === 'upgraded') { if (isT3 && t.t3_grants_perks_instead) perk = 1; else bonus = t.upgraded_bonus || 0; }
  else if (upgradeId === 'overclocked') { if (isT3 && t.t3_grants_perks_instead) perk = 2; else bonus = t.overclocked_bonus || 0; }
  const max = Number.isFinite(t.max) ? t.max : Infinity;
  return { count: Math.min(max, base + bonus), perk };
}

const upgradeLabel = id => ({ normal: 'Normal', upgraded: 'Upgraded', overclocked: 'Overclocked' }[id] || id);

/* ── V4.1 : forme canonique d'une stat (unité UNIQUE en jeu) ────────────
   Les stats de gear sont des RATINGS (points "flat") — y compris les
   chances de crit (seuil de DR) ; seuls les modificateurs explicitement
   en pourcentage font exception. null = genuinement ambigu/inconnu →
   l'éditeur repropose alors le choix manuel. */
const STAT_UNIT_OVERRIDES = {
  movement_speed: '%',
  physical_damage_decrease: '%',
  magical_damage_decrease: '%',
  outgoing_damage_increase: '%',
  heal_shield_power_increase_pct: '%',
};
function statUnit(statId) {
  if (!statId) return null;
  if (STAT_UNIT_OVERRIDES[statId] !== undefined) return STAT_UNIT_OVERRIDES[statId];
  const st = DB.statsById.get(statId);
  if (!st) return null;                        // stat inconnue → ambigu
  if (st.dr_threshold != null) return 'flat';  // rating à seuil de DR = points
  if (st.kind === 'main' || st.kind === 'secondary') return 'flat';
  return null;                                 // derived (aggro…) → ambigu
}
const unitSuffix = u => (u === '%' ? '%' : u === 'flat' ? 'pts' : '');

/* ── V4.1 : pool réel des stats secondaires roulables sur artefact ──────
   mechanics.secondary_stat_pool.groups = { physical/magical/utility: [ids] }.
   Absent → repli sur toutes les stats secondaires (dégradation douce). */
function secondaryPoolGroups() {
  const pool = DB.mechanics && DB.mechanics.secondary_stat_pool;
  const groups = pool && pool.groups;
  if (!groups || typeof groups !== 'object') return null;
  const out = [];
  Object.entries(groups).forEach(([g, ids]) => {
    if (!Array.isArray(ids)) return;
    const valid = ids.filter(id => DB.statsById.has(id));
    if (valid.length) out.push({ group: g, ids: valid });
  });
  return out.length ? out : null;
}
function secondaryPoolIds() {
  const gs = secondaryPoolGroups();
  return gs ? gs.flatMap(g => g.ids) : DB.secondaryStats.map(s => s.id);
}
