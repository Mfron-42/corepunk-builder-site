/* ── Corepunk Builder — moteur de calcul (character sheet + DPS) — v5 ──
   Module PUR : zéro accès DOM, zéro fetch, zéro mutation d'un état
   partagé. Fonctionne à l'identique dans le navigateur (attaché à
   `window.Engine`) et sous Node (`module.exports`) pour que
   tests/engine.test.js tourne en `node tests/engine.test.js` sans
   framework. Contrats : SPEC/COMBAT_MODEL.md §2 (v1, figé) + V2/V3/V4
   (audits, maîtrise, bandes de rolls) + SPEC/V5_ENGINE_ARCHITECTURE.md.

   ARCHITECTURE v5 — CONTRIBUTEURS : chaque entité de jeu présente dans le
   build (base de héros, arme, stat principale/secondaire d'artefact,
   chip, rune, passif d'objet, choix/bonus de talent, node/arête de
   maîtrise, sort universel, corruption, effet manuel, perk T3, cible)
   devient un objet CONTRIBUTOR qui possède sa tranche de données et ses
   règles : apply(ctx) + report(). compute() n'est plus qu'un pli phasé
   de la structure de personnage à travers tous les contributeurs :
     (1) ratings     — collecte des points de stats / mods / ajustements
     (2) conversion  — fiche (DR, rating→%), au niveau structure
     (3) derived     — cible/mitigation, crit, CDR
     (4) offense     — attaque de base, rotation, actives, HPS
     (5) audit       — assemblage result.audit (chaque entité équipée/
                       sélectionnée produit EXACTEMENT une entrée,
                       appliquée ou inerte avec une raison SPÉCIFIQUE —
                       plus rien ne peut être ignoré en silence).
   API publique inchangée numériquement (les 67 tests v4 passent tels
   quels) + result.audit et Engine.explain() (additifs).

   Règle d'or ("honesty rule") : toute donnée manquante retombe sur un
   défaut documenté et ajouté à `assumptions`; aucun calcul ne doit
   jamais produire NaN/Infinity — un `build` vide, une clé inconnue ou un
   `data.combat` totalement absent doivent toujours donner un résultat
   fini. */
(function (root, factory) {
  var Engine = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Engine;
  }
  if (root) {
    root.Engine = Engine;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════
     CONSTANTES — tous les défauts "assumption" du modèle, centralisés.
     ══════════════════════════════════════════════════════════════════ */
  var DEFAULT_MITIGATION_K_BASE = 100;
  var DEFAULT_MITIGATION_K_PER_LEVEL = 0.05;
  var DEFAULT_DR_POST_EFFICIENCY = 0.5;
  var DEFAULT_CRIT_POWER_BASE = 1.5;          // 150% dégâts crit de base — écrasé par combat.crit_base_power
  var DEFAULT_AP_TO_DAMAGE_COEFF = 1;         // 1 point d'Attack Power (ou Spell Power en basic magique) = +1 dégât brut par coup
  var DEFAULT_BASELINE_ATTACKS_PER_S = 1.0;   // cadence plancher quand aucune vitesse d'arme n'est connue
  var DEFAULT_ABILITY_COOLDOWN_S = 8;         // cadence par défaut si cooldown_s inconnu
  var DEFAULT_SPELL_COOLDOWN_S = 180;         // cooldown par défaut des sorts universels
  var RARITIES_FALLBACK = ['common', 'uncommon', 'rare', 'epic'];
  var UPGRADE_STATES_FALLBACK = ['normal', 'upgraded', 'overclocked'];

  var CORE_STAT_IDS = [
    'attack_power', 'weapon_damage', 'spell_power', 'health', 'armor', 'magic_resistance', 'mana',
    'attack_speed', 'physical_crit_chance', 'physical_crit_power', 'magical_crit_chance', 'magical_crit_power',
    'physical_penetration', 'magical_penetration', 'cooldown_reduction',
  ];

  /* Alias de talents : cibles génériques appliquées aux deux variantes
     physique/magique ; "aggro" alimente le multiplicateur dérivé ; le
     reste d'inconnu (ex. "damage") devient un multiplicateur global. */
  var TALENT_STAT_ALIASES = {
    crit_power: ['physical_crit_power', 'magical_crit_power'],
    crit_chance: ['physical_crit_chance', 'magical_crit_chance'],
    penetration: ['physical_penetration', 'magical_penetration'],
  };

  var ROTATION_SLOTS = ['Q', 'W', 'E', 'R']; // Passive/T exclus : jamais "castés" au sens rotation

  /* ══════════════════════════════════════════════════════════════════
     UTILITAIRES génériques
     ══════════════════════════════════════════════════════════════════ */
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function num(v, fallback) { return isNum(v) ? v : fallback; }
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }
  function pushUnique(list, msg) { if (msg && list.indexOf(msg) === -1) list.push(msg); }
  function trimText(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '…' : t; }

  /* ══════════════════════════════════════════════════════════════════
     CONTRIBUTEURS — mini-infrastructure. Un contributeur = UNE entité de
     jeu de ce build. Il accumule ses contributions (appliquées) ou sa
     raison d'inertie (spécifique, jamais un "n/a" générique), et expose
     des hooks par phase (runRatings/runDerived/runOffense).
     ══════════════════════════════════════════════════════════════════ */
  function makeContributor(id, kind, label, phase) {
    return {
      id: id, kind: kind, label: label, phase: phase,
      applied: false, contributions: [], inert_reason: null,
      runRatings: null, runDerived: null, runOffense: null,
      hiddenFromAudit: false,
      /* Contribution effective (marque le contributeur appliqué). */
      contribute: function (target, value, note) {
        this.applied = true;
        this.contributions.push({ target: target, value: isNum(value) ? value : null, note: note || null });
      },
      /* Information visible SANS marquer appliqué (valeurs info-only). */
      info: function (target, value, note) {
        this.contributions.push({ target: target, value: isNum(value) ? value : null, note: note || null });
      },
      inert: function (reason) {
        if (!this.applied && !this.inert_reason) this.inert_reason = reason;
      },
      report: function () {
        return {
          id: this.id, kind: this.kind, label: this.label, phase: this.phase,
          applied: this.applied,
          contributions: this.contributions,
          inert_reason: this.applied ? null : (this.inert_reason || 'no effect recorded'),
        };
      },
    };
  }

  /* Lignes de stats accumulées en phase ratings — la fiche (phase 2) leur
     applique la sémantique d'unité exacte du modèle v4 :
       - stat principale : flat s'ajoute, % multiplie le total ;
       - stat secondaire : flat s'ajoute (points de DR), % = points de
         pourcentage APRÈS conversion rating→% ;
       - kind dérivé (aggro…) : tout s'accumule tel quel en points. */
  function addStatRow(ctx, statId, value, unit, label, stars) {
    (ctx.statRows[statId] = ctx.statRows[statId] || []).push({ value: value, unit: unit, label: label, stars: stars });
  }

  /* Routage d'un mod vers la fiche / l'aggro / le multiplicateur global.
     Retourne la liste des contributions (pour l'audit) ou null si la
     cible est inconnue (l'appelant décide warning/inertie). */
  function routeMod(ctx, statTarget, value, unit, label, fromTalent) {
    if (statTarget === 'aggro') {
      ctx.aggroPoints += value;
      ctx.aggroAny = true;
      if (ctx.statsById.aggro) addStatRow(ctx, 'aggro', value, unit, label);
      return [{ target: 'aggro', value: value, note: unit === '%' ? '+' + value + '%' : null }];
    }
    if (ctx.statsById[statTarget]) {
      addStatRow(ctx, statTarget, value, unit, label);
      return [{ target: statTarget, value: value, note: unit === '%' ? '+' + value + '%' : null }];
    }
    if (TALENT_STAT_ALIASES[statTarget]) {
      var out = [];
      TALENT_STAT_ALIASES[statTarget].forEach(function (aliasId) {
        if (!ctx.statsById[aliasId]) return;
        addStatRow(ctx, aliasId, value, unit, label + ' (alias "' + statTarget + '")');
        out.push({ target: aliasId, value: value, note: 'alias "' + statTarget + '"' });
      });
      pushUnique(ctx.assumptions, "Talent stat target '" + statTarget + "' has no direct match in data.stats — applied to both its physical and magical variants (alias table).");
      return out;
    }
    if (fromTalent) {
      ctx.globalMods.push({ value: value, unit: unit, label: label, stat: statTarget });
      return [{ target: 'total_dps_multiplier', value: value, note: "unmapped stat '" + statTarget + "' treated as a global damage multiplier" }];
    }
    return null; // cible inconnue hors talents : l'appelant gère
  }

  /* ══════════════════════════════════════════════════════════════════
     RÉSOLUTION DE STRUCTURE — armes / artefacts / runes (validation des
     entrées du build contre la donnée ; les warnings de clés inconnues
     vivent ici, en amont des contributeurs).
     ══════════════════════════════════════════════════════════════════ */
  function deriveWeaponSlots(mastery) {
    if (!mastery) return [];
    var types = mastery.weapon_types || [];
    if (mastery.use_type === 'MainOff') {
      var t0 = types[0] || 'Weapon';
      var t1 = types.length >= 2 ? types[1] : t0;
      return [{ slotKey: 'main', weaponType: t0 }, { slotKey: 'off', weaponType: t1 }];
    }
    return [{ slotKey: 'weapon', weaponType: types[0] || 'Weapon' }];
  }

  function resolveWeaponSlot(entry, slotDef, data, ctx) {
    if (!entry || !entry.key) return null;
    var tier, weaponType, isGeneric = false;
    var rec = null;
    if (String(entry.key).indexOf('generic::') === 0) {
      isGeneric = true;
      weaponType = slotDef.weaponType;
      tier = ['T1', 'T2', 'T3'].indexOf(entry.tier) !== -1 ? entry.tier : 'T1';
    } else {
      rec = (data.weapons || []).filter(function (w) { return w.key === entry.key; })[0] || null;
      if (!rec) { ctx.warn("Unknown weapon key '" + entry.key + "' — slot treated as empty."); return null; }
      tier = rec.tier;
      weaponType = rec.weapon_type;
    }
    var rarityIds = (data.mechanics && data.mechanics.rarities) ? data.mechanics.rarities.map(function (r) { return r.id; }) : RARITIES_FALLBACK;
    var rarity = rarityIds.indexOf(entry.rarity) !== -1 ? entry.rarity : 'common';
    if (entry.rarity && rarity !== entry.rarity) ctx.warn("Unknown rarity '" + entry.rarity + "' on weapon '" + entry.key + "' — defaulted to common.");
    var upgStates = (data.mechanics && data.mechanics.upgrade_states) || UPGRADE_STATES_FALLBACK;
    var upgrade = upgStates.indexOf(entry.state) !== -1 ? entry.state : 'normal';
    if (entry.state && upgrade !== entry.state) ctx.warn("Unknown upgrade state '" + entry.state + "' on weapon '" + entry.key + "' — defaulted to normal.");
    var chips = (Array.isArray(entry.chips) ? entry.chips : []).filter(function (k) {
      if (!k) return false;
      var known = (data.chips || []).some(function (c) { return c.key === k; });
      if (!known) ctx.warn("Unknown chip key '" + k + "' — ignored.");
      return known;
    });
    /* v4 : la note "contribue 0" ne reste que pour les chips sans bandes. */
    var anyChipWithoutBands = chips.some(function (k) {
      var c = (data.chips || []).filter(function (x) { return x.key === k; })[0];
      return !(c && c.stat_bands);
    });
    if (anyChipWithoutBands) pushUnique(ctx.assumptions, 'Some equipped chips have no numeric stat bands — those contribute 0 to the sheet (use customEffects for assumed chip effects).');
    /* v4 : rolls d'arme optionnels, assainis ici, bornés à la résolution. */
    var rolls = {};
    if (entry.rolls && typeof entry.rolls === 'object') {
      Object.keys(entry.rolls).forEach(function (statId) {
        var v = sanitizeRoll(entry.rolls[statId], "'" + statId + "' on weapon '" + entry.key + "'", ctx);
        if (isNum(v)) rolls[statId] = v;
      });
    }
    return { key: entry.key, tier: tier, weaponType: weaponType, isGeneric: isGeneric, rarity: rarity, upgrade: upgrade, chips: chips, rolls: rolls, rec: rec };
  }

  function sanitizeRoll(v, what, ctx) {
    if (!isNum(v)) return undefined;
    if (v < 0) { ctx.warn('Negative roll ' + v + ' for ' + what + ' — clamped to 0.'); return 0; }
    return v;
  }

  function sanitizeStars(v) {
    if (!isNum(v)) return undefined;
    var s = Math.round(v);
    return (s >= 1 && s <= 5) ? s : undefined;
  }

  function resolveArtifactSlot(entry, data, statsDef, ctx) {
    if (!entry || !entry.key) return null;
    var rec = (data.artifacts || []).filter(function (a) { return a.key === entry.key; })[0];
    if (!rec) { ctx.warn("Unknown artifact key '" + entry.key + "' — slot treated as empty."); return null; }
    var rarityIds = (data.mechanics && data.mechanics.rarities) ? data.mechanics.rarities.map(function (r) { return r.id; }) : RARITIES_FALLBACK;
    var rarity = rarityIds.indexOf(entry.rarity) !== -1 ? entry.rarity : 'common';
    if (entry.rarity && rarity !== entry.rarity) ctx.warn("Unknown rarity '" + entry.rarity + "' on artifact '" + entry.key + "' — defaulted to common.");
    var upgStates = (data.mechanics && data.mechanics.upgrade_states) || UPGRADE_STATES_FALLBACK;
    var upgrade = upgStates.indexOf(entry.state) !== -1 ? entry.state : 'normal';
    if (entry.state && upgrade !== entry.state) ctx.warn("Unknown upgrade state '" + entry.state + "' on artifact '" + entry.key + "' — defaulted to normal.");

    var mainStatIds = (data.mechanics && Array.isArray(data.mechanics.artifact_main_stats))
      ? data.mechanics.artifact_main_stats
      : statsDef.filter(function (s) { return s.kind === 'main'; }).map(function (s) { return s.id; });
    var mainStat = null;
    if (entry.mainStat) {
      if (mainStatIds.indexOf(entry.mainStat) !== -1) mainStat = entry.mainStat;
      else ctx.warn("Unknown main stat '" + entry.mainStat + "' on artifact '" + entry.key + "' — ignored.");
    }

    var secondaryIds = statsDef.filter(function (s) { return s.kind === 'secondary'; }).map(function (s) { return s.id; });
    var secondary = [];
    function pushPick(statId, roll, stars) {
      if (!statId) return;
      if (secondaryIds.indexOf(statId) === -1) { ctx.warn("Unknown secondary stat '" + statId + "' on artifact '" + entry.key + "' — ignored."); return; }
      secondary.push({
        stat: statId,
        overrideRoll: sanitizeRoll(roll, "'" + statId + "' on artifact '" + entry.key + "'", ctx),
        stars: sanitizeStars(stars),
      });
    }
    if (Array.isArray(entry.secondaries)) {
      /* v3/v4 : [{ stat, stars, roll }] — le roll manuel prime. */
      entry.secondaries.forEach(function (p) { if (p && typeof p === 'object') pushPick(p.stat, p.roll, p.stars); });
    } else {
      /* v2 rétro-compatible : secondary[] + secondaryRolls[] parallèle. */
      (Array.isArray(entry.secondary) ? entry.secondary : []).forEach(function (statId, si) {
        var override = Array.isArray(entry.secondaryRolls) ? entry.secondaryRolls[si] : undefined;
        pushPick(statId, override, undefined);
      });
    }

    /* v4/v5 : rune résolue vers son enregistrement data ; la note
       "contribue 0" ne reste que pour les runes sans bandes. */
    var runeRec = null;
    var runeRef = (entry.rune && entry.rune.key) ? entry.rune : null;
    if (runeRef) {
      runeRec = resolveRuneRecord(runeRef, data);
      if (!runeRec || !runeRec.stat_bands) {
        pushUnique(ctx.assumptions, "Equipped runes without numeric stat bands contribute 0 to the sheet (use customEffects for assumed rune effects).");
      }
    }

    return {
      key: entry.key, tier: rec.tier, rarity: rarity, upgrade: upgrade, mainStat: mainStat,
      mainStatOverrideRoll: sanitizeRoll(entry.mainStatRoll, "main stat on artifact '" + entry.key + "'", ctx),
      mainStars: sanitizeStars(entry.mainStars),
      secondary: secondary,
      rec: rec,
      runeRef: runeRef,
      runeRec: runeRec,
    };
  }

  /* Accepte la clé data brute ET l'identifiant de groupe UI "Famille::Nom". */
  function resolveRuneRecord(runeRef, data) {
    if (!runeRef || !runeRef.key) return null;
    var runes = Array.isArray(data.runes) ? data.runes : [];
    var direct = runes.filter(function (r) { return r.key === runeRef.key; })[0];
    if (direct) return direct;
    var parts = String(runeRef.key).split('::');
    if (parts.length === 2) {
      var matches = runes.filter(function (r) { return r.name === parts[1]; });
      var byVariant = matches.filter(function (r) { return r.variant === (runeRef.variant || 'base'); })[0];
      return byVariant || matches[0] || null;
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════
     COMBAT DATA lookups — tolèrent data.combat totalement absent.
     ══════════════════════════════════════════════════════════════════ */
  function heroBaseRating(statId, heroId, level, data, ctx) {
    /* BUG 2 (audit v2) : le template de base du client porte physical/
       magical_crit_power = 2.0 — c'est la MÊME valeur que le
       multiplicateur de base combat.crit_base_power (200% de dégâts sur
       crit), pas un rating de bonus. La laisser entrer ici la comptait
       en double. crit_base_power reste la seule source du multiplicateur
       de base (ceinture+bretelles avec la donnée qui zère ces champs). */
    if (statId === 'physical_crit_power' || statId === 'magical_crit_power') return 0;
    if (ctx.combatMissing) return 0;
    var base = data.combat.base;
    if (!base) { pushUnique(ctx.assumptions, 'combat.base is missing — hero base stats treated as 0 for every stat.'); return 0; }
    var def = base['default'] || {};
    var ovr = (heroId && base[heroId]) || {};
    var picked = (ovr[statId] && isNum(ovr[statId].value)) ? ovr[statId] : def[statId];
    var level1 = (picked && isNum(picked.value)) ? picked.value : 0;
    if (!picked || !isNum(picked.value)) pushUnique(ctx.assumptions, "No combat.base value for stat '" + statId + "' — treated as 0.");
    var perLevelTable = (ovr.per_level && isNum(ovr.per_level[statId])) ? ovr.per_level : def.per_level;
    var perLevel = (perLevelTable && isNum(perLevelTable[statId])) ? perLevelTable[statId] : 0;
    return level1 + perLevel * Math.max(0, level - 1);
  }

  function statRoll(statId, tier, rarity, overrideVal, data, ctx) {
    if (isNum(overrideVal)) return overrideVal;
    if (ctx.combatMissing) return 0;
    var table = data.combat.stat_rolls;
    if (!table) { pushUnique(ctx.assumptions, 'combat.stat_rolls is missing — every artifact stat pick is treated as 0.'); return 0; }
    var entry = table[statId] && table[statId][tier] && table[statId][tier][rarity];
    if (entry && isNum(entry.value)) return entry.value;
    pushUnique(ctx.assumptions, "No roll value for '" + statId + "' at " + tier + "/" + rarity + " in combat.stat_rolls — treated as 0.");
    return 0;
  }

  /* attack_time null quand inconnu : la chaîne de repli de cadence (arme
     réelle > combat.weapon_base.default > baseline 1.0 att/s) gère. */
  function weaponBaseLookup(weaponType, tier, data, ctx) {
    if (ctx.combatMissing) return { damage: 0, attack_time: null };
    var wb = data.combat.weapon_base;
    if (!wb) {
      pushUnique(ctx.assumptions, 'combat.weapon_base is missing — weapon damage treated as 0.');
      return { damage: 0, attack_time: null };
    }
    var entry = wb[weaponType] && wb[weaponType][tier];
    var damage;
    if (entry && isNum(entry.damage)) { damage = entry.damage; }
    else { pushUnique(ctx.assumptions, 'No weapon_base damage for ' + weaponType + '/' + tier + ' — treated as 0.'); damage = 0; }
    var attackTime = (entry && isNum(entry.attack_time) && entry.attack_time > 0) ? entry.attack_time : null;
    return { damage: damage, attack_time: attackTime };
  }

  function applyDR(rating, threshold, postEfficiency) {
    if (rating <= threshold) return rating;
    return threshold + (rating - threshold) * postEfficiency;
  }

  /* ══════════════════════════════════════════════════════════════════
     CONVERSION rating → % (BUG 1, audit v2). Précédence :
       combat.rating_conversions[stat].pct_per_rating (sourcé) >
       dérivation linéaire depuis dr_model.sourced_threshold_points
       (ancrages "SUSPICIOUS" exclus) > défaut 1 rating = 1% + assumption.
     ══════════════════════════════════════════════════════════════════ */
  function conversionForStat(statId, data, ctx) {
    if (ctx.convCache[statId]) return ctx.convCache[statId];
    var out = null;
    var rc = data.combat && data.combat.rating_conversions;
    var entry = rc ? rc[statId] : undefined;
    if (entry != null) {
      var ppr = isNum(entry) ? entry : (isNum(entry.pct_per_rating) ? entry.pct_per_rating : null);
      if (isNum(ppr) && ppr > 0) out = { pctPerRating: ppr, mode: 'data' };
    }
    if (!out) {
      var pts = data.combat && data.combat.dr_model && data.combat.dr_model.sourced_threshold_points;
      var pt = pts ? pts[statId] : undefined;
      var suspicious = pt && typeof pt.note === 'string' && /suspicious/i.test(pt.note);
      if (pt && !suspicious && isNum(pt.rating) && pt.rating > 0 && isNum(pt.effective_pct) && pt.effective_pct > 0) {
        out = { pctPerRating: pt.effective_pct / pt.rating, mode: 'derived' };
        pushUnique(ctx.assumptions, "rating→% for '" + statId + "' derived linearly from the sourced DR anchor (" + pt.rating + ' rating → ' + pt.effective_pct + '%): ' + (Math.round(out.pctPerRating * 10000) / 10000) + ' %/rating — the linear shape is an assumption.');
      } else if (suspicious) {
        pushUnique(ctx.assumptions, "Sourced DR anchor for '" + statId + "' is flagged suspicious in the data — not used for rating→% conversion.");
      }
    }
    if (!out) {
      out = { pctPerRating: 1, mode: 'default' };
      pushUnique(ctx.assumptions, 'No rating→% conversion available for one or more secondary stats — treated as 1 rating point = 1 percent by default (÷100).');
    }
    ctx.convCache[statId] = out;
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     MITIGATION — K sourcé (explicite > dérivé d'ancrage > recalcul
     d'ancrage brut > défaut moteur) ; pénétration PLATE soustraite AVANT
     la pénétration en % (v3, ordre documenté).
     ══════════════════════════════════════════════════════════════════ */
  function defaultMitigationK(level) {
    return DEFAULT_MITIGATION_K_BASE * (1 + DEFAULT_MITIGATION_K_PER_LEVEL * level);
  }

  function anchorFromModel(mm, defKind) {
    var re = new RegExp('^' + defKind + '_at_([0-9]+(?:\\.[0-9]+)?)_reduction_pct$');
    var keys = Object.keys(mm);
    for (var i = 0; i < keys.length; i++) {
      var m = re.exec(keys[i]);
      if (!m) continue;
      var rating = Number(m[1]);
      var pct = mm[keys[i]];
      if (isNum(rating) && rating > 0 && isNum(pct) && pct > 0 && pct < 100) return { rating: rating, pct: pct };
    }
    return null;
  }

  function resolveMitigationK(defKind, level, data, ctx) {
    var mm = data.combat && data.combat.mitigation_model;
    if (mm && typeof mm === 'object') {
      var src = mm.source ? ' (source: ' + mm.source + ')' : '';
      if (isNum(mm.k)) {
        pushUnique(ctx.assumptions, 'Mitigation K = ' + mm.k + ' — explicit sourced constant from data.combat.mitigation_model' + src + '; formula defense/(defense+K).');
        return mm.k;
      }
      var anchor = anchorFromModel(mm, defKind);
      if (isNum(mm.derived_k_if_standard_formula)) {
        var anchorTxt = anchor ? ' (anchor: ' + anchor.rating + ' rating → ' + anchor.pct + '% reduction)' : '';
        pushUnique(ctx.assumptions, 'Mitigation K = ' + mm.derived_k_if_standard_formula + ' — calibrated from a sourced anchor point in data.combat.mitigation_model' + anchorTxt + src + '; the defense/(defense+K) formula shape itself is still an assumption.');
        return mm.derived_k_if_standard_formula;
      }
      if (anchor) {
        var k = anchor.rating * (100 / anchor.pct - 1);
        pushUnique(ctx.assumptions, 'Mitigation K = ' + (Math.round(k * 100) / 100) + ' — derived by the engine from the sourced anchor ' + anchor.rating + ' rating → ' + anchor.pct + '% reduction in data.combat.mitigation_model' + src + '; the defense/(defense+K) formula shape itself is still an assumption.');
        return k;
      }
    }
    pushUnique(ctx.assumptions, 'Mitigation formula: defense/(defense+K), K = ' + DEFAULT_MITIGATION_K_BASE + '×(1+' + DEFAULT_MITIGATION_K_PER_LEVEL + '×level) — engine built-in default (no sourced mitigation constant found in data.combat).');
    return defaultMitigationK(level);
  }

  function mitigationPct(defenseValue, penetrationPct, K, flatPenetration) {
    var afterFlat = Math.max(0, Math.max(0, defenseValue) - Math.max(0, flatPenetration || 0));
    var effectiveDefense = afterFlat * (1 - clamp01(penetrationPct || 0));
    return effectiveDefense / (effectiveDefense + Math.max(1e-9, K));
  }

  /* ══════════════════════════════════════════════════════════════════
     BANDES DE ROLLS RÉELLES (v4) + dérivation d'étoiles.
     ══════════════════════════════════════════════════════════════════ */
  var PLANNER_DEFAULT_ROLL_NOTE = 'Unset rolls default to the best band value (band max; band min for attack_time) — planner convention.';

  function bandFromTables(bands, rarity, sections, statId) {
    var rb = bands && bands[rarity];
    if (!rb || typeof rb !== 'object') return null;
    for (var i = 0; i < sections.length; i++) {
      var table = sections[i] === null ? rb : rb[sections[i]];
      var b = table && table[statId];
      if (Array.isArray(b) && isNum(b[0]) && isNum(b[1]) && b[1] >= b[0]) return b;
    }
    return null;
  }

  function starsFromBand(value, band) {
    if (!band || !isNum(value) || !isNum(band[0]) || !isNum(band[1])) return null;
    /* v6 : garde de span POSITIF (et non plus max(1,·)) pour que les
       bandes fractionnaires (lifesteal 0.008–0.012) dérivent leurs
       étoiles ; bande fixe (span 0) → 1★ comme avant. */
    var span = band[1] - band[0];
    if (!(span > 0)) span = 1;
    /* Bruit flottant aux seuils fractionnaires : 0.011 sur [0.008,0.012]
       donne un quotient de 2.999…96 au lieu de 3 → 3★ au lieu de 4★.
       Quotient arrondi à 1e-9 avant le floor pour que les valeurs-seuils
       exactes tombent du bon côté — aligné sur la normalisation entière
       que fait l'UI avant d'appeler Engine.deriveStars. */
    var q = Math.round(4 * (value - band[0]) / span * 1e9) / 1e9;
    return Math.max(1, Math.min(5, 1 + Math.floor(q)));
  }

  function starModelStatus(data) {
    return (data.mechanics && data.mechanics.star_model && data.mechanics.star_model.status)
      ? data.mechanics.star_model.status
      : 'quintile mapping is an engine assumption (no star model in data)';
  }

  /* ── v6 : bandes secondaires génériques client-exactes ──
     combat.secondary_bands[stat][tier][rarity] = [min,max], avec un
     rounding_step par stat (pas de quantisation quand 0/absent) et un
     _unit_note listant les stats dont les rolls sont des FRACTIONS. */
  function secondaryBandFor(statId, tier, rarity, data) {
    var sb = data.combat && data.combat.secondary_bands;
    var ent = sb ? sb[statId] : undefined;
    var b = ent && ent[tier] && ent[tier][rarity];
    if (Array.isArray(b) && isNum(b[0]) && isNum(b[1]) && b[1] >= b[0]) return b;
    return null;
  }

  function secondaryRoundingStep(statId, data) {
    var sb = data.combat && data.combat.secondary_bands;
    var ent = sb ? sb[statId] : undefined;
    return (ent && isNum(ent.rounding_step) && ent.rounding_step > 0) ? ent.rounding_step : null;
  }

  /* Stat à rolls fractionnaires (lifesteal/ability_steal) — détection
     par le _unit_note de la donnée, jamais par une liste en dur. */
  function fractionRollStat(statId, data) {
    var sb = data.combat && data.combat.secondary_bands;
    return !!(sb && typeof sb._unit_note === 'string' && sb._unit_note.indexOf(statId) !== -1);
  }

  var FRACTION_ROLL_NOTE = 'Lifesteal/Ability Steal client rolls are FRACTIONS (e.g. 0.012 = 1.2%) — applied as direct percentage points, bypassing the rating→% conversion (per the data _unit_note).';

  /* Quantisation d'un roll sur le pas de la stat (re-borné dans la bande). */
  function snapToStep(value, band, step) {
    if (!isNum(step) || step <= 0) return value;
    var snapped = band[0] + Math.round((value - band[0]) / step) * step;
    return Math.min(band[1], Math.max(band[0], snapped));
  }

  function resolveBandedRoll(statId, itemKey, rarity, band, roll, stars, lowIsBest, ctx, data, step) {
    var value;
    if (isNum(roll)) {
      value = Math.min(band[1], Math.max(band[0], roll));
      if (value !== roll) ctx.warn('Roll ' + roll + " for '" + statId + "' on '" + itemKey + "' is outside the " + rarity + ' band [' + band[0] + '-' + band[1] + '] — clamped to ' + value + '.');
      value = snapToStep(value, band, step); // v6 : pas de roll hors quantisation
    } else if (isNum(stars)) {
      value = snapToStep(band[0] + (stars - 1) / 4 * (band[1] - band[0]), band, step);
      pushUnique(ctx.assumptions, 'Star ratings map to quintiles of the stat band (star N = min + (N−1)/4×(max−min)) — ' + starModelStatus(data));
    } else {
      value = lowIsBest ? band[0] : band[1];
      pushUnique(ctx.assumptions, PLANNER_DEFAULT_ROLL_NOTE);
    }
    return { value: value, stars: starsFromBand(value, band), band: band };
  }

  /* Chaîne héritée v3 (pas de bande) : roll brut > étoiles sur plage
     stat_rolls > valeur médiane stat_rolls > 0. */
  function resolveStatValue(statId, artifact, data, ctx, roll, stars) {
    if (isNum(roll)) return roll;
    if (isNum(stars)) {
      var range = null;
      var ar = artifact.rec && artifact.rec.ranges && artifact.rec.ranges[statId];
      if (ar && isNum(ar.min) && isNum(ar.max) && ar.max >= ar.min) range = [ar.min, ar.max];
      if (!range && !ctx.combatMissing && data.combat.stat_rolls) {
        var t = data.combat.stat_rolls[statId];
        var e = t && t[artifact.tier] && t[artifact.tier][artifact.rarity];
        if (e && Array.isArray(e.range) && isNum(e.range[0]) && isNum(e.range[1]) && e.range[1] >= e.range[0]) range = [e.range[0], e.range[1]];
      }
      if (range) {
        pushUnique(ctx.assumptions, 'Star ratings map to quintiles of the stat range (star N = min + (N−1)/4×(max−min)) — ' + starModelStatus(data));
        return range[0] + (stars - 1) / 4 * (range[1] - range[0]);
      }
      pushUnique(ctx.assumptions, "No numeric range available for '" + statId + "' — star rating ignored, falling back to the default roll value.");
    }
    return statRoll(statId, artifact.tier, artifact.rarity, undefined, data, ctx);
  }

  /* Valeur d'un stat d'artefact — précédence v6 :
       bande de l'item (stat_bands) > bande secondaire générique
       (combat.secondary_bands[stat][tier][rareté], rounding_step
       respecté) > chaîne héritée v3 (stat_rolls) > 0.
     Le drapeau isFraction (lifesteal/ability_steal, cf. _unit_note)
     indique au contributeur d'appliquer le roll en POINTS DE POURCENTAGE
     directs au lieu de points de rating. */
  function resolveArtifactStat(statId, artifact, section, data, ctx, roll, stars) {
    var bands = artifact.rec && artifact.rec.stat_bands;
    var sections = section === 'main' ? ['main', 'secondary'] : ['secondary', 'main'];
    var band = bandFromTables(bands, artifact.rarity, sections, statId);
    if (!band) band = secondaryBandFor(statId, artifact.tier, artifact.rarity, data);
    var res;
    if (band) {
      res = resolveBandedRoll(statId, artifact.key, artifact.rarity, band, roll, stars, false, ctx, data, secondaryRoundingStep(statId, data));
    } else {
      var v = resolveStatValue(statId, artifact, data, ctx, roll, stars);
      res = { value: v, stars: isNum(stars) ? stars : null, band: null };
    }
    res.isFraction = fractionRollStat(statId, data) && isNum(res.value) && res.value > 0 && res.value < 1;
    if (res.isFraction) pushUnique(ctx.assumptions, FRACTION_ROLL_NOTE);
    return res;
  }

  /* ══════════════════════════════════════════════════════════════════
     CAPACITÉS — overrides utilisateur, dégâts + cadence (DoT, CDR),
     et parsing des effets d'objet ([base + P% [stat]] [md|pd] + [cd]).
     ══════════════════════════════════════════════════════════════════ */
  function mergeAbilityOverride(ab, ov, statsById, ctx) {
    if (!ov || typeof ov !== 'object') return { params: ab.params || null, overridden: false };
    var p = ab.params || {};
    function sanOv(v, what) {
      if (!isNum(v)) return undefined;
      if (v < 0) { ctx.warn('Negative override ' + what + ' (' + v + ") on ability '" + (ab.name || ab.slot) + "' — clamped to 0."); return 0; }
      return v;
    }
    var damage = sanOv(ov.damage, 'damage');
    var cd = sanOv(ov.cooldown_s, 'cooldown_s');
    var cast = sanOv(ov.cast_time_s, 'cast_time_s');
    var scaling = p.scaling;
    var hasScalingOverride = typeof ov.scaling_stat === 'string' && ov.scaling_stat;
    if (hasScalingOverride) {
      if (!statsById[ov.scaling_stat]) ctx.warn("Override scaling_stat '" + ov.scaling_stat + "' is not a known stat — its contribution is 0.");
      scaling = {};
      scaling[ov.scaling_stat] = 1;
      pushUnique(ctx.assumptions, 'Ability overrides with a scaling_stat use a 1.0 coefficient (1 stat point = +1 damage) — assumption.');
    }
    if (damage === undefined && cd === undefined && cast === undefined && !hasScalingOverride) {
      return { params: ab.params || null, overridden: false };
    }
    return {
      overridden: true,
      params: {
        damage: damage !== undefined ? damage : p.damage,
        scaling: scaling,
        cooldown_s: cd !== undefined ? cd : p.cooldown_s,
        cast_time_s: cast !== undefined ? cast : p.cast_time_s,
        duration_s: p.duration_s,
        confidence: p.confidence,
      },
    };
  }

  function abilityDamageAndCadence(name, params, sheetStats, cdrPct, ctx, masteryAdj) {
    var raw = 0, kind = 'physical', hasNumbers = false, notes = [];
    if (params && (isNum(params.damage) || (params.scaling && typeof params.scaling === 'object'))) {
      hasNumbers = true;
      raw = isNum(params.damage) ? Math.max(0, params.damage) : 0;
      var scaling = params.scaling || {};
      var hasSpell = false, hasAttack = false;
      Object.keys(scaling).forEach(function (statKey) {
        var coeff = scaling[statKey];
        if (!isNum(coeff)) return;
        var rating = (sheetStats[statKey] && isNum(sheetStats[statKey].rating)) ? sheetStats[statKey].rating : 0;
        raw += rating * coeff;
        if (statKey === 'spell_power') hasSpell = true;
        if (statKey === 'attack_power') hasAttack = true;
      });
      kind = (hasSpell && !hasAttack) ? 'magical' : 'physical';
    } else {
      pushUnique(ctx.assumptions, "Ability '" + name + "' has no numeric params (data.heroes[].masteries[].abilities[].params) — damage_per_cast treated as 0.");
      notes.push('no numeric params available for this ability');
    }
    if (masteryAdj && isNum(masteryAdj.damageMult)) raw *= masteryAdj.damageMult;
    var rawCd;
    if (params && isNum(params.cooldown_s)) { rawCd = Math.max(0, params.cooldown_s); }
    else { pushUnique(ctx.assumptions, "No cooldown_s for ability '" + name + "' — defaulted to " + DEFAULT_ABILITY_COOLDOWN_S + 's.'); rawCd = DEFAULT_ABILITY_COOLDOWN_S; }
    if (masteryAdj && isNum(masteryAdj.cooldownMult)) rawCd *= masteryAdj.cooldownMult;
    var cdAfterCdr = rawCd / Math.max(0.01, 1 + cdrPct);
    var castTime = (params && isNum(params.cast_time_s)) ? Math.max(0, params.cast_time_s) : 0;
    var cadence = Math.max(cdAfterCdr, castTime);
    if (hasNumbers && raw > 0 && params && isNum(params.duration_s) && params.duration_s > 0) {
      if (params.duration_s > cadence) cadence = params.duration_s;
      notes.push('DoT: damage spread over ' + params.duration_s + 's');
    }
    if (!(cadence > 0)) cadence = 1; // garde-fou anti-division-par-zéro
    return { raw: raw, kind: kind, cadence: cadence, hasNumbers: hasNumbers, notes: notes };
  }

  var ITEM_STAT_TOKENS = {
    ap: 'attack_power', sp: 'spell_power', armor: 'armor', hp: 'health', health: 'health',
    mr: 'magic_resistance', mres: 'magic_resistance', wd: 'weapon_damage',
    hsp: 'heal_shield_power', mana: 'mana',
  };
  var ITEM_FORMULA_RE = /\[\s*(\d+(?:\.\d+)?)((?:\s*\+\s*\d+(?:\.\d+)?\s*%\s*\[[a-z_]+\])*)\s*\]/i;
  function parseItemEffect(text, cooldown) {
    if (!text || !(isNum(cooldown) && cooldown > 0)) return null; // pas de cadence honnête sans cooldown
    var m = ITEM_FORMULA_RE.exec(String(text));
    if (!m) return null;
    var parts = [];
    var scaleRe = /(\d+(?:\.\d+)?)\s*%\s*\[([a-z_]+)\]/gi;
    var sm;
    while ((sm = scaleRe.exec(m[2] || '')) !== null) {
      var statId = ITEM_STAT_TOKENS[sm[2].toLowerCase()];
      if (!statId) return null; // token de stat inconnu -> pas de nombre inventé
      parts.push({ stat: statId, coeff: Number(sm[1]) / 100 });
    }
    var kind = /\[md\]/i.test(text) ? 'magical' : (/\[pd\]/i.test(text) ? 'physical' : (/heal|restor/i.test(text) ? 'heal' : null));
    if (!kind) return null;
    return { base: Number(m[1]), parts: parts, kind: kind, cooldown_s: cooldown };
  }

  /* ══════════════════════════════════════════════════════════════════
     MAÎTRISE D'ARME — parsing conservateur des effets de node (AV
     fractionnaire + motif dégâts/cooldown ; jamais de nombre inventé).
     ══════════════════════════════════════════════════════════════════ */
  function parseMasteryNodeEffect(node, level) {
    var raw = Array.isArray(node.levels) ? node.levels[level - 1] : null;
    var v = null;
    if (raw && typeof raw === 'object' && isNum(raw.AV)) v = raw.AV;
    if (!isNum(v) || v === 0 || Math.abs(v) > 1) return null; // nombre nu ou hors gamme fraction : sémantique inconnue
    var text = String(node.description || '').replace(/<[^>]*>/g, '').replace(/\{\{[^}]*\}\}/g, '').toLowerCase();
    var conditional = /\bfull\b|\bbelow\b|\babove\b|\bwhen\b|\bif\b|\bwhile\b|\bagainst\b/.test(text);
    if (/cooldown/.test(text) && (v < 0 || /reduc|decrease|lower/.test(text))) {
      return { type: 'cooldown', mult: Math.max(0.01, 1 - Math.abs(v)), conditional: conditional };
    }
    if (v > 0 && /more damage|damage (?:is )?increased|increased damage|increases? (?:the )?damage|additional damage|bonus damage/.test(text)) {
      return { type: 'damage', mult: 1 + v, conditional: conditional };
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════
     FABRIQUES DE CONTRIBUTEURS — une section par kind. Chaque fabrique
     lit sa tranche de build/data (déjà validée) et retourne des
     contributeurs avec leurs hooks de phase.
     ══════════════════════════════════════════════════════════════════ */

  /* ── hero_base ─────────────────────────────────────────────────────── */
  function makeHeroBaseContributor(ctx) {
    if (!ctx.hero) return [];
    var c = makeContributor('hero_base:' + ctx.hero.id, 'hero_base', ctx.hero.name + ' — base template (lvl ' + ctx.level + ')', 'ratings');
    c.runRatings = function () {
      ctx.statsDef.forEach(function (sd) {
        var v = heroBaseRating(sd.id, ctx.hero.id, ctx.level, ctx.data, ctx);
        if (v) {
          addStatRow(ctx, sd.id, v, 'flat', 'Hero base (lvl ' + ctx.level + ')');
          c.contribute(sd.id, v, null);
        }
      });
      c.inert('base template values are all zero for this hero in the client data');
    };
    return [c];
  }

  /* ── weapon (stats de bande + cadence pour la phase offense) ───────── */
  function makeWeaponContributors(ctx) {
    var out = [];
    ctx.resolvedWeapons.forEach(function (w, i) {
      if (!w) return;
      var c = makeContributor('weapon:w' + i + ':' + w.key, 'weapon', (w.rec ? w.rec.name : 'Generic ' + w.weaponType) + ' (' + w.rarity + ')', 'ratings');
      c.runRatings = function () {
        /* v4 : bandes de l'arme (rareté courante) — rolls bornés, défaut =
           meilleur roll (max ; min pour attack_time). */
        var bandStats = null;
        if (w.rec && w.rec.stat_bands) {
          var rb = w.rec.stat_bands[w.rarity];
          if (rb && typeof rb === 'object') {
            bandStats = {};
            ['main', 'secondary'].forEach(function (section) {
              var table = rb[section];
              if (!table || typeof table !== 'object') return;
              Object.keys(table).forEach(function (statId) {
                if (bandStats[statId]) return;
                var band = bandFromTables(w.rec.stat_bands, w.rarity, [section], statId);
                if (!band) return;
                bandStats[statId] = resolveBandedRoll(statId, w.key, w.rarity, band, w.rolls ? w.rolls[statId] : undefined, undefined, statId === 'attack_time', ctx, ctx.data);
              });
            });
          }
        }
        var damage = (bandStats && bandStats.weapon_damage) ? bandStats.weapon_damage.value : null;
        var attackTime = (bandStats && bandStats.attack_time && bandStats.attack_time.value > 0) ? bandStats.attack_time.value : null;
        if (damage === null || attackTime === null) {
          var base = weaponBaseLookup(w.weaponType, w.tier, ctx.data, ctx);
          if (damage === null) damage = base.damage;
          if (attackTime === null) attackTime = base.attack_time;
        }
        ctx.weaponInfos[i] = { damage: damage, attack_time: attackTime };
        if (damage) {
          addStatRow(ctx, 'weapon_damage', damage, 'flat', 'Weapon slot ' + i + ' (' + w.weaponType + ' ' + w.tier + ')',
            (bandStats && bandStats.weapon_damage) ? bandStats.weapon_damage.stars : undefined);
          c.contribute('weapon_damage', damage, null);
        }
        if (isNum(attackTime)) c.contribute('attack_time', attackTime, 'seconds per swing');
        if (bandStats) {
          Object.keys(bandStats).forEach(function (statId) {
            if (statId === 'weapon_damage' || statId === 'attack_time') return;
            if (!ctx.statsById[statId]) return;
            var e = bandStats[statId];
            if (e && e.value) {
              addStatRow(ctx, statId, e.value, 'flat', 'Weapon slot ' + i + ' (' + (w.rec ? w.rec.name : w.weaponType) + ', ' + w.rarity + ')', e.stars);
              c.contribute(statId, e.value, null);
            }
          });
        }
        c.inert('no weapon damage data (no stat bands for ' + w.rarity + '; no combat.weapon_base entry for ' + w.weaponType + '/' + w.tier + ')');
      };
      out.push(c);
    });
    return out;
  }

  /* ── chip (stat de bande / template actif / info-only) ─────────────── */
  function makeChipContributors(ctx) {
    var out = [];
    ctx.resolvedWeapons.forEach(function (w, i) {
      if (!w) return;
      (w.chips || []).forEach(function (chipKey, j) {
        var chip = (ctx.data.chips || []).filter(function (x) { return x.key === chipKey; })[0];
        if (!chip) return; // clé invalide déjà filtrée+warnée à la résolution
        var c = makeContributor('chip:w' + i + 'c' + j + ':' + chipKey, 'chip', chip.name + ' (' + w.rarity + ')', 'ratings');
        c.runRatings = function () {
          if (!chip.stat_bands) {
            c.inert('no numeric stat bands in the community catalog — contributes 0 (add a customEffect for an assumed value)');
            return;
          }
          if (ctx.overriddenGearSources['chip:' + chipKey]) {
            pushUnique(ctx.assumptions, "Manual customEffects override the automatic band contribution of 'chip:" + chipKey + "'.");
            c.inert('overridden by an explicit custom effect (chip:' + chipKey + ')');
            return;
          }
          var rb = chip.stat_bands[w.rarity];
          if (!rb || typeof rb !== 'object') {
            c.inert('band missing for rarity ' + w.rarity + ' in the catalog');
            return;
          }
          ctx.gearRarityProxyNote();
          Object.keys(rb).forEach(function (statKey) {
            var b = rb[statKey];
            if (!Array.isArray(b) || !isNum(b[1])) return;
            var value = b[1]; // bandes chips = valeurs fixes par rareté ; max sinon
            if (ctx.statsById[statKey]) {
              addStatRow(ctx, statKey, value, 'flat', 'Chip: ' + chip.name + ' (' + w.rarity + ')');
              c.contribute(statKey, value, null);
              return;
            }
            if (statKey === 'default' && typeof chip.effect_template === 'string') {
              ctx.pendingGearActives.push({ type: 'template', source: 'chip', name: chip.name + ' (' + w.rarity + ')', text: chip.effect_template.replace(/\[scale\]/gi, String(value)), contributor: c });
              return;
            }
            ctx.pendingGearActives.push({ type: 'info', source: 'chip', name: chip.name + ' (' + w.rarity + ')' + ' — ' + statKey + ' ' + value, contributor: c, infoTarget: statKey, infoValue: value });
          });
          c.inert('band value(s) surfaced info-only — no sheet stat and no parseable effect formula');
        };
        out.push(c);
      });
    });
    return out;
  }

  /* ── rune (bandes stat / info ; description tentée comme formule) ──── */
  function makeRuneContributors(ctx) {
    var out = [];
    ctx.resolvedArtifacts.forEach(function (a, i) {
      if (!a || !a.runeRef) return;
      var c;
      if (!a.runeRec) {
        c = makeContributor('rune:a' + i + ':' + a.runeRef.key, 'rune', 'Rune ' + a.runeRef.key, 'ratings');
        c.runRatings = function () { c.inert('unknown rune reference — no matching rune record in data'); };
        out.push(c);
        return;
      }
      var rune = a.runeRec;
      c = makeContributor('rune:a' + i + ':' + rune.key, 'rune', rune.name + ' (' + (rune.variant || 'base') + ', host ' + a.rarity + ')', 'ratings');
      c.runRatings = function () {
        if (!rune.stat_bands) {
          c.inert('no numeric stat bands in the community catalog — contributes 0 (add a customEffect for an assumed value)');
          return;
        }
        if (ctx.overriddenGearSources['rune:' + rune.key]) {
          pushUnique(ctx.assumptions, "Manual customEffects override the automatic band contribution of 'rune:" + rune.key + "'.");
          c.inert('overridden by an explicit custom effect (rune:' + rune.key + ')');
          return;
        }
        var rb = rune.stat_bands[a.rarity];
        if (!rb || typeof rb !== 'object') {
          c.inert('band missing for host rarity ' + a.rarity + ' in the catalog');
          return;
        }
        ctx.gearRarityProxyNote();
        Object.keys(rb).forEach(function (statKey) {
          var b = rb[statKey];
          if (!Array.isArray(b) || !isNum(b[1])) return;
          if (ctx.statsById[statKey]) {
            addStatRow(ctx, statKey, b[1], 'flat', 'Rune: ' + rune.name + ' (' + a.rarity + ')');
            c.contribute(statKey, b[1], null);
            return;
          }
          /* HUNT v5 : tenter la description comme formule d'effet (même
             chemin que les templates de chip) avant l'info-only. */
          ctx.pendingGearActives.push({ type: 'rune_param', source: 'rune', name: rune.name + ' (' + a.rarity + ')' + ' — ' + statKey + ' ' + b[1], text: rune.description || '', contributor: c, infoTarget: statKey, infoValue: b[1] });
        });
        c.inert('band value(s) surfaced info-only — ability parameters (duration/damage…) with no parseable formula in the rune text');
      };
      out.push(c);
    });
    return out;
  }

  /* ── artifact_main / artifact_secondary ────────────────────────────── */
  function makeArtifactContributors(ctx) {
    var out = [];
    ctx.resolvedArtifacts.forEach(function (a, i) {
      if (!a) return;
      var main = makeContributor('artifact_main:a' + i + ':' + a.key, 'artifact_main', a.rec.name + ' (' + a.tier + '/' + a.rarity + ') — main stat', 'ratings');
      /* v6 : roll fractionnaire (lifesteal/ability_steal) → points de
         pourcentage directs (ligne '%'), sinon points de rating (flat). */
      function applyResolvedRoll(contrib, statId, res, label) {
        if (!res.value) return false;
        if (res.isFraction) {
          var pctPts = Math.round(res.value * 100 * 1e9) / 1e9;
          addStatRow(ctx, statId, pctPts, '%', label, res.stars);
          contrib.contribute(statId, pctPts, (res.stars != null ? res.stars + '★ ' : '') + 'fraction roll → direct percentage points');
        } else {
          addStatRow(ctx, statId, res.value, 'flat', label, res.stars);
          contrib.contribute(statId, res.value, res.stars != null ? res.stars + '★' : null);
        }
        return true;
      }

      main.runRatings = function () {
        if (!a.mainStat) {
          main.inert('no main stat selected on this artifact');
          return;
        }
        var res = resolveArtifactStat(a.mainStat, a, 'main', ctx.data, ctx, a.mainStatOverrideRoll, a.mainStars);
        if (!applyResolvedRoll(main, a.mainStat, res, 'Artifact ' + (i + 1) + ' main stat (' + a.tier + '/' + a.rarity + ')')) {
          main.inert("no numeric roll data for '" + a.mainStat + "' at " + a.tier + '/' + a.rarity + (res.band ? '' : ' (no stat band for this rarity, no combat.stat_rolls entry)'));
        }
      };
      out.push(main);

      a.secondary.forEach(function (pick, j) {
        var sec = makeContributor('artifact_secondary:a' + i + 's' + j + ':' + a.key + ':' + pick.stat, 'artifact_secondary', a.rec.name + ' (' + a.tier + '/' + a.rarity + ') — secondary ' + pick.stat, 'ratings');
        sec.runRatings = function () {
          var res = resolveArtifactStat(pick.stat, a, 'secondary', ctx.data, ctx, pick.overrideRoll, pick.stars);
          if (!applyResolvedRoll(sec, pick.stat, res, 'Artifact ' + (i + 1) + ' secondary (' + a.tier + '/' + a.rarity + ')')) {
            /* HUNT v5 : plus jamais un 0 silencieux — raison spécifique. */
            sec.inert("no numeric roll data for '" + pick.stat + "' at " + a.tier + '/' + a.rarity + (res.band ? '' : ' (no stat band for this rarity, no combat.stat_rolls entry)'));
          }
        };
        out.push(sec);
      });
    });
    return out;
  }

  /* ── item_passive (passifs/actifs T3 + actives héritées v1) ────────── */
  function makeItemPassiveContributors(ctx) {
    var out = [];
    ctx.resolvedArtifacts.forEach(function (a, i) {
      if (!a || !a.rec) return;
      var entries = [];
      if (a.rec.passive && typeof a.rec.passive === 'object') {
        entries.push({ src: a.rec.passive, cd: a.rec.passive.numbers && a.rec.passive.numbers.cooldown_s, what: 'passive' });
      }
      if (a.rec.active && typeof a.rec.active === 'object'
          && !(a.rec.passive && a.rec.active.title && a.rec.active.title === a.rec.passive.title)) {
        entries.push({ src: a.rec.active, cd: a.rec.active.cooldown_s, what: 'active' });
      }
      entries.forEach(function (en) {
        var title = en.src.title || (a.rec.name + ' ' + en.what);
        var c = makeContributor('item_passive:a' + i + ':' + a.key + (en.what === 'active' ? ':active' : ''), 'item_passive', title + ' (' + a.rec.name + ')', 'offense');
        c.runOffense = function () {
          var eff = parseItemEffect(en.src.text, en.cd);
          if (!eff) {
            ctx.itemInfoOnly++;
            ctx.actives.push({ name: title, source: 'item', dps_or_hps: 0, cooldown_s: isNum(en.cd) ? en.cd : null, kind: 'info' });
            c.info('dps.actives', 0, 'info-only');
            c.inert(!isNum(en.cd) || en.cd <= 0
              ? 'no cooldown tag — the effect cannot be rated per second'
              : 'not parseable: "' + trimText(en.src.text, 70) + '"');
            return;
          }
          var amount = eff.base;
          eff.parts.forEach(function (p) { amount += p.coeff * ctx.getRating(p.stat); });
          var cd = eff.cooldown_s / Math.max(0.01, 1 + ctx.cdrPct);
          var factor = eff.kind === 'magical' ? (1 - ctx.mitigationMagical) : (eff.kind === 'physical' ? (1 - ctx.mitigationPhysical) : 1);
          var uptKey = isNum(ctx.uptimes[a.key]) ? a.key : title;
          var upt = isNum(ctx.uptimes[uptKey]) ? clamp01(ctx.uptimes[uptKey]) : 1;
          var perSecond = (amount * factor / cd) * upt;
          ctx.actives.push({ name: title, source: 'item', dps_or_hps: perSecond, cooldown_s: cd, kind: eff.kind === 'heal' ? 'heal' : 'damage' });
          if (eff.kind !== 'heal') ctx.activesDamageSum += perSecond;
          c.contribute('dps.actives', perSecond, eff.kind + ' every ' + cd.toFixed(1) + 's');
          pushUnique(ctx.assumptions, 'Item passives/actives with parseable formulas are cast on cooldown (CDR applied, target mitigation by damage type, no crit, 100% trigger uptime unless options.uptimes says otherwise) — assumption.');
        };
        out.push(c);
      });
    });

    /* Actives héritées du contrat v1 (data.artifact_actives). */
    var equippedKeys = ctx.resolvedArtifacts.filter(Boolean).map(function (a) { return a.key; });
    (Array.isArray(ctx.data.artifact_actives) ? ctx.data.artifact_actives : []).forEach(function (act) {
      if (!act || equippedKeys.indexOf(act.artifact_key) === -1) return;
      var name = act.name || act.ability_key || 'Unknown active';
      var c = makeContributor('item_passive:legacy:' + act.artifact_key + ':' + (act.ability_key || name), 'item_passive', name + ' (legacy active)', 'offense');
      c.runOffense = function () {
        var rawCd;
        if (isNum(act.cooldown_s) && act.cooldown_s > 0) { rawCd = act.cooldown_s; }
        else { pushUnique(ctx.assumptions, "Artifact active '" + (act.name || act.ability_key) + "' has no cooldown_s — defaulted to " + DEFAULT_ABILITY_COOLDOWN_S + 's.'); rawCd = DEFAULT_ABILITY_COOLDOWN_S; }
        var cd = rawCd / Math.max(0.01, 1 + ctx.cdrPct); // CDR sur actives (v2)
        var amount = isNum(act.amount) ? act.amount : 0;
        if (!isNum(act.amount)) pushUnique(ctx.assumptions, "Artifact active '" + (act.name || act.ability_key) + "' has no amount — treated as 0.");
        var uptKey = isNum(ctx.uptimes[act.ability_key]) ? act.ability_key : act.name;
        var upt = isNum(ctx.uptimes[uptKey]) ? clamp01(ctx.uptimes[uptKey]) : 1;
        var perSecond = (amount / cd) * upt;
        ctx.actives.push({ name: name, source: 'artifact', dps_or_hps: perSecond, cooldown_s: cd, kind: act.kind || 'utility' });
        if (act.kind === 'damage') ctx.activesDamageSum += perSecond;
        if (perSecond) c.contribute('dps.actives', perSecond, (act.kind || 'utility') + ' every ' + cd.toFixed(1) + 's');
        else c.inert('no amount in data — 0 per activation');
      };
      out.push(c);
    });
    return out;
  }

  /* ── talent_choice / talent_top ────────────────────────────────────── */
  function makeTalentContributors(ctx) {
    var out = [];
    var talents = (ctx.build.talents && typeof ctx.build.talents === 'object') ? ctx.build.talents : {};
    var ranksAll = (ctx.build.talentRanks && typeof ctx.build.talentRanks === 'object') ? ctx.build.talentRanks : {};
    var condsAll = (ctx.build.talentConds && typeof ctx.build.talentConds === 'object') ? ctx.build.talentConds : {};
    var treesById = {};
    (Array.isArray(ctx.data.talent_trees) ? ctx.data.talent_trees : []).forEach(function (t) { treesById[t.id] = t; });

    Object.keys(talents).forEach(function (treeId) {
      var tree = treesById[treeId];
      if (!tree) { ctx.warn("Unknown talent tree id '" + treeId + "' — ignored."); return; }

      /* v3 : top_mods — bonus permanent, actif dès la sélection de l'arbre. */
      var top = makeContributor('talent_top:' + treeId, 'talent_top', tree.name + ' — tree bonus', 'ratings');
      top.runRatings = function () {
        (Array.isArray(tree.top_mods) ? tree.top_mods : []).forEach(function (tm) {
          if (!tm || !tm.stat || !isNum(tm.value)) return;
          var contribs = routeMod(ctx, tm.stat, tm.value, tm.unit, 'Talent tree bonus: ' + tree.name, true);
          (contribs || []).forEach(function (cb) { top.contribute(cb.target, cb.value, cb.note); });
        });
        top.inert('no numeric top-of-tree bonus (top_mods) in data' + (tree.top_bonus ? ' — text: "' + trimText(tree.top_bonus, 50) + '"' : ''));
      };
      out.push(top);

      var rowObj = talents[treeId] || {};
      Object.keys(rowObj).forEach(function (rowKey) {
        if (rowKey === '_notes') return;
        var rowIdx = Number(rowKey);
        var row = tree.rows && tree.rows[rowIdx];
        if (!row) { ctx.warn("Unknown talent row '" + rowKey + "' in tree '" + treeId + "' — ignored."); return; }
        var choiceIdx = rowObj[rowKey];
        var choice = row.choices && row.choices[choiceIdx];
        if (!choice) { ctx.warn("Unknown talent choice index " + choiceIdx + " in tree '" + treeId + "' row " + rowIdx + " — ignored."); return; }

        var c = makeContributor('talent_choice:' + treeId + ':r' + rowIdx, 'talent_choice', tree.name + ' — ' + choice.name, 'ratings');
        c.runRatings = function () {
          var rank = 1;
          var rawRank = ranksAll[treeId] && ranksAll[treeId][rowKey];
          if (isNum(rawRank)) rank = Math.max(1, Math.min(5, Math.round(rawRank)));
          var condFlag = condsAll[treeId] ? condsAll[treeId][rowKey] : undefined;
          var mods = choice.stat_mods || [];
          var condOff = false;
          mods.forEach(function (mod) {
            if (!mod || !mod.stat) return;
            var val = mod.value;
            if (Array.isArray(mod.per_rank) && mod.per_rank.length) {
              var pv = mod.per_rank[Math.min(rank, mod.per_rank.length) - 1];
              if (isNum(pv)) val = pv;
            }
            if (!isNum(val)) return;
            if (mod.condition) {
              if (condFlag === false) { condOff = true; return; } // toggle OFF explicite
              pushUnique(ctx.assumptions, "Conditional talent effect '" + choice.name + "' assumed active" + (mod.condition.text ? ' (' + mod.condition.text + ')' : '') + '.');
            }
            var label = 'Talent: ' + tree.name + ' — ' + choice.name + (rank > 1 ? ' (rank ' + rank + ')' : '');
            var contribs = routeMod(ctx, mod.stat, val, mod.unit, label, true);
            (contribs || []).forEach(function (cb) { c.contribute(cb.target, cb.value, cb.note); });
          });
          if (condOff) c.inert('condition toggled off (talentConds)');
          /* HUNT v5 : choix sélectionné sans stat_mods numériques → visible. */
          c.inert(mods.length ? 'stat_mods carry no numeric values' : 'not parseable: no numeric stat_mods extracted from "' + trimText(choice.description, 60) + '"');
        };
        out.push(c);
      });
    });
    return out;
  }

  /* ── mastery_node / mastery_edge / t3_perk ─────────────────────────── */
  function makeMasteryContributors(ctx) {
    var out = [];
    var summary = { active: false, spec: null, points_spent: 0, points_max: 26, nodes_applied: [], unparsed_nodes: 0, edges_bought: 0, bySlot: {} };
    ctx.masterySummary = summary;
    if (!ctx.hero || !ctx.mastery) return out;
    var specKey = ctx.hero.id + '/' + ctx.mastery.id;
    summary.spec = specKey;

    /* Perks T3 : customEffects source "t3perk:*" porteurs d'un nodeId. */
    var perkEntries = [];
    (Array.isArray(ctx.build.customEffects) ? ctx.build.customEffects : []).forEach(function (ce, idx) {
      if (ce && typeof ce === 'object' && typeof ce.source === 'string' && ce.source.indexOf('t3perk:') === 0 && typeof ce.nodeId === 'string') {
        perkEntries.push({ idx: idx, source: ce.source, nodeId: ce.nodeId, levels: isNum(ce.value) ? Math.max(0, Math.round(ce.value)) : 1 });
      }
    });
    var perkLevelsByNode = {};
    perkEntries.forEach(function (p) { perkLevelsByNode[p.nodeId] = (perkLevelsByNode[p.nodeId] || 0) + p.levels; });

    var allocAll = (ctx.build.masteryAlloc && typeof ctx.build.masteryAlloc === 'object') ? ctx.build.masteryAlloc : {};
    var alloc = allocAll[specKey];
    if ((!alloc || typeof alloc !== 'object') && !perkEntries.length) return out;

    var mt = ctx.data.mastery_trees;
    var spec = mt && mt.specs && mt.specs[specKey];
    if (!spec || spec.built === false || !Array.isArray(spec.nodes)) {
      pushUnique(ctx.assumptions, 'No built mastery tree in data for ' + specKey + ' — mastery allocation ignored.');
      perkEntries.forEach(function (p) {
        var c = makeContributor('t3_perk:' + p.idx + ':' + p.source, 't3_perk', 'T3 gear perk → node ' + p.nodeId, 'ratings');
        c.runRatings = function () { c.inert('no built mastery tree in data for ' + specKey); };
        out.push(c);
      });
      return out;
    }
    summary.active = true;
    summary.points_max = (mt.system && isNum(mt.system.points_max)) ? mt.system.points_max : 26;

    var nodesById = {};
    spec.nodes.forEach(function (n) { nodesById[n.id] = n; });
    var allocNodes = (alloc && alloc.nodes && typeof alloc.nodes === 'object') ? alloc.nodes : {};
    var allIds = {};
    Object.keys(allocNodes).forEach(function (id) { allIds[id] = true; });
    Object.keys(perkLevelsByNode).forEach(function (id) { allIds[id] = true; });

    /* Contributeurs t3_perk (visibles, gratuits en points, cap max_level). */
    perkEntries.forEach(function (p) {
      var node = nodesById[p.nodeId];
      var c = makeContributor('t3_perk:' + p.idx + ':' + p.source, 't3_perk', 'T3 gear perk → ' + (node ? (node.name || p.nodeId) : p.nodeId), 'ratings');
      c.runRatings = function () {
        if (!node) { c.inert('unknown mastery node id for ' + specKey); return; }
        c.contribute('mastery_node:' + p.nodeId, p.levels, '+' + p.levels + ' level(s), cap ' + (isNum(node.max_level) ? node.max_level : 3));
      };
      out.push(c);
    });

    Object.keys(allIds).forEach(function (nodeId) {
      var node = nodesById[nodeId];
      var allocLvlRaw = isNum(allocNodes[nodeId]) ? Math.max(0, Math.min(3, Math.round(allocNodes[nodeId]))) : 0;
      var perk = perkLevelsByNode[nodeId] || 0;
      if (!node) {
        if (allocLvlRaw > 0 || perk > 0) ctx.warn("Unknown mastery node id '" + nodeId + "' for " + specKey + ' — ignored.');
        if (allocLvlRaw > 0) {
          var cu = makeContributor('mastery_node:' + nodeId, 'mastery_node', 'Mastery node ' + nodeId, 'ratings');
          cu.runRatings = function () { cu.inert('unknown node id in the ' + specKey + ' tree'); };
          out.push(cu);
        }
        return;
      }
      var maxLvl = isNum(node.max_level) ? node.max_level : 3;
      var allocLvl = Math.min(allocLvlRaw, maxLvl);
      var c = makeContributor('mastery_node:' + nodeId, 'mastery_node', (node.name || nodeId) + ' (' + node.skill + ')', 'ratings');
      c.runRatings = function () {
        summary.points_spent += allocLvl;
        var lvl = Math.min(maxLvl, allocLvl + perk);
        if (perk > 0) pushUnique(ctx.assumptions, "T3 gear perk grants +" + perk + " level(s) to mastery node '" + (node.name || nodeId) + "' (cap " + maxLvl + ").");
        if (lvl < 1) { c.inert('level 0 — no points invested'); return; }
        var eff = parseMasteryNodeEffect(node, lvl);
        if (!eff) {
          summary.unparsed_nodes++;
          c.inert('not parseable: "' + trimText(String(node.description || '').replace(/<[^>]*>/g, ''), 60) + '" (value table has no fractional AV or no damage/cooldown wording)');
          return;
        }
        if (ROTATION_SLOTS.indexOf(node.skill) === -1) {
          summary.unparsed_nodes++;
          c.inert('skill slot "' + node.skill + '" has no rotation entry to adjust (passive/trait slot)');
          return;
        }
        var s = summary.bySlot[node.skill] = summary.bySlot[node.skill] || { damageMult: 1, cooldownMult: 1, notes: [] };
        if (eff.type === 'damage') {
          s.damageMult *= eff.mult;
          s.notes.push('mastery: ' + (node.name || nodeId) + ' ×' + eff.mult.toFixed(2) + ' damage (lvl ' + lvl + ')');
        } else {
          s.cooldownMult *= eff.mult;
          s.notes.push('mastery: ' + (node.name || nodeId) + ' ×' + eff.mult.toFixed(2) + ' cooldown (lvl ' + lvl + ')');
        }
        if (eff.conditional) pushUnique(ctx.assumptions, "Conditional mastery effect '" + (node.name || nodeId) + "' assumed active.");
        summary.nodes_applied.push({ id: nodeId, name: node.name || null, skill: node.skill, effect: eff.type, mult: eff.mult, level: lvl });
        c.contribute('ability:' + node.skill, eff.mult, '×' + eff.mult.toFixed(2) + ' ' + eff.type + ' (lvl ' + lvl + ')');
      };
      out.push(c);
    });

    /* Arêtes achetées (+1 WSB) — HUNT v5 : visibles, comptées, inertes. */
    var edgeIds = {};
    (Array.isArray(spec.edges) ? spec.edges : []).forEach(function (e) { edgeIds[e.id] = true; });
    var edgeCost = (mt.system && isNum(mt.system.edge_cost_points)) ? mt.system.edge_cost_points : 1;
    (Array.isArray(alloc && alloc.edges) ? alloc.edges : []).forEach(function (eid) {
      var c = makeContributor('mastery_edge:' + eid, 'mastery_edge', 'Mastery edge ' + eid, 'ratings');
      c.runRatings = function () {
        if (!edgeIds[eid]) {
          ctx.warn("Unknown mastery edge id '" + eid + "' for " + specKey + ' — ignored.');
          c.inert('unknown edge id in the ' + specKey + ' tree');
          return;
        }
        summary.edges_bought++;
        summary.points_spent += edgeCost;
        c.info('mastery_points', edgeCost, 'edge cost');
        c.inert('+1 weapon skill bonus (edge) — text-only effect, not numerically modeled');
      };
      out.push(c);
    });

    /* Post-phase : résumé/garde-fous — après tous les nodes/arêtes.
       Porteur technique : pas une entité, caché de l'audit. */
    var closer = makeContributor('mastery_summary:' + specKey, 'mastery_node', 'Mastery summary (' + specKey + ')', 'ratings');
    closer.hiddenFromAudit = true;
    closer.runRatings = function () {
      if (summary.unparsed_nodes || summary.edges_bought) {
        pushUnique(ctx.assumptions, summary.unparsed_nodes + ' mastery node effect(s) and ' + summary.edges_bought + ' bought edge(s) (+1 weapon skill bonus each) are text-only — not numerically modeled; mastery contribution is a lower bound.');
      }
      if (summary.points_spent > summary.points_max) {
        ctx.warn('Mastery allocation spends ' + summary.points_spent + ' points — exceeds the ' + summary.points_max + '-point budget.');
      }
    };
    out.push(closer);
    return out;
  }

  /* ── universal_spell (HPS + HUNT : Sprint/Mana Burst/Cleanse) ──────── */
  function makeUniversalSpellContributors(ctx) {
    var out = [];
    var spellIds = Array.isArray(ctx.build.spells) ? ctx.build.spells : [];
    var spellUptimes = (ctx.build.spellUptimes && typeof ctx.build.spellUptimes === 'object') ? ctx.build.spellUptimes : {};
    ['d', 'f'].forEach(function (hand, idx) {
      var id = spellIds[idx];
      if (!id) return;
      var spell = (Array.isArray(ctx.data.universal_spells) ? ctx.data.universal_spells : []).filter(function (s) { return s.id === id; })[0];
      if (!spell) {
        ctx.warn("Unknown universal spell id '" + id + "' — ignored.");
        var cu = makeContributor('universal_spell:' + hand + ':' + id, 'universal_spell', 'Spell ' + id + ' (' + hand.toUpperCase() + ')', 'offense');
        cu.runOffense = function () { cu.inert('unknown spell id — no matching universal spell in data'); };
        out.push(cu);
        return;
      }
      var c = makeContributor('universal_spell:' + hand + ':' + id, 'universal_spell', spell.name + ' (' + hand.toUpperCase() + ')', 'offense');
      var P = spell.params;
      var upt = isNum(spellUptimes[hand]) ? clamp01(spellUptimes[hand]) : null;

      /* HUNT v5 (phase ratings) : buff de vitesse type Sprint → mod de
         movement_speed pondéré par l'uptime (fourni, sinon durée/cooldown). */
      c.runRatings = function () {
        if (!P || typeof P !== 'object') return;
        if ((P.kind === 'buff' || P.kind === 'utility') && isNum(P.ms_pct) && P.ms_pct !== 0 && ctx.statsById.movement_speed) {
          var natural = (isNum(P.duration_s) && P.duration_s > 0 && isNum(P.cooldown_s) && P.cooldown_s > 0) ? clamp01(P.duration_s / P.cooldown_s) : 1;
          var w = upt != null ? upt : natural;
          var val = P.ms_pct * w;
          if (val) {
            addStatRow(ctx, 'movement_speed', val, '%', 'Spell: ' + spell.name + ' (uptime ' + Math.round(w * 100) + '%)');
            c.contribute('movement_speed', val, '+' + P.ms_pct + '% × ' + Math.round(w * 100) + '% uptime');
            pushUnique(ctx.assumptions, 'Movement-speed spell buffs are averaged by uptime (given spellUptimes, else duration/cooldown) — assumption.');
          }
        }
      };

      c.runOffense = function () {
        if (!P || typeof P !== 'object') {
          pushUnique(ctx.assumptions, "Universal spell '" + spell.name + "' has no numeric params — not modeled in HPS.");
          c.inert('no numeric params in data — not modeled in HPS');
          return;
        }
        if (P.kind === 'heal' || P.kind === 'shield') {
          var amount = num(P.base, 0) + num(P.per_level, 0) * ctx.level + num(P.sp_scale, 0) * ctx.getRating('spell_power');
          amount = Math.max(0, amount) * (1 + ctx.hspPct);
          if (ctx.hspPct) pushUnique(ctx.assumptions, 'heal_shield_power is applied multiplicatively (1 + %) to universal-spell healing/shielding — assumption.');
          var cd;
          if (isNum(P.cooldown_s) && P.cooldown_s > 0) { cd = P.cooldown_s; }
          else { pushUnique(ctx.assumptions, "Universal spell '" + spell.name + "' has no cooldown_s — defaulted to " + DEFAULT_SPELL_COOLDOWN_S + 's.'); cd = DEFAULT_SPELL_COOLDOWN_S; }
          var w = upt != null ? upt : 1;
          var hps = (amount / cd) * w;
          ctx.hpsTotal += hps;
          ctx.hpsPerSpell.push({ slot: hand, id: id, name: spell.name, kind: P.kind, amount_per_cast: amount, cooldown_s: cd, uptime: w, hps: hps });
          c.contribute('dps.hps', hps, P.kind + ' ' + amount.toFixed(0) + ' per cast');
          return;
        }
        /* HUNT v5 : raisons spécifiques pour les sorts non-HPS. */
        if (isNum(P.ms_pct) && P.ms_pct !== 0) {
          c.inert('movement-speed buff — counted as a movement_speed stat mod, no DPS/HPS'); // Sprint : contribué en phase ratings
          return;
        }
        if (P.note && /mana/i.test(P.note)) {
          var manaAmount = num(P.base, 0) + num(P.per_level, 0) * ctx.level + num(P.sp_scale, 0) * ctx.getRating('spell_power');
          c.info('mana_restored_per_cast', manaAmount, 'restores Mana — resource, not health');
          c.inert('restores Mana (' + manaAmount.toFixed(0) + ' per cast) — mana economy is not modeled in DPS/HPS');
          return;
        }
        c.inert('kind "' + (P.kind || 'unknown') + '" (' + trimText((P.display && P.display[0] && P.display[0].value) || spell.description, 50) + ') — no numeric DPS/HPS semantics');
      };
      out.push(c);
    });
    return out;
  }

  /* ── custom_effect / corruption ────────────────────────────────────── */
  function makeCustomEffectContributors(ctx) {
    var out = [];
    (Array.isArray(ctx.build.customEffects) ? ctx.build.customEffects : []).forEach(function (ce, i) {
      if (!ce || typeof ce !== 'object') return;
      /* t3perk + nodeId = niveaux de node de maîtrise (contributeur t3_perk). */
      if (typeof ce.source === 'string' && ce.source.indexOf('t3perk:') === 0 && typeof ce.nodeId === 'string') return;
      var kind = (typeof ce.source === 'string' && ce.source.indexOf('corruption:') === 0) ? 'corruption' : 'custom_effect';
      var c = makeContributor('custom_effect:' + i + ':' + (ce.source || 'manual'), kind, 'Custom: ' + (ce.source || 'manual') + (ce.note ? ' — ' + ce.note : ''), 'ratings');
      c.runRatings = function () {
        if (!isNum(ce.value)) {
          ctx.warn('customEffects[' + i + '] has no numeric value — ignored.');
          c.inert('no numeric value on this custom effect');
          return;
        }
        var w = 1;
        if (ce.uptime != null) {
          w = isNum(ce.uptime) ? clamp01(ce.uptime) : 1;
          if (w < 1) pushUnique(ctx.assumptions, 'Custom effects with uptime < 100% are averaged (value × uptime).');
        }
        var label = 'Custom: ' + (ce.source || 'manual') + (ce.note ? ' — ' + ce.note : '');
        var contribs = routeMod(ctx, ce.stat, ce.value * w, ce.unit === '%' ? '%' : 'flat', label, false);
        if (contribs === null) {
          ctx.warn("customEffects targets unknown stat '" + ce.stat + "' — ignored.");
          c.inert("unknown stat '" + ce.stat + "' — no matching entry in data.stats");
          return;
        }
        contribs.forEach(function (cb) { c.contribute(cb.target, cb.value, cb.note); });
      };
      out.push(c);
    });
    return out;
  }

  /* ── target ────────────────────────────────────────────────────────── */
  function makeTargetContributor(ctx) {
    var c = makeContributor('target', 'target', 'Target (mitigation model)', 'derived');
    c.runDerived = function () {
      var targetOpt = ctx.options.target || {};
      var rawTargetLevel = isNum(targetOpt.level) ? targetOpt.level : ctx.level;
      var targetLevel = Math.max(1, Math.min(40, rawTargetLevel));
      if (targetLevel !== rawTargetLevel) ctx.warn('target.level ' + rawTargetLevel + ' is out of range — clamped to ' + targetLevel + '.');
      var targetArmor = isNum(targetOpt.armor) ? targetOpt.armor : 0;
      var targetMres = isNum(targetOpt.magic_resistance) ? targetOpt.magic_resistance : 0;
      if (!ctx.options.target) pushUnique(ctx.assumptions, 'No target specified (options.target) — using an undefended dummy (armor 0, magic resistance 0, level ' + targetLevel + ').');

      ctx.targetKPhysical = resolveMitigationK('armor', targetLevel, ctx.data, ctx);
      ctx.targetKMagical = resolveMitigationK('magic_resistance', targetLevel, ctx.data, ctx);
      var physPenPct = ctx.getPct('physical_penetration');
      var magPenPct = ctx.getPct('magical_penetration');
      /* v3 : pénétration plate soustraite AVANT la pénétration en %. */
      var flatPhysPen = ctx.getRating('flat_physical_penetration');
      var flatMagPen = ctx.getRating('flat_magical_penetration');
      if (flatPhysPen || flatMagPen) pushUnique(ctx.assumptions, 'Flat penetration is subtracted from the target defense BEFORE percentage penetration is applied — documented order.');
      ctx.mitigationPhysical = mitigationPct(targetArmor, physPenPct, ctx.targetKPhysical, flatPhysPen);
      ctx.mitigationMagical = mitigationPct(targetMres, magPenPct, ctx.targetKMagical, flatMagPen);
      ctx.targetArmor = targetArmor;
      ctx.targetMres = targetMres;

      c.contribute('mitigation_physical_pct', ctx.mitigationPhysical, 'armor ' + targetArmor + ', K=' + ctx.targetKPhysical);
      c.contribute('mitigation_magical_pct', ctx.mitigationMagical, 'magic resistance ' + targetMres + ', K=' + ctx.targetKMagical);
    };
    return [c];
  }

  /* ══════════════════════════════════════════════════════════════════
     FICHE DE STATS (phase 2 — niveau structure) : plie ctx.statRows par
     stat avec la sémantique d'unités v4 exacte, applique le DR (toute
     stat dotée d'un seuil, armor/MR 260 inclus) et la conversion en %.
     ══════════════════════════════════════════════════════════════════ */
  function buildSheet(ctx) {
    function sourceEntry(row, displayValue) {
      var e = { label: row.label, value: displayValue !== undefined ? displayValue : row.value };
      if (row.stars !== undefined && row.stars !== null) e.stars = row.stars;
      return e;
    }
    var sheetStats = {};
    ctx.statsDef.forEach(function (statDef) {
      var id = statDef.id;
      var sources = [];
      var rating = 0;
      var pctPoints = 0;
      var mainPctBonus = 0;

      (ctx.statRows[id] || []).forEach(function (row) {
        if (statDef.kind === 'main') {
          if (row.unit === '%') { mainPctBonus += row.value / 100; sources.push(sourceEntry(row, '+' + row.value + '%')); }
          else { rating += row.value; sources.push(sourceEntry(row)); }
        } else if (statDef.kind === 'secondary') {
          if (row.unit === '%') {
            pctPoints += row.value;
            sources.push(sourceEntry(row, '+' + row.value + ' pct pts')); // v6 : garde les étoiles des rolls fractionnaires
            pushUnique(ctx.assumptions, 'Percent-unit bonuses on secondary stats are applied as percentage points on top of the rating→% conversion.');
          } else { rating += row.value; sources.push(sourceEntry(row)); }
        } else {
          rating += row.value; // kind dérivé (aggro…) : points tels quels
          sources.push(sourceEntry(row));
        }
      });
      if (statDef.kind === 'main' && mainPctBonus) rating = rating * (1 + mainPctBonus);

      var dr = { threshold: (statDef.dr_threshold != null ? statDef.dr_threshold : null), past: false };
      var effective = rating, pct = null;
      if (dr.threshold != null) {
        effective = applyDR(rating, dr.threshold, ctx.drPostEfficiency);
        dr.past = rating > dr.threshold;
        if (dr.past) ctx.warn("Stat '" + id + "' is past its DR threshold (rating " + rating.toFixed(2) + ' > ' + dr.threshold + ').');
      }
      if (statDef.kind === 'secondary') {
        var conv = conversionForStat(id, ctx.data, ctx);
        pct = effective * conv.pctPerRating / 100 + pctPoints / 100;
      }

      sheetStats[id] = { rating: rating, effective: effective, pct: pct, sources: sources, dr: dr, kind: statDef.kind, name: statDef.name };
    });
    return sheetStats;
  }

  /**
   * Calcule la fiche de personnage complète + le DPS/HPS pour un build.
   * v5 : pli phasé de contributeurs — chaque entité équipée/sélectionnée
   * produit exactement une entrée d'audit (appliquée ou inerte avec une
   * raison spécifique) dans result.audit. API et nombres identiques à v4.
   *
   * @param {object} build - État de build au format share.js + champs
   *   additifs v2/v3/v4 (abilityOverrides, customEffects, talentRanks,
   *   talentConds, spellUptimes, rotationMode, masteryAlloc,
   *   artifacts[].secondaries/mainStars, weapons[].rolls) — tous optionnels.
   * @param {object} data - Contenu de site/data/builder.json ; tous les
   *   blocs numériques (combat, stat_bands, mastery_trees, params…) sont
   *   optionnels — le résultat reste fini quoi qu'il arrive.
   * @param {object} [options] - { target, rotation, drOverride, uptimes }
   *   (sémantiques v2/v3/v4 inchangées).
   * @returns {{
   *   sheet: { stats: object, derived: object },
   *   dps: { basic: object, rotation: object, actives: object[], hps: object,
   *          sustain: object, total: object, target: object },
   *   mastery: object,
   *   audit: { contributors: object[], totals: {applied: number, inert: number}, by_source: object },
   *   assumptions: string[],
   *   warnings: string[]
   * }}
   */
  function compute(build, data, options) {
    build = (build && typeof build === 'object') ? build : {};
    data = (data && typeof data === 'object') ? data : {};
    options = (options && typeof options === 'object') ? options : {};

    var assumptions = [];
    var warnings = [];

    /* ── ctx : la structure de personnage accumulée, passée aux phases et
       aux contributeurs. ── */
    var ctx = {
      build: build, data: data, options: options,
      assumptions: assumptions, warnings: warnings,
      combatMissing: !data.combat, convCache: {},
      statRows: {}, globalMods: [], aggroPoints: 0, aggroAny: false,
      weaponInfos: [], pendingGearActives: [],
      actives: [], activesDamageSum: 0, itemInfoOnly: 0,
      hpsPerSpell: [], hpsTotal: 0,
      uptimes: (options.uptimes && typeof options.uptimes === 'object') ? options.uptimes : {},
    };
    ctx.warn = function (msg) { pushUnique(warnings, msg); };
    var gearProxyNoted = false;
    ctx.gearRarityProxyNote = function () {
      if (gearProxyNoted) return;
      pushUnique(assumptions, "Chip/rune band values use the hosting item's rarity (chips/runes carry no own rarity in the build state) — planner convention.");
      gearProxyNoted = true;
    };

    if (ctx.combatMissing) {
      pushUnique(assumptions,
        'data.combat is entirely missing — every combat-related number uses an engine-builtin default ' +
        '(hero base 0, weapon damage 0, basic-attack cadence ' + DEFAULT_BASELINE_ATTACKS_PER_S + ' attack/s when no weapon speed is known, stat rolls 0, ' +
        'DR curve piecewise-linear at ' + Math.round(DEFAULT_DR_POST_EFFICIENCY * 100) + '% post-threshold efficiency, ' +
        'mitigation K=' + DEFAULT_MITIGATION_K_BASE + '×(1+' + DEFAULT_MITIGATION_K_PER_LEVEL + '×lvl), ' +
        'crit power base ' + Math.round(DEFAULT_CRIT_POWER_BASE * 100) + '%).');
    }

    var statsDef = Array.isArray(data.stats) ? data.stats : [];
    if (!statsDef.length) pushUnique(assumptions, 'data.stats is empty/missing — the character sheet has no stat entries.');
    var statsById = {};
    statsDef.forEach(function (s) { statsById[s.id] = s; });
    ctx.statsDef = statsDef;
    ctx.statsById = statsById;
    var missingCore = CORE_STAT_IDS.filter(function (id) { return !statsById[id]; });
    if (missingCore.length) pushUnique(assumptions, 'data.stats does not define: ' + missingCore.join(', ') + ' — these contribute 0 to every formula that needs them.');

    ctx.level = Math.max(1, Math.min(40, Math.round(num(build.lvl, 1))));

    /* ── Héros / mastery (structure) ── */
    var heroes = Array.isArray(data.heroes) ? data.heroes : [];
    var hero = null, mastery = null;
    if (build.hero) {
      hero = heroes.filter(function (h) { return h.id === build.hero; })[0] || null;
      if (!hero) ctx.warn("Unknown hero id '" + build.hero + "' — no hero selected.");
    }
    if (hero) {
      var masteries = hero.masteries || [];
      mastery = masteries.filter(function (m) { return m.id === build.mastery; })[0] || masteries[0] || null;
      if (build.mastery && mastery && mastery.id !== build.mastery) ctx.warn("Unknown mastery id '" + build.mastery + "' for hero '" + hero.id + "' — defaulted to first mastery.");
    }
    if (!hero) pushUnique(assumptions, 'No hero selected — base stats and kit abilities contribute 0.');
    ctx.hero = hero;
    ctx.mastery = mastery;

    /* ── Résolution de structure : armes / artefacts ── */
    var weaponSlotsDef = deriveWeaponSlots(mastery);
    var buildWeapons = Array.isArray(build.weapons) ? build.weapons : [];
    ctx.resolvedWeapons = weaponSlotsDef.map(function (slotDef, i) { return resolveWeaponSlot(buildWeapons[i], slotDef, data, ctx); });
    var buildArtifacts = Array.isArray(build.artifacts) ? build.artifacts.slice(0, 6) : [];
    ctx.resolvedArtifacts = [];
    for (var ai = 0; ai < 6; ai++) ctx.resolvedArtifacts.push(resolveArtifactSlot(buildArtifacts[ai], data, statsDef, ctx));

    /* Précédence customEffects explicites sur les contributions de bande. */
    ctx.overriddenGearSources = {};
    (Array.isArray(build.customEffects) ? build.customEffects : []).forEach(function (ce) {
      if (ce && typeof ce === 'object' && typeof ce.source === 'string' && /^(chip|rune):/.test(ce.source)) ctx.overriddenGearSources[ce.source] = true;
    });

    /* ── Courbe de DR ── */
    var drModel = (data.combat && data.combat.dr_model) || null;
    var drOverrideVal = (options.drOverride && isNum(options.drOverride.post_threshold_efficiency)) ? options.drOverride.post_threshold_efficiency : undefined;
    ctx.drPostEfficiency = isNum(drOverrideVal) ? drOverrideVal
      : (drModel && isNum(drModel.post_threshold_efficiency) ? drModel.post_threshold_efficiency : DEFAULT_DR_POST_EFFICIENCY);
    if (drModel && drModel.note) {
      pushUnique(assumptions, 'DR curve: ' + drModel.note + ' (post-threshold efficiency used = ' + ctx.drPostEfficiency + (drOverrideVal !== undefined ? ', overridden via options.drOverride' : '') + ').');
    } else {
      pushUnique(assumptions, 'DR curve is an assumption (no data.combat.dr_model) — piecewise linear, full value to threshold then ' + Math.round(ctx.drPostEfficiency * 100) + '% efficiency beyond it.');
    }

    /* ══════════════════════════════════════════════════════════════
       FABRICATION DES CONTRIBUTEURS — un par entité équipée/sélectionnée.
       ══════════════════════════════════════════════════════════════ */
    var contributors = []
      .concat(makeHeroBaseContributor(ctx))
      .concat(makeWeaponContributors(ctx))
      .concat(makeChipContributors(ctx))
      .concat(makeArtifactContributors(ctx))
      .concat(makeRuneContributors(ctx))
      .concat(makeTalentContributors(ctx))
      .concat(makeUniversalSpellContributors(ctx))
      .concat(makeCustomEffectContributors(ctx))
      .concat(makeMasteryContributors(ctx))
      .concat(makeItemPassiveContributors(ctx))
      .concat(makeTargetContributor(ctx));

    /* ══════════════════════════════════════════════════════════════
       PHASE 1 — RATINGS : chaque contributeur dépose ses lignes.
       ══════════════════════════════════════════════════════════════ */
    contributors.forEach(function (c) { if (c.runRatings) c.runRatings(); });

    /* ══════════════════════════════════════════════════════════════
       PHASE 2 — CONVERSION : la fiche (DR + rating→%).
       ══════════════════════════════════════════════════════════════ */
    var sheetStats = buildSheet(ctx);
    ctx.sheetStats = sheetStats;
    ctx.getRating = function (id) { return (sheetStats[id] && isNum(sheetStats[id].rating)) ? sheetStats[id].rating : 0; };
    ctx.getPct = function (id) { return (sheetStats[id] && isNum(sheetStats[id].pct)) ? sheetStats[id].pct : 0; };
    ctx.getEffective = function (id) { return (sheetStats[id] && isNum(sheetStats[id].effective)) ? sheetStats[id].effective : 0; };

    /* ══════════════════════════════════════════════════════════════
       PHASE 3 — DERIVED : cible/mitigation (contributeur), crit, CDR.
       ══════════════════════════════════════════════════════════════ */
    contributors.forEach(function (c) { if (c.runDerived) c.runDerived(); });

    var hasCritBase = data.combat && isNum(data.combat.crit_base_power);
    var critPowerBase = hasCritBase ? data.combat.crit_base_power : DEFAULT_CRIT_POWER_BASE;
    if (!hasCritBase) pushUnique(assumptions, 'No sourced base crit-power multiplier (data.combat.crit_base_power) — assuming ' + Math.round(critPowerBase * 100) + '% base; stat bonus is additive on top.');
    pushUnique(assumptions, 'Crit formula: 1 + critChance×(critPower−1), crit chance capped at 100%.');
    var ccPhys = clamp01(ctx.getPct('physical_crit_chance'));
    var cpPhys = critPowerBase + ctx.getPct('physical_crit_power');
    var critMultPhys = 1 + ccPhys * (cpPhys - 1);
    var ccMag = clamp01(ctx.getPct('magical_crit_chance'));
    var cpMag = critPowerBase + ctx.getPct('magical_crit_power');
    var critMultMag = 1 + ccMag * (cpMag - 1);
    ctx.critMultPhys = critMultPhys;
    ctx.critMultMag = critMultMag;

    pushUnique(assumptions, 'Cooldown reduction formula: cooldown / (1 + cdr%).');
    ctx.cdrPct = ctx.getPct('cooldown_reduction');
    ctx.hspPct = ctx.getPct('heal_shield_power');

    /* ══════════════════════════════════════════════════════════════
       PHASE 4 — OFFENSE : attaque de base, rotation, actives, HPS.
       (Assemblage structurel : synthèse des sorties des contributeurs.)
       ══════════════════════════════════════════════════════════════ */

    /* ── Attaque de base — branche sur mastery.damage_type (v2). ── */
    var basicKind = 'physical';
    if (mastery) {
      if (mastery.damage_type === 'magical') {
        basicKind = 'magical';
        pushUnique(assumptions, 'Basic attacks are magical for this mastery (damage_type) — scaling 1 Spell Power = +1 damage, checked against target magic resistance with magical crit.');
      } else if (mastery.damage_type == null) {
        pushUnique(assumptions, 'Mastery has no damage_type in data — basic attacks assumed physical.');
      }
    }

    var primaryWeaponInfo = null;
    for (var wi = 0; wi < ctx.resolvedWeapons.length; wi++) { if (ctx.resolvedWeapons[wi]) { primaryWeaponInfo = ctx.weaponInfos[wi]; break; } }

    /* Cadence : attack_time réel > combat.weapon_base.default > baseline
       1.0 att/s (la baseline ne fabrique jamais de dégâts : hit 0 → 0). */
    var baseAttacksPerS;
    if (primaryWeaponInfo && isNum(primaryWeaponInfo.attack_time) && primaryWeaponInfo.attack_time > 0) {
      baseAttacksPerS = 1 / primaryWeaponInfo.attack_time;
    } else {
      var noSpeedWhy = primaryWeaponInfo ? 'Equipped weapon has no attack-speed (attack_time) data' : 'No weapon equipped';
      var wbDefault = data.combat && data.combat.weapon_base && data.combat.weapon_base['default'];
      if (wbDefault && isNum(wbDefault.attack_time) && wbDefault.attack_time > 0) {
        baseAttacksPerS = 1 / wbDefault.attack_time;
        pushUnique(assumptions, noSpeedWhy + ' — using the data-provided default attack time of ' + wbDefault.attack_time + 's (combat.weapon_base.default).');
      } else {
        baseAttacksPerS = DEFAULT_BASELINE_ATTACKS_PER_S;
        pushUnique(assumptions, noSpeedWhy + ' — assuming a baseline of ' + DEFAULT_BASELINE_ATTACKS_PER_S.toFixed(1) + ' attacks per second so flat Attack Power / Weapon Damage still yield basic-attack DPS.');
      }
    }
    var attackSpeedPct = ctx.getPct('attack_speed');
    /* v3 : haste distinct du CDR — famille attack-speed (additif). */
    var hastePct = ctx.getPct('haste');
    if (hastePct) pushUnique(assumptions, 'Haste is treated as attack-speed-family (added to the attack-speed percentage) — its exact role vs Attack Speed is not sourced.');
    var attacksPerS = Math.max(0, baseAttacksPerS * (1 + attackSpeedPct + hastePct)); // clamp v2 : jamais négatif

    var weaponDamageRating = ctx.getRating('weapon_damage');
    var basicScaleStat = basicKind === 'magical' ? 'spell_power' : 'attack_power';
    var apBonus = ctx.getRating(basicScaleStat) * DEFAULT_AP_TO_DAMAGE_COEFF;
    if (basicKind === 'physical') {
      pushUnique(assumptions, '1 Attack Power = +' + DEFAULT_AP_TO_DAMAGE_COEFF + ' flat physical damage per basic-attack hit (assumption; no sourced AP→damage scaling formula found).');
    }
    var basicMitigation = basicKind === 'magical' ? ctx.mitigationMagical : ctx.mitigationPhysical;
    var basicCritMult = basicKind === 'magical' ? critMultMag : critMultPhys;
    var preMitigationHit = weaponDamageRating + apBonus;
    var postMitigationHit = preMitigationHit * (1 - basicMitigation);
    var expectedBasicHit = postMitigationHit * basicCritMult;
    var basicValue = expectedBasicHit * attacksPerS;

    /* ── Rotation — Q/W/E/R recastés à cadence effective (CDR, cast time,
       DoT), ajustements de maîtrise et overrides utilisateur. ── */
    var rotationModeBuild = build.rotationMode === 'autos' ? 'autos' : 'full';
    if (rotationModeBuild === 'autos') pushUnique(assumptions, "Rotation mode 'autos' — ability casts excluded from DPS (auto-attacks and artifact actives only).");
    var rotationLabel = rotationModeBuild === 'autos' ? 'autos' : (options.rotation === 'priority' ? 'priority' : 'spam');
    if (options.rotation === 'priority') pushUnique(assumptions, "Rotation mode 'priority' is not separately specified — computed identically to 'spam' (each ability recast on cooldown).");
    var abilityOverrides = (build.abilityOverrides && typeof build.abilityOverrides === 'object') ? build.abilityOverrides : {};

    var perAbility = [];
    var rotationPhysical = 0, rotationMagical = 0;
    var rotationAbilityCount = 0, rotationSourcedCount = 0;
    if (mastery && Array.isArray(mastery.abilities)) {
      mastery.abilities.filter(function (ab) { return ROTATION_SLOTS.indexOf(ab.slot) !== -1; }).forEach(function (ab) {
        rotationAbilityCount++;
        var merged = mergeAbilityOverride(ab, abilityOverrides[ab.slot], statsById, ctx);
        var masteryAdj = ctx.masterySummary.bySlot[ab.slot] || null;
        var res = abilityDamageAndCadence(ab.name || ab.slot, merged.params, sheetStats, ctx.cdrPct, ctx, masteryAdj);
        var notes = res.notes.slice();
        if (masteryAdj) notes = notes.concat(masteryAdj.notes);
        if (merged.overridden) notes.push('user override');
        if (merged.params && merged.params.confidence === 'low') {
          notes.push('low-confidence numbers');
          ctx.warn("Ability '" + (ab.name || ab.slot) + "' numeric params are flagged low-confidence — treat its DPS line as indicative.");
        }
        if (res.hasNumbers) rotationSourcedCount++;
        var isMagical = res.kind === 'magical';
        var mitig = isMagical ? ctx.mitigationMagical : ctx.mitigationPhysical;
        var crit = isMagical ? critMultMag : critMultPhys;
        var expected = res.raw * (1 - mitig) * crit;
        var upt = isNum(ctx.uptimes[ab.slot]) ? clamp01(ctx.uptimes[ab.slot]) : 1;
        var dpsVal = rotationModeBuild === 'autos' ? 0 : (expected / res.cadence) * upt;
        if (rotationModeBuild === 'autos') notes.push("excluded (rotation mode 'autos')");
        if (isMagical) rotationMagical += dpsVal; else rotationPhysical += dpsVal;
        perAbility.push({
          slot: ab.slot, name: ab.name || null, damage_per_cast: expected,
          effective_cooldown_s: res.cadence, dps: dpsVal, kind: res.kind,
          notes: notes,
        });
      });
    }
    if (rotationAbilityCount > 0 && rotationSourcedCount < rotationAbilityCount) {
      ctx.warn(rotationSourcedCount + '/' + rotationAbilityCount + ' rotation abilities have sourced numbers — rotation DPS is a lower bound.');
    }
    var rotationValue = rotationPhysical + rotationMagical;

    /* ── Actives/HPS : contributeurs de phase offense (passifs d'objet,
       actives héritées, sorts universels). ── */
    contributors.forEach(function (c) { if (c.runOffense) c.runOffense(); });

    /* ── Chips/runes : effets actifs des templates de bande (queue v4). ── */
    var gearInfoOnly = 0;
    ctx.pendingGearActives.forEach(function (p) {
      if (p.type === 'template' || p.type === 'rune_param') {
        var cdMatch = /\[cd\]\s*(\d+(?:\.\d+)?)\s*sec/i.exec(p.text);
        var eff = parseItemEffect(p.text, cdMatch ? Number(cdMatch[1]) : null);
        if (eff) {
          var amount = eff.base;
          eff.parts.forEach(function (part) { amount += part.coeff * ctx.getRating(part.stat); });
          var cd = eff.cooldown_s / Math.max(0.01, 1 + ctx.cdrPct);
          var factor = eff.kind === 'magical' ? (1 - ctx.mitigationMagical) : (eff.kind === 'physical' ? (1 - ctx.mitigationPhysical) : 1);
          var upt = isNum(ctx.uptimes[p.name]) ? clamp01(ctx.uptimes[p.name]) : 1;
          var perSecond = (amount * factor / cd) * upt;
          ctx.actives.push({ name: p.name, source: p.source, dps_or_hps: perSecond, cooldown_s: cd, kind: eff.kind === 'heal' ? 'heal' : 'damage' });
          if (eff.kind !== 'heal') ctx.activesDamageSum += perSecond;
          if (p.contributor) p.contributor.contribute('dps.actives', perSecond, eff.kind + ' every ' + cd.toFixed(1) + 's');
          pushUnique(assumptions, 'Chip effect templates with parseable formulas are cast on cooldown at their band value (CDR applied, target mitigation by damage type, no crit, 100% trigger uptime unless options.uptimes says otherwise) — assumption.');
          return;
        }
      }
      gearInfoOnly++;
      ctx.actives.push({ name: p.name, source: p.source, dps_or_hps: 0, cooldown_s: null, kind: 'info' });
      if (p.contributor) p.contributor.info(p.infoTarget || 'info', isNum(p.infoValue) ? p.infoValue : 0, 'info-only band value');
    });
    if (gearInfoOnly) {
      pushUnique(assumptions, gearInfoOnly + ' equipped chip/rune effect(s) have no cleanly parseable formula — listed info-only at their band value; use customEffects for a manual estimate.');
    }
    if (ctx.itemInfoOnly) {
      pushUnique(assumptions, ctx.itemInfoOnly + ' equipped item passive/active effect(s) have no cleanly parseable numbers — listed as info-only (0 DPS); use customEffects for a manual estimate.');
    }

    /* ── TOTAL — multiplicateur global de talents en dernier. ── */
    var globalDamagePct = 0;
    ctx.globalMods.forEach(function (m) {
      if (m.unit === '%') { globalDamagePct += m.value / 100; }
      else { ctx.warn("Talent modifier on non-stat target '" + m.stat + "' with unit '" + m.unit + "' has no defined semantics — ignored."); }
    });
    if (globalDamagePct) pushUnique(assumptions, "Talent modifiers on targets with no matching data.stats id (e.g. 'damage') are applied as a flat " + (globalDamagePct * 100).toFixed(1) + '% multiplier on total DPS (basic + rotation + damaging actives).');

    var physicalSum = (basicKind === 'physical' ? basicValue : 0) + rotationPhysical;
    var magicalSum = (basicKind === 'magical' ? basicValue : 0) + rotationMagical;
    var preGlobalTotal = physicalSum + magicalSum + ctx.activesDamageSum;
    var totalValue = preGlobalTotal * (1 + globalDamagePct);
    var shareDenom = physicalSum + magicalSum;
    var physicalShare = shareDenom > 0 ? physicalSum / shareDenom : 0;
    var magicalShare = shareDenom > 0 ? magicalSum / shareDenom : 0;

    /* ── DERIVED / SUSTAIN / AGGRO ── */
    var selfKPhysical = resolveMitigationK('armor', ctx.level, data, ctx);
    var selfKMagical = resolveMitigationK('magic_resistance', ctx.level, data, ctx);
    /* v3 : la mitigation personnelle lit la valeur EFFECTIVE (post-DR 260). */
    var selfMitigationPhysical = mitigationPct(ctx.getEffective('armor'), 0, selfKPhysical, 0);
    var selfMitigationMagical = mitigationPct(ctx.getEffective('magic_resistance'), 0, selfKMagical, 0);
    var health = ctx.getRating('health');
    /* v3 : shield block = réduction moyenne (chance × puissance) sur l'EHP physique. */
    var blockFactor = clamp01(ctx.getPct('shield_block_chance')) * clamp01(ctx.getPct('shield_block_power'));
    if (blockFactor > 0) pushUnique(assumptions, 'Shield block modeled as an average incoming-damage reduction (chance × power) on physical EHP — assumption.');
    var ehpPhysical = health / Math.max(1e-9, (1 - selfMitigationPhysical) * (1 - blockFactor));
    var ehpMagical = health / Math.max(1e-9, (1 - selfMitigationMagical));

    var aggroMultiplier = 1 + ctx.aggroPoints / 100;
    if (ctx.aggroAny) pushUnique(assumptions, 'Aggro modifiers combine additively into a single multiplier (1 + Σ%/100) — assumption; no sourced aggro formula.');

    var derived = {
      basic_damage: expectedBasicHit,
      basic_damage_kind: basicKind,
      attacks_per_s: attacksPerS,
      crit_multiplier_effective: critMultPhys,
      crit_multiplier_effective_magical: critMultMag,
      crit_power_physical: cpPhys,
      crit_power_magical: cpMag,
      ehp_physical: ehpPhysical,
      ehp_magical: ehpMagical,
      aggro_multiplier: aggroMultiplier,
      talent_global_damage_pct: globalDamagePct,
    };

    var sustain = {
      ehp_physical: ehpPhysical,
      ehp_magical: ehpMagical,
      hps_total: ctx.hpsTotal,
      health_regen_rating: ctx.getRating('health_regen'),
      mana_regen_rating: ctx.getRating('mana_regen'),
      note: 'regen rating→per-second conversion is not sourced — regen shown as raw rating',
    };

    /* ══════════════════════════════════════════════════════════════
       PHASE 5 — AUDIT : une entrée par entité (garantie de complétude).
       ══════════════════════════════════════════════════════════════ */
    var auditContributors = [];
    var bySource = {};
    var appliedCount = 0, inertCount = 0;
    contributors.forEach(function (c) {
      if (c.hiddenFromAudit) return; // porteurs techniques (résumé de maîtrise)
      var rep = c.report();
      auditContributors.push(rep);
      bySource[rep.id] = rep.contributions;
      if (rep.applied) appliedCount++; else inertCount++;
    });

    return {
      sheet: { stats: sheetStats, derived: derived },
      dps: {
        basic: {
          value: basicValue,
          kind: basicKind,
          breakdown: { base: weaponDamageRating, ap_bonus: apBonus, crit_bonus: basicCritMult, attack_speed_factor: attacksPerS, pen_factor: 1 - basicMitigation },
        },
        rotation: { value: rotationValue, mode: rotationLabel, per_ability: perAbility },
        actives: ctx.actives,
        hps: { value: ctx.hpsTotal, per_spell: ctx.hpsPerSpell },
        sustain: sustain,
        total: { value: totalValue, physical_share: physicalShare, magical_share: magicalShare },
        target: {
          armor: ctx.targetArmor, mres: ctx.targetMres,
          mitigation_physical_pct: ctx.mitigationPhysical, mitigation_magical_pct: ctx.mitigationMagical,
          k_physical: ctx.targetKPhysical, k_magical: ctx.targetKMagical, // K réellement utilisé (sourcé ou défaut)
        },
      },
      /* v3 : résumé de la maîtrise d'arme (masteryAlloc + perks T3). */
      mastery: {
        active: ctx.masterySummary.active,
        spec: ctx.masterySummary.spec,
        points_spent: ctx.masterySummary.points_spent,
        points_max: ctx.masterySummary.points_max,
        nodes_applied: ctx.masterySummary.nodes_applied,
        unparsed_nodes: ctx.masterySummary.unparsed_nodes,
        edges_bought: ctx.masterySummary.edges_bought,
      },
      /* v5 : audit par entité — rien ne peut être ignoré en silence. */
      audit: {
        contributors: auditContributors,
        totals: { applied: appliedCount, inert: inertCount },
        by_source: bySource,
      },
      assumptions: assumptions,
      warnings: warnings,
    };
  }

  /**
   * Analyse de sensibilité par différences finies (+10 rating flat par
   * stat sondée via un customEffect non mutant) — trié décroissant.
   * @param {string[]} [statIds] - défaut : 7 stats principales + toute
   *   secondaire dont le rating courant est > 0.
   * @returns {{stat: string, dDpsPer10: number}[]}
   */
  function sensitivity(build, data, options, statIds) {
    build = (build && typeof build === 'object') ? build : {};
    var base = compute(build, data, options);
    var baseline = base.dps.total.value;
    var ids;
    if (Array.isArray(statIds) && statIds.length) {
      ids = statIds.slice();
    } else {
      ids = [];
      var stats = (data && Array.isArray(data.stats)) ? data.stats : [];
      stats.forEach(function (s) {
        if (s.kind === 'main') ids.push(s.id);
        else if (s.kind === 'secondary' && base.sheet.stats[s.id] && base.sheet.stats[s.id].rating > 0) ids.push(s.id);
      });
    }
    var results = ids.map(function (id) {
      var probe = {};
      Object.keys(build).forEach(function (k) { probe[k] = build[k]; });
      probe.customEffects = (Array.isArray(build.customEffects) ? build.customEffects : [])
        .concat([{ source: 'sensitivity-probe', stat: id, value: 10, unit: 'flat', uptime: 1 }]);
      var v = compute(probe, data, options).dps.total.value;
      return { stat: id, dDpsPer10: v - baseline };
    });
    results.sort(function (a, b) { return b.dDpsPer10 - a.dDpsPer10; });
    return results;
  }

  /**
   * Dérivation d'affichage des étoiles (v4) : position d'un roll dans sa
   * bande [min,max] — stars = 1 + floor(4×(value−min)/max(1,max−min)),
   * borné 1..5 ; null si bande/valeur invalide.
   * @param {number} value @param {[number, number]} band
   * @returns {number|null}
   */
  function deriveStars(value, band) {
    return starsFromBand(value, band);
  }

  /**
   * Rapport d'un contributeur précis (v5) — commodité UI : recalcule le
   * build et retourne l'entrée d'audit dont l'id correspond, ou null.
   * @param {string} contributorId - ex. "item_passive:a0:art_t3_arcane_buster"
   * @returns {object|null}
   */
  function explain(build, data, options, contributorId) {
    var r = compute(build, data, options);
    return r.audit.contributors.filter(function (c) { return c.id === contributorId; })[0] || null;
  }

  return { compute: compute, sensitivity: sensitivity, deriveStars: deriveStars, explain: explain };
});
