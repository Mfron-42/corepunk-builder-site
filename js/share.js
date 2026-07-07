/* ── Corepunk Builder — état de build, partage & sauvegardes ───────────
   Ce fichier possède la forme du "state" applicatif (créé vierge, converti
   en JSON compact pour l'URL/les sauvegardes/l'export, reconstruit avec
   validation contre DB à l'import). app.js ne fait que lire/écrire cet
   état et redessiner l'écran. */

const SHARE_VERSION = 1;
const LS_SAVES_KEY = 'corepunk_builder_saves_v1';
/* Plafond défensif (anti-lien-abusif) pour les picks secondaires d'un
   artefact — volontairement bien au-dessus du nombre de sockets calculé
   (mechanics.artifact_secondary_slots) : un lien/sauvegarde peut porter
   PLUS de picks que ce que la table actuelle autorise (rareté rabaissée,
   ou table de tiers régénérée par le pipeline) — on les garde tous et
   l'UI les flague "over slot count" au lieu de les supprimer. */
const SECONDARY_PICKS_HARD_CAP = 20;

/* ── Squelette d'état vierge ─────────────────────────────────────────── */
function makeDefaultState() {
  return {
    name: 'Untitled build',
    heroId: null,
    masteryId: null,
    level: 1,
    weapons: [],                              // rempli par freshWeaponsForMastery()
    artifacts: new Array(6).fill(null),
    spells: { d: null, f: null },
    talents: [
      { treeId: null, picks: {}, notes: {}, ranks: {}, conds: {} },
      { treeId: null, picks: {}, notes: {}, ranks: {}, conds: {} },
      { treeId: null, picks: {}, notes: {}, ranks: {}, conds: {} },
    ],
    /* Extensions v1 ADDITIVES (moteur de calcul) — optionnelles dans les
       vieux liens/sauvegardes, dégradation silencieuse à l'absence. */
    baseOverrides: {},                                            // { statId: number } → patch combat.base.default
    target: { armor: null, magic_resistance: null, level: null, preset: null },
    /* Contrat V2 (SPEC/V2_CHALLENGE_PLAN.md "New build-state fields") : */
    abilityOverrides: {},        // { "Q|W|E|R|Passive": { damage, cooldown_s, cast_time_s, scaling_stat } }
    customEffects: [],           // [{ source, stat, value, unit "%|flat", uptime 0..1|null, note }]
    spellUptimes: { d: 1, f: 1 },
    rotationMode: 'full',        // "full" | "autos"
    weaponMastery: { points: 0, notes: '' },   // legacy V2 (notes libres) — l'arbre réel est masteryAlloc
    /* Contrat V3 (SPEC/V3_INTEGRATION.md) : allocation d'arbre de mastery
       par spec — { "<hero>/<mastery>": { nodes: {id: 0..3}, edges: [id] } } */
    masteryAlloc: {},
  };
}

const ABILITY_SLOTS = ['Q', 'W', 'E', 'R', 'Passive'];
const TARGET_PRESETS = ['dummy', 'squishy', 'tank'];

/* Dérive les slots d'arme d'une mastery : TwoHanded → 1 slot ; MainOff →
   main-hand + off-hand (même weapon_type des deux mains si un seul type
   est déclaré, ex. armes à une main dupliquées). use_type absent (4
   masteries non confirmées côté client) retombe sur un slot unique. */
function freshWeaponsForMastery(mastery) {
  const types = (mastery && mastery.weapon_types) || [];
  const useType = mastery && mastery.use_type;
  let slots;
  if (useType === 'MainOff') {
    const t0 = types[0] || 'Weapon';
    const t1 = types.length >= 2 ? types[1] : t0;
    slots = [
      { slotKey: 'main', label: 'Main-hand', weaponType: t0 },
      { slotKey: 'off', label: 'Off-hand', weaponType: t1 },
    ];
  } else {
    slots = [{ slotKey: 'weapon', label: 'Weapon', weaponType: types[0] || 'Weapon' }];
  }
  return slots.map(s => ({
    ...s, key: null, isGeneric: false, tier: 'T1', rarity: 'common', upgrade: 'normal', chips: [],
  }));
}

function freshArtifactSlot() { return null; }

/* ── state ⇄ JSON compact (schéma du DATA_CONTRACT / brief) ───────────── */

/* Tronque les null de fin d'un tableau (les null INTÉRIEURS sont gardés :
   secondary[] et secondaryRolls[] sont alignés par POSITION — c'est le
   contrat lu par Engine.compute, cf. engine.js::resolveArtifactSlot). */
function trimTrailingNulls(arr) {
  const out = (arr || []).slice();
  while (out.length && out[out.length - 1] == null) out.pop();
  return out;
}

function stateToShare(state) {
  const weapons = state.weapons.map(w => ({
    key: w.key, rarity: w.rarity, state: w.upgrade,
    tier: w.isGeneric ? w.tier : undefined,          // seul un slot générique a un tier au choix
    chips: (w.chips || []).filter(Boolean),
  }));
  const artifacts = state.artifacts.map(a => {
    if (!a) return null;
    const secondary = trimTrailingNulls(a.secondary);
    const out = {
      key: a.key, mainStat: a.mainStat, rarity: a.rarity, state: a.upgrade,
      secondary,
      rune: a.rune ? { key: a.rune.key, variant: a.rune.variant } : null,
    };
    if (Number.isFinite(a.mainStatRoll)) out.mainStatRoll = a.mainStatRoll;
    const rolls = (a.secondaryRolls || []).slice(0, secondary.length)
      .map(v => (Number.isFinite(v) ? v : null));
    if (rolls.some(v => v != null)) out.secondaryRolls = rolls;
    /* V3 — étoiles : forme du contrat `secondaries: [{stat, stars, roll}]`
       + `mainStars`. Les anciens champs restent émis (compat moteur V2
       et vieux liens) ; le roll manuel gagne toujours sur les étoiles. */
    const stars = (a.secondaryStars || []).slice(0, secondary.length)
      .map(v => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null));
    if (stars.some(v => v != null)) {
      out.secondaries = secondary.map((stat, si) => ({
        stat: stat || null,
        stars: stars[si] != null ? stars[si] : null,
        roll: Number.isFinite(rolls[si]) ? rolls[si] : null,
      }));
    }
    if (Number.isInteger(a.mainStars) && a.mainStars >= 1 && a.mainStars <= 5) out.mainStars = a.mainStars;
    return out;
  });
  const talents = {};
  state.talents.forEach(t => {
    if (!t.treeId) return;
    const rowObj = {};
    Object.entries(t.picks || {}).forEach(([row, idx]) => { rowObj[row] = idx; });
    if (t.notes && Object.keys(t.notes).length) rowObj._notes = t.notes;
    talents[t.treeId] = rowObj;
  });
  const share = {
    v: SHARE_VERSION,
    hero: state.heroId, mastery: state.masteryId, lvl: state.level,
    weapons, artifacts, spells: [state.spells.d, state.spells.f],
    talents, name: state.name,
  };
  /* Champs additifs — omis quand vides pour garder les liens courts. */
  const bo = state.baseOverrides || {};
  if (Object.keys(bo).length) share.baseOverrides = { ...bo };
  const t = state.target || {};
  if ([t.armor, t.magic_resistance, t.level].some(Number.isFinite) || t.preset) {
    share.target = {};
    if (Number.isFinite(t.armor)) share.target.armor = t.armor;
    if (Number.isFinite(t.magic_resistance)) share.target.magic_resistance = t.magic_resistance;
    if (Number.isFinite(t.level)) share.target.level = t.level;
    if (TARGET_PRESETS.includes(t.preset)) share.target.preset = t.preset;
  }

  /* ── Champs V2 (tous optionnels, défauts omis) ── */
  const ao = {};
  ABILITY_SLOTS.forEach(slot => {
    const o = (state.abilityOverrides || {})[slot];
    if (!o) return;
    const out = {};
    ['damage', 'cooldown_s', 'cast_time_s'].forEach(f => { if (Number.isFinite(o[f])) out[f] = o[f]; });
    if (o.scaling_stat && DB.statsById.has(o.scaling_stat)) out.scaling_stat = o.scaling_stat;
    if (Object.keys(out).length) ao[slot] = out;
  });
  if (Object.keys(ao).length) share.abilityOverrides = ao;

  /* customEffects : entrées stat+valeur OU pointeur de node (t3perk V3 :
     "+1 niveau au talent <nodeId>, cap 3" — le moteur V3 le résout). */
  const fx = (state.customEffects || [])
    .filter(e => e && e.source && ((e.stat && Number.isFinite(e.value)) || e.nodeId))
    .map(e => {
      const out = {
        source: String(e.source).slice(0, 60),
        unit: e.unit === 'flat' ? 'flat' : '%',
        uptime: Number.isFinite(e.uptime) ? Math.max(0, Math.min(1, e.uptime)) : null,
        note: e.note ? String(e.note).slice(0, 120) : '',
      };
      if (e.stat && Number.isFinite(e.value)) { out.stat = e.stat; out.value = e.value; }
      if (e.nodeId) out.nodeId = String(e.nodeId).slice(0, 40);
      return out;
    });
  if (fx.length) share.customEffects = fx;

  /* ── V3 : allocation d'arbre de mastery (specs non vides seulement) ── */
  const ma = {};
  Object.entries(state.masteryAlloc || {}).forEach(([spec, alloc]) => {
    if (!alloc) return;
    const nodes = {};
    Object.entries(alloc.nodes || {}).forEach(([nid, lvl]) => {
      if (Number.isInteger(lvl) && lvl >= 1 && lvl <= 3) nodes[nid] = lvl;
    });
    const edges = (alloc.edges || []).filter(x => typeof x === 'string').slice(0, 200);
    if (Object.keys(nodes).length || edges.length) ma[spec] = { nodes, edges };
  });
  if (Object.keys(ma).length) share.masteryAlloc = ma;

  const ranks = {}, conds = {};
  state.talents.forEach(tal => {
    if (!tal.treeId) return;
    const r = {};
    Object.entries(tal.ranks || {}).forEach(([row, v]) => { if (Number.isInteger(v) && v > 1) r[row] = v; });
    if (Object.keys(r).length) ranks[tal.treeId] = r;
    const c = {};
    Object.entries(tal.conds || {}).forEach(([row, v]) => { if (v === false) c[row] = false; });
    if (Object.keys(c).length) conds[tal.treeId] = c;
  });
  if (Object.keys(ranks).length) share.talentRanks = ranks;
  if (Object.keys(conds).length) share.talentConds = conds;

  const su = state.spellUptimes || {};
  if ((Number.isFinite(su.d) && su.d !== 1) || (Number.isFinite(su.f) && su.f !== 1)) {
    share.spellUptimes = {
      d: Number.isFinite(su.d) ? Math.max(0, Math.min(1, su.d)) : 1,
      f: Number.isFinite(su.f) ? Math.max(0, Math.min(1, su.f)) : 1,
    };
  }
  if (state.rotationMode === 'autos') share.rotationMode = 'autos';
  const wm = state.weaponMastery || {};
  if ((Number.isFinite(wm.points) && wm.points > 0) || (wm.notes && wm.notes.trim())) {
    share.weaponMastery = { points: Math.max(0, Math.min(26, Math.round(wm.points || 0))), notes: String(wm.notes || '').slice(0, 200) };
  }
  return share;
}

/* Reconstruit un état complet depuis un objet partagé, en validant chaque
   champ contre DB — toute clé inconnue ou invalide est ignorée plutôt que
   de faire planter le chargement ("unknown keys degrade gracefully"). */
function applyShareToState(obj) {
  const state = makeDefaultState();
  if (!obj || typeof obj !== 'object') return state;

  /* Compteur de dégradation : chaque champ significatif abandonné (id
     inconnu après régénération des données) incrémente ; le chargeur
     (app.js) lit state._degraded pour afficher un toast honnête. */
  let dropped = 0;

  if (typeof obj.name === 'string' && obj.name.trim()) state.name = obj.name.slice(0, 80);
  if (Number.isFinite(obj.lvl)) state.level = Math.max(1, Math.min(40, Math.round(obj.lvl)));

  const hero = DB.heroesById.get(obj.hero);
  if (obj.hero && !hero) dropped++;
  if (hero) {
    state.heroId = hero.id;
    const mastery = hero.masteries.find(m => m.id === obj.mastery) || hero.masteries[0];
    state.masteryId = mastery.id;
    state.weapons = freshWeaponsForMastery(mastery);

    if (Array.isArray(obj.weapons)) {
      obj.weapons.forEach((w, i) => {
        const slot = state.weapons[i];
        if (!slot || !w || !w.key) return;
        const item = resolveWeapon(w.key, slot.weaponType, w.tier);
        if (!item) { dropped++; return; }
        slot.key = item.key;
        slot.isGeneric = !!item.isGeneric;
        slot.tier = item.isGeneric ? (['T1', 'T2', 'T3'].includes(w.tier) ? w.tier : 'T1') : item.tier;
        slot.rarity = DB.rarityById.has(w.rarity) ? w.rarity : 'common';
        slot.upgrade = ['normal', 'upgraded', 'overclocked'].includes(w.state) ? w.state : 'normal';
        const cap = computeSlots('weapon_chip_sockets', slot.tier, slot.rarity, slot.upgrade).count;
        slot.chips = (Array.isArray(w.chips) ? w.chips : []).filter(k => DB.chipsByKey.has(k)).slice(0, cap);
      });
    }
  }

  if (Array.isArray(obj.artifacts)) {
    obj.artifacts.slice(0, 6).forEach((a, i) => {
      if (!a || !a.key) return;
      const item = DB.artifactsByKey.get(a.key);
      if (!item) { dropped++; return; }
      const rarity = DB.rarityById.has(a.rarity) ? a.rarity : 'common';
      const upgrade = ['normal', 'upgraded', 'overclocked'].includes(a.state) ? a.state : 'normal';
      let rune = null;
      if (a.rune && a.rune.key) {
        const grp = DB.runeGroupById.get(a.rune.key);
        if (grp) {
          const variant = grp.variants[a.rune.variant] ? a.rune.variant : Object.keys(grp.variants)[0];
          rune = { key: grp.id, variant };
        }
      }
      /* secondary/secondaryRolls : alignement PAR POSITION (une valeur de
         roll suit son pick) — un id inconnu devient null à sa place au
         lieu d'être filtré, pour ne pas décaler les rolls suivants.
         V3 : la forme `secondaries: [{stat, stars, roll}]` est prioritaire
         quand elle est présente ; les vieux champs restent lus sinon.
         V4.2 : on NE tronque PLUS au nombre de sockets calculé (cap) — un
         pick au-delà du compte actuel est gardé tel quel (jamais de perte
         de donnée utilisateur) et sera flagué "over slot count" par
         normalizeArtifactSlot/artifactCardHTML ; seul un plafond défensif
         anti-abus borne la taille du tableau. */
      let secondary, secondaryRolls, secondaryStars;
      if (Array.isArray(a.secondaries)) {
        const secs = a.secondaries.slice(0, SECONDARY_PICKS_HARD_CAP);
        secondary = secs.map(s => (s && DB.secondaryStats.some(x => x.id === s.stat) ? s.stat : null));
        secondaryRolls = secs.map(s => (s && Number.isFinite(s.roll) ? s.roll : null));
        secondaryStars = secs.map(s => (s && Number.isInteger(s.stars) && s.stars >= 1 && s.stars <= 5 ? s.stars : null));
      } else {
        secondary = (Array.isArray(a.secondary) ? a.secondary : []).slice(0, SECONDARY_PICKS_HARD_CAP)
          .map(id => (DB.secondaryStats.some(s => s.id === id) ? id : null));
        secondaryRolls = (Array.isArray(a.secondaryRolls) ? a.secondaryRolls : []).slice(0, SECONDARY_PICKS_HARD_CAP)
          .map(v => (Number.isFinite(v) ? v : null));
        secondaryStars = secondary.map(() => null);
      }
      state.artifacts[i] = {
        key: item.key,
        mainStat: DB.mainStats.some(s => s.id === a.mainStat) ? a.mainStat : null,
        rarity, upgrade,
        secondary,
        secondaryRolls,
        secondaryStars,
        mainStatRoll: Number.isFinite(a.mainStatRoll) ? a.mainStatRoll : null,
        mainStars: (Number.isInteger(a.mainStars) && a.mainStars >= 1 && a.mainStars <= 5) ? a.mainStars : null,
        rune,
      };
    });
  }

  if (Array.isArray(obj.spells)) {
    const [d, f] = obj.spells;
    if (DB.spellsById.has(d)) state.spells.d = d;
    if (DB.spellsById.has(f)) state.spells.f = f;
  }

  if (obj.talents && typeof obj.talents === 'object') {
    const givenTrees = Object.keys(obj.talents);
    const treeIds = givenTrees.filter(id => DB.talentTreesById.has(id)).slice(0, 3);
    dropped += givenTrees.length - givenTrees.filter(id => DB.talentTreesById.has(id)).length;
    treeIds.forEach((treeId, slotIdx) => {
      const tree = DB.talentTreesById.get(treeId);
      const raw = obj.talents[treeId] || {};
      const picks = {}, notes = {};
      Object.entries(raw).forEach(([row, val]) => {
        if (row === '_notes' && val && typeof val === 'object') {
          Object.entries(val).forEach(([r, text]) => {
            const ri = Number(r);
            if (tree.rows[ri]) notes[ri] = String(text).slice(0, 140);
          });
          return;
        }
        const ri = Number(row);
        const rowDef = tree.rows[ri];
        if (rowDef && Number.isInteger(val) && rowDef.choices[val]) picks[ri] = val;
      });
      state.talents[slotIdx] = { treeId, picks, notes, ranks: {}, conds: {} };
    });
  }

  /* ── Extensions additives (absentes des vieux liens → défauts) ── */
  if (obj.baseOverrides && typeof obj.baseOverrides === 'object') {
    Object.entries(obj.baseOverrides).slice(0, 60).forEach(([k, v]) => {
      if (typeof k === 'string' && k.length <= 40 && Number.isFinite(v)) state.baseOverrides[k] = v;
    });
  }
  if (obj.target && typeof obj.target === 'object') {
    if (Number.isFinite(obj.target.armor)) state.target.armor = Math.max(0, obj.target.armor);
    if (Number.isFinite(obj.target.magic_resistance)) state.target.magic_resistance = Math.max(0, obj.target.magic_resistance);
    if (Number.isFinite(obj.target.level)) state.target.level = Math.max(1, Math.min(40, Math.round(obj.target.level)));
    if (TARGET_PRESETS.includes(obj.target.preset)) state.target.preset = obj.target.preset;
  }

  /* ── Champs V2 (SPEC/V2_CHALLENGE_PLAN.md) — validation champ à champ ── */
  if (obj.abilityOverrides && typeof obj.abilityOverrides === 'object') {
    ABILITY_SLOTS.forEach(slot => {
      const o = obj.abilityOverrides[slot];
      if (!o || typeof o !== 'object') return;
      const out = {};
      ['damage', 'cooldown_s', 'cast_time_s'].forEach(f => { if (Number.isFinite(o[f])) out[f] = Math.max(0, o[f]); });
      if (typeof o.scaling_stat === 'string' && DB.statsById.has(o.scaling_stat)) out.scaling_stat = o.scaling_stat;
      if (Object.keys(out).length) state.abilityOverrides[slot] = out;
    });
  }
  if (Array.isArray(obj.customEffects)) {
    obj.customEffects.slice(0, 40).forEach(e => {
      if (!e || typeof e.source !== 'string' || !e.source || e.source.length > 60) return;
      const hasStatVal = DB.statsById.has(e.stat) && Number.isFinite(e.value);
      const hasNode = typeof e.nodeId === 'string' && e.nodeId.length <= 40;
      if (!hasStatVal && !hasNode) { dropped++; return; }
      /* V4.1 : migration douce — l'unité stockée est écrasée par la forme
         canonique de la stat quand elle est connue (chaque stat n'a
         qu'une forme réelle en jeu ; le choix libre reste pour l'ambigu). */
      const derivedUnit = hasStatVal ? statUnit(e.stat) : null;
      state.customEffects.push({
        source: e.source,
        stat: hasStatVal ? e.stat : null,
        value: hasStatVal ? e.value : null,
        unit: derivedUnit || (e.unit === 'flat' ? 'flat' : '%'),
        uptime: Number.isFinite(e.uptime) ? Math.max(0, Math.min(1, e.uptime)) : null,
        note: typeof e.note === 'string' ? e.note.slice(0, 120) : '',
        nodeId: hasNode ? e.nodeId : null,
      });
    });
  }
  state.talents.forEach(tal => {
    if (!tal.treeId) return;
    const tree = DB.talentTreesById.get(tal.treeId);
    const r = obj.talentRanks && obj.talentRanks[tal.treeId];
    if (r && typeof r === 'object') Object.entries(r).forEach(([row, v]) => {
      const ri = Number(row);
      if (tree.rows[ri] && Number.isInteger(v) && v >= 1 && v <= 5) tal.ranks[ri] = v;
    });
    const c = obj.talentConds && obj.talentConds[tal.treeId];
    if (c && typeof c === 'object') Object.entries(c).forEach(([row, v]) => {
      const ri = Number(row);
      if (tree.rows[ri] && typeof v === 'boolean') tal.conds[ri] = v;
    });
  });
  if (obj.spellUptimes && typeof obj.spellUptimes === 'object') {
    ['d', 'f'].forEach(h => {
      if (Number.isFinite(obj.spellUptimes[h])) state.spellUptimes[h] = Math.max(0, Math.min(1, obj.spellUptimes[h]));
    });
  }
  if (obj.rotationMode === 'autos') state.rotationMode = 'autos';
  if (obj.weaponMastery && typeof obj.weaponMastery === 'object') {
    if (Number.isFinite(obj.weaponMastery.points)) state.weaponMastery.points = Math.max(0, Math.min(26, Math.round(obj.weaponMastery.points)));
    if (typeof obj.weaponMastery.notes === 'string') state.weaponMastery.notes = obj.weaponMastery.notes.slice(0, 200);
  }

  /* ── V3 : masteryAlloc — validé node par node contre l'arbre client ── */
  if (obj.masteryAlloc && typeof obj.masteryAlloc === 'object') {
    Object.entries(obj.masteryAlloc).slice(0, 18).forEach(([specKey, alloc]) => {
      const spec = DB.masterySpecs[specKey];
      if (!spec || !spec.built || !alloc || typeof alloc !== 'object') { if (alloc) dropped++; return; }
      const nodeIds = new Set((spec.nodes || []).map(n => n.id));
      const edgeIds = new Set();
      (spec.edges || []).forEach(e => { edgeIds.add(e.id); if (e.reverse_edge) edgeIds.add(e.reverse_edge); });
      const nodes = {};
      Object.entries(alloc.nodes || {}).forEach(([nid, lvl]) => {
        if (nodeIds.has(nid) && Number.isInteger(lvl) && lvl >= 1 && lvl <= 3) nodes[nid] = lvl;
      });
      const edges = [...new Set((Array.isArray(alloc.edges) ? alloc.edges : []).filter(x => edgeIds.has(x)))].slice(0, 200);
      if (Object.keys(nodes).length || edges.length) state.masteryAlloc[specKey] = { nodes, edges };
    });
  }

  if (dropped > 0) state._degraded = true;
  return state;
}

/* ── Base64url (Unicode-safe) pour le fragment d'URL ──────────────────── */
function b64urlEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}
function encodeHash(state) {
  try { return b64urlEncode(stateToShare(state)); } catch { return ''; }
}
function decodeHash(hashStr) {
  try { return applyShareToState(b64urlDecode(hashStr)); } catch { return null; }
}

/* ── Sauvegardes locales (localStorage) ────────────────────────────────
   Liste nommée, la plus récente en tête ; chaque entrée stocke le JSON
   compact (pas l'état interne) pour rester stable si le state applicatif
   évolue plus tard. */
function listSaves() {
  try { return JSON.parse(localStorage.getItem(LS_SAVES_KEY) || '[]'); }
  catch { return []; }
}
function persistSaves(list) { localStorage.setItem(LS_SAVES_KEY, JSON.stringify(list)); }
function saveBuildToStorage(name, state) {
  const list = listSaves();
  const entry = { id: 'sv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, savedAt: new Date().toISOString(), data: stateToShare(state) };
  list.unshift(entry);
  persistSaves(list);
  return entry.id;
}
function deleteSavedBuild(id) { persistSaves(listSaves().filter(s => s.id !== id)); }
function getSaveById(id) { return listSaves().find(s => s.id === id) || null; }
function loadSavedBuild(id) {
  const found = getSaveById(id);
  return found ? applyShareToState(found.data) : null;
}
function findSaveByName(name) { return listSaves().find(s => s.name === name) || null; }
function overwriteSavedBuild(id, state) {
  const list = listSaves();
  const e = list.find(s => s.id === id);
  if (!e) return null;
  e.savedAt = new Date().toISOString();
  e.data = stateToShare(state);
  persistSaves(list);
  return e.id;
}
function renameSavedBuild(id, newName) {
  const list = listSaves();
  const e = list.find(s => s.id === id);
  if (e && newName && newName.trim()) { e.name = newName.trim().slice(0, 80); persistSaves(list); }
}
function duplicateSavedBuild(id) {
  const list = listSaves();
  const e = list.find(s => s.id === id);
  if (!e) return;
  list.unshift({
    id: 'sv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (e.name + ' (copy)').slice(0, 80),
    savedAt: new Date().toISOString(),
    data: JSON.parse(JSON.stringify(e.data)),
  });
  persistSaves(list);
}

/* ── Export / import JSON ─────────────────────────────────────────────── */
function exportBuildFile(state) {
  const blob = new Blob([JSON.stringify(stateToShare(state), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = ((state.name || 'build').replace(/[^a-z0-9_\- ]/gi, '').trim() || 'build').replace(/\s+/g, '-');
  a.href = url; a.download = `corepunk-${safeName}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function importBuildFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(applyShareToState(JSON.parse(reader.result))); }
      catch (e) { reject(e); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
