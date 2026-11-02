(() => {
  const page = document.querySelector('.estimator-page');
  if (!page) return;

  const lang = page.dataset.language || 'en';

  const words = {
    en: {
      empty: 'No optional services selected',
      monthlyCustom: 'Custom monthly quote',
      month: '/ month',
      week: 'week',
      weeks: 'weeks',
      subject: 'Website project estimate inquiry',
      messages: {
        sending: 'Sending your request...',
        sent: 'Thanks. Your request has been sent and we will reply to your email shortly.',
        required: 'Please add your name and email.',
        email: 'Enter a valid email address.',
        consent: 'Please accept the privacy policy to continue.',
        captcha: 'Please complete the verification.',
        rate: 'Too many requests. Please wait a minute and try again.',
        badWords: 'Your message was flagged by our spam filter. Please rephrase it and try again.',
        sendError: 'Something went wrong. Please try again.',
      },
      labels: {
        design: 'Custom visual design',
        responsive: 'Responsive mobile and tablet layouts',
        content: 'Content structure and page copy',
        accessibility: 'Accessibility and usability review',
        login: 'User login and accounts',
        database: 'Database and data management',
        api: 'Custom API and integrations',
        admin: 'Admin dashboard',
        security: 'Advanced security requirements',
        booking: 'Bookings and contact workflows',
        seo: 'SEO setup',
        cms: 'CMS integration',
        shop: 'Online store',
        hosting: 'Hosting, SSL, and backups setup',
        maintenance: 'Ongoing maintenance',
      },
    },
    ro: {
      empty: 'Nu ai selectat servicii opționale',
      monthlyCustom: 'Ofertă lunară personalizată',
      month: '/ lună',
      week: 'săptămână',
      weeks: 'săptămâni',
      subject: 'Solicitare estimare proiect website',
      messages: {
        sending: 'Se trimite solicitarea...',
        sent: 'Mulțumim. Solicitarea a fost trimisă și îți vom răspunde pe email în curând.',
        required: 'Te rugăm să adaugi numele și emailul.',
        email: 'Introdu o adresă de email validă.',
        consent: 'Te rugăm să accepți politica de confidențialitate pentru a continua.',
        captcha: 'Te rugăm să completezi verificarea.',
        rate: 'Prea multe cereri. Te rugăm să aștepți un minut și să încerci din nou.',
        badWords: 'Mesajul a fost marcat de filtrul de spam. Te rugăm să îl reformulezi.',
        sendError: 'Ceva nu a funcționat. Te rugăm să încerci din nou.',
      },
      labels: {
        design: 'Design vizual personalizat',
        responsive: 'Layout pentru mobil și tabletă',
        content: 'Structură și texte pentru pagini',
        accessibility: 'Verificare accesibilitate și utilizare',
        login: 'Autentificare și conturi',
        database: 'Bază de date și gestionarea datelor',
        api: 'API personalizat și integrări',
        admin: 'Panou de administrare',
        security: 'Cerințe avansate de securitate',
        booking: 'Programări și fluxuri de contact',
        seo: 'Configurare SEO',
        cms: 'Integrare CMS',
        shop: 'Magazin online',
        hosting: 'Găzduire, SSL și backup-uri',
        maintenance: 'Mentenanță continuă',
      },
    },
    ru: {
      empty: 'Дополнительные услуги не выбраны',
      monthlyCustom: 'Индивидуальная цена в месяц',
      month: '/ месяц',
      week: 'неделя',
      weeks: 'недели',
      subject: 'Запрос оценки веб-проекта',
      messages: {
        sending: 'Отправляем запрос...',
        sent: 'Спасибо. Запрос отправлен, мы ответим на вашу почту в ближайшее время.',
        required: 'Пожалуйста, укажите имя и email.',
        email: 'Введите корректный адрес email.',
        consent: 'Пожалуйста, примите политику конфиденциальности, чтобы продолжить.',
        captcha: 'Пожалуйста, пройдите проверку.',
        rate: 'Слишком много запросов. Подождите минуту и попробуйте снова.',
        badWords: 'Сообщение было отмечено спам-фильтром. Пожалуйста, переформулируйте его.',
        sendError: 'Что-то пошло не так. Попробуйте ещё раз.',
      },
      labels: {
        design: 'Индивидуальный визуальный дизайн',
        responsive: 'Адаптация для телефонов и планшетов',
        content: 'Структура и тексты страниц',
        accessibility: 'Проверка доступности и удобства',
        login: 'Вход и учётные записи',
        database: 'База данных и управление данными',
        api: 'Собственный API и интеграции',
        admin: 'Панель администратора',
        security: 'Расширенные требования безопасности',
        booking: 'Запись и сценарии связи',
        seo: 'Настройка SEO',
        cms: 'Интеграция CMS',
        shop: 'Интернет-магазин',
        hosting: 'Хостинг, SSL и резервные копии',
        maintenance: 'Постоянная поддержка',
      },
    },
  };

  const t = words[lang] || words.en;
  const pages = document.querySelector('#estimatePages');
  const cost = document.querySelector('#estimateCost');
  const monthly = document.querySelector('#estimateMonthly');
  const timeline = document.querySelector('#estimateTimeline');
  const selection = document.querySelector('#estimateSelection');

  const money = (value) =>
    '$' +
    Math.round(value).toLocaleString(
      lang === 'en' ? 'en-US' : lang === 'ro' ? 'ro-RO' : 'ru-RU'
    );

  const planSelect = document.querySelector('#estimatePlan');
  const requestedPlan = new URLSearchParams(location.search).get('plan');
  if (['foundation', 'growth', 'enterprise'].includes(requestedPlan)) {
    planSelect.value = requestedPlan;
  }

  const checkedFeatures = () => [...document.querySelectorAll('.choice input:checked')];

  const update = () => {
    const checks = checkedFeatures();
    const pageCount = Number(pages.value);
    const base =
      pageCount <= 3
        ? 50
        : pageCount <= 6
          ? 630
          : pageCount <= 10
            ? 930
            : pageCount <= 15
              ? 1320
              : pageCount <= 20
                ? 1740
                : 2160;
    const total = base + checks.reduce((sum, item) => sum + Number(item.dataset.price), 0);
    const low = Math.round(total / 50) * 50;
    const high = Math.round((total * 1.3) / 50) * 50;
    cost.textContent = `${money(low)}–${money(high)}`;

    const planValue = planSelect.value;
    monthly.textContent =
      planValue === 'foundation'
        ? `${money(49)} ${t.month}`
        : planValue === 'growth'
          ? `${money(99)} ${t.month}`
          : t.monthlyCustom;

    const weeks = Math.max(1, Math.ceil(pageCount / 5) + Math.ceil(checks.length / 4));
    timeline.textContent = `${weeks}–${weeks + 1} ${weeks === 1 ? t.week : t.weeks}`;

    const selected = checks.map((item) => t.labels[item.dataset.key]).filter(Boolean);
    selection.textContent = selected.length ? selected.join(', ') : t.empty;
  };

  document.querySelectorAll('.choice input').forEach((item) => {
    item.addEventListener('change', update);
  });
  pages.addEventListener('change', update);
  planSelect.addEventListener('change', update);
  update();

  const langSelect = document.querySelector('#estimateLanguage');
  langSelect?.addEventListener('change', () => {
    const target =
      langSelect.value === 'en' ? '/estimate/' : `/${langSelect.value}/estimate/`;
    location.href = target;
  });

  const form = document.querySelector('#inquiryForm');
  if (!form) return;

  const nameInput = document.querySelector('#inquiryName');
  const emailInput = document.querySelector('#inquiryEmail');
  const companyInput = document.querySelector('#inquiryCompany');
  const consentInput = document.querySelector('#inquiryConsent');
  const websiteInput = document.querySelector('#inquiryWebsite');
  const captchaEl = document.querySelector('#inquiryCaptcha');
  const statusEl = document.querySelector('#inquiryStatus');
  const submitBtn = document.querySelector('#estimateSubmit');
  const submitLabel = submitBtn.textContent;
  const customNotes = document.querySelector('#estimateCustom');

  let startedAt = performance.now();
  let captchaEnabled = false;
  let captchaWidget = null;
  let busy = false;

  const setStatus = (message, type) => {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.hidden = !message;
    statusEl.className = 'inquiry-status' + (type ? ` is-${type}` : '');
  };

  const buildScope = () => {
    const checks = checkedFeatures();
    return {
      pages: pages.selectedOptions[0]?.textContent || '',
      plan: planSelect.selectedOptions[0]?.textContent || '',
      features: checks.map((item) => t.labels[item.dataset.key]).filter(Boolean),
      estimate: cost.textContent,
      monthly: monthly.textContent,
      timeline: timeline.textContent,
    };
  };

  const getCaptchaToken = () => {
    if (!captchaEnabled || captchaWidget == null || !window.turnstile) return '';
    return window.turnstile.getResponse(captchaWidget) || '';
  };

  const resetCaptcha = () => {
    if (captchaWidget != null && window.turnstile) {
      window.turnstile.reset(captchaWidget);
    }
  };

  const renderCaptcha = (siteKey) => {
    if (!captchaEl) return;
    captchaEnabled = true;
    captchaEl.hidden = false;
    captchaWidget = window.turnstile.render(captchaEl, {
      sitekey: siteKey,
      theme: 'dark',
    });
  };

  const setupCaptcha = async () => {
    if (!captchaEl) return;
    let siteKey = '';
    try {
      const response = await fetch('/api/inquiry/config', {
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        siteKey = payload?.siteKey || '';
      }
    } catch {}

    if (!siteKey) {
      captchaEl.hidden = true;
      return;
    }

    let waited = 0;
    const timer = window.setInterval(() => {
      if (window.turnstile) {
        window.clearInterval(timer);
        renderCaptcha(siteKey);
      } else if ((waited += 300) >= 12000) {
        window.clearInterval(timer);
      }
    }, 300);
  };

  setupCaptcha();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    const name = nameInput.value.trim();
    const email = emailInput.value.trim();

    if (!name || !email) {
      setStatus(t.messages.required, 'error');
      nameInput.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setStatus(t.messages.email, 'error');
      emailInput.focus();
      return;
    }
    if (!consentInput.checked) {
      setStatus(t.messages.consent, 'error');
      consentInput.focus();
      return;
    }

    const captchaToken = getCaptchaToken();
    if (captchaEnabled && !captchaToken) {
      setStatus(t.messages.captcha, 'error');
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = t.messages.sending;
    setStatus('', '');

    try {
      const scope = buildScope();
      const response = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          company: companyInput?.value.trim() || '',
          message: customNotes?.value.trim() || '',
          scope,
          consent: true,
          locale: lang,
          turnstileToken: captchaToken,
          website: websiteInput?.value || '',
          elapsedMs: Math.round(performance.now() - startedAt),
        }),
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {}

      if (response.status === 429) throw new Error(t.messages.rate);
      if (response.status === 422) throw new Error(payload?.error || t.messages.badWords);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || t.messages.sendError);
      }

      form.reset();
      resetCaptcha();
      startedAt = performance.now();
      setStatus(t.messages.sent, 'success');
    } catch (error) {
      setStatus(error?.message || t.messages.sendError, 'error');
      resetCaptcha();
    } finally {
      busy = false;
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
    }
  });
})();
