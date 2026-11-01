(() => {
  'use strict';

  const track = document.querySelector('[data-client-track]');
  const original = track?.querySelector('.client-set');
  if (!track || !original) return;

  const translations = {
    en: {
      role: 'Partner',
      plan: 'Growth plan',
      quote: '“We are extremely satisfied with Midnight Webs services. The team is responsible and dedicated to what they do. We’ve got many advantages and cheaper prices by our partnership. They created exactly what we wanted and delivered it before the deadline. We strongly recommend Midnight Webs to any studio or business that want a modern and working site at a cheaper price than usual.”',
    },
    ro: {
      role: 'Partener',
      plan: 'Planul Growth',
      quote: '„Suntem extrem de mulțumiți de serviciile Midnight Webs. Echipa este responsabilă și dedicată muncii sale. Parteneriatul nostru ne-a adus multe avantaje și prețuri mai mici. Au creat exact ce ne-am dorit și au livrat proiectul înainte de termen. Recomandăm cu încredere Midnight Webs oricărui studio sau oricărei afaceri care își dorește un site modern și funcțional, la un preț mai mic decât de obicei.”',
    },
    ru: {
      role: 'Партнёр',
      plan: 'План Growth',
      quote: '«Мы очень довольны услугами Midnight Webs. Команда ответственная и предана своему делу. Благодаря партнёрству мы получили много преимуществ и более выгодные цены. Они создали именно то, что мы хотели, и завершили работу раньше срока. Мы настоятельно рекомендуем Midnight Webs любой студии или компании, которой нужен современный и функциональный сайт по цене ниже обычной.»',
    },
  };

  function setLanguage() {
    const words = translations[document.documentElement.lang] || translations.en;
    track.querySelectorAll('[data-client2-role]').forEach(node => { node.textContent = words.role; });
    track.querySelectorAll('[data-client2-plan]').forEach(node => { node.textContent = words.plan; });
    track.querySelectorAll('[data-client2-quote]').forEach(node => { node.textContent = words.quote; });
  }

  function buildLoop() {
    track.querySelectorAll('.client-set[data-clone]').forEach(node => node.remove());
    while (track.children.length < 4) {
      const clone = original.cloneNode(true);
      clone.setAttribute('data-clone', '');
      clone.setAttribute('aria-hidden', 'true');
      clone.querySelectorAll('a').forEach(link => link.setAttribute('tabindex', '-1'));
      track.appendChild(clone);
    }
    setLanguage();
  }

  buildLoop();
  const languageObserver = new MutationObserver(setLanguage);
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
})();
