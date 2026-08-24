// Interface injectée (Shadow DOM) : bouton flottant, formulaire, suivi des étapes, questions à l'utilisateur

export const STEPS = [
  ['prepare', 'Connexion Brevo & attributs'],
  ['website', 'Site web de la société'],
  ['phone', 'Coordonnées'],
  ['company', 'Société dans Brevo'],
  ['contact', 'Création du contact'],
  ['enrich', 'Infos société (effectif, CA, statut, siège)'],
  ['open', 'Ouverture de la fiche Brevo'],
];

const FIELDS = [
  ['firstName', 'Prénom'],
  ['lastName', 'Nom'],
  ['title', 'Titre de poste'],
  ['company', 'Société'],
  ['email', 'Email'],
  ['phone', 'Téléphone'],
  ['companyWebsite', 'Site web société'],
  ['language', 'Langue'],
];

const ICONS = { pending: '○', running: '◌', done: '✓', warn: '!', error: '✕' };

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}

export class Panel {
  constructor({ onFabClick, onSubmit, onOpenOptions }) {
    this.onFabClick = onFabClick;
    this.onSubmit = onSubmit;
    this.onOpenOptions = onOpenOptions;
    this.hidden = {};
    this.busy = false;
  }

  async mount() {
    if (document.getElementById('lib-brevo-host')) return;
    this.host = el('div', { id: 'lib-brevo-host' });
    this.shadow = this.host.attachShadow({ mode: 'open' });
    let css = '';
    try {
      css = await (await fetch(chrome.runtime.getURL('src/content/ui.css'))).text();
    } catch {
      /* styles minimaux inline ci-dessous */
    }
    this.shadow.append(el('style', { text: css }));

    this.fab = el('button', { class: 'lb-fab', title: 'Ajouter ce contact à Brevo', onclick: () => this.onFabClick?.() }, [
      el('span', { class: 'lb-fab-logo', text: 'B' }),
      el('span', { text: 'Ajouter à Brevo' }),
    ]);

    this.form = el('form', { class: 'lb-form', onsubmit: (e) => this.handleSubmit(e) });
    this.inputs = {};
    for (const [name, label] of FIELDS) {
      const input = el('input', { name, type: name === 'email' ? 'email' : 'text', autocomplete: 'off', spellcheck: 'false' });
      this.inputs[name] = input;
      this.form.append(el('label', {}, [el('span', { text: label }), input]));
    }
    this.submitBtn = el('button', { type: 'submit', class: 'lb-btn lb-primary', text: 'Créer dans Brevo' });
    this.form.append(el('div', { class: 'lb-actions' }, [this.submitBtn]));

    this.status = el('div', { class: 'lb-status' });
    this.stepsEl = el('ul', { class: 'lb-steps lb-hidden' });
    this.askEl = el('div', { class: 'lb-ask lb-hidden' });
    this.resultEl = el('div', { class: 'lb-result lb-hidden' });

    this.panel = el('div', { class: 'lb-panel lb-hidden' }, [
      el('header', {}, [
        el('span', { class: 'lb-title', text: 'LinkedIn → Brevo' }),
        el('span', { class: 'lb-spacer' }),
        el('button', { class: 'lb-icon', title: 'Options', text: '⚙', onclick: () => this.onOpenOptions?.() }),
        el('button', { class: 'lb-icon', title: 'Fermer', text: '×', onclick: () => this.close() }),
      ]),
      el('div', { class: 'lb-body' }, [this.status, this.form, this.stepsEl, this.askEl, this.resultEl]),
    ]);

    this.shadow.append(el('div', { class: 'lb-root' }, [this.fab, this.panel]));
    document.documentElement.append(this.host);
  }

  showFab(visible) {
    this.fab?.classList.toggle('lb-hidden', !visible);
    if (!visible) this.close();
  }

  open() {
    this.panel.classList.remove('lb-hidden');
  }

  close() {
    if (this.busy) return;
    this.panel.classList.add('lb-hidden');
  }

  setStatus(text, kind = 'info') {
    this.status.textContent = text || '';
    this.status.className = `lb-status lb-${kind}`;
  }

  setBusy(b) {
    this.busy = b;
    this.submitBtn.disabled = b;
    for (const i of Object.values(this.inputs)) i.disabled = b;
    this.submitBtn.textContent = b ? 'En cours…' : 'Créer dans Brevo';
  }

  fillForm(profile = {}) {
    this.resultEl.classList.add('lb-hidden');
    this.stepsEl.classList.add('lb-hidden');
    this.form.classList.remove('lb-hidden');
    for (const [name] of FIELDS) this.inputs[name].value = profile[name] || '';
    this.hidden = {
      source: profile.source,
      url: profile.url,
      slug: profile.slug,
      companyLinkedInUrl: profile.companyLinkedInUrl,
    };
  }

  readForm() {
    const p = { ...this.hidden };
    for (const [name] of FIELDS) p[name] = this.inputs[name].value.trim();
    return p;
  }

  handleSubmit(e) {
    e.preventDefault();
    const p = this.readForm();
    if (!p.firstName && !p.lastName) {
      this.setStatus('Prénom ou nom requis.', 'error');
      return;
    }
    this.onSubmit?.(p);
  }

  resetSteps() {
    this.resultEl.classList.add('lb-hidden');
    this.stepsEl.replaceChildren();
    this.stepItems = {};
    for (const [id, label] of STEPS) {
      const li = el('li', { class: 'lb-step lb-pending', 'data-step': id }, [
        el('span', { class: 'lb-step-icon', text: ICONS.pending }),
        el('span', { class: 'lb-step-label', text: label }),
        el('span', { class: 'lb-step-msg' }),
      ]);
      this.stepItems[id] = li;
      this.stepsEl.append(li);
    }
    this.stepsEl.classList.remove('lb-hidden');
  }

  setStep(step, status, message) {
    const li = this.stepItems?.[step];
    if (!li) return;
    li.className = `lb-step lb-${status}`;
    li.querySelector('.lb-step-icon').textContent = ICONS[status] || ICONS.pending;
    li.querySelector('.lb-step-msg').textContent = message || '';
  }

  /** Question posée par le service worker : {kind:'input'|'confirm', title, message, placeholder, rows, links, yes, no} */
  ask(payload) {
    return new Promise((resolve) => {
      const box = this.askEl;
      box.replaceChildren();
      const finish = (value) => {
        box.classList.add('lb-hidden');
        box.replaceChildren();
        resolve({ value });
      };
      box.append(el('h4', { text: payload.title || 'Question' }));
      if (payload.message) box.append(el('p', { text: payload.message }));
      if (payload.rows?.length) {
        const table = el('table', { class: 'lb-table' }, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Champ' }), el('th', { text: 'Actuel' }), el('th', { text: 'Nouveau' })])),
          el(
            'tbody',
            {},
            payload.rows.map((r) => el('tr', {}, [el('td', { text: r.label }), el('td', { text: r.current }), el('td', { text: r.next })]))
          ),
        ]);
        box.append(table);
      }
      if (payload.links?.length) {
        box.append(
          el(
            'p',
            { class: 'lb-links' },
            payload.links.map((l) => el('a', { href: l.url, target: '_blank', rel: 'noopener', text: l.label }))
          )
        );
      }
      if (payload.kind === 'choice') {
        const name = `lb-choice-${Date.now()}`;
        const list = el(
          'div',
          { class: 'lb-choices' },
          (payload.options || []).map((o, i) =>
            el('label', { class: 'lb-choice' }, [
              el('input', { type: 'radio', name, value: String(o.value), ...(i === 0 ? { checked: '' } : {}) }),
              el('span', {}, [el('strong', { text: o.label }), o.detail ? el('small', { text: o.detail }) : null]),
            ])
          )
        );
        box.append(list);
        box.append(
          el('div', { class: 'lb-actions' }, [
            el('button', { type: 'button', class: 'lb-btn', text: payload.no || 'Aucune', onclick: () => finish(null) }),
            el('button', {
              type: 'button',
              class: 'lb-btn lb-primary',
              text: payload.yes || 'Valider',
              onclick: () => finish(list.querySelector('input:checked')?.value ?? null),
            }),
          ])
        );
      } else if (payload.kind === 'input') {
        const input = el('input', { type: 'text', placeholder: payload.placeholder || '' });
        box.append(input);
        box.append(
          el('div', { class: 'lb-actions' }, [
            el('button', { type: 'button', class: 'lb-btn', text: 'Continuer sans', onclick: () => finish('') }),
            el('button', { type: 'button', class: 'lb-btn lb-primary', text: 'Valider', onclick: () => finish(input.value.trim()) }),
          ])
        );
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(input.value.trim());
          }
        });
        setTimeout(() => input.focus(), 0);
      } else {
        box.append(
          el('div', { class: 'lb-actions' }, [
            el('button', { type: 'button', class: 'lb-btn', text: payload.no || 'Non', onclick: () => finish(false) }),
            el('button', { type: 'button', class: 'lb-btn lb-primary', text: payload.yes || 'Oui', onclick: () => finish(true) }),
          ])
        );
      }
      box.classList.remove('lb-hidden');
      this.open();
      box.scrollIntoView({ block: 'nearest' });
    });
  }

  showResult(res) {
    const box = this.resultEl;
    box.replaceChildren();
    if (!res?.ok) {
      this.setStatus('Échec.', 'error');
      box.className = 'lb-result lb-error';
      box.append(el('p', { text: res?.error || 'Erreur inconnue' }));
      if (/cl[ée] api/i.test(res?.error || '')) {
        box.append(el('button', { type: 'button', class: 'lb-btn', text: 'Ouvrir les options', onclick: () => this.onOpenOptions?.() }));
      }
    } else {
      this.setStatus(res.alreadyExisted ? 'Contact déjà présent dans Brevo.' : 'Contact créé dans Brevo.', 'ok');
      box.className = 'lb-result lb-ok';
      box.append(
        el('p', {}, [
          el('strong', { text: res.alreadyExisted ? 'Contact existant : ' : 'Contact créé : ' }),
          el('a', { href: res.url, target: '_blank', rel: 'noopener', text: res.email || res.url }),
        ])
      );
      if (res.companyName) box.append(el('p', { text: `Société : ${res.companyName}` }));
      if (res.info) {
        const i = res.info;
        const lines = [
          `SIREN ${i.siren} — ${i.nom}`,
          i.effectif && `Effectif : ${i.effectif}`,
          i.ca && `CA : ${i.ca}`,
          `Statut : ${i.statut}${i.procedure ? ` — ${i.procedure}` : ''}`,
          (i.departement || i.ville) && `Siège : ${[i.departement, i.ville].filter(Boolean).join(' · ')}`,
        ].filter(Boolean);
        box.append(el('ul', { class: 'lb-info' }, lines.map((t) => el('li', { text: t }))));
        box.append(
          el('p', { class: 'lb-links' }, [
            el('a', { href: i.annuaireUrl, target: '_blank', rel: 'noopener', text: 'Annuaire des entreprises' }),
            el('a', { href: i.societeUrl, target: '_blank', rel: 'noopener', text: 'societe.com' }),
          ])
        );
      }
      if (res.warnings?.length) box.append(el('ul', { class: 'lb-warnings' }, res.warnings.map((w) => el('li', { text: w }))));
    }
    box.classList.remove('lb-hidden');
  }
}
