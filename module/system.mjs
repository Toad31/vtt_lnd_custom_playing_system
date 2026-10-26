const STATS = ["dexterite", "force", "intelligence", "charisme"];

/** +1 par point au-dessus de 5 (arrondi au supérieur). */
export function statModifier(value) {
  return Math.max(0, Math.ceil((Number(value) || 0) - 5));
}

export class CustomActor extends Actor {
  prepareDerivedData() {
    const s = this.system;
    if (!s.stats) return;
    for (const k of STATS) s.stats[k].mod = statModifier(s.stats[k].value);
    s.armure = 5 + s.stats.force.mod;
  }

  /** Armure de la première cible, ou null. */
  static targetArmor() {
    const t = game.user.targets.first();
    return t?.actor?.system?.armure ?? null;
  }

  async #prompt(title, fields) {
    const content = fields.map(f =>
      `<div class="form-group"><label>${f.label}</label><input type="${f.type ?? "text"}" name="${f.name}" value="${f.value ?? ""}"></div>`).join("");
    return foundry.applications.api.DialogV2.prompt({
      window: { title }, content, rejectClose: false,
      ok: { callback: (ev, btn) => new foundry.applications.ux.FormDataExtended(btn.form).object }
    });
  }

  async #chat(flavor, roll) {
    return roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this }), flavor });
  }

  /** Jet de 1d10 + modificateur de la caractéristique. */
  async rollStat(stat, flavor = "", extra = "") {
    const mod = this.system.stats[stat].mod;
    const roll = await new Roll(`1d10 + ${mod}`).evaluate();
    await this.#chat(`${flavor}${extra}`, roll);
    return roll;
  }

  async #damageRoll(formula, flavor) {
    const r = await new Roll(formula).evaluate();
    await this.#chat(flavor, r);
    return r;
  }

  async attack(weapon) {
    const stat = weapon.system.stat;
    const armor = CustomActor.targetArmor();
    const roll = await this.rollStat(stat, `${weapon.name} — ${game.i18n.localize("LND.Attack")}`,
      armor === null ? "" : ` (${game.i18n.localize("LND.Armor")} ${armor})`);
    if (armor === null) return roll;
    if (roll.total > armor) await this.#damageRoll(weapon.system.damage, `${weapon.name} — ${game.i18n.localize("LND.Damage")}`);
    else ui.notifications.info(game.i18n.localize("LND.Miss"));
    return roll;
  }

  async castSpell(spell) {
    const kind = spell.system.kind;
    const label = spell.name;
    if (kind === "heal") {
      return this.#damageRoll(spell.system.heal, `${label} — ${game.i18n.localize("LND.Heal")}`);
    }
    if (kind === "attack") {
      const armor = CustomActor.targetArmor();
      const roll = await this.rollStat("intelligence", label, armor === null ? "" : ` (${game.i18n.localize("LND.Armor")} ${armor})`);
      if (armor !== null && roll.total > armor) await this.#damageRoll(spell.system.damage, `${label} — ${game.i18n.localize("LND.Damage")}`);
      return roll;
    }
    return this.#rollVsDifficulty("intelligence", label);
  }

  async useSkill(skill) {
    return this.#rollVsDifficulty(skill.system.stat, skill.name);
  }

  async #rollVsDifficulty(stat, label) {
    const data = await this.#prompt(label, [{ label: game.i18n.localize("LND.Difficulty"), name: "dc", type: "number", value: 10 }]);
    if (!data) return;
    const dc = Number(data.dc);
    const roll = await this.rollStat(stat, label, ` (${game.i18n.localize("LND.Difficulty")} ${dc})`);
    ui.notifications.info(game.i18n.localize(roll.total >= dc ? "LND.Success" : "LND.Failure"));
    return roll;
  }

  /** Actions génériques de la fiche. */
  async doAction(action) {
    switch (action) {
      case "heal": {
        const data = await this.#prompt(game.i18n.localize("LND.Heal"), [{ label: game.i18n.localize("LND.HealFormula"), name: "f", value: "1d6" }]);
        if (!data) return;
        return this.#damageRoll(`${data.f} + ${this.system.stats.charisme.mod}`, game.i18n.localize("LND.Heal"));
      }
      case "move":
        return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: this }), content: game.i18n.localize("LND.MoveMsg") });
      case "interact":
        return this.#rollVsDifficulty("force", game.i18n.localize("LND.Interact"));
      case "other": {
        const data = await this.#prompt(game.i18n.localize("LND.Other"), [{ label: game.i18n.localize("LND.Describe"), name: "text" }]);
        if (!data) return;
        return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: this }), content: foundry.utils.escapeHTML(data.text) });
      }
    }
  }
}

export class CustomActorSheet extends ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["lnd", "sheet", "actor"], template: "systems/vtt-lnd-custom/templates/actor/actor-sheet.hbs",
      width: 600, height: 700
    });
  }

  async getData() {
    const ctx = await super.getData();
    ctx.system = this.actor.system;
    ctx.statList = STATS.map(k => ({ key: k, ...this.actor.system.stats[k] }));
    const by = t => this.actor.items.filter(i => i.type === t);
    Object.assign(ctx, { weapons: by("weapon"), spells: by("spell"), skills: by("skill"), objects: by("object") });
    return ctx;
  }

  activateListeners(html) {
    super.activateListeners(html);
    if (!this.isEditable) return;
    const item = el => this.actor.items.get(el.closest("[data-item-id]").dataset.itemId);
    html.find("[data-action]").click(ev => this.actor.doAction(ev.currentTarget.dataset.action));
    html.find(".stat-roll").click(ev => this.actor.rollStat(ev.currentTarget.dataset.stat, game.i18n.localize(`LND.${ev.currentTarget.dataset.stat}`)));
    html.find(".item-use").click(ev => {
      const i = item(ev.currentTarget);
      if (i.type === "weapon") this.actor.attack(i);
      else if (i.type === "spell") this.actor.castSpell(i);
      else if (i.type === "skill") this.actor.useSkill(i);
    });
    html.find(".item-edit").click(ev => item(ev.currentTarget).sheet.render(true));
    html.find(".item-delete").click(ev => item(ev.currentTarget).delete());
  }
}

export class CustomItemSheet extends ItemSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["lnd", "sheet", "item"], template: "systems/vtt-lnd-custom/templates/item/item-sheet.hbs",
      width: 450, height: 400
    });
  }

  async getData() {
    const ctx = await super.getData();
    ctx.system = this.item.system;
    ctx.statChoices = Object.fromEntries(STATS.map(k => [k, `LND.${k}`]));
    return ctx;
  }
}

Hooks.once("init", () => {
  CONFIG.Actor.documentClass = CustomActor;
  CONFIG.Combat.initiative = { formula: "1d10 + @stats.dexterite.mod", decimals: 0 };
  Actors.unregisterSheet("core", ActorSheet);
  Actors.registerSheet("vtt-lnd-custom", CustomActorSheet, { makeDefault: true });
  Items.unregisterSheet("core", ItemSheet);
  Items.registerSheet("vtt-lnd-custom", CustomItemSheet, { makeDefault: true });
  Handlebars.registerHelper("eq", (a, b) => a === b);
  Handlebars.registerHelper("concat", (...a) => a.slice(0, -1).join(""));
});
