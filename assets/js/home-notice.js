(() => {
  'use strict';

  const notice = document.getElementById('toolNotice');
  if (!notice) return;

  const closeButton = notice.querySelector('[data-notice-close]');
  const textNodes = {
    label: notice.querySelector('[data-notice-label]'),
    title: notice.querySelector('[data-notice-title]'),
    copy: notice.querySelector('[data-notice-copy]'),
    action: notice.querySelector('[data-notice-action]'),
  };
  const copy = {
    en: {
      label: 'NEW TOOL',
      title: 'Free website audit',
      copy: 'Check a website’s speed, SEO, security, and mobile basics in seconds.',
      action: 'Explore the tool',
      dismiss: 'Dismiss notification',
    },
    ro: {
      label: 'INSTRUMENT NOU',
      title: 'Audit gratuit pentru site',
      copy: 'Verifică în câteva secunde viteza, SEO, securitatea și experiența pe mobil.',
      action: 'Descoperă instrumentul',
      dismiss: 'Închide notificarea',
    },
    ru: {
      label: 'НОВЫЙ ИНСТРУМЕНТ',
      title: 'Бесплатный аудит сайта',
      copy: 'Проверьте скорость, SEO, безопасность и мобильную версию сайта за секунды.',
      action: 'Открыть инструмент',
      dismiss: 'Закрыть уведомление',
    },
  };

  function updateLanguage() {
    const words = copy[document.documentElement.lang] || copy.en;
    textNodes.label.textContent = words.label;
    textNodes.title.textContent = words.title;
    textNodes.copy.textContent = words.copy;
    textNodes.action.firstChild.textContent = `${words.action} `;
    closeButton.setAttribute('aria-label', words.dismiss);
  }

  let alreadyDismissed = false;
  try { alreadyDismissed = sessionStorage.getItem('mw_audit_notice_dismissed') === '1'; } catch (error) {}
  if (alreadyDismissed) return;

  updateLanguage();
  const languageObserver = new MutationObserver(updateLanguage);
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  const showTimer = window.setTimeout(() => {
    notice.classList.add('is-visible');
    notice.setAttribute('aria-hidden', 'false');
  }, 900);

  closeButton.addEventListener('click', () => {
    window.clearTimeout(showTimer);
    notice.classList.remove('is-visible');
    notice.setAttribute('aria-hidden', 'true');
    try { sessionStorage.setItem('mw_audit_notice_dismissed', '1'); } catch (error) {}
    languageObserver.disconnect();
  });
})();
