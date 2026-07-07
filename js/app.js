/* ── Corepunk Builder — application ─────────────────────────────────────
   État applicatif (voir share.js pour la forme du state), rendu de tous
   les panneaux, agrégation de stats. Un seul flux : mutation du state puis
   render() complet, sauf pour les champs texte/slider natifs qui vivent en
   dehors des conteneurs redessinés (pas de perte de focus/curseur). */

let state = makeDefaultState();
let expandedAbilities = new Set();
let auditOpen = false; // V5 : panneau "Audit" (result.audit) — vue, pas du build state

/* ── Repli visuel d'étiquette (talents "damage" -> "Damage") ──────────── */
const pretty = k => String(k || '').replace(/[_-]+/g, ' ').trim().replace(/^./, c => c.toUpperCase());
const foldAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/* Troncature propre : coupe à la frontière de mot et n'ajoute "…" QUE si
   le texte a réellement été raccourci (jamais de phrase hachée net). */
function truncate(s, max) {
  s = String(s || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.!·-]+$/, '') + '…';
}

/* Nom d'affichage d'une stat — jamais l'id interne dans un title. */
function statDisplayName(id) {
  const st = DB.statsById.get(id);
  return st ? st.name : pretty(id);
}

/* ══════════════════════════════════════════════════════════════════════
   RENDU — hero rail / mastery tabs / kit strip
   ══════════════════════════════════════════════════════════════════════ */
function renderHeroRail() {
  $('#hero-rail').innerHTML = DB.heroes.map(h => `
    <button class="hero-card ${h.id === state.heroId ? 'active' : ''}" data-action="select-hero" data-hero="${esc(h.id)}">
      ${iconTag(h.portrait, 'hero-portrait', initials(h.name))}
      <span class="hero-name">${esc(h.name)}</span>
      <span class="hero-archetype">${esc(h.archetype)}</span>
    </button>`).join('');
}

function currentHero() { return state.heroId ? DB.heroesById.get(state.heroId) : null; }
function currentMastery() {
  const hero = currentHero();
  return hero ? hero.masteries.find(m => m.id === state.masteryId) : null;
}

function renderMasteryTabs() {
  const hero = currentHero();
  $('#mastery-tabs').innerHTML = hero.masteries.map(m => `
    <button class="mastery-tab ${m.id === state.masteryId ? 'active' : ''}" data-action="select-mastery" data-mastery="${esc(m.id)}">
      ${iconTag(m.portrait, 'mastery-portrait', initials(m.name))}
      <span class="mastery-tab-text">
        <span class="mastery-name">${esc(m.name)}</span>
        <span class="mastery-role">${esc(m.role)}</span>
        <span class="mastery-wtypes">${(m.weapon_types || []).map(t => `<span class="wtype-chip">${esc(t)}</span>`).join('')}</span>
      </span>
    </button>`).join('');
  $('#mastery-desc').textContent = currentMastery()?.description || '';
}

/* Puces de valeurs d'une capacité — chaque nombre connu (params) rendu en
   chip mono, visible SANS déplier la carte. params.display (pipeline V2)
   est prioritaire quand il existe ; sinon on construit depuis les champs. */
const STAT_ABBREV = { attack_power: 'AP', spell_power: 'SP', heal_shield_power: 'HSP', weapon_damage: 'WD', health: 'HP', armor: 'AR', magic_resistance: 'MR', mana: 'MP' };
function statAbbrev(id) { return STAT_ABBREV[id] || statDisplayName(id); }
function abilityValueChips(ab) {
  const p = ab.params;
  if (!p) return [];
  if (Array.isArray(p.display) && p.display.length) {
    return p.display
      .filter(d => d && d.label != null && d.value != null)
      .map(d => `${String(d.label).toUpperCase()} ${d.value}${d.unit || ''}`);
  }
  const chips = [];
  const scal = (p.scaling && typeof p.scaling === 'object')
    ? Object.entries(p.scaling).filter(([, v]) => Number.isFinite(v) && v !== 0) : [];
  if (Number.isFinite(p.damage) && (p.damage !== 0 || scal.length)) chips.push('DMG ' + fmtNum(p.damage));
  scal.forEach(([stat, v]) => chips.push(`+${Math.round(v * 100)}% ${statAbbrev(stat)}`));
  if (Number.isFinite(p.cooldown_s)) chips.push('CD ' + fmtNum(p.cooldown_s) + 's');
  if (Number.isFinite(p.cast_time_s) && p.cast_time_s !== 0) chips.push('CAST ' + fmtNum(p.cast_time_s) + 's');
  if (Number.isFinite(p.duration_s) && p.duration_s !== 0) chips.push('DUR ' + fmtNum(p.duration_s) + 's');
  if (Number.isFinite(p.range) && p.range !== 0) chips.push(fmtNum(p.range) + 'm');
  return chips;
}

/* Éditeur d'overrides par capacité (contrat build.abilityOverrides) —
   même patron que les inputs de roll : state + recalcul, jamais de
   re-rendu de la section pendant la frappe. */
function abilityOverrideEditorHTML(slot) {
  const o = state.abilityOverrides[slot] || {};
  const val = f => (Number.isFinite(o[f]) ? esc(String(o[f])) : '');
  const fld = (f, lab, ph) => `<label class="ab-ov-f"><span>${lab}</span>
    <input type="number" step="any" min="0" class="roll-input mono" placeholder="${ph}"
           data-action="change-ability-ov" data-slot="${esc(slot)}" data-field="${f}"
           value="${val(f)}" aria-label="${esc(slot)} ${lab} override"></label>`;
  return `<div class="ab-ov">
    <span class="fx-row-label">Your overrides <span class="hint-inline">(blank = data/default; they feed the engine)</span></span>
    <div class="ab-ov-fields">
      ${fld('damage', 'dmg', '—')}
      ${fld('cooldown_s', 'cd s', '—')}
      ${fld('cast_time_s', 'cast s', '—')}
      <label class="ab-ov-f"><span>scales</span>
        <select data-action="change-ability-ov" data-slot="${esc(slot)}" data-field="scaling_stat" aria-label="${esc(slot)} scaling stat override">
          <option value="">—</option>
          ${DB.mainStats.map(s => `<option value="${esc(s.id)}" ${o.scaling_stat === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select></label>
    </div>
  </div>`;
}

function renderKitStrip() {
  const mastery = currentMastery();
  $('#kit-strip').innerHTML = mastery.abilities.map((ab, idx) => {
    const expanded = expandedAbilities.has(idx);
    /* V3 : plus d'"Unnamed" — repli "Q — <Mastery>" (les descriptions
       réelles du client sont maintenant présentes pour 90/90). */
    const name = ab.name ? esc(ab.name) : `<span class="unnamed">${esc(ab.slot)} — ${esc(mastery.name)}</span>`;
    const chips = abilityValueChips(ab);
    const lowConf = ab.params && (ab.params.confidence === 'low');
    const chipsHtml = chips.length
      ? `<div class="val-chips">${chips.map(c => `<span class="val-chip mono">${esc(c)}</span>`).join('')}
         ${lowConf ? `<span class="val-chip warn" title="${esc(ab.params.numbers_source || 'low-confidence source')}">low conf.</span>` : ''}</div>`
      : `<div class="val-chips"><button class="val-chip muted-chip" data-action="toggle-ability" data-idx="${idx}" title="Open the override editor">no sourced values — set your own</button></div>`;
    return `<div class="kit-card-wrap">
      <button class="kit-card ${expanded ? 'expanded' : ''}" data-action="toggle-ability" data-idx="${idx}" aria-expanded="${expanded}">
        <span class="kit-slot-badge">${esc(ab.slot === 'Passive' ? 'P' : ab.slot)}</span>
        ${iconTag(ab.icon, 'kit-icon', KIND_GLYPH.ability)}
        <span class="kit-name">${name}</span>
        <span class="kit-dps mono" data-kit-dps="${esc(ab.slot)}"></span>
      </button>
      ${chipsHtml}
      <div class="kit-desc" ${expanded ? '' : 'hidden'}>
        ${esc(stripCtrl(ab.description) || 'No description available.')}
        ${abilityOverrideEditorHTML(ab.slot)}
      </div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════════
   V3 — ARBRE DE MASTERY (layout client réel : nodes x/y, arêtes achetables)
   Budget 26 points (1 pt par niveau de node, 1 pt par arête achetée — le
   coût d'arête est une hypothèse, cf. rough edges). Ults exclusifs.
   ══════════════════════════════════════════════════════════════════════ */
let selectedMasteryNode = null;

/* Le texte client embarque des balises (<ctrl>…</ctrl>) : on les retire
   plutôt que de les afficher échappées. */
function stripCtrl(s) { return String(s || '').replace(/<\/?[a-z][^>]*>/gi, ''); }

/* ── Résolution des paramètres de node ({{Data.N.PARAM}}) ───────────────
   Les `levels` d'un node sont soit des scalaires (un seul paramètre),
   soit des objets {PARAM: valeur} par niveau. Les descriptions client
   référencent des paramètres parfois ABSENTS des tables extraites : on
   résout alors par famille (suffixe numérique retiré, ex. ACP2→ACP1),
   marqué ≈ approximatif ; sinon "?" muet — jamais de token brut ni de
   [object Object]. Valeurs |v| ≤ 1 = pourcentages (×100, signe gardé). */
function nodeParamTable(node) {
  const out = {};
  const lvls = node.levels || [];
  if (lvls.length && lvls.every(v => typeof v === 'number')) {
    const key = (node.level_params && node.level_params[0]) || 'value';
    out[key] = lvls.slice();
    return out;
  }
  lvls.forEach((lv, li) => {
    if (lv && typeof lv === 'object') {
      Object.entries(lv).forEach(([k, v]) => {
        if (!out[k]) out[k] = [null, null, null];
        out[k][li] = v;
      });
    }
  });
  return out;
}
const paramBase = k => String(k).replace(/\d+$/, '');
function resolveNodeParam(table, key) {
  if (table[key]) return { key, values: table[key], approx: false };
  const base = paramBase(key);
  const fam = Object.keys(table).filter(k => paramBase(k) === base)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  if (fam.length) return { key: fam[0], values: table[fam[0]], approx: true, wanted: key };
  return null;
}
function fmtParamVal(v, signed) {
  if (!Number.isFinite(v)) return '?';
  if (Math.abs(v) <= 1) {
    const p = Math.round(v * 1000) / 10;             // 0.125 → 12.5
    return (signed && p > 0 ? '+' : '') + p + '%';
  }
  const n = Math.round(v * 100) / 100;
  return (signed && n > 0 ? '+' : '') + n;
}
/* Texte de node : échappé PUIS placeholders substitués — valeur au niveau
   investi, ou progression "v1/v2/v3" quand aucun point n'est mis. */
function renderNodeText(node, txt, lvl) {
  const table = nodeParamTable(node);
  let safe = esc(stripCtrl(txt || ''));
  safe = safe.replace(/\{\{Data\.\d+\.([A-Za-z0-9_]+)\}\}/g, (m0, key) => {
    const r = resolveNodeParam(table, key);
    if (!r) return `<span class="mt-val missing" title="value not in the extracted client tables (${esc(key)})">?</span>`;
    const prog = r.values.map(v => fmtParamVal(v, false)).join('/');
    const shown = lvl > 0 ? fmtParamVal(r.values[Math.min(lvl, r.values.length) - 1], false) : prog;
    const tip = (r.approx ? `nearest param ${r.key} (description asks ${r.wanted}) — approximate · ` : '') + 'L1/L2/L3: ' + prog;
    return `<span class="mt-val ${r.approx ? 'approx' : ''}" title="${esc(tip)}">${r.approx ? '≈' : ''}${esc(shown)}</span>`;
  });
  /* Placeholders non-Data (rares, ex. EffectCreator…) : "?" muet. */
  safe = safe.replace(/\{\{[^}]*\}\}/g, '<span class="mt-val missing" title="unresolvable client placeholder">?</span>');
  return safe;
}
/* Chips par niveau : seulement les paramètres réellement référencés par la
   description (le reste dans le title), format "AV −30% · ACP1 +30%". */
function nodeLevelChips(node, selLvl) {
  const table = nodeParamTable(node);
  const allKeys = Object.keys(table);
  if (!allKeys.length) return '';
  const txt = (node.description || '') + ' ' + (node.level_bonus_text || '');
  const refKeys = [];
  (txt.match(/\{\{Data\.\d+\.([A-Za-z0-9_]+)\}\}/g) || []).forEach(m => {
    const key = m.replace(/^\{\{Data\.\d+\./, '').replace(/\}\}$/, '');
    const r = resolveNodeParam(table, key);
    if (r && !refKeys.includes(r.key)) refKeys.push(r.key);
  });
  const shown = refKeys.length ? refKeys : allKeys;
  return [0, 1, 2].map(li => {
    const parts = shown.map(k => `${k} ${fmtParamVal(table[k][li], true)}`).join(' · ');
    const tipAll = 'all params — ' + allKeys.map(k => `${k} ${fmtParamVal(table[k][li], true)}`).join(' · ');
    return `<span class="val-chip mono ${selLvl >= li + 1 ? '' : 'off'}" title="${esc(tipAll)}">L${li + 1}: ${esc(parts)}</span>`;
  }).join('');
}
/* Texte simple (talents…) : jamais de {{placeholder}} brut à l'écran. */
function renderPlainText(txt) {
  return esc(stripCtrl(txt || ''))
    .replace(/\{\{[^}]*\}\}/g, '<span class="mt-val missing" title="unresolvable client placeholder">?</span>');
}

function masterySpecKey() { return state.heroId + '/' + state.masteryId; }
function masterySpec() { return DB.masterySpecs[masterySpecKey()] || null; }
function masteryAllocFor(create) {
  if (!state.masteryAlloc) state.masteryAlloc = {};
  let a = state.masteryAlloc[masterySpecKey()];
  if (!a && create) a = state.masteryAlloc[masterySpecKey()] = { nodes: {}, edges: [] };
  return a || { nodes: {}, edges: [] };
}
function masteryPointsSpent(alloc) {
  return Object.values(alloc.nodes || {}).reduce((s, v) => s + v, 0) + (alloc.edges || []).length;
}
/* Les arêtes existent en double (aller/retour) : id canonique = le plus
   petit des deux — un seul trait dessiné, un seul achat par paire. */
function canonicalEdgeId(e) {
  return (e.reverse_edge && String(e.reverse_edge) < String(e.id)) ? e.reverse_edge : e.id;
}

/* ══ V4.3 — CONNECTIVITÉ DE PROGRESSION (règle UI, feedback utilisateur) ══
   In-game on progresse pas à pas : un point n'est investissable que s'il
   est ATTEIGNABLE depuis la progression courante. Règle appliquée à l'UI
   uniquement — le moteur ne la vérifie pas (cohérent avec la philosophie
   du budget souple : le state reste calculable quoi qu'il contienne).

   RACINES (inférence, vérifiée sur les 7 specs construits) : chaque
   branche de skill (Q/W/E/T) démarre à son node le plus proche du rail
   gauche = le plus petit x de la branche, qui coïncide partout avec le
   suffixe _1 des ids client (CHA_S1_Q_1, CHA_S3_Q1…). EXCEPTION ULTS :
   les nodes R (ult_exclusive_group) sont ISOLÉS dans les données client —
   zéro arête ne les touche sur les 7 specs — la connectivité est donc
   inapplicable : ils restent investissables librement (terminaux et
   mutuellement exclusifs, comme avant).

   Règles de clic :
   - node niveau 0 → 1 : racine, ult, OU une arête ACHETÉE le relie à un
     node investi ; monter un node déjà investi (2, 3) : toujours permis ;
   - arête : achetable seulement si ≥1 extrémité est un node investi ;
   - REMBOURSEMENT (règle choisie : BLOCAGE, pas de cascade) : retirer un
     node/une arête est refusé si cela créerait de NOUVEAUX orphelins
     (node investi déconnecté des racines, arête sans ancre) — on défait
     sa progression feuille par feuille, comme in-game. Le "nouveaux" est
     important : les orphelins HÉRITÉS d'une vieille sauvegarde (règle
     absente à l'époque) restent librement remboursables.
   - MIGRATION : une allocation héritée non connectée est CONSERVÉE telle
     quelle (jamais supprimée) + chip d'avertissement sur l'en-tête de
     l'arbre ; les nouveaux clics suivent la règle. */
function masteryRoots(spec) {
  const best = {};
  (spec.nodes || []).forEach(n => {
    if (n.ult_exclusive_group) return; // les ults ne sont jamais racines
    const s = n.skill || '?';
    if (!best[s] || n.x < best[s].x) best[s] = n;
  });
  return new Set(Object.values(best).map(n => n.id));
}
/* Index {cid → arête} (une entrée par paire canonique). */
function masteryCanonEdges(spec) {
  const map = new Map();
  (spec.edges || []).forEach(e => {
    const cid = canonicalEdgeId(e);
    if (!map.has(cid)) map.set(cid, e);
  });
  return map;
}
/* Un node de niveau 0 est-il investissable ? (règle locale, verbatim :
   racine OU relié à un node INVESTI par une arête ACHETÉE ; ult exempté.) */
function masteryNodeInvestable(spec, alloc, nodeId) {
  const node = (spec.nodes || []).find(n => n.id === nodeId);
  if (!node) return false;
  if (node.ult_exclusive_group) return true; // aucune arête client ne touche les ults — inapplicable
  if (masteryRoots(spec).has(nodeId)) return true;
  const invested = new Set(Object.keys(alloc.nodes || {}).filter(id => (alloc.nodes || {})[id] > 0));
  const canon = masteryCanonEdges(spec);
  return (alloc.edges || []).some(cid => {
    const e = canon.get(cid);
    if (!e) return false;
    return (e.from === nodeId && invested.has(e.to)) || (e.to === nodeId && invested.has(e.from));
  });
}
/* Une arête est-elle achetable ? (≥1 extrémité investie.) */
function masteryEdgeBuyable(spec, alloc, cid) {
  const e = masteryCanonEdges(spec).get(cid);
  if (!e) return false;
  const nodes = alloc.nodes || {};
  return (nodes[e.from] || 0) > 0 || (nodes[e.to] || 0) > 0;
}
/* Validation globale par point fixe : depuis les racines/ults investis, on
   propage à travers les arêtes achetées vers les nodes investis. Retourne
   les orphelins (nodes investis non connectés + arêtes sans ancre connectée)
   — sert au chip de migration ET à la garde de remboursement. */
function masteryConnectivity(spec, alloc) {
  const invested = new Set(Object.keys(alloc.nodes || {}).filter(id => (alloc.nodes || {})[id] > 0));
  const bought = (alloc.edges || []).slice();
  const roots = masteryRoots(spec);
  const canon = masteryCanonEdges(spec);
  const nodeById = {};
  (spec.nodes || []).forEach(n => { nodeById[n.id] = n; });
  const conn = new Set();
  invested.forEach(id => {
    const n = nodeById[id];
    if (roots.has(id) || (n && n.ult_exclusive_group)) conn.add(id);
  });
  let changed = true;
  while (changed) {
    changed = false;
    bought.forEach(cid => {
      const e = canon.get(cid);
      if (!e) return;
      if (conn.has(e.from) && invested.has(e.to) && !conn.has(e.to)) { conn.add(e.to); changed = true; }
      if (conn.has(e.to) && invested.has(e.from) && !conn.has(e.from)) { conn.add(e.from); changed = true; }
    });
  }
  const orphanNodes = [...invested].filter(id => !conn.has(id));
  const orphanEdges = bought.filter(cid => {
    const e = canon.get(cid);
    return !e || !(conn.has(e.from) || conn.has(e.to));
  });
  return { orphanNodes, orphanEdges, ok: !orphanNodes.length && !orphanEdges.length };
}
/* Garde de remboursement : simule la mutation et refuse si elle crée de
   NOUVEAUX orphelins (les orphelins hérités d'une vieille sauvegarde ne
   comptent pas — ils doivent rester remboursables). true = OK. */
function masteryRefundAllowed(spec, alloc, mutate) {
  const before = masteryConnectivity(spec, alloc);
  const seen = new Set([...before.orphanNodes, ...before.orphanEdges]);
  const sim = { nodes: { ...(alloc.nodes || {}) }, edges: (alloc.edges || []).slice() };
  mutate(sim);
  const after = masteryConnectivity(spec, sim);
  return ![...after.orphanNodes, ...after.orphanEdges].some(x => !seen.has(x));
}
const MASTERY_LOCKED_TIP = 'atteins ce point via un chemin connecté';

function renderMasteryTree() {
  const el = $('#mastery-tree');
  if (!el) return;
  const spec = masterySpec();
  const maxPts = (DB.masterySystem || {}).points_max || 26;
  if (!spec || !spec.built) {
    el.innerHTML = `<div class="mt-empty"><span class="unknown-chip">not in game yet</span>
      <p class="hint">This mastery's tree isn't present in the client build — nothing to allocate.</p></div>`;
    return;
  }
  const alloc = masteryAllocFor(false);
  const spent = masteryPointsSpent(alloc);
  const nodes = spec.nodes || [], edges = spec.edges || [];
  const PAD = 55;
  const ANCHOR_GUTTER = 100; // gouttière gauche pour les ancres de skill (look in-game)
  const minX = Math.min(...nodes.map(n => n.x)) - PAD - ANCHOR_GUTTER;
  const maxX = Math.max(...nodes.map(n => n.x)) + PAD;
  const minY = Math.min(...nodes.map(n => n.y)) - PAD, maxY = Math.max(...nodes.map(n => n.y)) + PAD;
  const W = maxX - minX, H = maxY - minY;
  const px = x => (((x - minX) / W) * 100).toFixed(3);
  const py = y => (((y - minY) / H) * 100).toFixed(3);
  const nodeById = {};
  nodes.forEach(n => { nodeById[n.id] = n; });
  const seen = new Set(); const uniq = [];
  edges.forEach(e => { const cid = canonicalEdgeId(e); if (!seen.has(cid)) { seen.add(cid); uniq.push(e); } });
  const boughtSet = new Set(alloc.edges || []);
  const investedSet = new Set(Object.keys(alloc.nodes || {}).filter(id => (alloc.nodes || {})[id] > 0));

  /* V4.3 — états visuels DÉSORMAIS contraignants (garde de clic dans le
     handler) : invested / available (racine, ult, ou relié à un investi
     par une arête achetée) / locked. Arbre vierge : seules les racines
     (et les ults, données sans arêtes) sont disponibles. */
  const roots = masteryRoots(spec);
  const investableSet = new Set([...roots].filter(id => nodeById[id]));
  nodes.forEach(n => { if (n.ult_exclusive_group) investableSet.add(n.id); });
  boughtSet.forEach(cid => {
    const e = uniq.find(x => canonicalEdgeId(x) === cid);
    if (!e) return;
    if (investedSet.has(e.from)) investableSet.add(e.to);
    if (investedSet.has(e.to)) investableSet.add(e.from);
  });
  const nodeState = id => investedSet.has(id) ? 'invested' : investableSet.has(id) ? 'available' : 'locked';
  /* Migration : allocation héritée non connectée → conservée + signalée. */
  const connectivity = masteryConnectivity(spec, alloc);

  /* ── Connecteurs = CHAÎNES DE CELLULES LOSANGE (look in-game), plus
     aucune ligne SVG. 2-4 cellules par arête selon sa longueur (~130
     cellules mineures par arbre dans la référence) ; l'achat de l'arête
     (1 pt) allume toute sa chaîne en ambre. */
  let cellsHtml = '';
  uniq.forEach(e => {
    const a = nodeById[e.from], b = nodeById[e.to];
    if (!a || !b) return;
    const cid = canonicalEdgeId(e);
    const bought = boughtSet.has(cid);
    /* V4.3 : une arête n'est disponible que depuis une extrémité investie
       (plus de tout-disponible sur arbre vierge : investis une racine). */
    const avail = bought || investedSet.has(e.from) || investedSet.has(e.to);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const K = Math.max(2, Math.min(4, Math.round(dist / 70)));
    const tip = `${stripCtrl(e.effect_text)} · +1 WSB (${e.wsb_slot || '?'}) · 1 pt${bought ? ' — bought' : ''}${!bought && !avail ? ' · ' + MASTERY_LOCKED_TIP : ''}`;
    for (let k = 1; k <= K; k++) {
      const t = k / (K + 1);
      const cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t;
      cellsHtml += `<button class="mt-cell ${bought ? 'bought' : ''} ${avail ? '' : 'locked'}"
        style="left:${px(cx)}%;top:${py(cy)}%"
        data-action="toggle-mastery-edge" data-edge-id="${esc(cid)}"
        title="${esc(tip)}" aria-label="Path cell — ${esc(stripCtrl(e.effect_text))}"><span class="mt-cell-plus">+</span></button>`;
    }
  });

  /* ── Ancres de skill (rail gauche, comme in-game) : Q/W/E/R/T à la
     hauteur moyenne de leurs nodes, icône du kit quand elle existe. */
  const mastery = currentMastery();
  const skillRows = {};
  nodes.forEach(n => {
    const s = n.skill || '?';
    (skillRows[s] = skillRows[s] || { ys: [], name: n.skill_name || s }).ys.push(n.y);
  });
  const anchorX = minX + PAD + ANCHOR_GUTTER * 0.35;
  const anchorsHtml = Object.entries(skillRows).map(([sk, info]) => {
    const meanY = info.ys.reduce((s, v) => s + v, 0) / info.ys.length;
    const ab = mastery && (mastery.abilities || []).find(x => x.slot === (sk === 'T' ? 'Passive' : sk));
    return `<div class="mt-anchor" style="left:${px(anchorX)}%;top:${py(meanY)}%" title="${esc(info.name)} (${esc(sk)})">
      ${iconTag(ab && ab.icon, 'mt-anchor-icon', sk)}
      <span class="mt-anchor-key">${esc(sk)}</span>
    </div>`;
  }).join('');

  const nodesHtml = nodes.map(n => {
    const lvl = (alloc.nodes || {})[n.id] || 0;
    const st = nodeState(n.id);
    return `<button class="mt-node ${st} ${n.ult_exclusive_group ? 'ult' : ''} ${selectedMasteryNode === n.id ? 'selected' : ''}"
      style="left:${px(n.x)}%;top:${py(n.y)}%"
      data-action="mastery-node" data-node-id="${esc(n.id)}"
      title="${esc(n.name)} — ${esc(n.skill_name || n.skill)}${n.ult_exclusive_group ? ' (ult — exclusive, terminal)' : ''}${st === 'locked' ? ' · ' + esc(MASTERY_LOCKED_TIP) : ''}"
      aria-label="${esc(n.name)}, level ${lvl} of ${n.max_level || 3}, ${st}">
      ${iconTag(n.icon, 'mt-node-icon', '◆')}
      ${lvl ? `<span class="mt-node-lvl mono">${lvl}</span>` : ''}
    </button>`;
  }).join('');

  /* Perks T3 officiels des armes équipées : "+1 niveau à ce talent, cap 3"
     (news #306) — picker limité aux nodes investis. */
  const enhBlocks = [];
  state.weapons.forEach((slot, i) => {
    if (!slot.key) return;
    const item = resolveWeapon(slot.key, slot.weaponType, slot.tier);
    if (!item || (item.tier !== 'T3' && item.tier !== 'T3+') || slot.upgrade === 'normal') return;
    const nPerks = slot.upgrade === 'overclocked' ? 2 : 1;
    const picked = fxList('t3perk:w' + i).filter(e => e.nodeId);
    const chips = picked.map((e, pi) => {
      const node = nodeById[e.nodeId];
      return `<span class="val-chip" title="+1 level to this talent (cap 3) — official T3 gear perk">${esc(node ? node.name : e.nodeId)}
        <button class="clear-btn small" data-action="clear-enhanced" data-slot-index="${i}" data-fx-index="${pi}" aria-label="Remove enhanced talent">×</button></span>`;
    }).join('');
    const addBtn = picked.length < nPerks
      ? `<button class="act ghost" data-action="pick-enhanced" data-slot-index="${i}">+ enhanced talent (${picked.length}/${nPerks})</button>` : '';
    enhBlocks.push(`<div class="mt-enh"><span class="field-label">${esc(slot.label)} · T3 ${esc(upgradeLabel(slot.upgrade))}</span>${chips}${addBtn}</div>`);
  });

  const sel = selectedMasteryNode ? nodeById[selectedMasteryNode] : null;
  const selLvl = sel ? ((alloc.nodes || {})[sel.id] || 0) : 0;
  const detail = sel ? `
    <div class="mt-detail">
      <div class="mt-detail-head">
        ${iconTag(sel.icon, 'mt-node-icon', '◆')}
        <span class="mt-detail-name">${esc(sel.name)}</span>
        <span class="wtype-chip">${esc(sel.skill_name || sel.skill)}</span>
        ${sel.ult_exclusive_group ? '<span class="val-chip warn">ult — exclusive</span>' : ''}
        <span class="mono">lvl ${selLvl}/${sel.max_level || 3}</span>
      </div>
      <p class="mt-detail-desc">${renderNodeText(sel, sel.description, selLvl)}</p>
      <div class="val-chips">${nodeLevelChips(sel, selLvl)}</div>
      ${sel.level_bonus_text ? `<p class="hint">Level 3 bonus — ${renderNodeText(sel, sel.level_bonus_text, selLvl)}</p>` : ''}
    </div>` : '<p class="hint">Start at a branch’s root node (next to the skill rail), then buy path cells to reach further nodes — progression is step-by-step, like in-game. Click a node to invest (1→3, one more click clears) · click a path to buy it (+1 weapon skill bonus).</p>';

  el.innerHTML = `
    <div class="mt-head">
      <span class="mono mt-budget ${spent > maxPts ? 'over' : ''}">${spent}/${maxPts} pts</span>
      ${auditBadgeHTML('mastery_node:|mastery_edge:')}
      ${!connectivity.ok ? `<span class="val-chip warn" title="${esc(`Cette allocation contient ${connectivity.orphanNodes.length} node(s) et ${connectivity.orphanEdges.length} arête(s) non connectés à une racine — héritage d'une sauvegarde antérieure à la règle de progression connectée. Rien n'est supprimé ; les nouveaux clics suivent la règle.`)}">allocation non connectée (ancienne sauvegarde)</span>` : ''}
      ${spent ? '<button class="act ghost" data-action="reset-mastery">Reset</button>' : ''}
      ${enhBlocks.join('')}
    </div>
    <div class="mt-board" style="aspect-ratio:${(W / H).toFixed(3)}">${cellsHtml}${anchorsHtml}${nodesHtml}</div>
    ${detail}`;
}

function openEnhancedPicker(weaponIdx) {
  const spec = masterySpec();
  if (!spec || !spec.built) { showToast('No mastery tree in game for this spec.'); return; }
  const alloc = masteryAllocFor(false);
  const invested = (spec.nodes || []).filter(n => (alloc.nodes || {})[n.id] > 0);
  if (!invested.length) { showToast('Invest mastery points first — the perk enhances one of YOUR nodes.'); return; }
  openDrawer({
    title: 'Enhanced talent (+1 level, cap 3)', kind: 'generic',
    items: invested.map(n => ({ key: n.id, name: n.name, icon: n.icon, sub: `${n.skill_name || n.skill} · current level ${(alloc.nodes || {})[n.id]}`, generic: false })),
    onSelect(it) {
      state.customEffects.push({
        source: 't3perk:w' + weaponIdx, stat: null, value: null, unit: '%', uptime: null,
        note: '+1 level to ' + it.name + ' (cap 3, official T3 perk)', nodeId: it.key,
      });
      render();
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════
   V4 — ROLLS BORNÉS : chaque stat roll est un ENTIER dans la fourchette
   réelle [min,max] de (item, stat, RARETÉ) — stat_bands par item quand le
   pipeline les a matchées, sinon repli catalogue générique. Les étoiles
   sont DÉRIVÉES de la position du roll dans la bande (1 + floor(4·(v−min)
   /(max−min)), seuils in-game non confirmés) — plus jamais saisies.
   ══════════════════════════════════════════════════════════════════════ */
function statRollRange(statId, tier, rarity) {
  const c = DB.raw.combat && DB.raw.combat.stat_rolls;
  const cell = c && c[statId] && c[statId][tier] && c[statId][tier][rarity];
  return (cell && Array.isArray(cell.range) && cell.range.length === 2) ? cell.range : null;
}
function mainStatRange(item, statId) {
  if (item && item.main_stat && item.main_stat.stat === statId
      && Number.isFinite(item.main_stat.min) && Number.isFinite(item.main_stat.max)) {
    return [item.main_stat.min, item.main_stat.max];
  }
  return item ? statRollRange(statId, item.tier, 'common') : null;
}
/* Bande entière pour un slot de stat d'artefact, à la rareté COURANTE.
   main : item.stat_bands[rarity].main[stat] > main_stat > catalogue ;
   secondary : item.stat_bands[rarity].secondary[stat] (vide aujourd'hui)
   > catalogue stat_rolls. null = pas de bande (mode libre flaggé). */
/* V4.1 : bandes de stats secondaires par (stat, tier) — livrées par la
   vague pipeline parallèle dans combat.secondary_bands ; la cellule peut
   être un [min,max] invariant OU un objet par rareté. Absence = null. */
function secondaryBandLookup(statId, tier, rarity) {
  const sb = DB.raw.combat && DB.raw.combat.secondary_bands;
  const cell = sb && sb[statId] && sb[statId][tier];
  if (!cell) return null;
  if (Array.isArray(cell)) return cell;
  if (typeof cell === 'object') {
    const r = cell[rarity] || cell.common;
    return Array.isArray(r) ? r : null;
  }
  return null;
}
/* V6 : bandes FRACTIONNAIRES (lifesteal/ability_steal, cf. le _unit_note de
   combat.secondary_bands : [0.008,0.012] = 0.8–1.2%) — l'arrondi entier les
   écrasait en [0,0] (stepper "0 – 0", ± désactivés, tout clic clampé à 0).
   Détection par la magnitude de la bande (max < 1 : aucune stat en points
   ne roll sous 1), même sémantique que fractionRollStat côté moteur. */
function isFractionBand(band) {
  return Array.isArray(band) && Math.abs(band[1]) < 1 && Math.abs(band[0]) < 1;
}
/* Pas d'incrément d'un roll : rounding_step de la stat quand la donnée en
   fournit un (> 0), sinon 0.001 pour une bande fractionnaire, sinon 1. */
function bandStep(statId, band) {
  const sb = DB.raw.combat && DB.raw.combat.secondary_bands;
  const ent = sb && statId ? sb[statId] : null;
  if (ent && Number.isFinite(ent.rounding_step) && ent.rounding_step > 0) return ent.rounding_step;
  return isFractionBand(band) ? 0.001 : 1;
}
/* Nettoie le bruit flottant d'une arithmétique de pas fractionnaire
   (0.008 + 0.001 → 0.009000000000000001) ; inoffensif sur les entiers. */
function snapRollValue(v) { return Number.isFinite(v) ? +v.toFixed(6) : v; }
/* Affichage d'une valeur de roll : les fractions gardent leurs décimales
   réelles (fmtNum tronquerait 0.008 en "0.01") ; les entiers inchangés. */
function fmtRollValue(v, fractional) { return fractional ? String(snapRollValue(v)) : String(v); }

function bandFor(item, slot, statId, isMain) {
  if (!item || !statId) return null;
  const sb = item.stat_bands && item.stat_bands[slot.rarity];
  let b = null;
  if (sb) b = isMain ? (sb.main && sb.main[statId]) : (sb.secondary && sb.secondary[statId]);
  if (!b && !isMain) b = secondaryBandLookup(statId, item.tier, slot.rarity); // V4.1
  if (!b) b = isMain ? mainStatRange(item, statId) : statRollRange(statId, item.tier, slot.rarity);
  if (!Array.isArray(b) || b.length !== 2 || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) return null;
  const lo = Math.min(b[0], b[1]), hi = Math.max(b[0], b[1]);
  if (isFractionBand([lo, hi])) return [lo, hi]; // V6 : jamais d'arrondi entier sur une bande fraction
  return [Math.round(lo), Math.round(hi)];
}
function clampToBand(v, band) {
  if (isFractionBand(band)) return Math.min(band[1], Math.max(band[0], v)); // V6 : clamp sans arrondi
  return Math.min(band[1], Math.max(band[0], Math.round(v)));
}

/* V4.1 : dropdown des stats secondaires restreint au POOL réellement
   roulable sur artefact (mechanics.secondary_stat_pool.groups), en
   optgroups physical/magical/utility ; une stat hors pool venue d'un
   vieux lien reste sélectionnable dans un groupe "legacy". */
function secondaryStatOptionsHTML(currentVal) {
  const groups = secondaryPoolGroups();
  if (!groups) {
    return DB.secondaryStats.map(s => `<option value="${esc(s.id)}" ${currentVal === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  }
  const poolIds = new Set(groups.flatMap(g => g.ids));
  let html = groups.map(g => `<optgroup label="${esc(pretty(g.group))}">
    ${g.ids.map(id => `<option value="${esc(id)}" ${currentVal === id ? 'selected' : ''}>${esc(statDisplayName(id))}</option>`).join('')}
  </optgroup>`).join('');
  if (currentVal && !poolIds.has(currentVal)) {
    html += `<optgroup label="Legacy (not in the artifact pool)">
      <option value="${esc(currentVal)}" selected>${esc(statDisplayName(currentVal))}</option>
    </optgroup>`;
  }
  return html;
}
/* Étoiles dérivées (V4) : position du roll dans la bande, clampé 1..5.
   V6 : délégué à Engine.deriveStars — parité exacte avec le moteur, dont
   la garde de span positif fait marcher les bandes fractionnaires
   (l'ancien max(1, span) local écrasait un span de 0.004 → toujours 1★).
   Les bandes fractionnaires sont d'abord normalisées en espace ENTIER
   (×1000, exact pour un pas de 0.001) : l'arithmétique IEEE des quintiles
   fractionnaires est bruitée (4×(0.011−0.008)/0.004 = 2.999…9 → floor 2)
   et afficherait 3★ là où 0.011 est exactement la valeur 4★. */
function starsFromRoll(v, band) {
  if (!band || !Number.isFinite(v)) return null;
  if (isFractionBand(band)) {
    return Engine.deriveStars(Math.round(v * 1000), [Math.round(band[0] * 1000), Math.round(band[1] * 1000)]);
  }
  return Engine.deriveStars(v, band);
}
/* Conversion des étoiles héritées (vieux liens) en roll — quintile. */
function rollFromStars(stars, band) {
  return clampToBand(band[0] + (stars - 1) / 4 * (band[1] - band[0]), band);
}

/* Drapeaux UI "custom" (théorycrafting hors bande) — jamais persistés ;
   une valeur hors bande au chargement s'affiche d'office en custom. */
const customRollFlags = new Set();
function rollKey(i, si) { return si == null ? `cu:${i}:main` : `cu:${i}:${si}`; }
function isCustomRoll(i, si, roll, band) {
  if (customRollFlags.has(rollKey(i, si))) return true;
  return Number.isFinite(roll) && band && (roll < band[0] || roll > band[1]);
}

/* V4.2 — étoiles en saisie DIRECTE pour les secondaires sans bande :
   combat.secondary_bands livre des cellules toutes nulles (aucune source
   numérique publique) ; on laisse l'utilisateur cliquer l'étoile vue en
   jeu plutôt que de deviner une valeur. Stocké dans secondaryStars[si] ;
   le moteur applique le repli étoiles→plage (resolveStatValue) quand une
   plage existe ailleurs (stat_rolls), sinon inerte avec raison précise —
   dans tous les cas un roll saisi à côté GARDE la priorité (contrat
   engine.js::resolveBandedRoll/resolveStatValue : roll > stars). */
const SECONDARY_STAR_TITLE = 'plages non publiées — entre la valeur ou les étoiles vues en jeu';
function secondaryStarPickerHTML(i, si, roll, label) {
  const a = state.artifacts[i];
  const stars = a && Array.isArray(a.secondaryStars) ? a.secondaryStars[si] : null;
  const hasManualValue = Number.isFinite(roll);
  const glyph = DB.starModel && DB.starModel.ui_glyph;
  return `<div class="star-row picker ${hasManualValue ? 'dim' : ''}" title="${esc(SECONDARY_STAR_TITLE)}">
    <span class="star-set manual" aria-label="${Number.isInteger(stars) ? stars : 0} of 5 stars, set manually">
      ${[1, 2, 3, 4, 5].map(s => `<button type="button" class="star-glyph-wrap btn ${Number.isInteger(stars) && stars >= s ? 'on' : ''}"
          data-action="set-secondary-stars" data-slot-index="${i}" data-sec-index="${si}" data-stars="${s}"
          aria-label="${esc(label)} — set ${s} star${s > 1 ? 's' : ''} (click again to clear)" aria-pressed="${stars === s}">
          ${iconTag(glyph, 'star-glyph', '★')}
        </button>`).join('')}
    </span>
    ${hasManualValue ? '<span class="hint-inline">value entered — stars kept but not used</span>'
      : (Number.isInteger(stars) ? '<span class="hint-inline">stars feed the engine via its fallback mapping</span>' : '')}
  </div>`;
}

/* Éditeur de roll V4 : stepper borné [− valeur +] + bande "min–max" mono
   + étoiles DÉRIVÉES en direct (5★ = max) ; échappatoire "custom" (#)
   pour le hors-bande, clairement flaggée. Sans bande : saisie libre +
   (secondaires uniquement) étoiles cliquées en direct (V4.2). */
function rollEditorHTML(kind, i, si, roll, band, label, statId) {
  const isMain = kind === 'main';
  const chgAction = isMain ? 'change-main-roll' : 'change-secondary-roll';
  const stepAction = isMain ? 'step-main-roll' : 'step-secondary-roll';
  const togAction = isMain ? 'toggle-main-exact' : 'toggle-exact';
  const secAttr = isMain ? '' : `data-sec-index="${si}"`;
  const custom = isCustomRoll(i, si, roll, band);
  const glyph = DB.starModel && DB.starModel.ui_glyph;

  if (!band || custom) {
    /* Mode libre : pas de bande connue, ou théorycrafting assumé. */
    return `<div class="star-row exact">
      <input type="number" step="any" class="roll-input mono" placeholder="0"
        title="${band ? 'Custom value — outside the real band' : 'No band data for this stat — free value'}"
        aria-label="${esc(label)} custom roll value"
        data-action="${chgAction}" data-slot-index="${i}" ${secAttr}
        value="${Number.isFinite(roll) ? esc(String(roll)) : ''}">
      ${band ? `<span class="val-chip warn" title="Out-of-band theorycrafting — real band is ${band[0]}–${band[1]}">custom</span>
        <span class="mono star-range">[${band[0]}–${band[1]}]</span>
        <button class="act ghost star-toggle" data-action="${togAction}" data-slot-index="${i}" ${secAttr}
          title="Back to the real bounded band">band</button>`
      : '<span class="hint-inline" title="No [min,max] band shipped yet for this stat/tier — free value, engine clamps once bands land">band unknown</span>'}
    </div>
    ${(!isMain && !band) ? secondaryStarPickerHTML(i, si, roll, label) : ''}`;
  }

  /* V6 : bandes fractionnaires (lifesteal 0.008–0.012 = 0.8–1.2%) — pas
     d'incrément entier, affichage avec les vraies décimales + équivalent %
     dans l'étiquette de bande (le _unit_note de la donnée fait foi). */
  const frac = isFractionBand(band);
  const step = bandStep(statId, band);
  const shown = Number.isFinite(roll) ? clampToBand(roll, band) : band[1]; // défaut = max (convention planner)
  const stars = starsFromRoll(shown, band);
  const rangeTxt = `${fmtRollValue(band[0], frac)}–${fmtRollValue(band[1], frac)}`;
  const pctTxt = frac ? ` · ${+(band[0] * 100).toFixed(2)}–${+(band[1] * 100).toFixed(2)}%` : '';
  return `<div class="star-row bounded">
    <button class="step-btn" data-action="${stepAction}" data-slot-index="${i}" ${secAttr} data-dir="-1" data-step="${step}"
      aria-label="${esc(label)} decrease" ${shown <= band[0] ? 'disabled' : ''}>−</button>
    <input type="number" step="${step}" min="${band[0]}" max="${band[1]}" class="roll-input mono roll-bounded"
      data-action="${chgAction}" data-slot-index="${i}" ${secAttr}
      value="${esc(fmtRollValue(shown, frac))}" aria-label="${esc(label)} roll value (bounded ${band[0]} to ${band[1]})">
    <button class="step-btn" data-action="${stepAction}" data-slot-index="${i}" ${secAttr} data-dir="1" data-step="${step}"
      aria-label="${esc(label)} increase" ${shown >= band[1] ? 'disabled' : ''}>+</button>
    <span class="mono star-range" title="Real band at ${esc(label)} for this rarity${frac ? ' — client rolls this stat as a FRACTION (0.012 = 1.2%)' : ''}">${rangeTxt}${pctTxt}</span>
    <span class="star-set derived" title="${stars}★ — derived from the roll's position in the band (in-game thresholds unconfirmed)" aria-label="${stars} of 5 stars, derived">
      ${[1, 2, 3, 4, 5].map(s => `<span class="star-glyph-wrap ${stars >= s ? 'on' : ''}">${iconTag(glyph, 'star-glyph', '★')}</span>`).join('')}
    </span>
    <button class="act ghost star-toggle" data-action="${togAction}" data-slot-index="${i}" ${secAttr}
      title="Custom value (out-of-band theorycrafting, flagged)">#</button>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   RENDU — gear plate : armes / artefacts / sorts universels
   ══════════════════════════════════════════════════════════════════════ */
function tierControlHTML(i, current) {
  return `<div class="tier-seg" role="group" aria-label="Generic tier">
    ${['T1', 'T2', 'T3'].map(t => `<button class="seg-btn ${t === current ? 'active' : ''}" data-action="set-weapon-tier" data-slot-index="${i}" data-tier="${t}">${t}</button>`).join('')}
  </div>`;
}
function rarityDotsHTML(kind, i, current) {
  return `<div class="rarity-dots" role="group" aria-label="Rarity">
    ${DB.mechanics.rarities.map(r => `<button class="rarity-dot ${r.id === current ? 'active' : ''}" style="--chip-c:${r.color}" data-action="set-${kind}-rarity" data-slot-index="${i}" data-rarity="${r.id}" title="${esc(r.name)}" aria-label="${esc(r.name)}"></button>`).join('')}
  </div>`;
}
function upgradeSegHTML(kind, i, current) {
  return `<div class="upgrade-seg" role="group" aria-label="Upgrade state">
    ${DB.mechanics.upgrade_states.map(u => `<button class="seg-btn ${u === current ? 'active' : ''}" data-action="set-${kind}-upgrade" data-slot-index="${i}" data-upgrade="${u}">${upgradeLabel(u)}</button>`).join('')}
  </div>`;
}
/* ── Teinte de rareté d'un item ÉQUIPÉ : toute la carte prend la couleur
   (bordure, fond, nom, cadre d'icône) — épique = violet immanquable.
   Toujours des teintes douces via color-mix, jamais d'aplat saturé. */
function rarityColor(id) { const r = DB.rarityById.get(id); return r ? r.color : '#b9c2c8'; }

/* ── Effets supposés (contrat build.customEffects) ──────────────────────
   Aucune donnée chiffrée n'existe pour puces/runes/perks/corruption : on
   laisse l'utilisateur déclarer l'effet qu'il suppose (stat/valeur/unité/
   uptime) ; chaque entrée est taguée par sa source et part au moteur. */
function fxList(sourceTag) { return state.customEffects.filter(e => e.source === sourceTag); }
function fxCountActive(tags) {
  return state.customEffects.filter(e => tags.includes(e.source) && Number.isFinite(e.value)).length;
}
function fxGetOrCreate(sourceTag, idx, presetStat) {
  const list = fxList(sourceTag);
  while (list.length <= idx) {
    const ne = { source: sourceTag, stat: presetStat || null, value: null, unit: '%', uptime: null, note: '' };
    state.customEffects.push(ne);
    list.push(ne);
  }
  return list[idx];
}
function fxRemove(sourceTag, idx) {
  let n = -1;
  for (let k = 0; k < state.customEffects.length; k++) {
    if (state.customEffects[k].source === sourceTag) {
      n++;
      if (n === idx) { state.customEffects.splice(k, 1); return; }
    }
  }
}
function fxRowHTML(sourceTag, idx, label, presetStat, note) {
  const e = fxList(sourceTag)[idx] || null;
  const stat = e ? e.stat : (presetStat || '');
  /* V4.1 : l'unité est DÉRIVÉE de la stat choisie (chaque stat n'a qu'une
     forme réelle en jeu : les ratings sont des points "flat", les
     modificateurs explicites sont en %) — suffixe statique. Le choix
     manuel %/flat ne réapparaît que pour une stat ambiguë/inconnue. */
  const derived = statUnit(stat);
  const unitCtl = derived
    ? `<span class="unit-suffix mono" title="${derived === '%' ? 'This stat is a percentage in game' : 'This stat is a flat rating (points) in game'}">${esc(unitSuffix(derived))}</span>`
    : `<div class="tier-seg fx-unit" role="group" aria-label="Effect unit (stat form unknown)">
        <button class="seg-btn ${!e || e.unit !== 'flat' ? 'active' : ''}" data-action="set-fx-unit" data-unit="%">%</button>
        <button class="seg-btn ${e && e.unit === 'flat' ? 'active' : ''}" data-action="set-fx-unit" data-unit="flat">flat</button>
      </div>`;
  return `<div class="fx-row" data-fx-source="${esc(sourceTag)}" data-fx-index="${idx}" data-fx-preset="${esc(presetStat || '')}">
    <span class="fx-row-label" title="${esc(label)}">${esc(label)}</span>
    <button class="clear-btn small" data-action="clear-fx" aria-label="Remove assumed effect — ${esc(label)}">×</button>
    <select data-action="change-fx" data-field="stat" aria-label="Assumed effect stat — ${esc(label)}">
      <option value="">— stat —</option>
      ${DB.stats.map(s => `<option value="${esc(s.id)}" ${stat === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select>
    <span class="fx-val-wrap">
      <input type="number" step="any" class="roll-input mono" placeholder="0" data-action="change-fx" data-field="value"
             value="${e && Number.isFinite(e.value) ? esc(String(e.value)) : ''}" aria-label="Assumed effect value — ${esc(label)}">
    </span>
    ${unitCtl}
    <input type="number" min="0" max="100" step="5" class="roll-input mono fx-upt" placeholder="100" data-action="change-fx" data-field="uptime"
           value="${e && Number.isFinite(e.uptime) ? Math.round(e.uptime * 100) : ''}" title="Uptime / averaged proc, %" aria-label="Uptime percent — ${esc(label)}">
    ${note ? `<span class="hint fx-note">${esc(note)}</span>` : ''}
  </div>`;
}
function fxBlockHTML(key, rows, hint) {
  if (!rows.length) return '';
  const tags = [...new Set(rows.map(r => r.tag))];
  const active = fxCountActive(tags);
  const anyReal = rows.some(r => r.html);
  return `<details class="fx-block" data-key="${esc(key)}" ${openPanels.has(key) ? 'open' : ''}>
    <summary>${anyReal ? 'Socket effects' : 'Assumed effects'} <span class="mono">(${active})</span></summary>
    <p class="hint">${esc(hint || (anyReal
      ? 'Real values where the catalog has them (pick the socketed item’s rarity) — assumed entries elsewhere.'
      : 'No parsed numbers exist for these — declare the effect you assume; it feeds the engine as a tagged source.'))}</p>
    ${rows.map(r => r.html ? r.html : fxRowHTML(r.tag, r.idx, r.label, r.preset, r.note)).join('')}
  </details>`;
}

/* ── V4 : rangée "valeur réelle" d'une puce socketée ────────────────────
   Les bandes des puces sont des valeurs FIXES par rareté (clé 'default') ;
   la stat vient de stat_hint. Choisir la rareté de la puce écrit la
   valeur réelle dans la même entrée customEffects (le moteur V4 saura
   aussi la compter seul — l'entrée explicite garde la précédence). */
function chipBandValue(chip, rarityId) {
  const m = chip.stat_bands && chip.stat_bands[rarityId];
  if (!m) return null;
  const k = Object.keys(m)[0];
  const b = k && m[k];
  return Array.isArray(b) && Number.isFinite(b[1]) ? b[1] : null;
}
function chipAutoCounted(statId) {
  if (!statId || !engineResult) return false;
  const st = engineResult.sheet.stats[statId];
  return !!(st && (st.sources || []).some(s => /chip/i.test(String(s.label))));
}
function chipRealRowHTML(sourceTag, idx, chip) {
  const e = fxList(sourceTag)[idx] || null;
  const stat = (e && e.stat) || chip.stat_hint || '';
  const rarities = DB.mechanics.rarities.map(r => r.id).filter(r => chipBandValue(chip, r) != null);
  const auto = chipAutoCounted(stat);
  return `<div class="fx-row real" data-fx-source="${esc(sourceTag)}" data-fx-index="${idx}" data-fx-preset="${esc(chip.stat_hint || '')}">
    <span class="fx-row-label" title="${esc(stripCtrl(chip.description) || chip.name)}">${esc(chip.name)}
      <span class="val-chip mono" title="Real catalog values per chip rarity">real</span>
      ${auto ? '<span class="val-chip" title="The engine already counts this chip automatically — your entry overrides it">auto-counted</span>'
             : '<span class="hint-inline" title="Engine auto-count pending — this entry feeds the sheet">manual</span>'}
    </span>
    <button class="clear-btn small" data-action="clear-fx" aria-label="Remove chip effect — ${esc(chip.name)}">×</button>
    <select data-action="change-fx" data-field="stat" aria-label="Chip stat — ${esc(chip.name)}">
      <option value="">— stat —</option>
      ${DB.stats.map(s => `<option value="${esc(s.id)}" ${stat === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select>
    <span class="chip-rar-set" role="group" aria-label="Socketed chip rarity">
      ${rarities.map(r => {
        const v = chipBandValue(chip, r);
        const active = e && Number.isFinite(e.value) && e.value === v;
        return `<button class="chip-rar ${active ? 'active' : ''}" style="--chip-c:${esc(rarityColor(r))}"
          data-action="set-chip-fx-value" data-value="${v}" title="${esc(r)}: ${v}"
          aria-label="Chip rarity ${esc(r)} — value ${v}">${esc(r[0].toUpperCase())}</button>`;
      }).join('')}
    </span>
    <input type="number" step="1" class="roll-input mono" placeholder="0" data-action="change-fx" data-field="value"
      value="${e && Number.isFinite(e.value) ? esc(String(e.value)) : ''}" aria-label="Chip effect value — ${esc(chip.name)}">
    <span class="unit-suffix mono" title="Unit derived from the stat's real in-game form">${esc(unitSuffix(statUnit(stat) || 'flat'))}</span>
    <input type="number" min="0" max="100" step="5" class="roll-input mono fx-upt" placeholder="100" data-action="change-fx" data-field="uptime"
      value="${e && Number.isFinite(e.uptime) ? Math.round(e.uptime * 100) : ''}" title="Uptime %" aria-label="Chip uptime percent — ${esc(chip.name)}">
  </div>`;
}
/* Bandes de runes : des PARAMÈTRES d'effet (duration, damage…), pas des
   stats — affichées comme info réelle, l'éditeur supposé reste pour la
   contribution en stats. */
function runeBandInfoHTML(grp) {
  const rec = Object.values(grp.variants).find(v => v && v.stat_bands);
  if (!rec) return '';
  const bands = rec.stat_bands;
  const params = {};
  Object.entries(bands).forEach(([rar, m]) => {
    Object.entries(m || {}).forEach(([k, b]) => {
      if (!Array.isArray(b)) return;
      (params[k] = params[k] || {})[rar] = b[1];
    });
  });
  const chips = Object.entries(params).map(([k, byRar]) => {
    const seq = DB.mechanics.rarities.map(r => r.id).filter(r => byRar[r] != null)
      .map(r => `${r[0].toUpperCase()} ${byRar[r]}`).join(' · ');
    return `<span class="val-chip mono" title="Real ${esc(pretty(k))} per rune rarity">${esc(pretty(k))}: ${esc(seq)}</span>`;
  }).join('');
  return chips ? `<div class="val-chips rune-band-info">${chips}<span class="hint-inline">real effect values — stat contribution below is still yours to assume</span></div>` : '';
}

function socketsRowHTML(i, chips, count, perk, fxKey) {
  let html = `<div class="sockets" role="group" aria-label="Chip sockets">`;
  for (let s = 0; s < count; s++) {
    const key = chips[s];
    if (key) {
      const chip = DB.chipsByKey.get(key);
      html += `<button class="socket filled" data-action="open-chip-picker" data-slot-index="${i}" data-chip-index="${s}" title="${esc(chip ? chip.name : 'Unknown chip')}">
        ${iconTag(chip ? chip.icon : null, 'socket-icon', KIND_GLYPH.chip)}
      </button>`;
    } else {
      html += `<button class="socket empty" data-action="open-chip-picker" data-slot-index="${i}" data-chip-index="${s}" aria-label="Empty chip socket">◇</button>`;
    }
  }
  html += `</div>`;
  html += auditBadgeHTML('chip:w' + i + 'c'); // V5 : ✓/○ agrégé des puces socketées dans cette rangée
  if (perk) html += `<button class="perk-badge" data-action="open-fx-block" data-fx-key="${esc(fxKey || '')}" title="Pick the perk's assumed effect">+${perk} mastery perk</button>`;
  if (!count && !perk) html += `<p class="hint">No chip sockets at this rarity/state.</p>`;
  return html;
}

function weaponCardHTML(slot, i) {
  const item = resolveWeapon(slot.key, slot.weaponType, slot.tier);
  if (!item) {
    return `<div class="gear-card weapon-card empty">
      <div class="card-head empty-head" data-action="open-weapon-picker" data-slot-index="${i}" tabindex="0" role="button" aria-label="Choose ${esc(slot.label)}">
        <span class="empty-glyph">⚔</span><span class="empty-label">Choose ${esc(slot.label)}…</span>
      </div>
    </div>`;
  }
  const reqLvl = TIER_LEVEL[item.tier] || 1;
  const belowLvl = state.level < reqLvl;
  const { count, perk } = computeSlots('weapon_chip_sockets', item.tier, slot.rarity, slot.upgrade);
  /* Effets supposés : une ligne par puce socketée + une par perk T3. */
  const fxRows = [];
  const chipSeen = {};
  slot.chips.forEach(k => {
    if (!k) return;
    const chip = DB.chipsByKey.get(k);
    if (!chip) return;
    const occ = chipSeen[k] = (chipSeen[k] ?? -1) + 1;
    if (chip.stat_bands) {
      /* V4 : valeurs réelles par rareté de puce — éditeur borné dédié. */
      fxRows.push({ tag: 'chip:' + k, idx: occ, html: chipRealRowHTML('chip:' + k, occ, chip) });
    } else {
      fxRows.push({ tag: 'chip:' + k, idx: occ, label: chip.name, preset: chip.stat_hint || '', note: '' });
    }
  });
  for (let p = 0; p < perk; p++) fxRows.push({ tag: 't3perk:w' + i, idx: p, label: 'Mastery perk ' + (p + 1), preset: '', note: '' });
  return `<div class="gear-card weapon-card rarified rar-${esc(slot.rarity)} ${item.isGeneric ? 'generic' : ''}" style="--rar:${esc(rarityColor(slot.rarity))}">
    <div class="card-head" data-action="open-weapon-picker" data-slot-index="${i}" tabindex="0" role="button" aria-label="Change ${esc(slot.label)}">
      ${iconTag(item.icon, 'card-icon', KIND_GLYPH.weapon)}
      <div class="card-head-text">
        <div class="card-name">${esc(item.name)}${item.isGeneric ? ' <span class="generic-badge">GENERIC</span>' : ''}</div>
        <div class="card-sub">${esc(slot.label)} · <span class="tier-badge tier-${cssTier(item.tier)}">${item.tier}</span> <span class="rar-name">${esc(slot.rarity)}</span>${belowLvl ? ` <span class="lvl-warn" title="Requires level ${reqLvl}">⚠ Lv${reqLvl}</span>` : ''}</div>
      </div>
      ${auditBadgeHTML('weapon:w' + i)}
    </div>
    ${item.isGeneric ? tierControlHTML(i, slot.tier) : ''}
    <div class="rarity-row">${rarityDotsHTML('weapon', i, slot.rarity)}</div>
    <div class="upgrade-row">${upgradeSegHTML('weapon', i, slot.upgrade)}</div>
    <div class="sockets-row">${socketsRowHTML(i, slot.chips, count, perk, 'fx:w' + i)}</div>
    ${fxBlockHTML('fx:w' + i, fxRows)}
    ${slot.upgrade === 'overclocked' ? `<p class="hint">Overclocked — chips may gain bonus effects.</p>` : ''}
  </div>`;
}

function cssTier(t) { return t.replace('+', 'plus'); } // "T3+" -> classe CSS "tier-T3plus"

function renderWeaponRow() {
  const mastery = currentMastery();
  const unconfirmed = mastery.use_type == null;
  $('#weapon-row').innerHTML =
    (unconfirmed ? `<p class="hint">Weapon configuration unconfirmed for this mastery (no use-type in client data) — shown as a single slot.</p>` : '') +
    state.weapons.map((slot, i) => weaponCardHTML(slot, i)).join('');
}

function runeSocketHTML(slot, i) {
  if (!slot.rune) {
    return `<button class="socket empty rune-socket" data-action="open-rune-picker" data-slot-index="${i}" aria-label="Empty rune socket">◇ Rune</button>`;
  }
  const grp = DB.runeGroupById.get(slot.rune.key);
  if (!grp) { slot.rune = null; return runeSocketHTML(slot, i); }
  const variantKeys = Object.keys(grp.variants);
  return `<div class="rune-filled">
    <button class="socket filled rune-socket" data-action="open-rune-picker" data-slot-index="${i}" title="${esc(grp.name)}">
      ${iconTag(grp.icon, 'socket-icon', KIND_GLYPH.rune)}<span class="rune-name">${esc(grp.name)}</span>
    </button>
    ${auditBadgeHTML('rune:a' + i)}
    ${variantKeys.length > 1 ? `<div class="tier-seg" role="group" aria-label="Rune variant">
      ${variantKeys.map(v => `<button class="seg-btn ${v === slot.rune.variant ? 'active' : ''}" data-action="set-rune-variant" data-slot-index="${i}" data-variant="${v}">${upgradeLabel(v)}</button>`).join('')}
    </div>` : ''}
    <button class="clear-btn small" data-action="clear-rune" data-slot-index="${i}" aria-label="Clear rune">×</button>
  </div>`;
}

/* ── V3 : blocs passif/actif des artefacts T3 (84 items) ────────────────
   Titre + texte-formule client + chip de cooldown. L'indicateur "counted
   in DPS" s'allume quand le moteur V3 rapporte l'item dans dps.actives
   (source "item…") ; sinon repli "manual" qui ouvre les effets supposés. */
function itemCountedInDps(artKey, title) {
  const acts = (engineResult && engineResult.dps && engineResult.dps.actives) || [];
  return acts.some(a => {
    const src = String(a.source || '');
    if (!src.startsWith('item')) return false;
    return a.artifact_key === artKey || a.key === artKey
      || (title && String(a.name || '') === title);
  });
}
function artifactPABlocksHTML(item, i) {
  const blocks = [];
  const seenTxt = new Set();
  ['passive', 'active'].forEach(kind => {
    const b = item[kind];
    if (!b || !b.text) return;
    const sig = (b.title || '') + '|' + b.text;
    if (seenTxt.has(sig)) return; // passif et actif identiques -> un seul bloc
    seenTxt.add(sig);
    blocks.push({ kind, title: b.title || 'Item effect', text: b.text, cd: b.numbers && b.numbers.cooldown_s });
  });
  if (!blocks.length) return '';
  return blocks.map((b, bi) => {
    const counted = itemCountedInDps(item.key, b.title);
    const key = `pa:a${i}:${bi}`;
    return `<details class="pa-block" data-key="${esc(key)}" ${openPanels.has(key) ? 'open' : ''}>
      <summary>Item ${esc(b.kind)} — ${esc(b.title)}
        ${Number.isFinite(b.cd) ? `<span class="val-chip mono">CD ${fmtNum(b.cd)}s</span>` : ''}
        ${counted
          ? '<span class="val-chip" title="The engine reports this item effect in the DPS breakdown">counted in DPS</span>'
          : `<button class="val-chip muted-chip" data-action="open-fx-block" data-fx-key="fx:a${i}" title="Engine doesn't parse this yet — declare an assumed effect">manual</button>`}
      </summary>
      <p class="pa-text">${esc(stripCtrl(b.text))}</p>
    </details>`;
  }).join('');
}

function artifactCardHTML(slot, i) {
  if (!slot) {
    return `<div class="gear-card artifact-card empty">
      <div class="card-head empty-head" data-action="open-artifact-picker" data-slot-index="${i}" tabindex="0" role="button" aria-label="Choose artifact slot ${i + 1}">
        <span class="empty-glyph">◈</span><span class="empty-label">Choose artifact…</span>
      </div>
    </div>`;
  }
  const item = DB.artifactsByKey.get(slot.key);
  if (!item) return artifactCardHTML(null, i); // clé invalide -> repli défensif
  const reqLvl = TIER_LEVEL[item.tier] || 1;
  const belowLvl = state.level < reqLvl;
  const { count, perk } = computeSlots('artifact_secondary_slots', item.tier, slot.rarity, slot.upgrade);
  /* Effets supposés : rune socketée + perks T3 + corruption (toujours). */
  const corr = DB.raw.mechanics && DB.raw.mechanics.corruption;
  const corrNote = corr && Array.isArray(corr.proc_chance_range_pct)
    ? `documented proc ${corr.proc_chance_range_pct[0]}–${corr.proc_chance_range_pct[1]}% — enter an averaged assumed effect (use the uptime field as proc average)`
    : 'documented proc chance ≈0.5–5% (boss-trophy endgame modifier) — enter an averaged assumed effect';
  const fxRows = [];
  if (slot.rune) {
    const grp = DB.runeGroupById.get(slot.rune.key);
    if (grp) {
      const info = runeBandInfoHTML(grp);
      fxRows.push({
        tag: 'rune:' + slot.rune.key, idx: 0,
        html: info + fxRowHTML('rune:' + slot.rune.key, 0, 'Rune — ' + grp.name, '', ''),
      });
    }
  }
  for (let p = 0; p < perk; p++) fxRows.push({ tag: 't3perk:a' + i, idx: p, label: 'Mastery perk ' + (p + 1), preset: '', note: '' });
  fxRows.push({ tag: 'corruption:a' + i, idx: 0, label: 'Corruption', preset: '', note: corrNote });
  return `<div class="gear-card artifact-card rarified rar-${esc(slot.rarity)}" style="--rar:${esc(rarityColor(slot.rarity))}">
    <div class="card-head" data-action="open-artifact-picker" data-slot-index="${i}" tabindex="0" role="button" aria-label="Change artifact">
      ${iconTag(item.icon, 'card-icon', KIND_GLYPH.artifact)}
      <div class="card-head-text">
        <div class="card-name">${esc(item.name)}</div>
        <div class="card-sub"><span class="tier-badge tier-${cssTier(item.tier)}">${item.tier}</span> <span class="rar-name">${esc(slot.rarity)}</span>${belowLvl ? ` <span class="lvl-warn" title="Requires level ${reqLvl}">⚠ Lv${reqLvl}</span>` : ''}</div>
      </div>
      ${auditBadgeHTML('artifact_main:a' + i + '|artifact_secondary:a' + i)}
      <button class="clear-btn copy-btn" data-action="copy-artifact" data-slot-index="${i}" title="Copy configuration" aria-label="Copy artifact configuration">⧉</button>
      ${artifactClipboard ? `<button class="clear-btn copy-btn" data-action="paste-artifact" data-slot-index="${i}" title="Paste configuration" aria-label="Paste artifact configuration">⇩</button>` : ''}
      <button class="clear-btn" data-action="clear-artifact" data-slot-index="${i}" aria-label="Clear slot" title="Clear slot">×</button>
    </div>
    ${(() => {
      /* V3 : options de main stat restreintes à ce que l'item roll VRAIMENT
         (main_stat fixe ou main_stat_options du catalogue) ; repli = tout. */
      let allowed = null;
      if (item.main_stat && item.main_stat.stat && DB.statsById.has(item.main_stat.stat)) allowed = [item.main_stat.stat];
      else if (Array.isArray(item.main_stat_options) && item.main_stat_options.length) {
        allowed = item.main_stat_options.map(o => o && o.stat).filter(id => id && DB.statsById.has(id));
        if (!allowed.length) allowed = null;
      }
      if (allowed && slot.mainStat && !allowed.includes(slot.mainStat)) allowed = allowed.concat([slot.mainStat]); // vieux lien : on garde
      const opts = allowed ? allowed : DB.mainStats.map(s => s.id);
      const conflict = item.main_stat && item.main_stat.conflict;
      const alt = conflict ? item.main_stat.alt_range : null;
      const altTxt = alt ? (Array.isArray(alt) ? alt.join('–') : `${alt.min}–${alt.max}`) : '?';
      const conflictTip = conflict
        ? `Range disputed — catalog [${item.main_stat.min}–${item.main_stat.max}] vs corepunk.help [${altTxt}]`
        : '';
      const range = slot.mainStat ? bandFor(item, slot, slot.mainStat, true) : null;
      return `<label class="field-row field-col">
        <span class="field-label">Main stat${conflict ? ` <span class="val-chip warn" title="${esc(conflictTip)}">range disputed</span>` : ''}</span>
        <select data-action="change-main-stat" data-slot-index="${i}" aria-label="Artifact ${i + 1} main stat"
                ${slot.mainStat ? `title="${esc(statDisplayName(slot.mainStat))}"` : ''}>
          <option value="">— pick —</option>
          ${opts.map(id => `<option value="${esc(id)}" ${slot.mainStat === id ? 'selected' : ''}>${esc(statDisplayName(id))}</option>`).join('')}
        </select>
      </label>
      ${slot.mainStat ? rollEditorHTML('main', i, null, slot.mainStatRoll, range, 'Main stat', slot.mainStat) : ''}`;
    })()}
    <div class="rarity-row">${rarityDotsHTML('artifact', i, slot.rarity)}</div>
    <div class="upgrade-row">${upgradeSegHTML('artifact', i, slot.upgrade)}</div>
    <div class="secondary-block">
      ${slot.secondary.map((val, si) => {
        /* V4.2 : pick au-delà du compte courant — gardé, jamais supprimé.
           Seule une case avec une VRAIE stat choisie mérite le chip : une
           case vide au-delà du compte (padding historique d'un équipement
           à rareté plus haute) n'a rien à préserver, pas la peine d'alarmer. */
        const over = si >= count && !!val;
        return `
        <label class="field-row field-col secondary-slot ${over ? 'over-slot' : ''}">
          <span class="field-label">Secondary ${si + 1}${over
            ? ` <span class="over-slot-chip" title="This artifact currently offers ${count} secondary slot${count === 1 ? '' : 's'} at ${esc(slot.rarity)}/${esc(upgradeLabel(slot.upgrade))} — this pick came from your save/link and is kept, not deleted.">over slot count</span>`
            : ''}</span>
          <select data-action="change-secondary-stat" data-slot-index="${i}" data-sec-index="${si}"
                  aria-label="Artifact ${i + 1} secondary stat ${si + 1}"
                  ${val ? `title="${esc(statDisplayName(val))}"` : ''}>
            <option value="">— pick —</option>
            ${secondaryStatOptionsHTML(val)}
          </select>
        </label>
        ${val ? rollEditorHTML('sec', i, si, slot.secondaryRolls && slot.secondaryRolls[si], bandFor(item, slot, val, false), 'Secondary ' + (si + 1), val) : ''}`;
      }).join('')}
      ${perk ? `<button class="perk-badge" data-action="open-fx-block" data-fx-key="fx:a${i}" title="Pick the perk's assumed effect">+${perk} mastery perk</button>` : ''}
      ${!count && !perk && !slot.secondary.length ? `<p class="hint">No secondary slots at this rarity/state.</p>` : ''}
    </div>
    ${artifactPABlocksHTML(item, i)}
    <div class="rune-block">${runeSocketHTML(slot, i)}</div>
    ${fxBlockHTML('fx:a' + i, fxRows)}
    ${slot.upgrade === 'overclocked' ? `<p class="hint">Overclocked — chips may gain bonus effects.</p>` : ''}
  </div>`;
}

let artifactClipboard = null; // config copiée (⧉) — collable sur un autre artefact équipé
function renderArtifactGrid() {
  const anyEquipped = state.artifacts.some(Boolean);
  const bulkBar = anyEquipped ? `
    <div class="bulk-bar">
      <span class="field-label">Set all artifacts</span>
      <select id="bulk-rarity" aria-label="Bulk rarity">
        ${DB.mechanics.rarities.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}
      </select>
      <select id="bulk-state" aria-label="Bulk upgrade state">
        ${DB.mechanics.upgrade_states.map(u => `<option value="${esc(u)}">${upgradeLabel(u)}</option>`).join('')}
      </select>
      <button class="act" data-action="bulk-apply">Apply</button>
      ${artifactClipboard ? `<span class="hint-inline">config copied — paste with ⇩ on a card</span>` : ''}
    </div>` : '';
  $('#artifact-grid').innerHTML =
    bulkBar +
    (anyEquipped ? `<p class="hint grid-hint">Roll inputs: type the values from YOUR in-game items — the client data has no public roll tables (they feed the DPS engine).</p>` : '') +
    state.artifacts.map((a, i) => artifactCardHTML(a, i)).join('');
}

/* Valeur calculée d'un sort universel au niveau/SP courants (params du
   pipeline V2 — absent aujourd'hui : la ligne se cache, honnêtement). */
function spellComputedAmount(spell) {
  const p = spell && spell.params;
  if (!p || !Number.isFinite(p.base)) return null;
  const sp = (engineResult && engineResult.sheet.stats.spell_power && engineResult.sheet.stats.spell_power.rating) || 0;
  return (p.base || 0) + (p.per_level || 0) * state.level + (p.sp_scale || 0) * sp;
}
function spellValueChips(spell) {
  const p = spell && spell.params;
  if (!p) return [];
  const chips = [];
  const amount = spellComputedAmount(spell);
  if (amount != null) {
    const verb = p.kind === 'heal' ? 'HEAL' : (p.kind === 'shield' ? 'SHIELD' : (p.kind === 'damage' ? 'DMG' : 'VAL'));
    chips.push(`${verb} ~${fmtNum(amount)}`);
  }
  if (Number.isFinite(p.ms_pct) && p.ms_pct) chips.push(`+${p.ms_pct}% MS`);
  if (Number.isFinite(p.duration_s) && p.duration_s) chips.push(`DUR ${fmtNum(p.duration_s)}s`);
  chips.push(`CD ${fmtNum(Number.isFinite(p.cooldown_s) ? p.cooldown_s : 180)}s`);
  return chips;
}

function renderSpellRow() {
  $('#spell-row').innerHTML = ['d', 'f'].map(hand => {
    const unlockLvl = hand === 'd' ? 5 : 10;
    const id = state.spells[hand];
    const spell = id ? DB.spellsById.get(id) : null;
    const locked = state.level < unlockLvl;
    if (!spell) {
      return `<div class="gear-card spell-card empty ${locked ? 'locked' : ''}">
        <div class="card-head empty-head" data-action="open-spell-picker" data-hand="${hand}" tabindex="0" role="button" aria-label="Choose ${hand.toUpperCase()} spell">
          <span class="empty-glyph">✚</span><span class="empty-label">Choose ${hand.toUpperCase()}…</span>
        </div>
        <div class="spell-unlock hint">Unlocks Lv ${unlockLvl}${locked ? ' <span class="lvl-warn">not yet reached</span>' : ''}</div>
      </div>`;
    }
    const chips = spellValueChips(spell);
    const uptPct = Math.round(((state.spellUptimes && state.spellUptimes[hand]) ?? 1) * 100);
    return `<div class="gear-card spell-card ${locked ? 'locked' : ''}">
      <div class="card-head" data-action="open-spell-picker" data-hand="${hand}" tabindex="0" role="button" aria-label="Change ${hand.toUpperCase()} spell">
        ${iconTag(spell.icon, 'card-icon', KIND_GLYPH.spell)}
        <div class="card-head-text">
          <div class="card-name">${esc(spell.name)}</div>
          <div class="card-sub">${hand.toUpperCase()} · Lv ${unlockLvl}${locked ? ' <span class="lvl-warn">locked</span>' : ''}</div>
        </div>
      </div>
      ${chips.length ? `<div class="val-chips">${chips.map(c => `<span class="val-chip mono">${esc(c)}</span>`).join('')}<span class="hint-inline">at lvl ${state.level} + your Spell Power</span></div>` : ''}
      <div class="uptime-row">
        <span class="field-label">Uptime</span>
        <input type="range" min="0" max="100" step="5" value="${uptPct}" data-action="change-spell-uptime" data-hand="${hand}" aria-label="${hand.toUpperCase()} spell uptime percent">
        <span class="mono" data-upt-label="${hand}">${uptPct}%</span>
      </div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════════
   RENDU — talents
   ══════════════════════════════════════════════════════════════════════ */
/* V4.1 : investissement POINT PAR POINT — 1 clic sur la carte = +1 rang
   (1→5), le coût d'une rangée = son rang investi ; budget 15 par arbre,
   souple (avertit, ne bloque jamais). */
const TALENT_BUDGET = 15;
function talentPoints(slot) {
  return Object.keys(slot.picks).reduce((sum, row) => sum + ((slot.ranks && slot.ranks[row]) || 1), 0);
}
function renderTalentPickers() {
  $('#talent-pickers').innerHTML = state.talents.map((slot, idx) => {
    const chosenElsewhere = state.talents.filter((_, j) => j !== idx).map(s => s.treeId).filter(Boolean);
    const options = DB.talentTrees.filter(t => !chosenElsewhere.includes(t.id) || t.id === slot.treeId);
    return `<label class="talent-picker-label">
      <span class="field-label">Tree ${idx + 1}</span>
      <select data-action="change-talent-tree" data-talent-slot="${idx}" aria-label="Talent tree ${idx + 1}">
        <option value="">— none —</option>
        ${options.map(t => `<option value="${esc(t.id)}" ${t.id === slot.treeId ? 'selected' : ''}>${esc(t.name)}${t.live === false ? ' (client only)' : ''}</option>`).join('')}
      </select>
    </label>`;
  }).join('');
}
/* Valeur d'un stat_mod au rang choisi (per_rank V2 quand présent). */
function modValueAtRank(m, rank) {
  return (Array.isArray(m.per_rank) && m.per_rank[rank - 1] != null) ? m.per_rank[rank - 1] : m.value;
}
/* V3 : per_rank vit aussi au niveau du CHOIX (valeurs client exactes). */
function choiceValueAtRank(c, rank) {
  if (Array.isArray(c.per_rank) && c.per_rank[rank - 1] != null) return c.per_rank[rank - 1];
  const m = (c.stat_mods || []).find(x => Array.isArray(x.per_rank) && x.per_rank.length);
  return m ? m.per_rank[rank - 1] : null;
}
/* 13 choix en désaccord entre sources (corepunk.help vs valeurs client). */
function choiceDisputed(c) {
  return (c.cross_check && c.cross_check !== 'match' && !String(c.confidence || '').startsWith('client-only'))
    || c.confidence === 'med';
}
function renderTalentTrees() {
  $('#talent-trees').innerHTML = state.talents.map((slot, idx) => {
    if (!slot.treeId) return '';
    const tree = DB.talentTreesById.get(slot.treeId);
    const pts = talentPoints(slot);
    const rowsHtml = tree.rows.map((row, ri) => {
      const cost = ri + 1;
      if (!row.choices.length) {
        const noteVal = slot.notes[ri] || '';
        return `<div class="talent-row empty-row">
          <span class="row-cost mono">+${cost}</span>
          <div class="row-unknown">
            <span class="unknown-chip">content unknown in public sources</span>
            <input type="text" class="note-input" maxlength="140" placeholder="describe your pick…" value="${esc(noteVal)}" data-action="change-talent-note" data-talent-slot="${idx}" data-row="${ri}">
          </div>
        </div>`;
      }
      const activeCi = slot.picks[ri];
      const rank = (slot.ranks && slot.ranks[ri]) || 1;
      const cardsHtml = row.choices.map((c, ci) => {
        const active = activeCi === ci;
        const rkHere = active ? rank : 1;
        const cv = choiceValueAtRank(c, rkHere);
        /* V4.1 : la carte s'investit POINT PAR POINT — clic = +1 rang ;
           pips de rang visibles ; petit − (span role=button, seul HTML
           valide dans un <button>) pour retirer 1 rang (rang 1 → retire
           le choix). Changer de choix dans la rangée DÉPLACE les points
           (un seul choix par rangée in-game, le rang investi suit). */
        return `<button class="talent-card ${active ? 'active' : ''}" data-action="select-talent-choice" data-talent-slot="${idx}" data-row="${ri}" data-choice="${ci}"
          title="${active ? (rank < 5 ? 'Click: +1 rank (' + rank + '/5)' : 'Max rank') : 'Click: pick at rank ' + (Number.isInteger(activeCi) ? rank : 1)}">
          <span class="talent-card-head">
            ${iconTag(c.icon, 'talent-icon', '✦')}
            <span class="talent-card-name">${esc(c.name)}</span>
            ${choiceDisputed(c) ? `<span class="val-chip warn" title="${esc(c.cross_check && c.cross_check !== 'match' ? c.cross_check : 'confidence: ' + (c.confidence || '?'))}">≠ sources</span>` : ''}
            ${active ? auditBadgeHTML('talent_choice:' + slot.treeId + ':r' + ri) : ''}
            ${active ? `<span class="talent-minus" role="button" tabindex="0" data-action="talent-rank-minus" data-talent-slot="${idx}" data-row="${ri}"
              title="−1 rank (removes the pick at rank 1)" aria-label="Remove one rank from ${esc(c.name)}">−</span>` : ''}
          </span>
          <span class="talent-card-desc">${renderPlainText(c.description)}</span>
          <span class="rank-pips ${active ? '' : 'idle'}" aria-label="${active ? rank : 0} of 5 ranks">
            ${[1, 2, 3, 4, 5].map(rk => {
              const v = choiceValueAtRank(c, rk);
              return `<span class="rank-pip ${active && rank >= rk ? 'on' : ''}" title="${v != null ? 'rank ' + rk + ': ' + v + (c.unit === '%' ? '%' : '') : 'rank ' + rk}"></span>`;
            }).join('')}
          </span>
          ${c.stat_mods && c.stat_mods.length ? `<span class="talent-mods">${c.stat_mods.map(m => {
            const v = modValueAtRank(m, rkHere);
            return `<span class="mod-chip">${esc(pretty(m.stat))} ${v > 0 ? '+' : ''}${v}${m.unit === '%' ? '%' : ''}${m.condition ? ' ⚑' : ''}</span>`;
          }).join('')}</span>`
          : (cv != null ? `<span class="talent-mods"><span class="mod-chip">${cv > 0 ? '+' : ''}${cv}${c.unit === '%' ? '%' : ''}</span></span>` : '')}
        </button>`;
      }).join('');
      /* Toggle de condition (défaut ON) — le sélecteur de rang séparé a
         disparu au profit du point-par-point sur la carte. */
      let ctrls = '';
      const activeChoice = Number.isInteger(activeCi) ? row.choices[activeCi] : null;
      if (activeChoice) {
        const condMod = (activeChoice.stat_mods || []).find(m => m.condition && m.condition.text)
          || (activeChoice.condition && activeChoice.condition.text ? { condition: activeChoice.condition } : null);
        if (condMod) {
          const on = !slot.conds || slot.conds[ri] !== false;
          ctrls = `<div class="talent-ctrls"><button class="cond-chip ${on ? 'on' : ''}" data-action="toggle-talent-cond" data-talent-slot="${idx}" data-row="${ri}" title="${esc(condMod.condition.text)}">condition: ${on ? 'ON' : 'OFF'}</button></div>`;
        }
      }
      return `<div class="talent-row"><span class="row-cost mono" title="points invested in this row">${Number.isInteger(activeCi) ? rank : 0}</span><div class="row-choices">${cardsHtml}${ctrls}</div></div>`;
    }).join('');
    return `<div class="talent-tree-panel">
      <div class="talent-tree-head">
        <span class="talent-tree-name">${esc(tree.name)}</span>
        ${tree.live === false ? '<span class="val-chip warn" title="Present in the client files but not selectable in-game">client data — not selectable in-game</span>' : ''}
        <span class="talent-top-bonus">${esc(tree.top_bonus || '')}</span>
        <span class="talent-points mono ${pts > TALENT_BUDGET ? 'over' : ''}" title="${pts > TALENT_BUDGET ? 'Over the in-game budget of ' + TALENT_BUDGET + ' — soft warning only' : 'in-game budget: ' + TALENT_BUDGET}">${pts}/${TALENT_BUDGET}</span>
      </div>
      ${rowsHtml}
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════════
   MOTEUR — glue Engine.compute (engine.js, module pur, jamais modifié ici)
   Le moteur lit le format stateToShare() ; les overrides de stats de base
   patchent une COPIE de builder.json (clonée une seule fois au premier
   calcul, re-patchée à chaque compute — DB.raw n'est jamais muté).
   ══════════════════════════════════════════════════════════════════════ */
let engineResult = null;
let engineDataCache = null;
let engineBaseOriginals = null;

function deepClone(o) {
  return (typeof structuredClone === 'function') ? structuredClone(o) : JSON.parse(JSON.stringify(o));
}
function ensureEngineData() {
  if (engineDataCache) return;
  engineDataCache = deepClone(DB.raw);
  engineBaseOriginals = {};
  const def = engineDataCache.combat && engineDataCache.combat.base && engineDataCache.combat.base.default;
  if (def) Object.keys(def).forEach(k => {
    const e = def[k];
    if (e && typeof e === 'object' && 'value' in e) engineBaseOriginals[k] = e.value;
  });
}
function patchedEngineData() {
  ensureEngineData();
  const def = engineDataCache.combat && engineDataCache.combat.base && engineDataCache.combat.base.default;
  if (def) Object.keys(engineBaseOriginals).forEach(k => {
    const ov = state.baseOverrides ? state.baseOverrides[k] : undefined;
    def[k].value = Number.isFinite(ov) ? ov : engineBaseOriginals[k];
  });
  return engineDataCache;
}
function engineOptions() {
  const t = state.target || {};
  const tgt = {};
  if (Number.isFinite(t.armor)) tgt.armor = t.armor;
  if (Number.isFinite(t.magic_resistance)) tgt.magic_resistance = t.magic_resistance;
  if (Number.isFinite(t.level)) tgt.level = t.level;
  /* options.target omis quand rien n'est saisi → le moteur documente
     lui-même son mannequin par défaut dans les assumptions. */
  return Object.keys(tgt).length ? { target: tgt } : {};
}
/* Le moteur V2 expose Engine.sensitivity — on s'en sert de marqueur de
   génération : chaque bloc V2 de l'UI se cache proprement sur moteur V1. */
function engineIsV2() { return typeof Engine.sensitivity === 'function'; }

let engineSens = null; // top stats d'Engine.sensitivity (V2 seulement)
function computeEngine() {
  try {
    const share = stateToShare(state);
    const data = patchedEngineData();
    const opts = engineOptions();
    engineResult = Engine.compute(share, data, opts);
    engineSens = null;
    if (engineIsV2()) {
      try { engineSens = Engine.sensitivity(share, data, opts); } catch (e) { engineSens = null; }
    }
  } catch (err) { console.error('Engine.compute failed', err); engineResult = null; engineSens = null; }
}
/* Recalcul après une frappe dans un input numérique : on ne redessine QUE
   les vues d'affichage (#dps-view/#sheet-view) + les puces dps du kit —
   jamais les sections qui contiennent l'input actif (focus préservé). */
function computeAndRefresh() {
  computeEngine();
  renderEngineViews();
  refreshKitDps();
  syncAudit(); // V5 : le panneau audit (si ouvert) et les badges suivent chaque frappe aussi
}
/* Puces "x dps" des cartes du kit : mise à jour chirurgicale (textContent
   seulement — aucun innerHTML, donc aucun risque pour le focus). */
function refreshKitDps() {
  const per = (engineResult && engineResult.dps.rotation.per_ability) || [];
  const map = {};
  per.forEach(a => { map[a.slot] = a.dps; });
  $$('[data-kit-dps]').forEach(elm => {
    const v = map[elm.dataset.kitDps];
    elm.textContent = Number.isFinite(v) && v > 0 ? fmtNum(v) + ' dps' : '';
  });
}
/* HPS local (estimation) quand le moteur V1 n'expose pas encore dps.hps :
   somme des sorts heal/shield équipés = montant / cd × uptime. Null quand
   aucun sort chiffrable (params absents des données du jour). */
function localHps() {
  let sum = 0, any = false;
  ['d', 'f'].forEach(hand => {
    const id = state.spells[hand];
    if (!id) return;
    const sp = DB.spellsById.get(id);
    const p = sp && sp.params;
    if (!p || (p.kind !== 'heal' && p.kind !== 'shield')) return;
    const amount = spellComputedAmount(sp);
    if (amount == null) return;
    const cd = Number.isFinite(p.cooldown_s) && p.cooldown_s > 0 ? p.cooldown_s : 180;
    const upt = (state.spellUptimes && state.spellUptimes[hand]) ?? 1;
    sum += (amount / cd) * upt;
    any = true;
  });
  return any ? sum : null;
}

/* Format compact des nombres du moteur (mono partout). */
function fmtNum(n) {
  if (!Number.isFinite(n)) return '0';
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toLocaleString('en-US');
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

/* Mémoire d'ouverture des <details data-key> à travers les re-rendus
   ('toggle' ne bulle pas mais se capture très bien). */
const openPanels = new Set();
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!d || d.tagName !== 'DETAILS' || !d.dataset.key) return;
  if (d.open) openPanels.add(d.dataset.key); else openPanels.delete(d.dataset.key);
}, true);

/* ══════════════════════════════════════════════════════════════════════
   RENDU — panneau de stats : coquille (inputs) + vues moteur (affichage)
   ══════════════════════════════════════════════════════════════════════ */

/* Inputs "Base stats" : un champ numérique par stat du template
   combat.base.default, pré-rempli depuis la donnée (presque tout est 0
   dans ce build client — l'utilisateur saisit sa feuille de perso). */
function baseEditRowsHTML() {
  const def = DB.raw.combat && DB.raw.combat.base && DB.raw.combat.base.default;
  if (!def) return '<p class="hint">No combat.base block in data — engine falls back to zeros.</p>';
  const orderedIds = DB.stats.map(s => s.id)
    .filter(id => def[id] && typeof def[id] === 'object' && 'value' in def[id]);
  const extras = Object.keys(def).filter(k =>
    k !== 'per_level' && !orderedIds.includes(k) && def[k] && typeof def[k] === 'object' && 'value' in def[k]);
  return orderedIds.concat(extras).map(id => {
    const orig = def[id].value;
    const ov = state.baseOverrides[id];
    const val = Number.isFinite(ov) ? ov : (orig == null ? '' : orig);
    const name = statDisplayName(id);
    return `<label class="base-edit-row ${Number.isFinite(ov) ? 'overridden' : ''}">
      <span class="base-edit-name" title="${esc(name)}">${esc(name)}</span>
      <input type="number" step="any" class="roll-input mono" data-action="change-base-stat"
             data-stat="${esc(id)}" value="${val === '' ? '' : esc(String(val))}" placeholder="0"
             aria-label="Base ${esc(name)}">
    </label>`;
  }).join('');
}

function targetRowHTML(label, field) {
  const v = state.target[field];
  return `<label class="target-row">
    <span class="field-label">${esc(label)}</span>
    <input type="number" step="any" min="0" class="roll-input mono" data-action="change-target"
           data-field="${esc(field)}" value="${Number.isFinite(v) ? esc(String(v)) : ''}"
           placeholder="${field === 'level' ? String(state.level) : '0'}" aria-label="Target ${esc(label)}">
  </label>`;
}

/* Presets de cible — valeurs DEVINÉES (aucune source), étiquetées comme
   telles ; elles remplissent armor/MR, le niveau reste celui du build. */
const TARGET_PRESET_DEFS = [
  { id: 'dummy', label: 'Dummy', armor: 0, mres: 0 },
  { id: 'squishy', label: 'Squishy', armor: 120, mres: 90 },
  { id: 'tank', label: 'Armored', armor: 380, mres: 260 },
];

function renderStatsPanel() {
  const hero = currentHero();
  const mastery = currentMastery();

  const weaponsEquipped = state.weapons.filter(w => w.key).length;
  const artifactsEquipped = state.artifacts.filter(Boolean).length;
  const talentPtsTotal = state.talents.reduce((sum, t) => sum + (t.treeId ? talentPoints(t) : 0), 0);
  const weaponCost = state.weapons.reduce((s, w) => {
    if (!w.key) return s;
    const it = resolveWeapon(w.key, w.weaponType, w.tier);
    return (it && Number.isFinite(it.price)) ? s + it.price : s;
  }, 0);
  const summaryHtml = `
    <div class="stat-block summary-block">
      <div class="summary-row"><span>Hero</span><span class="mono">${hero ? esc(hero.name) + ' · ' + esc(mastery.name) : '—'}</span></div>
      <div class="summary-row"><span>Level</span><span class="mono">${state.level}</span></div>
      <div class="summary-row"><span>Weapons</span><span class="mono">${weaponsEquipped}/${state.weapons.length}</span></div>
      <div class="summary-row"><span>Artifacts</span><span class="mono">${artifactsEquipped}/6</span></div>
      <div class="summary-row"><span>Talent points</span><span class="mono">${talentPtsTotal}/45</span></div>
      <div class="summary-row"><span>Cost</span><span class="mono" title="Sum of equipped weapon prices — artifact prices unknown in client data">${weaponCost ? weaponCost.toLocaleString('en-US') + ' (weapons only)' : '—'}</span></div>
    </div>`;

  /* Chips de bonus de talents : au rang choisi, conditions OFF exclues. */
  const talentMods = [];
  state.talents.forEach(t => {
    if (!t.treeId) return;
    const tree = DB.talentTreesById.get(t.treeId);
    Object.entries(t.picks).forEach(([row, ci]) => {
      const choice = tree.rows[Number(row)]?.choices[ci];
      const rank = (t.ranks && t.ranks[row]) || 1;
      (choice?.stat_mods || []).forEach(m => {
        if (m.condition && t.conds && t.conds[row] === false) return;
        talentMods.push({ stat: m.stat, unit: m.unit, value: modValueAtRank(m, rank), cond: !!m.condition });
      });
    });
  });
  const talentHtml = talentMods.length
    ? talentMods.map(m => `<span class="mod-chip" ${m.cond ? 'title="conditional effect — assumed active"' : ''}>${esc(pretty(m.stat))} ${m.value > 0 ? '+' : ''}${m.value}${m.unit === '%' ? '%' : ''}${m.cond ? ' ⚑' : ''}</span>`).join('')
    : `<p class="hint">No numeric talent bonuses selected.</p>`;

  $('#stats-panel-content').innerHTML = `
    ${summaryHtml}
    <div class="stat-block dps-card">
      <div class="dps-head">
        <h3>DPS</h3>
        <div class="target-wrap">
          <button class="act ghost" data-action="toggle-target-pop">Target ▾</button>
          <div id="target-pop" class="target-pop">
            <div class="filter-chip-row preset-row">
              ${TARGET_PRESET_DEFS.map(p => `<button class="chip-btn ${state.target.preset === p.id ? 'active' : ''}" data-action="apply-target-preset" data-preset="${p.id}" title="armor ${p.armor} / MR ${p.mres} — guessed values, not sourced">${esc(p.label)}</button>`).join('')}
            </div>
            ${targetRowHTML('Armor', 'armor')}
            ${targetRowHTML('Magic resist', 'magic_resistance')}
            ${targetRowHTML('Level', 'level')}
            <p class="hint">Empty = undefended training dummy at build level. Preset values are guesses.</p>
          </div>
        </div>
      </div>
      <div id="dps-view"></div>
    </div>
    <details class="stat-block base-edit" data-key="base-edit" ${openPanels.has('base-edit') ? 'open' : ''}>
      <summary>Base stats — editable</summary>
      <p class="hint">The game's shared base template is mostly zeros (all 6 heroes share it) —
        enter your in-game character sheet values here. Real anchors kept: crit multiplier base 2.0, move speed 3.7.
        <button class="act ghost" data-action="reset-base">Reset</button></p>
      <div class="base-edit-grid">${baseEditRowsHTML()}</div>
    </details>
    <div id="sheet-view"></div>
    <div class="stat-block"><h3>Talent bonuses</h3><div class="mod-chips">${talentHtml}</div></div>
  `;
  renderEngineViews();
}

/* ── Vues moteur (affichage pur, re-rendues à chaque frappe) ─────────── */
function sheetRowHTML(st, id) {
  const sources = st.sources || [];
  const isSec = st.kind === 'secondary';
  const showEff = isSec && st.dr.threshold != null && Math.abs(st.effective - st.rating) > 1e-9;
  const stacked = sources.length >= 3;
  const statDef = DB.statsById.get(id);
  let bar = '';
  if (isSec && st.dr.threshold != null && st.rating > 0) {
    const scale = Math.max(st.dr.threshold * 1.25, st.rating);
    const tickPct = (st.dr.threshold / scale) * 100;
    const fillPct = Math.min(100, (st.rating / scale) * 100);
    const okPct = Math.min(fillPct, tickPct);
    bar = `<div class="dr-track" style="--tick:${tickPct.toFixed(2)}%">
      <div class="dr-fill" style="width:${okPct.toFixed(2)}%"></div>
      ${fillPct > tickPct ? `<div class="dr-fill past" style="left:${tickPct.toFixed(2)}%;width:${(fillPct - tickPct).toFixed(2)}%"></div>` : ''}
    </div>`;
  }
  return `<details class="sheet-row ${st.rating ? '' : 'zero'}" data-key="sr:${esc(id)}" ${openPanels.has('sr:' + id) ? 'open' : ''}>
    <summary>
      ${iconTag(statDef && statDef.icon, 'stat-icon', KIND_GLYPH.stat)}
      <span class="sheet-name">${esc(st.name)}</span>
      ${sources.length ? `<span class="src-chip mono ${stacked ? 'warn' : ''}" title="${sources.length} source${sources.length > 1 ? 's' : ''}${stacked ? ' — heavily stacked' : ''}">×${sources.length}</span>` : ''}
      <span class="sheet-val mono">${fmtNum(st.rating)}</span>
      ${showEff ? `<span class="sheet-eff mono ${st.dr.past ? 'past' : ''}">→ ${fmtNum(st.effective)}</span>` : ''}
    </summary>
    ${bar}
    ${isSec && st.pct != null ? `<p class="hint">≈ ${(st.pct * 100).toFixed(1)}% effective (rating→% conversion is an assumption)${st.dr.threshold != null ? ` · DR threshold ${st.dr.threshold}` : ''}</p>` : ''}
    <div class="sheet-src-list">${sources.length
      ? sources.map(s => `<div class="src-row"><span>${esc(s.label)}</span><span class="mono">${esc(String(s.value))}</span></div>`).join('')
      : '<p class="hint">No sources — value comes only from zeros/defaults.</p>'}</div>
  </details>`;
}

/* V3 : 40 stats — les lignes à zéro sont repliées par défaut derrière un
   <details> par groupe (la fiche reste lisible, rien n'est caché). */
function sheetGroupHTML(label, defs, stats, keyPrefix, emptyHint) {
  const present = defs.filter(s => stats[s.id]);
  const nz = present.filter(s => stats[s.id].rating !== 0);
  const z = present.filter(s => stats[s.id].rating === 0);
  const zk = 'zf:' + keyPrefix;
  return `<div class="stat-block"><h3>${label}</h3>
    ${nz.map(s => sheetRowHTML(stats[s.id], s.id)).join('')}
    ${!nz.length ? `<p class="hint">${emptyHint}</p>` : ''}
    ${z.length ? `<details class="zero-fold" data-key="${esc(zk)}" ${openPanels.has(zk) ? 'open' : ''}>
      <summary>${z.length} more at zero</summary>
      ${z.map(s => sheetRowHTML(stats[s.id], s.id)).join('')}
    </details>` : ''}
  </div>`;
}

function sheetViewHTML(r) {
  const stats = r.sheet.stats;
  const d = r.sheet.derived;
  const drv = [
    ['Basic hit (expected)', fmtNum(d.basic_damage)],
    ['Attacks / s', fmtNum(d.attacks_per_s)],
    ['Crit mult · phys', '×' + d.crit_multiplier_effective.toFixed(2)],
    ['Crit mult · mag', '×' + d.crit_multiplier_effective_magical.toFixed(2)],
    ['EHP · physical', fmtNum(d.ehp_physical)],
    ['EHP · magical', fmtNum(d.ehp_magical)],
  ];
  if (d.talent_global_damage_pct) drv.push(['Global damage (talents)', '+' + (d.talent_global_damage_pct * 100).toFixed(1) + '%']);
  const derivedStats = DB.stats.filter(s => s.kind === 'derived' && stats[s.id] && stats[s.id].rating !== 0);
  return `
    ${sheetGroupHTML('Main stats', DB.mainStats, stats, 'main', 'All main stats at zero — fill Base stats and rolls.')}
    ${sheetGroupHTML('Secondary stats', DB.secondaryStats, stats, 'sec', 'No secondary ratings yet — pick artifact secondaries with stars or rolls.')}
    <div class="stat-block"><h3>Derived</h3>${drv.map(x =>
      `<div class="drv-row"><span>${esc(x[0])}</span><span class="mono">${esc(x[1])}</span></div>`).join('')}
      ${derivedStats.map(s => sheetRowHTML(stats[s.id], s.id)).join('')}</div>`;
}

function renderEngineViews() {
  const dv = $('#dps-view'), sv = $('#sheet-view');
  if (!dv || !sv) return;
  const r = engineResult;
  if (!r) {
    dv.innerHTML = '<p class="hint">Engine unavailable — see browser console.</p>';
    sv.innerHTML = '';
    return;
  }
  const total = r.dps.total;

  /* Mode "autos only" : le moteur V2 le lit dans build.rotationMode ; sur
     moteur V1 on retire l'apport de la rotation côté affichage (calcul
     exact d'après les composantes v1 : (basic + actives dégâts)×(1+g)). */
  const autosLocal = state.rotationMode === 'autos' && !engineIsV2();
  let totalVal = total.value, ps = total.physical_share, ms = total.magical_share;
  if (autosLocal) {
    const activesDmg = r.dps.actives.filter(a => a.kind === 'damage').reduce((s, a) => s + a.dps_or_hps, 0);
    const g = r.sheet.derived.talent_global_damage_pct || 0;
    totalVal = (r.dps.basic.value + activesDmg) * (1 + g);
    ps = 1; ms = 0; // v1 : l'auto-attaque est physique, la rotation est exclue
  }

  const modeSeg = `<div class="tier-seg rot-seg" role="group" aria-label="Rotation mode">
    <button class="seg-btn ${state.rotationMode !== 'autos' ? 'active' : ''}" data-action="set-rotation-mode" data-mode="full">Full rotation</button>
    <button class="seg-btn ${state.rotationMode === 'autos' ? 'active' : ''}" data-action="set-rotation-mode" data-mode="autos">Autos only</button>
  </div>`;

  const hpsEngine = r.dps.hps && Number.isFinite(r.dps.hps.value) ? r.dps.hps.value : null;
  const hpsLocal = hpsEngine == null ? localHps() : null;
  const hpsVal = hpsEngine != null ? hpsEngine : hpsLocal;
  const hpsLine = hpsVal != null ? `
    <div class="hps-line"><span class="hps-label">HPS</span><span class="mono">${fmtNum(hpsVal)}</span>
    ${hpsEngine == null ? '<span class="hint-inline">estimated from spell formulas × uptime</span>' : ''}</div>` : '';

  let html = modeSeg;
  if (!(totalVal > 0)) {
    /* État vide amical : expliquer QUOI remplir, pas un 0 nu. */
    html += `
      <div class="dps-total-row dim"><span class="dps-total mono">0.0</span><span class="dps-unit">dps</span></div>
      ${hpsLine}
      <div class="dps-empty">
        <p>No numbers yet — the client data ships no base stats or roll tables. For a live estimate:</p>
        <ul>
          <li>fill <b>Base stats</b> below with your in-game character sheet,</li>
          <li>type the <b>roll</b> values next to artifact main &amp; secondary stats,</li>
          <li>equip a weapon so basic attacks count (Attack Power alone works too).</li>
        </ul>
      </div>`;
  } else {
    html += `<div class="dps-total-row"><span class="dps-total mono">${fmtNum(totalVal)}</span><span class="dps-unit">dps</span>${autosLocal ? '<span class="hint-inline">autos only</span>' : ''}</div>`;
    html += hpsLine;
    html += `
      <div class="share-bar" role="img" aria-label="physical ${(ps * 100).toFixed(0)}%, magical ${(ms * 100).toFixed(0)}%">
        <div class="share-phys" style="width:${(ps * 100).toFixed(1)}%"></div>
        <div class="share-mag" style="width:${(ms * 100).toFixed(1)}%"></div>
      </div>
      <div class="share-legend"><span class="leg-phys">physical ${(ps * 100).toFixed(0)}%</span><span class="leg-mag">magical ${(ms * 100).toFixed(0)}%</span></div>`;
    const rows = [{ label: 'Basic attack', val: r.dps.basic.value, cls: '', sub: `${fmtNum(r.sheet.derived.attacks_per_s)} atk/s` }];
    if (!autosLocal) {
      r.dps.rotation.per_ability.forEach(a => rows.push({
        label: `${a.slot} · ${a.name || 'Unnamed'}`, val: a.dps,
        cls: a.kind === 'magical' ? 'mag' : '',
        sub: `cd ${fmtNum(a.effective_cooldown_s)}s${a.notes.length ? ' · no data' : ''}`,
      }));
    }
    r.dps.actives.forEach(a => rows.push({
      label: `${a.name} (active)`, val: a.dps_or_hps, cls: 'active', sub: `cd ${fmtNum(a.cooldown_s)}s · ${a.kind}`,
    }));
    const maxV = Math.max(...rows.map(x => x.val), 1e-9);
    html += '<div class="dps-rows">' + rows.map(x => `
      <div class="dps-row">
        <span class="dps-row-label">${esc(x.label)}</span>
        <span class="dps-row-sub">${esc(x.sub)}</span>
        <span class="dps-row-val mono">${fmtNum(x.val)}</span>
      </div>
      <div class="dps-bar"><div class="dps-bar-fill ${x.cls}" style="width:${Math.max(1.2, (x.val / maxV) * 100).toFixed(1)}%"></div></div>`).join('') + '</div>';
    const tg = r.dps.target;
    html += `<p class="hint">vs target — armor ${fmtNum(tg.armor)} (−${(tg.mitigation_physical_pct * 100).toFixed(1)}% phys) · MR ${fmtNum(tg.mres)} (−${(tg.mitigation_magical_pct * 100).toFixed(1)}% mag)</p>`;
  }

  /* Priorité de stats (Engine.sensitivity, moteur V2 uniquement). */
  if (Array.isArray(engineSens) && engineSens.length) {
    const top = engineSens.slice(0, 5);
    html += `<div class="sens-block"><h4>Stat priority <span class="hint-inline">Δdps per +10 rating</span></h4>
      ${top.map(s => `<div class="drv-row"><span>${esc(statDisplayName(s.stat))}</span><span class="mono">${s.dDpsPer10 > 0 ? '+' : ''}${fmtNum(s.dDpsPer10)}</span></div>`).join('')}
    </div>`;
  }

  html += `
    <details class="assump-block" data-key="assump" ${openPanels.has('assump') ? 'open' : ''}>
      <summary>Model &amp; assumptions <span class="mono">(${r.assumptions.length}${r.warnings.length ? ' · ' + r.warnings.length + ' warn' : ''})</span></summary>
      ${r.warnings.length ? `<ul class="warn-list">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <ul class="assump-list">${r.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>
    </details>`;
  dv.innerHTML = html;
  sv.innerHTML = sheetViewHTML(r);
}

/* ══════════════════════════════════════════════════════════════════════
   V5 — AUDIT : panneau de confiance (result.audit) + mini-badges ✓/○ par
   élément équipé/sélectionné. Deux façades sur la même donnée :
     1. le panneau (#audit-panel, ouvert via le bouton "Audit" de l'en-tête
        du panneau de stats) — liste groupée par kind, comptée/inerte ;
     2. les badges posés par chaque rendu de carte (weaponCardHTML,
        artifactCardHTML, socketsRowHTML, runeSocketHTML, talent card,
        mt-head) — un <span data-audit-badge="prefix[|prefix2]"> vide,
        rempli/masqué par refreshAuditBadges() à CHAQUE recalcul moteur
        (textContent/class seulement — jamais d'innerHTML, donc pas de
        perte de focus et peu de travail DOM même sur une frappe).
   Résolution : les id de contributeurs embarquent index de slot/clé/ligne
   (cf. engine.js §CONTRIBUTEURS) — un simple préfixe suffit à les
   retrouver (indices bornés à un chiffre partout dans ce build : 6
   artefacts max, 2 armes, 5 sockets, 3 arbres, 5 lignes). ══════════════ */
const AUDIT_KIND_LABELS = {
  hero_base: 'Hero base', weapon: 'Weapons', artifact_main: 'Artifact — main stat',
  artifact_secondary: 'Artifact — secondary stat', chip: 'Chips', rune: 'Runes',
  item_passive: 'Item passives / actives', talent_choice: 'Talent choices',
  talent_top: 'Talent tree bonuses', mastery_node: 'Mastery nodes', mastery_edge: 'Mastery edges',
  universal_spell: 'Universal spells', corruption: 'Corruption', custom_effect: 'Custom effects',
  t3_perk: 'T3 gear perks', target: 'Target model',
};
function auditKindLabel(kind) { return AUDIT_KIND_LABELS[kind] || pretty(kind); }

/* Étiquette lisible d'une cible de contribution — la plupart sont des ids
   de stat (nom d'affichage réel) ; le reste (pseudo-cibles internes du
   moteur) reçoit un libellé statique ou dérivé. */
const AUDIT_TARGET_LABELS = {
  'dps.actives': 'dps', 'dps.hps': 'hps',
  mitigation_physical_pct: 'physical mitigation', mitigation_magical_pct: 'magical mitigation',
  mastery_points: 'mastery points', mana_restored_per_cast: 'mana / cast',
};
function auditTargetLabel(target) {
  if (!target) return 'effect';
  if (AUDIT_TARGET_LABELS[target]) return AUDIT_TARGET_LABELS[target];
  if (target.indexOf('mastery_node:') === 0) return 'mastery level';
  if (target.indexOf('ability:') === 0) return pretty(target.slice(8)) + ' ability';
  if (DB.statsById.has(target)) return statDisplayName(target);
  return pretty(target);
}
function auditContributionText(c) {
  const valStr = Number.isFinite(c.value) ? fmtNum(c.value) : null;
  return auditTargetLabel(c.target) + (valStr != null ? ' ' + valStr : '') + (c.note ? ' (' + c.note + ')' : '');
}

/* Tous les contributeurs dont l'id COMMENCE PAR l'un des préfixes donnés
   (chaîne unique, préfixes séparés par "|" — cf. data-audit-badge). */
function contributorsMatchingAny(prefixes) {
  const audit = engineResult && engineResult.audit;
  if (!audit || !prefixes.length) return [];
  return audit.contributors.filter(c => prefixes.some(p => c.id.indexOf(p) === 0));
}
function auditBadgeStatus(prefixKey) {
  const prefixes = String(prefixKey || '').split('|').filter(Boolean);
  const list = contributorsMatchingAny(prefixes);
  if (!list.length) return null; // rien d'équipé/sélectionné ici -> pas de badge du tout
  const appliedN = list.filter(c => c.applied).length;
  if (appliedN) return { ok: true, tip: appliedN + '/' + list.length + ' contributor' + (list.length > 1 ? 's' : '') + ' counted in the sheet/DPS' };
  return { ok: false, tip: list[0].inert_reason || 'no effect recorded' };
}
/* Placeholder posé au premier rendu (masqué) — refreshAuditBadges() décide
   ensuite du contenu/visibilité, sans jamais retoucher le HTML autour. */
function auditBadgeHTML(prefixKey) {
  return `<span class="audit-badge" data-audit-badge="${esc(prefixKey)}" role="img" hidden></span>`;
}
function applyAuditBadge(el) {
  const st = auditBadgeStatus(el.dataset.auditBadge);
  if (!st) { el.hidden = true; el.textContent = ''; el.removeAttribute('aria-label'); el.removeAttribute('title'); return; }
  el.hidden = false;
  el.textContent = st.ok ? '✓' : '○';
  el.classList.toggle('ok', st.ok);
  el.classList.toggle('bad', !st.ok);
  el.title = st.tip;
  el.setAttribute('aria-label', (st.ok ? 'Counted — ' : 'Inert — ') + st.tip);
}
function refreshAuditBadges() { $$('[data-audit-badge]').forEach(applyAuditBadge); }

function renderAuditPanel() {
  const panel = $('#audit-panel');
  if (!panel) return;
  panel.classList.toggle('open', auditOpen);
  if (!auditOpen) { panel.innerHTML = ''; return; }
  const audit = engineResult && engineResult.audit;
  if (!audit) { panel.innerHTML = '<p class="hint">Audit unavailable — see browser console.</p>'; return; }
  const groups = {};
  audit.contributors.forEach(c => { (groups[c.kind] = groups[c.kind] || []).push(c); });
  const kinds = Object.keys(groups).sort((a, b) => auditKindLabel(a).localeCompare(auditKindLabel(b)));
  panel.innerHTML = `
    <div class="audit-head mono">${audit.totals.applied} counted · ${audit.totals.inert} inert</div>
    ${kinds.map(kind => {
      const list = groups[kind];
      const appliedN = list.filter(c => c.applied).length;
      return `<details class="audit-group" open>
        <summary>${esc(auditKindLabel(kind))} <span class="mono">(${appliedN}/${list.length})</span></summary>
        ${list.map(c => {
          const reason = c.inert_reason || '';
          const longReason = reason.length > 54;
          const contribs = (c.contributions || []).filter(x => x.value != null || x.note);
          return `<div class="audit-entry ${c.applied ? 'applied' : 'inert'}">
            <span class="audit-entry-label" title="${esc(c.id)}">${esc(c.label)}</span>
            ${c.applied
              ? (contribs.length ? `<span class="audit-contribs">${contribs.map(x => `<span class="audit-contrib mono">${esc(auditContributionText(x))}</span>`).join('')}</span>` : '')
              : `<span class="audit-reason-chip" title="${esc(reason)}">${esc(longReason ? truncate(reason, 54) : reason)}</span>`}
          </div>`;
        }).join('')}
      </details>`;
    }).join('')}`;
}
/* Un seul point d'appel après chaque recalcul moteur : synchronise le
   panneau (s'il est ouvert) + les badges + l'état visuel du bouton. */
function syncAudit() {
  renderAuditPanel();
  refreshAuditBadges();
  const btn = $('.audit-toggle');
  if (btn) { btn.classList.toggle('active', auditOpen); btn.setAttribute('aria-expanded', String(auditOpen)); }
}

/* ── Avertissements de palier (soft — jamais bloquant) ─────────────────── */
function getTierWarnings() {
  const warns = [];
  state.weapons.forEach(w => {
    if (!w.key) return;
    const item = resolveWeapon(w.key, w.weaponType, w.tier);
    if (!item) return;
    const req = TIER_LEVEL[item.tier] || 1;
    if (state.level < req) warns.push(`${item.name} (${item.tier}) — needs level ${req}`);
  });
  state.artifacts.forEach(a => {
    if (!a) return;
    const item = DB.artifactsByKey.get(a.key);
    if (!item) return;
    const req = TIER_LEVEL[item.tier] || 1;
    if (state.level < req) warns.push(`${item.name} (${item.tier}) — needs level ${req}`);
  });
  return warns;
}
function renderTierWarnings() {
  const warns = getTierWarnings();
  $('#tier-warnings').innerHTML = warns.length ? `
    <div class="tier-warn-banner">
      <span>⚠ ${warns.length} item${warns.length > 1 ? 's' : ''} below their tier's level requirement</span>
      <details><summary>Details</summary><ul>${warns.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>
    </div>` : '';
}

/* ══════════════════════════════════════════════════════════════════════
   RENDU — orchestrateur
   ══════════════════════════════════════════════════════════════════════ */
function render() {
  computeEngine(); // une seule passe moteur par re-rendu, partagée par toutes les vues
  renderHeroRail();
  renderMasteryTabs();
  renderKitStrip();
  renderMasteryTree();
  renderWeaponRow();
  renderArtifactGrid();
  renderSpellRow();
  renderTalentPickers();
  renderTalentTrees();
  renderWeaponMastery();
  renderStatsPanel();
  renderTierWarnings();
  refreshKitDps();
  syncAudit(); // V5 : panneau + badges — après que toutes les cartes (avec leurs placeholders) sont en place
}

/* ══════════════════════════════════════════════════════════════════════
   DRAWER — picker générique (armes / artefacts / chips / runes / sorts)
   ══════════════════════════════════════════════════════════════════════ */
let drawerCtx = null;
let drawerFilterTier = null;
let drawerFilterFamily = null;

function openDrawer(ctx) {
  drawerCtx = ctx;
  drawerFilterTier = null;
  drawerFilterFamily = null;
  $('#drawer-search').value = '';
  $('#drawer-title').textContent = ctx.title;
  /* Accent de rareté : le tiroir ouvert POUR un item équipé porte la
     couleur de sa rareté (liseré + titre) — épique = violet, etc. */
  const drawer = $('#drawer');
  if (ctx.accent) {
    drawer.classList.add('rarified');
    drawer.style.setProperty('--rar', ctx.accent);
  } else {
    drawer.classList.remove('rarified');
    drawer.style.removeProperty('--rar');
  }
  renderDrawerFilters();
  renderDrawerList();
  drawer.classList.add('open');
  $('#drawer-backdrop').classList.add('open');
  setTimeout(() => $('#drawer-search').focus(), 50);
}
function closeDrawer() {
  const drawer = $('#drawer');
  drawer.classList.remove('open', 'rarified');
  drawer.style.removeProperty('--rar');
  $('#drawer-backdrop').classList.remove('open');
  drawerCtx = null;
}
function renderDrawerFilters() {
  if (!drawerCtx) return;
  let html = '';
  if (drawerCtx.allowClear) html += `<button class="act ghost" data-action="drawer-clear">Clear slot</button>`;
  if (drawerCtx.showTierFilter) {
    const tiers = [...new Set(drawerCtx.items.map(i => i.tier).filter(Boolean))].sort();
    html += `<div class="filter-chip-row">${tiers.map(t => `<button class="chip-btn" data-action="drawer-filter-tier" data-value="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
  }
  if (drawerCtx.showFamilyFilter) {
    html += `<div class="filter-chip-row">${drawerCtx.showFamilyFilter.map(f => `<button class="chip-btn" data-action="drawer-filter-family" data-value="${esc(f)}">${esc(f)}</button>`).join('')}</div>`;
  }
  $('#drawer-filters').innerHTML = html;
}
function renderDrawerList() {
  if (!drawerCtx) return;
  const q = foldAccents($('#drawer-search').value.trim().toLowerCase());
  let list = drawerCtx.items;
  if (q) list = list.filter(it => foldAccents(it.name.toLowerCase()).includes(q));
  if (drawerFilterTier) list = list.filter(it => it.tier === drawerFilterTier);
  if (drawerFilterFamily) list = list.filter(it => it.family === drawerFilterFamily);
  if (!list.length) { $('#drawer-list').innerHTML = `<p class="drawer-empty">No matches.</p>`; return; }
  const glyph = KIND_GLYPH[drawerCtx.kind] || KIND_GLYPH.generic;
  $('#drawer-list').innerHTML = list.map(it => {
    const isEquipped = drawerCtx.selectedKey != null && it.key === drawerCtx.selectedKey;
    return `
    <button class="drawer-row ${it.generic ? 'generic-row' : ''} ${isEquipped ? 'equipped rarified' : ''}"
            ${isEquipped && drawerCtx.accent ? `style="--rar:${esc(drawerCtx.accent)}"` : ''}
            ${it.titleText ? `title="${esc(it.titleText)}"` : ''}
            data-action="drawer-select" data-key="${esc(it.key)}">
      ${iconTag(it.icon, 'drawer-row-icon', glyph)}
      <span class="drawer-row-text">
        <span class="drawer-row-name">${esc(it.name)}${it.generic ? ' <span class="generic-badge">GENERIC</span>' : ''}${isEquipped ? ' <span class="equipped-chip">EQUIPPED</span>' : ''}</span>
        ${it.sub ? `<span class="drawer-row-sub">${esc(it.sub)}</span>` : ''}
      </span>
      ${it.tier ? `<span class="tier-badge tier-${cssTier(it.tier)}">${esc(it.tier)}</span>` : ''}
    </button>`;
  }).join('');
}
function toggleDrawerFilter(kind, btn) {
  const val = btn.dataset.value;
  const row = btn.parentElement;
  if (kind === 'tier') drawerFilterTier = drawerFilterTier === val ? null : val;
  else drawerFilterFamily = drawerFilterFamily === val ? null : val;
  row.querySelectorAll('.chip-btn').forEach(b => b.classList.toggle('active',
    b === btn && ((kind === 'tier' && drawerFilterTier === val) || (kind === 'family' && drawerFilterFamily === val))));
  renderDrawerList();
}

/* ── Ouverture des pickers par nature de slot ─────────────────────────── */
function openWeaponPicker(i) {
  const hero = currentHero(), mastery = currentMastery();
  const slot = state.weapons[i];
  let candidates = weaponsFor(hero.name, mastery.id, slot.weaponType).map(w => ({
    key: w.key, name: w.name, icon: w.icon, tier: w.tier, sub: `${w.class} · ${w.spec}`, generic: false,
  }));
  if (!candidates.length) {
    candidates = [{ key: genericWeaponKey(slot.weaponType), name: `Generic ${slot.weaponType}`, icon: null, tier: 'T1', sub: 'No real item modeled for this mastery yet — configurable placeholder.', generic: true }];
  }
  openDrawer({
    title: `Choose ${slot.label}`, kind: 'weapon', items: candidates,
    showTierFilter: candidates.some(c => !c.generic),
    allowClear: !!slot.key,
    accent: slot.key ? rarityColor(slot.rarity) : null,
    selectedKey: slot.key,
    onSelect(it) {
      const item = resolveWeapon(it.key, slot.weaponType, 'T1');
      slot.key = item.key; slot.isGeneric = !!item.isGeneric; slot.tier = item.tier;
      slot.rarity = 'common'; slot.upgrade = 'normal'; slot.chips = [];
      normalizeWeaponSlot(i);
      render();
    },
    onClear() { slot.key = null; slot.isGeneric = false; slot.chips = []; render(); },
  });
}
function openArtifactPicker(i) {
  const candidates = DB.artifacts.map(a => ({ key: a.key, name: a.name, icon: a.icon, tier: a.tier, sub: truncate(a.flavor, 90), generic: false }));
  openDrawer({
    title: `Choose artifact ${i + 1}`, kind: 'artifact', items: candidates, showTierFilter: true,
    allowClear: !!state.artifacts[i],
    accent: state.artifacts[i] ? rarityColor(state.artifacts[i].rarity) : null,
    selectedKey: state.artifacts[i] ? state.artifacts[i].key : null,
    onSelect(it) {
      const item = DB.artifactsByKey.get(it.key);
      /* V3 : main stat auto-sélectionnée quand l'item la fixe. */
      const fixed = item && item.main_stat && item.main_stat.stat && DB.statsById.has(item.main_stat.stat)
        ? item.main_stat.stat : null;
      state.artifacts[i] = { key: it.key, mainStat: fixed, rarity: 'common', upgrade: 'normal', secondary: [], secondaryRolls: [], secondaryStars: [], mainStatRoll: null, mainStars: null, rune: null };
      normalizeArtifactSlot(i);
      render();
    },
    onClear() { state.artifacts[i] = null; render(); },
  });
}
function openChipPicker(weaponIdx, chipIdx) {
  const slot = state.weapons[weaponIdx];
  const candidates = DB.chips.map(c => ({ key: c.key, name: c.name, icon: c.icon, tier: c.tier, family: c.family, sub: truncate(stripCtrl(c.description), 140), titleText: stripCtrl(c.description), generic: false }));
  openDrawer({
    title: 'Choose chip', kind: 'chip', items: candidates, showTierFilter: true, showFamilyFilter: ['standard', 'advanced'],
    allowClear: !!slot.chips[chipIdx],
    accent: slot.key ? rarityColor(slot.rarity) : null,
    selectedKey: slot.chips[chipIdx] || null,
    onSelect(it) { slot.chips[chipIdx] = it.key; render(); },
    onClear() { slot.chips[chipIdx] = null; render(); },
  });
}
function openRunePicker(i) {
  const candidates = DB.runeGroups.map(g => ({
    key: g.id, name: g.name, icon: g.icon, family: g.family,
    sub: truncate(stripCtrl(g.description), 140) || (Object.keys(g.variants).length > 1 ? 'Has upgraded/overclocked variants' : ''),
    titleText: stripCtrl(g.description),
    generic: false,
  }));
  openDrawer({
    title: 'Choose rune', kind: 'rune', items: candidates, showFamilyFilter: ['Active', 'Advanced', 'Basic'],
    allowClear: !!(state.artifacts[i] && state.artifacts[i].rune),
    accent: state.artifacts[i] ? rarityColor(state.artifacts[i].rarity) : null,
    selectedKey: state.artifacts[i] && state.artifacts[i].rune ? state.artifacts[i].rune.key : null,
    onSelect(it) {
      const grp = DB.runeGroupById.get(it.key);
      const variant = grp.variants.base ? 'base' : Object.keys(grp.variants)[0];
      state.artifacts[i].rune = { key: grp.id, variant };
      render();
    },
    onClear() { state.artifacts[i].rune = null; render(); },
  });
}
function openSpellPicker(hand) {
  const candidates = DB.universalSpells.map(s => ({ key: s.id, name: s.name, icon: s.icon, sub: `Unlocks at level ${s.unlock_level}`, generic: false }));
  openDrawer({
    title: `Choose ${hand.toUpperCase()} spell`, kind: 'spell', items: candidates,
    allowClear: !!state.spells[hand],
    selectedKey: state.spells[hand] || null,
    onSelect(it) { state.spells[hand] = it.key; render(); },
    onClear() { state.spells[hand] = null; render(); },
  });
}

/* ══════════════════════════════════════════════════════════════════════
   MUTATIONS d'état
   ══════════════════════════════════════════════════════════════════════ */
function normalizeWeaponSlot(i) {
  const slot = state.weapons[i];
  const item = resolveWeapon(slot.key, slot.weaponType, slot.tier);
  if (!item) { slot.chips = []; return; }
  const { count } = computeSlots('weapon_chip_sockets', slot.tier, slot.rarity, slot.upgrade);
  slot.chips.length = Math.min(slot.chips.length, count);
  while (slot.chips.length < count) slot.chips.push(null);
}
function setWeaponRarity(i, rarity) { state.weapons[i].rarity = rarity; normalizeWeaponSlot(i); render(); }
function setWeaponUpgrade(i, upgrade) { state.weapons[i].upgrade = upgrade; normalizeWeaponSlot(i); render(); }
function setWeaponTier(i, tier) { state.weapons[i].tier = tier; normalizeWeaponSlot(i); render(); }

function normalizeArtifactSlot(i) {
  const a = state.artifacts[i];
  if (!a) return;
  const item = DB.artifactsByKey.get(a.key);
  if (!item) return;
  const { count } = computeSlots('artifact_secondary_slots', item.tier, a.rarity, a.upgrade);
  /* V4.2 : plus jamais de troncature — un pick au-delà de `count` (rareté
     rabaissée, ou table de tiers régénérée par le pipeline avec moins de
     sockets qu'avant) reste dans le build et sera flagué "over slot count"
     à l'affichage (artifactCardHTML) au lieu d'être supprimé. On ne fait
     QUE grandir jusqu'au compte courant quand il y a moins de picks. */
  while (a.secondary.length < count) a.secondary.push(null);
  /* secondaryRolls/secondaryStars suivent secondary position par position
     (jamais plus courts, jamais tronqués en dessous des picks existants). */
  if (!Array.isArray(a.secondaryRolls)) a.secondaryRolls = [];
  while (a.secondaryRolls.length < a.secondary.length) a.secondaryRolls.push(null);
  if (!Array.isArray(a.secondaryStars)) a.secondaryStars = [];
  while (a.secondaryStars.length < a.secondary.length) a.secondaryStars.push(null);
  if (!('mainStatRoll' in a)) a.mainStatRoll = null;
  if (!('mainStars' in a)) a.mainStars = null;
  /* V4 : les étoiles HÉRITÉES (vieux liens) deviennent des rolls (valeur
     au quintile dans la bande réelle) — le roll est la source de vérité,
     les étoiles ne sont plus que dérivées à l'affichage. */
  const slotRef = a;
  if (a.mainStars && a.mainStat) {
    if (Number.isFinite(a.mainStatRoll)) a.mainStars = null; // le roll gagne — étoiles désormais dérivées
    else {
      const b = bandFor(item, slotRef, a.mainStat, true);
      if (b) { a.mainStatRoll = rollFromStars(a.mainStars, b); a.mainStars = null; }
    }
  }
  a.secondary.forEach((statId, si) => {
    if (!statId || !a.secondaryStars[si]) return;
    if (Number.isFinite(a.secondaryRolls[si])) { a.secondaryStars[si] = null; return; }
    const b = bandFor(item, slotRef, statId, false);
    if (b) { a.secondaryRolls[si] = rollFromStars(a.secondaryStars[si], b); a.secondaryStars[si] = null; }
  });
}
/* V4 : changement de rareté = re-liaison des bandes + re-clamp des rolls
   qui étaient DANS la bande (les valeurs custom hors-bande sont gardées). */
function reclampArtifactRolls(i) {
  const a = state.artifacts[i];
  if (!a) return;
  const item = DB.artifactsByKey.get(a.key);
  if (!item) return;
  if (a.mainStat && Number.isFinite(a.mainStatRoll) && !customRollFlags.has(rollKey(i, null))) {
    const b = bandFor(item, a, a.mainStat, true);
    if (b) a.mainStatRoll = clampToBand(a.mainStatRoll, b);
  }
  a.secondary.forEach((statId, si) => {
    if (!statId || !Number.isFinite(a.secondaryRolls[si]) || customRollFlags.has(rollKey(i, si))) return;
    const b = bandFor(item, a, statId, false);
    if (b) a.secondaryRolls[si] = clampToBand(a.secondaryRolls[si], b);
  });
}
/* Après un chargement (hash, sauvegarde, import), les tableaux chips/
   secondary peuvent être plus courts que le nombre de sockets calculé :
   on complète pour que chaque socket ait bien sa case à l'écran. */
function normalizeAllSlots() {
  state.weapons.forEach((_, i) => normalizeWeaponSlot(i));
  state.artifacts.forEach((_, i) => normalizeArtifactSlot(i));
}
function setArtifactRarity(i, rarity) { state.artifacts[i].rarity = rarity; normalizeArtifactSlot(i); reclampArtifactRolls(i); render(); }
function setArtifactUpgrade(i, upgrade) { state.artifacts[i].upgrade = upgrade; normalizeArtifactSlot(i); render(); }
/* Application groupée rareté/état à tous les artefacts équipés (V2). */
function bulkApplyArtifacts(rarity, upgrade) {
  if (!DB.rarityById.has(rarity) || !DB.mechanics.upgrade_states.includes(upgrade)) return 0;
  let n = 0;
  state.artifacts.forEach((art, ai) => {
    if (!art) return;
    art.rarity = rarity;
    art.upgrade = upgrade;
    normalizeArtifactSlot(ai);
    n++;
  });
  return n;
}
function setRuneVariant(i, variant) { state.artifacts[i].rune.variant = variant; render(); }

function toggleAbility(idx) {
  expandedAbilities.has(idx) ? expandedAbilities.delete(idx) : expandedAbilities.add(idx);
  render();
}
/* V4.1 : clic = +1 point. Carte non choisie → choisie (le rang investi de
   la rangée SUIT le nouveau choix : un seul choix par rangée in-game, on
   déplace les points au lieu de les perdre). Carte déjà choisie → +1 rang
   jusqu'à 5. Budget 15 souple : avertit au dépassement, ne bloque pas. */
function selectTalentChoice(slotIdx, row, choice) {
  const slot = state.talents[slotIdx];
  if (!slot.ranks) slot.ranks = {};
  const before = talentPoints(slot);
  if (slot.picks[row] === choice) {
    const rank = slot.ranks[row] || 1;
    if (rank >= 5) { showToast('Max rank (5) — use − to remove points.'); return; }
    slot.ranks[row] = rank + 1;
  } else {
    slot.picks[row] = choice;               // les points investis suivent le choix
    if (!slot.ranks[row]) slot.ranks[row] = 1;
  }
  const after = talentPoints(slot);
  if (after > TALENT_BUDGET && before <= TALENT_BUDGET) {
    showToast(`Over the ${TALENT_BUDGET}-point tree budget — allowed for theorycrafting, flagged in the counter.`);
  }
  render();
}
function talentRankMinus(slotIdx, row) {
  const slot = state.talents[slotIdx];
  if (!Number.isInteger(slot.picks[row])) return;
  const rank = (slot.ranks && slot.ranks[row]) || 1;
  if (rank <= 1) { delete slot.picks[row]; if (slot.ranks) delete slot.ranks[row]; }
  else slot.ranks[row] = rank - 1;
  render();
}
function changeTalentTree(slotIdx, treeId) {
  state.talents[slotIdx] = { treeId: treeId || null, picks: {}, notes: {}, ranks: {}, conds: {} };
  render();
}
function selectHero(heroId) {
  const hero = DB.heroesById.get(heroId);
  if (!hero) return;
  state.heroId = heroId;
  const mastery = hero.masteries[0];
  state.masteryId = mastery.id;
  state.weapons = freshWeaponsForMastery(mastery);
  expandedAbilities.clear();
  selectedMasteryNode = null;
  render();
}
function selectMastery(masteryId) {
  const hero = currentHero();
  const mastery = hero.masteries.find(m => m.id === masteryId);
  if (!mastery) return;
  state.masteryId = masteryId;
  state.weapons = freshWeaponsForMastery(mastery);
  expandedAbilities.clear();
  selectedMasteryNode = null;
  render();
}

/* ══════════════════════════════════════════════════════════════════════
   CHARGEMENT SÛR — repli héros par défaut (correctif UX#1 : un import/
   chargement dont le héros n'existe plus ne doit JAMAIS faire planter
   render() ni mentir dans le toast).
   ══════════════════════════════════════════════════════════════════════ */
function ensureConsistentState(st) {
  let degraded = !!st._degraded;
  delete st._degraded;
  const hero = st.heroId ? DB.heroesById.get(st.heroId) : null;
  if (!hero) {
    if (st.heroId) degraded = true; // un id était fourni mais ne résout plus
    const h = DB.heroes[0];
    st.heroId = h.id;
    st.masteryId = h.masteries[0].id;
    st.weapons = freshWeaponsForMastery(h.masteries[0]);
  } else if (!hero.masteries.some(m => m.id === st.masteryId)) {
    degraded = true;
    st.masteryId = hero.masteries[0].id;
    st.weapons = freshWeaponsForMastery(hero.masteries[0]);
  }
  return degraded;
}
/* Adopte un état restauré (hash/sauvegarde/import/preset) de manière
   cohérente et honnête — toast dégradé quand des champs ont été perdus. */
function adoptState(newState, okMsg) {
  state = newState;
  const degraded = ensureConsistentState(state);
  normalizeAllSlots();
  refreshHeaderInputs();
  expandedAbilities.clear();
  render();
  showToast(degraded ? 'Loaded with defaults — some saved fields no longer exist.' : okMsg);
}

/* ══════════════════════════════════════════════════════════════════════
   MAÎTRISE D'ARME (stub honnête — arbre non mappé publiquement)
   ══════════════════════════════════════════════════════════════════════ */
function renderWeaponMastery() {
  const el = $('#wm-section');
  if (!el) return;
  const wm = state.weaponMastery || (state.weaponMastery = { points: 0, notes: '' });
  el.innerHTML = `
    <div class="wm-row">
      <input type="number" min="0" max="26" step="1" class="roll-input mono" value="${Number.isFinite(wm.points) ? wm.points : 0}"
             data-action="change-wm-points" aria-label="Weapon mastery points">
      <span class="mono">/ 26 points</span>
      <input type="text" class="note-input wm-notes" maxlength="200" placeholder="notes (e.g. which nodes you took in game)…"
             value="${esc(wm.notes || '')}" data-action="change-wm-notes" aria-label="Weapon mastery notes">
    </div>
    <p class="hint">Display-only — the weapon mastery tree isn't in any public data; these points feed nothing in the engine.</p>`;
}

/* ══════════════════════════════════════════════════════════════════════
   PRESETS — 2-3 builds de départ (clés résolues au runtime contre DB,
   rolls/base = placeholders assumés, jamais présentés comme sourcés)
   ══════════════════════════════════════════════════════════════════════ */
let PRESETS = [];
function buildPresets() {
  PRESETS = [];
  const wpn = pred => DB.weapons.find(pred) || null;
  const t2Arts = DB.artifacts.filter(a => a.tier === 'T2');
  const mkArt = (art, main, secs) => art ? {
    key: art.key, mainStat: main, rarity: 'epic', state: 'upgraded',
    secondary: secs, secondaryRolls: secs.map(() => 100), mainStatRoll: 100, rune: null,
  } : null;
  const mk = (id, label, share) => PRESETS.push({ id, label, share });

  const bow = wpn(w => w.spec === 'Ranger' && w.tier === 'T2') || wpn(w => w.spec === 'Ranger');
  if (bow) mk('ranger', 'Ranger — bow skirmisher', {
    v: 1, hero: 'champion', mastery: 'ranger', lvl: 30, name: 'Preset — Ranger skirmisher',
    weapons: [{ key: bow.key, rarity: 'epic', state: 'upgraded', chips: [] }],
    artifacts: [mkArt(t2Arts[0], 'attack_power', ['attack_speed', 'physical_crit_chance']), mkArt(t2Arts[1], 'health', ['lifesteal']), null, null, null, null],
    spells: ['heal', 'sprint'], talents: { hunter: { 0: 0, 1: 0 }, warrior: { 2: 0 } },
    baseOverrides: { attack_power: 60, health: 1500, weapon_damage: 45 },
  });
  const sword = wpn(w => w.spec === 'Destroyer' && w.tier === 'T2') || wpn(w => w.spec === 'Destroyer');
  if (sword) mk('destroyer', 'Destroyer — melee bruiser', {
    v: 1, hero: 'champion', mastery: 'destroyer', lvl: 30, name: 'Preset — Destroyer bruiser',
    weapons: [{ key: sword.key, rarity: 'epic', state: 'upgraded', chips: [] }],
    artifacts: [mkArt(t2Arts[2] || t2Arts[0], 'attack_power', ['lifesteal', 'physical_crit_power']), mkArt(t2Arts[3] || t2Arts[1], 'armor', ['tenacity']), null, null, null, null],
    spells: ['heal', 'shield'], talents: { warrior: { 1: 0, 2: 0 }, tank: { 0: 0 } },
    baseOverrides: { attack_power: 70, health: 2100, weapon_damage: 55, armor: 90 },
  });
  const fist = wpn(w => w.spec === 'Shaman');
  if (fist) mk('shaman', 'Shaman — fist support', {
    v: 1, hero: 'warmonger', mastery: 'shaman', lvl: 25, name: 'Preset — Shaman support',
    weapons: [{ key: fist.key, rarity: 'rare', state: 'normal', chips: [] }],
    artifacts: [mkArt(t2Arts[4] || t2Arts[0], 'heal_shield_power', ['cooldown_reduction', 'mana_regen']), null, null, null, null, null],
    spells: ['heal', 'mana_burst'], talents: { medic: { 0: 0 }, support: { 0: 0 } },
    baseOverrides: { spell_power: 55, health: 1400, mana: 900, heal_shield_power: 40 },
  });
}
function loadPresetAction(presetId) {
  const p = PRESETS.find(x => x.id === presetId);
  if (!p) return;
  adoptState(applyShareToState(deepClone(p.share)), 'Preset loaded — rolls and base stats are honest placeholders, adjust them.');
  $('#saves-panel')?.classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════════════
   ONBOARDING — bannière discrète, rejet mémorisé (localStorage)
   ══════════════════════════════════════════════════════════════════════ */
const LS_ONBOARD_KEY = 'corepunk_builder_onboard_v1';
function renderOnboarding() {
  const slot = $('#onboard-slot');
  if (!slot) return;
  if (localStorage.getItem(LS_ONBOARD_KEY)) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="onboard">
    <span class="onboard-text">New bench? Pick a hero on the left — or start from a preset:</span>
    ${PRESETS.map(p => `<button class="act" data-action="load-preset" data-preset-id="${esc(p.id)}">${esc(p.label)}</button>`).join('')}
    <button class="act ghost" data-action="dismiss-onboard">Dismiss</button>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   COMPARAISON — build courant vs sauvegarde (table mono, deltas ±)
   ══════════════════════════════════════════════════════════════════════ */
function computeForShare(share) {
  ensureEngineData();
  const def = engineDataCache.combat && engineDataCache.combat.base && engineDataCache.combat.base.default;
  if (def) Object.keys(engineBaseOriginals).forEach(k => {
    const ov = share.baseOverrides ? share.baseOverrides[k] : undefined;
    def[k].value = Number.isFinite(ov) ? ov : engineBaseOriginals[k];
  });
  const opts = {};
  const t = share.target || {};
  const tgt = {};
  ['armor', 'magic_resistance', 'level'].forEach(f => { if (Number.isFinite(t[f])) tgt[f] = t[f]; });
  if (Object.keys(tgt).length) opts.target = tgt;
  try { return Engine.compute(share, engineDataCache, opts); }
  catch (e) { console.error('compare compute failed', e); return null; }
}
function openCompare(saveId) {
  const save = getSaveById(saveId);
  if (!save) { showToast('Save not found.'); return; }
  const other = computeForShare(save.data);
  computeEngine(); // re-patch les données pour le build COURANT (et résultat frais)
  const cur = engineResult;
  if (!cur || !other) { showToast('Comparison unavailable — engine error (see console).'); return; }
  const rows = [];
  const add = (label, a, b) => rows.push({ label, a: Number.isFinite(a) ? a : 0, b: Number.isFinite(b) ? b : 0 });
  DB.mainStats.forEach(s => add(s.name, cur.sheet.stats[s.id]?.rating, other.sheet.stats[s.id]?.rating));
  DB.secondaryStats.forEach(s => {
    const a = cur.sheet.stats[s.id]?.rating ?? 0, b = other.sheet.stats[s.id]?.rating ?? 0;
    if (a || b) add(s.name, a, b);
  });
  add('DPS (total)', cur.dps.total.value, other.dps.total.value);
  const hA = cur.dps.hps && cur.dps.hps.value, hB = other.dps.hps && other.dps.hps.value;
  if (Number.isFinite(hA) || Number.isFinite(hB)) add('HPS', hA, hB);
  add('EHP physical', cur.sheet.derived.ehp_physical, other.sheet.derived.ehp_physical);
  add('EHP magical', cur.sheet.derived.ehp_magical, other.sheet.derived.ehp_magical);
  $('#compare-body').innerHTML = `
    <div class="compare-row compare-heads"><span class="cmp-label">Stat</span><span class="mono">Current</span><span class="mono">${esc(truncate(save.name, 18))}</span><span class="mono">Δ</span></div>
    ${rows.map(r => {
      const d = r.a - r.b;
      const cls = d > 0 ? 'pos' : (d < 0 ? 'neg' : '');
      return `<div class="compare-row"><span class="cmp-label">${esc(r.label)}</span>
        <span class="mono">${fmtNum(r.a)}</span><span class="mono">${fmtNum(r.b)}</span>
        <span class="mono cmp-delta ${cls}">${d === 0 ? '—' : (d > 0 ? '+' : '') + fmtNum(d)}</span></div>`;
    }).join('')}
    <p class="hint">Zeros usually mean missing base stats/rolls, not real equality — both builds share the same data gaps.</p>`;
  $('#compare-overlay').classList.add('open');
  $('#saves-panel')?.classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════════════
   HEADER — partage, sauvegardes, export/import
   ══════════════════════════════════════════════════════════════════════ */
let toastTimer = null;
function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function refreshHeaderInputs() {
  $('#build-name').value = state.name;
  $('#level-slider').value = state.level;
  $('#level-readout').textContent = 'LV ' + String(state.level).padStart(2, '0');
}
function copyLinkAction() {
  const hash = encodeHash(state);
  const url = location.origin + location.pathname + '#' + hash;
  history.replaceState(null, '', '#' + hash);
  const msg = url.length > 2000
    ? `Link copied — heads-up: it's ${url.length} characters, some apps truncate URLs over 2000.`
    : 'Link copied to clipboard.';
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => showToast(msg), () => fallbackCopy(url, msg));
  } else fallbackCopy(url, msg);
}
function fallbackCopy(url, msg) {
  const ta = document.createElement('textarea');
  ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast(msg || 'Link copied to clipboard.'); }
  catch { showToast('Could not copy — select the address bar manually.'); }
  ta.remove();
}
function saveBuildAction() {
  const name = state.name && state.name.trim() ? state.name.trim() : 'Untitled build';
  const existing = findSaveByName(name);
  if (existing) {
    if (!confirm(`A build named "${name}" already exists. Overwrite it?`)) return;
    overwriteSavedBuild(existing.id, state);
  } else {
    saveBuildToStorage(name, state);
  }
  renderSavesPanel();
  showToast('Build saved: ' + name);
}
function toggleSavesPanel() {
  const panel = $('#saves-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderSavesPanel();
}
function renderSavesPanel() {
  const saves = listSaves();
  const savesHtml = saves.length ? saves.map(s => `
    <div class="save-row">
      <button class="save-name" data-action="load-save" data-id="${esc(s.id)}" title="Click: load · double-click: rename">${esc(s.name)}</button>
      <span class="save-date mono">${esc(new Date(s.savedAt).toLocaleDateString())}</span>
      <button class="save-mini" data-action="compare-save" data-id="${esc(s.id)}" title="Compare with current build" aria-label="Compare with current build">⇄</button>
      <button class="save-mini" data-action="dup-save" data-id="${esc(s.id)}" title="Duplicate" aria-label="Duplicate save">⧉</button>
      <button class="save-del" data-action="delete-save" data-id="${esc(s.id)}" aria-label="Delete save">×</button>
    </div>`).join('') : `<p class="drawer-empty">No saved builds yet.</p>`;
  const presetsHtml = PRESETS.length ? `
    <h3 class="saves-sub">Presets <span class="hint-inline">placeholder rolls</span></h3>
    ${PRESETS.map(p => `<div class="save-row"><button class="save-name" data-action="load-preset" data-preset-id="${esc(p.id)}">${esc(p.label)}</button></div>`).join('')}` : '';
  $('#saves-list').innerHTML = savesHtml + presetsHtml;
}
function loadSaveAction(id) {
  const loaded = loadSavedBuild(id);
  if (!loaded) { showToast('Could not load save.'); return; }
  $('#saves-panel').classList.remove('open');
  adoptState(loaded, 'Build loaded.');
}
function deleteSaveAction(id) { deleteSavedBuild(id); renderSavesPanel(); }
function newBuildAction() {
  if (!confirm('Start a new build? Unsaved changes will be lost.')) return;
  state = makeDefaultState();
  const hero = DB.heroes[0];
  state.heroId = hero.id; state.masteryId = hero.masteries[0].id;
  state.weapons = freshWeaponsForMastery(hero.masteries[0]);
  history.replaceState(null, '', location.pathname);
  refreshHeaderInputs();
  expandedAbilities.clear();
  render();
}
function handleImportFile(file) {
  if (!file) return;
  importBuildFile(file)
    .then(loaded => {
      /* Erreur de rendu ≠ fichier invalide : deux toasts distincts (le
         vieux bug affichait "Import failed" alors que le state était
         à moitié appliqué). */
      try { adoptState(loaded, 'Build imported.'); }
      catch (err) { console.error(err); showToast('Import hit a rendering error — see console.'); }
    })
    .catch(() => showToast('Import failed — the file is not valid build JSON.'));
  $('#import-input').value = '';
}

/* ══════════════════════════════════════════════════════════════════════
   ÉVÉNEMENTS — délégation globale
   ══════════════════════════════════════════════════════════════════════ */
document.body.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const i = () => Number(el.dataset.slotIndex);
  switch (a) {
    case 'select-hero': selectHero(el.dataset.hero); break;
    case 'select-mastery': selectMastery(el.dataset.mastery); break;
    case 'toggle-ability': toggleAbility(Number(el.dataset.idx)); break;
    case 'open-weapon-picker': openWeaponPicker(i()); break;
    case 'open-artifact-picker': openArtifactPicker(i()); break;
    case 'clear-artifact': state.artifacts[i()] = null; render(); break;
    case 'set-weapon-rarity': setWeaponRarity(i(), el.dataset.rarity); break;
    case 'set-weapon-upgrade': setWeaponUpgrade(i(), el.dataset.upgrade); break;
    case 'set-weapon-tier': setWeaponTier(i(), el.dataset.tier); break;
    case 'set-artifact-rarity': setArtifactRarity(i(), el.dataset.rarity); break;
    case 'set-artifact-upgrade': setArtifactUpgrade(i(), el.dataset.upgrade); break;
    case 'open-chip-picker': openChipPicker(i(), Number(el.dataset.chipIndex)); break;
    case 'open-rune-picker': openRunePicker(i()); break;
    case 'clear-rune': state.artifacts[i()].rune = null; render(); break;
    case 'set-rune-variant': setRuneVariant(i(), el.dataset.variant); break;
    case 'open-spell-picker': openSpellPicker(el.dataset.hand); break;
    case 'select-talent-choice': selectTalentChoice(Number(el.dataset.talentSlot), Number(el.dataset.row), Number(el.dataset.choice)); break;
    case 'drawer-select': { const it = drawerCtx?.items.find(x => x.key === el.dataset.key); if (it) drawerCtx.onSelect(it); closeDrawer(); break; }
    case 'drawer-clear': if (drawerCtx) drawerCtx.onClear(); closeDrawer(); break;
    case 'drawer-filter-tier': toggleDrawerFilter('tier', el); break;
    case 'drawer-filter-family': toggleDrawerFilter('family', el); break;
    case 'close-drawer': closeDrawer(); break;
    case 'copy-link': copyLinkAction(); break;
    case 'save-build': saveBuildAction(); break;
    case 'toggle-saves': toggleSavesPanel(); break;
    case 'load-save': {
      /* Chargement différé (280 ms) pour laisser sa chance au double-clic
         de renommage — annulé par le handler dblclick. */
      const id = el.dataset.id;
      clearTimeout(loadSaveTimer);
      loadSaveTimer = setTimeout(() => loadSaveAction(id), 280);
      break;
    }
    case 'delete-save': deleteSaveAction(el.dataset.id); break;
    case 'dup-save': duplicateSavedBuild(el.dataset.id); renderSavesPanel(); showToast('Save duplicated.'); break;
    case 'compare-save': openCompare(el.dataset.id); break;
    case 'close-compare': $('#compare-overlay').classList.remove('open'); break;
    case 'load-preset': loadPresetAction(el.dataset.presetId); break;
    case 'dismiss-onboard': localStorage.setItem(LS_ONBOARD_KEY, '1'); renderOnboarding(); break;
    case 'export-build': exportBuildFile(state); showToast('Build exported.'); break;
    case 'new-build': newBuildAction(); break;
    case 'trigger-import': $('#import-input').click(); break;
    case 'toggle-target-pop': $('#target-pop')?.classList.toggle('open'); break;
    case 'toggle-audit': auditOpen = !auditOpen; syncAudit(); break;
    case 'reset-base': state.baseOverrides = {}; render(); showToast('Base stats reset to data defaults.'); break;
    case 'apply-target-preset': {
      const p = TARGET_PRESET_DEFS.find(x => x.id === el.dataset.preset);
      if (p) { state.target.armor = p.armor; state.target.magic_resistance = p.mres; state.target.preset = p.id; render(); }
      break;
    }
    case 'set-rotation-mode': state.rotationMode = el.dataset.mode === 'autos' ? 'autos' : 'full'; computeAndRefresh(); break;
    case 'bulk-apply': {
      const n = bulkApplyArtifacts($('#bulk-rarity')?.value, $('#bulk-state')?.value);
      render();
      showToast(n ? `Applied to ${n} artifact${n > 1 ? 's' : ''}.` : 'No artifacts equipped.');
      break;
    }
    case 'copy-artifact': {
      const a = state.artifacts[i()];
      if (a) {
        artifactClipboard = deepClone({ mainStat: a.mainStat, rarity: a.rarity, upgrade: a.upgrade, secondary: a.secondary, secondaryRolls: a.secondaryRolls, mainStatRoll: a.mainStatRoll, rune: a.rune });
        render();
        showToast('Artifact config copied — paste with ⇩ on another card.');
      }
      break;
    }
    case 'paste-artifact': {
      const a = state.artifacts[i()];
      if (a && artifactClipboard) {
        Object.assign(a, deepClone(artifactClipboard));
        normalizeArtifactSlot(i());
        render();
        showToast('Artifact config pasted.');
      }
      break;
    }
    case 'open-fx-block': if (el.dataset.fxKey) { openPanels.add(el.dataset.fxKey); render(); } break;
    case 'set-chip-fx-value': {
      const row = el.closest('.fx-row');
      if (row) {
        const fx2 = fxGetOrCreate(row.dataset.fxSource, Number(row.dataset.fxIndex), row.dataset.fxPreset || null);
        fx2.value = Number(el.dataset.value);
        fx2.unit = 'flat';                       // valeurs de puce = points de rating
        if (!fx2.stat && row.dataset.fxPreset) fx2.stat = row.dataset.fxPreset;
        render();
      }
      break;
    }
    case 'set-fx-unit': {
      const row = el.closest('.fx-row');
      if (row) {
        const e2 = fxGetOrCreate(row.dataset.fxSource, Number(row.dataset.fxIndex), row.dataset.fxPreset || null);
        /* V4.2 garde : une stat à forme canonique connue (statUnit non
           null) ne se laisse JAMAIS écraser par le toggle — ce contrôle ne
           devrait même plus être à l'écran pour elle (fxRowHTML rend un
           suffixe statique), mais un toggle périmé d'un DOM pas encore
           repeint ne doit pas pouvoir corrompre l'unité dérivée. */
        if (statUnit(e2.stat)) { render(); break; }
        e2.unit = el.dataset.unit === 'flat' ? 'flat' : '%';
        render();
      }
      break;
    }
    case 'clear-fx': {
      const row = el.closest('.fx-row');
      if (row) { fxRemove(row.dataset.fxSource, Number(row.dataset.fxIndex)); render(); }
      break;
    }
    case 'talent-rank-minus': talentRankMinus(Number(el.dataset.talentSlot), Number(el.dataset.row)); break;
    /* ── V3 : arbre de mastery ── */
    case 'mastery-node': {
      const spec = masterySpec();
      if (!spec || !spec.built) break;
      const nid = el.dataset.nodeId;
      const node = (spec.nodes || []).find(n => n.id === nid);
      if (!node) break;
      const alloc = masteryAllocFor(true);
      const cur = alloc.nodes[nid] || 0;
      const maxPts = (DB.masterySystem || {}).points_max || 26;
      selectedMasteryNode = nid; // la sélection (lecture du détail) reste libre même sur un node verrouillé
      if (cur >= (node.max_level || 3)) {
        /* V4.3 garde de remboursement : refuser si la libération créerait
           de NOUVEAUX orphelins en aval (on défait feuille par feuille). */
        if (!masteryRefundAllowed(spec, alloc, sim => { delete sim.nodes[nid]; })) {
          showToast('Ce node porte ta progression — libère d\'abord les nodes/segments en aval.');
        } else {
          delete alloc.nodes[nid]; // un clic de plus au max = on libère les points
        }
      } else if (cur === 0 && !masteryNodeInvestable(spec, alloc, nid)) {
        /* V4.3 connectivité : niveau 1 seulement depuis une racine ou via
           une arête achetée reliée à un node investi (monter 2→3 : libre). */
        showToast('Verrouillé — ' + MASTERY_LOCKED_TIP + ' (investis une racine près du rail, puis achète les segments).');
      } else if (masteryPointsSpent(alloc) + 1 > maxPts) {
        showToast(`Budget ${maxPts} points reached — free some first.`);
      } else {
        if (node.ult_exclusive_group) {
          (spec.nodes || []).forEach(n2 => {
            if (n2.id !== nid && n2.ult_exclusive_group === node.ult_exclusive_group) delete alloc.nodes[n2.id];
          });
        }
        alloc.nodes[nid] = cur + 1;
      }
      render();
      break;
    }
    case 'toggle-mastery-edge': {
      const spec = masterySpec();
      if (!spec || !spec.built) break;
      const alloc = masteryAllocFor(true);
      const eid = el.dataset.edgeId;
      const at = alloc.edges.indexOf(eid);
      if (at >= 0) {
        /* V4.3 garde de remboursement : ne pas couper un pont utilisé. */
        if (!masteryRefundAllowed(spec, alloc, sim => { sim.edges.splice(sim.edges.indexOf(eid), 1); })) {
          showToast('Ce segment relie ta progression — libère d\'abord les nodes en aval.');
          render();
          break;
        }
        alloc.edges.splice(at, 1);
      } else {
        /* V4.3 connectivité : achetable seulement depuis un node investi. */
        if (!masteryEdgeBuyable(spec, alloc, eid)) {
          showToast('Verrouillé — ' + MASTERY_LOCKED_TIP + ' (une extrémité du segment doit être un node investi).');
          render();
          break;
        }
        const maxPts = (DB.masterySystem || {}).points_max || 26;
        if (masteryPointsSpent(alloc) + 1 > maxPts) { showToast(`Budget ${maxPts} points reached — free some first.`); break; }
        alloc.edges.push(eid);
      }
      render();
      break;
    }
    case 'reset-mastery': {
      if (state.masteryAlloc) delete state.masteryAlloc[masterySpecKey()];
      selectedMasteryNode = null;
      render();
      break;
    }
    case 'pick-enhanced': openEnhancedPicker(i()); break;
    case 'clear-enhanced': {
      const tag = 't3perk:w' + i();
      const withNode = state.customEffects.filter(e => e.source === tag && e.nodeId);
      const target = withNode[Number(el.dataset.fxIndex)];
      if (target) { state.customEffects.splice(state.customEffects.indexOf(target), 1); render(); }
      break;
    }
    /* ── V4 : steppers bornés + échappatoire custom ── */
    case 'step-main-roll': {
      const a = state.artifacts[i()];
      if (!a || !a.mainStat) break;
      const item = DB.artifactsByKey.get(a.key);
      const b = bandFor(item, a, a.mainStat, true);
      if (!b) break;
      /* V6 : pas fractionnaire (lifesteal…) porté par data-step ; snap
         anti-bruit flottant (0.008+0.001 → 0.009, pas 0.009000000000001). */
      const step = Number(el.dataset.step) > 0 ? Number(el.dataset.step) : 1;
      const cur = Number.isFinite(a.mainStatRoll) ? clampToBand(a.mainStatRoll, b) : b[1];
      a.mainStatRoll = snapRollValue(clampToBand(cur + Number(el.dataset.dir) * step, b));
      render();
      break;
    }
    case 'step-secondary-roll': {
      const a = state.artifacts[i()];
      if (!a) break;
      const si = Number(el.dataset.secIndex);
      const item = DB.artifactsByKey.get(a.key);
      const b = item ? bandFor(item, a, a.secondary[si], false) : null;
      if (!b) break;
      const step = Number(el.dataset.step) > 0 ? Number(el.dataset.step) : 1; // V6 : pas fractionnaire
      const cur = Number.isFinite(a.secondaryRolls[si]) ? clampToBand(a.secondaryRolls[si], b) : b[1];
      a.secondaryRolls[si] = snapRollValue(clampToBand(cur + Number(el.dataset.dir) * step, b));
      render();
      break;
    }
    /* V4.2 : étoiles en saisie directe pour une secondaire sans bande —
       reclique la même valeur = efface (undo) ; le roll manuel garde
       toujours la priorité côté moteur (stocké quand même, juste ignoré). */
    case 'set-secondary-stars': {
      const a = state.artifacts[i()];
      if (!a) break;
      if (!Array.isArray(a.secondaryStars)) a.secondaryStars = [];
      const si = Number(el.dataset.secIndex);
      const v = Number(el.dataset.stars);
      a.secondaryStars[si] = a.secondaryStars[si] === v ? null : v;
      render();
      break;
    }
    case 'toggle-main-exact': {
      const a = state.artifacts[i()];
      if (!a) break;
      const k = rollKey(i(), null);
      if (customRollFlags.has(k) || isCustomRoll(i(), null, a.mainStatRoll, DB.artifactsByKey.get(a.key) && bandFor(DB.artifactsByKey.get(a.key), a, a.mainStat, true))) {
        customRollFlags.delete(k);
        reclampArtifactRolls(i()); // retour en mode borné = valeur ramenée dans la bande
      } else {
        customRollFlags.add(k);
      }
      render();
      break;
    }
    case 'toggle-exact': {
      const a = state.artifacts[i()];
      if (!a) break;
      const si = Number(el.dataset.secIndex);
      const k = rollKey(i(), si);
      const item = DB.artifactsByKey.get(a.key);
      if (customRollFlags.has(k) || isCustomRoll(i(), si, a.secondaryRolls[si], item && bandFor(item, a, a.secondary[si], false))) {
        customRollFlags.delete(k);
        reclampArtifactRolls(i());
      } else {
        customRollFlags.add(k);
      }
      render();
      break;
    }
    case 'toggle-talent-cond': {
      const t = state.talents[Number(el.dataset.talentSlot)];
      if (t) {
        if (!t.conds) t.conds = {};
        const row = Number(el.dataset.row);
        t.conds[row] = t.conds[row] === false; // OFF -> ON, sinon -> OFF
        render();
      }
      break;
    }
  }
});
let loadSaveTimer = null;
/* Double-clic sur un nom de sauvegarde = renommage (le clic simple de
   chargement est différé puis annulé ici). */
document.body.addEventListener('dblclick', e => {
  const el = e.target.closest('[data-action="load-save"]');
  if (!el) return;
  clearTimeout(loadSaveTimer);
  const s = getSaveById(el.dataset.id);
  if (!s) return;
  const nn = prompt('Rename build:', s.name);
  if (nn && nn.trim()) { renameSavedBuild(s.id, nn); renderSavesPanel(); showToast('Save renamed.'); }
});
/* Les <span role="button"> imbriqués dans de vrais <button> (seul HTML
   valide) doivent rester activables au clavier. */
document.body.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest ? e.target.closest('span[role="button"][data-action]') : null;
  if (el) { e.preventDefault(); e.stopPropagation(); el.click(); }
});
document.addEventListener('click', e => {
  // Ferme le panneau des sauvegardes et le popover de cible au clic extérieur.
  if (!e.target.closest('#saves-panel') && !e.target.closest('[data-action="toggle-saves"]')) {
    $('#saves-panel')?.classList.remove('open');
  }
  if (!e.target.closest('#target-pop') && !e.target.closest('[data-action="toggle-target-pop"]')) {
    $('#target-pop')?.classList.remove('open');
  }
});

let levelRenderTimer = null;
document.body.addEventListener('input', e => {
  if (e.target.id === 'build-name') { state.name = e.target.value; return; }
  if (e.target.id === 'level-slider') {
    /* Lecture immédiate, re-rendu (avec recalcul moteur) débouncé. */
    state.level = Number(e.target.value);
    $('#level-readout').textContent = 'LV ' + String(state.level).padStart(2, '0');
    clearTimeout(levelRenderTimer);
    levelRenderTimer = setTimeout(render, 120);
    return;
  }
  if (e.target.id === 'drawer-search') { renderDrawerList(); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  /* Inputs numériques du moteur : mise à jour du state + recalcul, SANS
     re-rendre la section qui contient l'input (focus/curseur préservés). */
  const numVal = () => { const v = parseFloat(el.value); return Number.isFinite(v) ? v : null; };
  switch (el.dataset.action) {
    case 'change-talent-note': {
      const idx = Number(el.dataset.talentSlot), row = Number(el.dataset.row);
      state.talents[idx].notes[row] = el.value; // pas de render() : préserve le focus/curseur
      break;
    }
    case 'change-base-stat': {
      const id = el.dataset.stat, v = numVal();
      if (v === null) delete state.baseOverrides[id]; else state.baseOverrides[id] = v;
      computeAndRefresh();
      break;
    }
    case 'change-main-roll': {
      const a = state.artifacts[Number(el.dataset.slotIndex)];
      if (a) { a.mainStatRoll = numVal(); computeAndRefresh(); }
      break;
    }
    case 'change-secondary-roll': {
      const a = state.artifacts[Number(el.dataset.slotIndex)];
      if (a) {
        if (!Array.isArray(a.secondaryRolls)) a.secondaryRolls = [];
        a.secondaryRolls[Number(el.dataset.secIndex)] = numVal();
        computeAndRefresh();
      }
      break;
    }
    case 'change-target': {
      const f = el.dataset.field, v = numVal();
      state.target[f] = v === null ? null
        : (f === 'level' ? Math.max(1, Math.min(40, Math.round(v))) : Math.max(0, v));
      state.target.preset = null; // saisie manuelle = plus un preset
      computeAndRefresh();
      break;
    }
    case 'change-ability-ov': {
      const slot = el.dataset.slot, f = el.dataset.field;
      const o = state.abilityOverrides[slot] || (state.abilityOverrides[slot] = {});
      if (f === 'scaling_stat') { if (el.value) o.scaling_stat = el.value; else delete o.scaling_stat; }
      else { const v = numVal(); if (v === null) delete o[f]; else o[f] = Math.max(0, v); }
      if (!Object.keys(o).length) delete state.abilityOverrides[slot];
      computeAndRefresh();
      break;
    }
    case 'change-fx': {
      const row = el.closest('.fx-row');
      if (!row) break;
      const fx = fxGetOrCreate(row.dataset.fxSource, Number(row.dataset.fxIndex), row.dataset.fxPreset || null);
      const f = el.dataset.field;
      if (f === 'stat') {
        fx.stat = el.value || null;
        const derived = statUnit(fx.stat);      // V4.1 : l'unité suit la stat
        if (derived) fx.unit = derived;
        /* V4.2 fix : le contrôle d'unité VISIBLE (suffixe pts/% vs toggle
           %/flat) dépend de la stat choisie — computeAndRefresh() seul ne
           repeint jamais le DOM des cartes de gear, donc le toggle périmé
           restait à l'écran (et cliquable) jusqu'au prochain re-rendu
           complet. Changer de stat dans un <select> a déjà "consommé" le
           focus utile : le render() complet est ici sans coût UX. */
        render();
        break;
      }
      if (f === 'value') fx.value = numVal();
      else if (f === 'uptime') { const v = numVal(); fx.uptime = v === null ? null : Math.max(0, Math.min(1, v / 100)); }
      computeAndRefresh();
      break;
    }
    case 'change-spell-uptime': {
      const hand = el.dataset.hand, v = numVal();
      if (!state.spellUptimes) state.spellUptimes = { d: 1, f: 1 };
      state.spellUptimes[hand] = v === null ? 1 : Math.max(0, Math.min(1, v / 100));
      const lab = $(`[data-upt-label="${hand}"]`);
      if (lab) lab.textContent = Math.round(state.spellUptimes[hand] * 100) + '%';
      computeAndRefresh();
      break;
    }
    case 'change-wm-points': {
      const v = numVal();
      state.weaponMastery.points = v === null ? 0 : Math.max(0, Math.min(26, Math.round(v)));
      break; // affichage seul — aucun recalcul nécessaire
    }
    case 'change-wm-notes': state.weaponMastery.notes = el.value.slice(0, 200); break;
  }
});

document.body.addEventListener('change', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'change-main-stat': state.artifacts[Number(el.dataset.slotIndex)].mainStat = el.value || null; render(); break;
    case 'change-secondary-stat': {
      const si = Number(el.dataset.slotIndex), sj = Number(el.dataset.secIndex);
      state.artifacts[si].secondary[sj] = el.value || null; render(); break;
    }
    case 'change-talent-tree': changeTalentTree(Number(el.dataset.talentSlot), el.value); break;
    case 'import-file': handleImportFile(el.files[0]); break;
    /* V4 : clamp de fin de saisie (blur) — pendant la frappe la valeur
       reste libre, à la validation elle rentre dans la bande sauf mode
       custom explicite. */
    case 'change-main-roll': {
      const a = state.artifacts[Number(el.dataset.slotIndex)];
      if (a && Number.isFinite(a.mainStatRoll) && !customRollFlags.has(rollKey(Number(el.dataset.slotIndex), null))) {
        const item = DB.artifactsByKey.get(a.key);
        const b = item ? bandFor(item, a, a.mainStat, true) : null;
        if (b) a.mainStatRoll = clampToBand(a.mainStatRoll, b);
      }
      render();
      break;
    }
    case 'change-secondary-roll': {
      const idx2 = Number(el.dataset.slotIndex), si2 = Number(el.dataset.secIndex);
      const a = state.artifacts[idx2];
      if (a && Number.isFinite(a.secondaryRolls[si2]) && !customRollFlags.has(rollKey(idx2, si2))) {
        const item = DB.artifactsByKey.get(a.key);
        const b = item ? bandFor(item, a, a.secondary[si2], false) : null;
        if (b) a.secondaryRolls[si2] = clampToBand(a.secondaryRolls[si2], b);
      }
      render();
      break;
    }
  }
});

/* ══════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════ */
async function init() {
  await loadData();
  buildPresets();
  const hash = location.hash.replace(/^#/, '');
  const loadedFromHash = hash ? decodeHash(hash) : null;
  state = loadedFromHash || makeDefaultState();
  const degraded = ensureConsistentState(state);
  normalizeAllSlots();
  refreshHeaderInputs();
  render();
  renderOnboarding();
  const stamp = $('#build-stamp');
  if (stamp) stamp.textContent = 'data ' + String(DB.meta.built || '').slice(0, 10);
  $('#loading-veil')?.remove();
  if (degraded) showToast('Loaded with defaults — some shared fields no longer exist.');
}
init().catch(err => {
  console.error(err);
  document.body.innerHTML = '<p style="color:#e0645c;padding:2rem;font-family:monospace">Failed to load builder data — see console.</p>';
});
