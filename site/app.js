/* =========================================================
   Логика сайта: календарь, расчёт цены, поиск по датам,
   роутинг карточек, бронирование в WhatsApp/Telegram.
   Максиму сюда лезть не нужно — всё содержимое в data.js.
   ========================================================= */
'use strict';

/* ---------- Утилиты дат ---------- */
const DAY = 86400000;
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function today() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function nightsBetween(a, b) {
  return Math.round((fromISO(b) - fromISO(a)) / DAY);
}
function fmtShort(iso) {
  const d = fromISO(iso);
  return d.getDate() + ' ' + MONTHS_RU[d.getMonth()].slice(0, 3);
}
function fmtLong(iso) {
  const d = fromISO(iso);
  return d.getDate() + ' ' + MONTHS_RU[d.getMonth()];
}
function fmtMoney(n) {
  return n.toLocaleString('ru-RU') + ' ₽';
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const nightsWord = n => plural(n, 'ночь', 'ночи', 'ночей');
const guestsWord = n => plural(n, 'гость', 'гостя', 'гостей');
// родительный падеж после «до»: до 1 гостя, до 4 гостей
const guestsWordGen = n => (n % 10 === 1 && n % 100 !== 11) ? 'гостя' : 'гостей';

/* ---------- Занятость и цены ---------- */
function isNightBusy(apt, iso) {
  return apt.busy.some(([from, to]) => iso >= from && iso < to);
}
function rangeFree(apt, checkin, checkout) {
  for (let d = fromISO(checkin); toISO(d) < checkout; d = addDays(d, 1)) {
    if (isNightBusy(apt, toISO(d))) return false;
  }
  return true;
}
function calcPrice(apt, checkin, checkout, guests) {
  const nights = nightsBetween(checkin, checkout);
  if (nights <= 0) return null;
  let base = 0;
  for (let d = fromISO(checkin); toISO(d) < checkout; d = addDays(d, 1)) {
    const wd = d.getDay(); // ночь пт (5) и сб (6) — по тарифу выходного
    base += (wd === 5 || wd === 6) ? apt.priceWeekend : apt.priceWeekday;
  }
  const extraGuests = Math.max(0, (guests || apt.baseGuests) - apt.baseGuests);
  const extraFee = extraGuests * (apt.extraGuestFee || 0) * nights;
  let discountPct = 0;
  for (const rule of SITE.discounts) {
    if (nights >= rule.nights) discountPct = Math.max(discountPct, rule.pct);
  }
  const discountAmt = Math.round(base * discountPct / 100);
  return { nights, base, extraGuests, extraFee, discountPct, discountAmt, total: base + extraFee - discountAmt };
}
function priceRangeLabel(apt) {
  const lo = Math.min(apt.priceWeekday, apt.priceWeekend);
  const hi = Math.max(apt.priceWeekday, apt.priceWeekend);
  return lo === hi ? fmtMoney(lo) : lo.toLocaleString('ru-RU') + '–' + hi.toLocaleString('ru-RU') + ' ₽';
}

/* ---------- Яндекс.Метрика (цели) ---------- */
function track(goal) {
  if (SITE.metrikaId && typeof window.ym === 'function') {
    window.ym(SITE.metrikaId, 'reachGoal', goal);
  }
}

/* ---------- Состояние ---------- */
const state = {
  heroSel: { checkin: null, checkout: null, guests: 2 },
  heroVersion: 0,      // растёт при каждом изменении дат/гостей на главной
  aptSel: {},          // aptId -> {checkin, checkout, guests, heroV}
  calMonth: {},        // ключ календаря -> смещение первого видимого месяца
  galleryIdx: {},      // aptId -> индекс текущего фото
};

/* уменьшенная версия фото для карточек и миниатюр */
function thumb(src) {
  return src.includes('images.unsplash.com') ? src.replace('w=1400', 'w=480') : src;
}

/* ---------- Фолбэк для фото ---------- */
const PHOTO_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#2e2620"/><stop offset="1" stop-color="#4a3b2f"/></linearGradient></defs>' +
  '<rect width="800" height="600" fill="url(#g)"/>' +
  '<text x="400" y="300" fill="#c9b8a4" font-family="Georgia,serif" font-size="28" text-anchor="middle">Фото квартиры</text></svg>'
);
function imgFallback(img) {
  if (img.src !== PHOTO_FALLBACK) img.src = PHOTO_FALLBACK;
}

/* ---------- Календарь ----------
   opts: { key, busyOf(iso)->bool, sel: {checkin, checkout}, onPick(sel), months }  */
function renderCalendar(container, opts) {
  const offset = state.calMonth[opts.key] || 0;
  const base = today();
  const startMonth = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const monthsToShow = opts.months || 2;

  let html = '<div class="cal">';
  html += '<div class="cal-nav">' +
    `<button class="cal-btn" data-calnav="-1" ${offset <= 0 ? 'disabled' : ''} aria-label="Предыдущий месяц">‹</button>` +
    `<button class="cal-btn" data-calnav="1" ${offset >= 10 ? 'disabled' : ''} aria-label="Следующий месяц">›</button>` +
    '</div><div class="cal-months">';

  for (let m = 0; m < monthsToShow; m++) {
    const mDate = new Date(startMonth.getFullYear(), startMonth.getMonth() + m, 1);
    html += `<div class="cal-month"><div class="cal-title">${MONTHS_NOM[mDate.getMonth()]} ${mDate.getFullYear()}</div>`;
    html += '<div class="cal-grid">';
    for (const wd of WEEKDAYS_RU) html += `<div class="cal-wd">${wd}</div>`;
    const firstDow = (mDate.getDay() + 6) % 7; // пн = 0
    for (let i = 0; i < firstDow; i++) html += '<div></div>';
    const daysInMonth = new Date(mDate.getFullYear(), mDate.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(mDate.getFullYear(), mDate.getMonth(), day);
      const iso = toISO(d);
      const past = d < base;
      const busy = opts.busyOf(iso);
      const { checkin, checkout } = opts.sel;
      const selectingEnd = checkin && !checkout;
      // заезд возможен, только если ближайшие minNights ночей свободны
      let canStart = !busy;
      for (let k = 0; canStart && k < SITE.minNights; k++) {
        if (opts.busyOf(toISO(addDays(d, k)))) canStart = false;
      }
      let cls = 'cal-day';
      if (past) cls += ' is-past';
      else if (busy) cls += ' is-busy';
      else if (!canStart && !selectingEnd) cls += ' is-blocked';
      if (checkin && iso === checkin) cls += ' is-start';
      if (checkout && iso === checkout) cls += ' is-end';
      if (checkin && checkout && iso > checkin && iso < checkout) cls += ' is-mid';
      const clickable = !past && (selectingEnd ? (iso > checkin || canStart) : canStart);
      html += `<button type="button" class="${cls}" ${clickable ? `data-pick="${iso}"` : 'disabled'}` +
        ` aria-label="${day} ${MONTHS_RU[mDate.getMonth()]}${busy ? ', занято' : ''}">${day}</button>`;
    }
    html += '</div></div>';
  }
  html += '</div></div>';
  container.innerHTML = html;

  container.querySelectorAll('[data-calnav]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.calMonth[opts.key] = (state.calMonth[opts.key] || 0) + Number(btn.dataset.calnav);
      renderCalendar(container, opts);
    });
  });
  container.querySelectorAll('[data-pick]').forEach(cell => {
    cell.addEventListener('click', e => {
      e.stopPropagation();
      const iso = cell.dataset.pick;
      const sel = { ...opts.sel };
      if (!sel.checkin || (sel.checkin && sel.checkout)) {
        // начало нового выбора
        if (opts.busyOf(iso)) return;
        sel.checkin = iso; sel.checkout = null;
      } else {
        if (iso <= sel.checkin) {
          if (opts.busyOf(iso)) return;
          sel.checkin = iso; sel.checkout = null;
        } else {
          // проверяем: все ночи от checkin до iso свободны
          let free = true;
          for (let d = fromISO(sel.checkin); toISO(d) < iso; d = addDays(d, 1)) {
            if (opts.busyOf(toISO(d))) { free = false; break; }
          }
          if (!free) {
            toast('В выбранном диапазоне есть занятые даты — выберите другой период');
            return;
          }
          if (nightsBetween(sel.checkin, iso) < SITE.minNights) {
            toast(`Минимальный срок — ${SITE.minNights} ${nightsWord(SITE.minNights)}`);
            return;
          }
          sel.checkout = iso;
        }
      }
      opts.onPick(sel);
    });
  });
}

/* ---------- Тост ---------- */
let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

/* ---------- Заявка на бронь ---------- */
function bookingMessage(apt, sel) {
  const price = calcPrice(apt, sel.checkin, sel.checkout, sel.guests);
  let msg = `Здравствуйте, ${SITE.ownerName}! Хочу забронировать «${apt.title}» ` +
    `с ${fmtLong(sel.checkin)} по ${fmtLong(sel.checkout)} ` +
    `(${price.nights} ${nightsWord(price.nights)}, ${sel.guests} ${guestsWord(sel.guests)}).`;
  msg += ` Стоимость по сайту: ${fmtMoney(price.total)}`;
  if (price.discountPct) msg += ` (со скидкой ${price.discountPct}%)`;
  msg += '. Даты свободны?';
  return msg;
}
function openWhatsApp(apt, sel) {
  track('booking_whatsapp');
  const url = 'https://wa.me/' + SITE.whatsapp + '?text=' + encodeURIComponent(bookingMessage(apt, sel));
  window.open(url, '_blank', 'noopener');
}
function openTelegram(apt, sel) {
  track('booking_telegram');
  const msg = bookingMessage(apt, sel);
  const url = 'https://t.me/' + SITE.telegram;
  // окно открываем синхронно в обработчике клика — иначе Safari блокирует popup
  const win = window.open(url, '_blank', 'noopener');
  const short = `${apt.title}, ${fmtShort(sel.checkin)} — ${fmtShort(sel.checkout)}, ${sel.guests} ${guestsWord(sel.guests)}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(msg)
      .then(() => toast('Заявка скопирована — вставьте её в чат'))
      .catch(() => toast('Напишите в чате: ' + short));
  } else {
    toast('Напишите в чате: ' + short);
  }
  if (!win) location.href = url;
}

/* ---------- Карточки каталога ---------- */
function heroDatesChosen() {
  return state.heroSel.checkin && state.heroSel.checkout;
}
function renderCatalog() {
  const grid = document.querySelector('#catalog-grid');
  if (!grid) return;
  const withDates = heroDatesChosen();

  let banner = '';
  if (withDates && APARTMENTS.every(a => !rangeFree(a, state.heroSel.checkin, state.heroSel.checkout))) {
    const askText = `Здравствуйте, ${SITE.ownerName}! На сайте с ${fmtLong(state.heroSel.checkin)} по ${fmtLong(state.heroSel.checkout)} всё занято — подскажете варианты рядом с этими датами?`;
    banner = `<div class="catalog-banner">
      <p>На ${fmtShort(state.heroSel.checkin)} — ${fmtShort(state.heroSel.checkout)} всё занято. Напишите мне — предложу соседние свободные даты.</p>
      <a class="btn btn-wa btn-sm" href="https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent(askText)}" target="_blank" rel="noopener">Спросить в WhatsApp</a>
    </div>`;
  }

  grid.innerHTML = banner + APARTMENTS.map(apt => {
    const fits = state.heroSel.guests <= apt.guests;
    const free = withDates ? rangeFree(apt, state.heroSel.checkin, state.heroSel.checkout) : true;
    const unavailable = !fits || !free;
    let availHtml = '';
    let priceHtml = `<span class="price-num">${priceRangeLabel(apt)}</span><span class="price-per"> / ночь</span>`;
    if (!free) {
      availHtml = '<span class="avail avail-no">Занята на ваши даты</span>';
    } else if (!fits) {
      availHtml = `<span class="avail avail-no">Вмещает до ${apt.guests} ${guestsWordGen(apt.guests)}</span>`;
    } else if (withDates) {
      const p = calcPrice(apt, state.heroSel.checkin, state.heroSel.checkout, state.heroSel.guests);
      availHtml = '<span class="avail avail-yes">Свободна на ваши даты</span>';
      priceHtml = `<span class="price-num">${fmtMoney(p.total)}</span><span class="price-per"> за ${p.nights} ${nightsWord(p.nights)}</span>`;
    }
    return `
    <article class="apt-card ${unavailable ? 'is-unavailable' : ''}" data-goto="${apt.id}" tabindex="0" role="link" aria-label="${apt.title} — подробнее">
      <div class="apt-card-photo">
        <img src="${thumb(apt.photos[0])}" alt="${apt.title} — фото" loading="lazy" onerror="imgFallback(this)">
        <div class="apt-card-badges">${apt.badges.map(b => `<span class="badge">${b}</span>`).join('')}</div>
        ${availHtml ? `<div class="apt-card-avail">${availHtml}</div>` : ''}
      </div>
      <div class="apt-card-body">
        <h3 class="apt-card-title">${apt.title}</h3>
        <p class="apt-card-meta">м. ${apt.metro.name} · ${apt.metro.walkMin} мин пешком</p>
        <p class="apt-card-specs">${apt.rooms} · ${apt.area} м² · до ${apt.guests} ${guestsWordGen(apt.guests)}</p>
        <div class="apt-card-foot">
          <div class="apt-card-price">${priceHtml}</div>
          <span class="apt-card-link">Подробнее →</span>
        </div>
      </div>
    </article>`;
  }).join('');

  grid.querySelectorAll('[data-goto]').forEach(card => {
    const go = () => { location.hash = '#/apt/' + card.dataset.goto; };
    card.addEventListener('click', go);
    card.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}

/* ---------- Hero: выбор дат и гостей ---------- */
function renderHeroSearch() {
  const box = document.querySelector('#hero-dates-label');
  const guestsEl = document.querySelector('#hero-guests-num');
  if (!box) return;
  if (heroDatesChosen()) {
    box.textContent = `${fmtShort(state.heroSel.checkin)} — ${fmtShort(state.heroSel.checkout)}`;
  } else if (state.heroSel.checkin) {
    box.textContent = `${fmtShort(state.heroSel.checkin)} — выезд?`;
  } else {
    box.textContent = 'Выберите даты';
  }
  box.classList.toggle('is-placeholder', !state.heroSel.checkin);
  if (guestsEl) guestsEl.textContent = state.heroSel.guests;
  renderCatalog();
}
function initHero() {
  const popover = document.querySelector('#hero-cal-popover');
  const toggle = document.querySelector('#hero-dates-toggle');
  const calBox = document.querySelector('#hero-cal');
  if (!popover || !toggle) return;

  const setOpen = open => {
    popover.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };

  const redraw = () => renderCalendar(calBox, {
    key: 'hero',
    months: window.matchMedia('(max-width: 720px)').matches ? 1 : 2,
    busyOf: () => false, // в общем поиске даты не блокируем — доступность покажем на карточках
    sel: state.heroSel,
    onPick(sel) {
      state.heroSel.checkin = sel.checkin;
      state.heroSel.checkout = sel.checkout;
      state.heroVersion++;
      redraw();
      renderHeroSearch();
      if (sel.checkin && sel.checkout) {
        setTimeout(() => {
          setOpen(false);
          document.querySelector('#catalog').scrollIntoView({ behavior: 'smooth' });
        }, 350);
      }
    },
  });

  toggle.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = !popover.classList.contains('is-open');
    setOpen(willOpen);
    if (willOpen) redraw();
  });
  document.addEventListener('click', e => {
    if (!popover.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && popover.classList.contains('is-open')) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.querySelector('#hero-cal-clear').addEventListener('click', () => {
    state.heroSel.checkin = state.heroSel.checkout = null;
    state.heroVersion++;
    redraw();
    renderHeroSearch();
  });
  document.querySelector('#hero-cal-done').addEventListener('click', () => {
    setOpen(false);
    if (heroDatesChosen()) document.querySelector('#catalog').scrollIntoView({ behavior: 'smooth' });
  });
  document.querySelectorAll('[data-guests]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.heroSel.guests = Math.min(6, Math.max(1, state.heroSel.guests + Number(btn.dataset.guests)));
      state.heroVersion++;
      renderHeroSearch();
    });
  });
  renderHeroSearch();
}

/* ---------- Отзывы и FAQ ---------- */
function renderReviews() {
  const wrap = document.querySelector('#reviews-track');
  if (!wrap) return;
  wrap.innerHTML = REVIEWS.map(r => {
    const apt = APARTMENTS.find(a => a.id === r.apt);
    return `
    <blockquote class="review">
      <div class="review-stars" aria-label="Оценка ${r.rating} из 5">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
      <p class="review-text">${r.text}</p>
      <footer class="review-foot">
        <strong>${r.name}</strong>
        <span>${apt ? apt.title : ''} · ${r.date} · ${r.source}</span>
      </footer>
      ${r.reply ? `<div class="review-reply"><b>Ответ Максима:</b> ${r.reply}</div>` : ''}
    </blockquote>`;
  }).join('');
}
function renderRatings() {
  const wrap = document.querySelector('#ratings-row');
  if (!wrap) return;
  wrap.innerHTML = SITE.platformRatings.map(r => `
    <a class="rating-pill" href="${r.url}" target="_blank" rel="noopener">
      <span class="rating-source">${r.source}</span>
      <span class="rating-num">★ ${r.rating}<small>/${r.scale}</small></span>
      <span class="rating-count">${r.reviews} ${plural(r.reviews, 'отзыв', 'отзыва', 'отзывов')}</span>
    </a>`).join('');
}
function renderFaq() {
  const wrap = document.querySelector('#faq-list');
  if (!wrap) return;
  wrap.innerHTML = FAQ.map(item => `
    <details class="faq-item">
      <summary>${item.q}</summary>
      <p>${item.a}</p>
    </details>`).join('');
}

/* ---------- Карточка квартиры ---------- */
function aptSel(id) {
  const apt = APARTMENTS.find(a => a.id === id);
  const cached = state.aptSel[id];
  // пересоздаём кэш, если гость менял даты/гостей на главной после его создания
  if (!cached || cached.heroV !== state.heroVersion) {
    const s = {
      checkin: state.heroSel.checkin,
      checkout: state.heroSel.checkout,
      guests: Math.min(state.heroSel.guests, apt.guests),
      heroV: state.heroVersion,
    };
    // если выбранные в hero даты заняты в этой квартире — не переносим их
    if (s.checkin && s.checkout && !rangeFree(apt, s.checkin, s.checkout)) {
      s.checkin = s.checkout = null;
    }
    state.aptSel[id] = s;
  }
  return state.aptSel[id];
}

function renderAptBooking(apt) {
  const box = document.querySelector('#apt-booking-summary');
  const stickyPrice = document.querySelector('#apt-sticky-price');
  if (!box) return;
  const sel = aptSel(apt.id);
  let inner;
  if (sel.checkin && sel.checkout) {
    const p = calcPrice(apt, sel.checkin, sel.checkout, sel.guests);
    inner = `
      <div class="calc">
        <div class="calc-row"><span>${fmtShort(sel.checkin)} → ${fmtShort(sel.checkout)}</span><span>${p.nights} ${nightsWord(p.nights)}</span></div>
        <div class="calc-row"><span>Проживание</span><span>${fmtMoney(p.base)}</span></div>
        ${p.extraFee ? `<div class="calc-row"><span>Доплата за ${p.extraGuests} доп. ${plural(p.extraGuests, 'гостя', 'гостей', 'гостей')} (${fmtMoney(p.extraGuests * apt.extraGuestFee)}/ночь)</span><span>+${fmtMoney(p.extraFee)}</span></div>` : ''}
        ${p.discountPct ? `<div class="calc-row calc-discount"><span>Скидка за ${p.nights} ${nightsWord(p.nights)}</span><span>−${fmtMoney(p.discountAmt)}</span></div>` : ''}
        <div class="calc-row calc-total"><span>Итого</span><span>${fmtMoney(p.total)}</span></div>
        <p class="calc-note">Это окончательная цена — без комиссий и сборов при заселении. Залог ${fmtMoney(SITE.deposit)} возвращается при выезде.</p>
      </div>`;
    if (stickyPrice) stickyPrice.innerHTML = `<strong>${fmtMoney(p.total)}</strong> за ${p.nights} ${nightsWord(p.nights)}`;
  } else {
    inner = `<p class="calc-hint">Выберите заезд и выезд в календаре — сразу посчитаю точную стоимость со скидками.</p>`;
    if (stickyPrice) stickyPrice.innerHTML = `${priceRangeLabel(apt)} / ночь`;
  }
  box.innerHTML = inner;

  const canBook = sel.checkin && sel.checkout;
  document.querySelectorAll('.book-btn').forEach(b => b.classList.toggle('is-disabled', !canBook));
  const stickyBtn = document.querySelector('[data-scrollbook]');
  if (stickyBtn) stickyBtn.textContent = canBook ? 'Забронировать' : 'Выбрать даты';
}

function renderAptView(apt) {
  const view = document.querySelector('#apt-view');
  const gIdx = state.galleryIdx[apt.id] || 0;
  const others = APARTMENTS.filter(a => a.id !== apt.id).slice(0, 3);

  view.innerHTML = `
    <div class="apt-page">
      <button class="back-link" data-back>← Все квартиры</button>
      <div class="apt-head">
        <h1 class="apt-title">${apt.title}</h1>
        <p class="apt-sub">${apt.address} · м. ${apt.metro.name}, ${apt.metro.walkMin} мин пешком ·
          <a href="https://yandex.ru/maps/?ll=${apt.coords[1]},${apt.coords[0]}&z=14&l=map" target="_blank" rel="noopener">район на карте</a></p>
      </div>

      <div class="gallery">
        <div class="gallery-main">
          <img id="gallery-img" src="${apt.photos[gIdx]}" alt="${apt.title} — фото ${gIdx + 1}" onerror="imgFallback(this)">
          <button class="gallery-arrow gallery-prev" data-gal="-1" aria-label="Предыдущее фото">‹</button>
          <button class="gallery-arrow gallery-next" data-gal="1" aria-label="Следующее фото">›</button>
          <div class="gallery-count">${gIdx + 1} / ${apt.photos.length}</div>
        </div>
        <div class="gallery-thumbs">
          ${apt.photos.map((p, i) => `<img src="${thumb(p)}" data-galto="${i}" class="${i === gIdx ? 'is-current' : ''}" alt="миниатюра ${i + 1}" loading="lazy" onerror="imgFallback(this)">`).join('')}
        </div>
      </div>

      <div class="apt-columns">
        <div class="apt-info">
          <div class="apt-specs">
            <div class="spec"><span class="spec-num">до ${apt.guests}</span><span>${guestsWordGen(apt.guests)}</span></div>
            <div class="spec"><span class="spec-num">${apt.area} м²</span><span>${apt.rooms}</span></div>
            <div class="spec"><span class="spec-num">${apt.floor.split(' ')[0]} этаж</span><span>${apt.floor.includes('без лифта') ? 'без лифта' : 'есть лифт'}</span></div>
          </div>
          <p class="apt-beds">Спальные места: ${apt.beds.toLowerCase()}</p>
          <p class="apt-desc">${apt.description}</p>

          <h2 class="h-block">Важно знать</h2>
          <p class="apt-important">${apt.important}</p>

          <h2 class="h-block">В квартире есть</h2>
          <ul class="amenities">${apt.amenities.map(a => `<li>${a}</li>`).join('')}</ul>

          <h2 class="h-block">Условия</h2>
          <ul class="rules">
            <li>Заезд с ${SITE.checkIn}, выезд до ${SITE.checkOut}. ${SITE.earlyCheckIn}</li>
            <li>Минимальный срок — ${SITE.minNights} ${nightsWord(SITE.minNights)}. Скидки: ${SITE.discounts.map(d => `от ${d.nights} ночей — ${d.pct}%`).join(', ')}.</li>
            <li>Залог ${fmtMoney(SITE.deposit)}, возвращается в день выезда.</li>
            <li>Бесплатная отмена за ${SITE.cancellationDays} ${plural(SITE.cancellationDays, 'день', 'дня', 'дней')} до заезда; позже — перенос дат один раз бесплатно.</li>
            <li>Для договора нужен паспорт. Точный адрес и код подъезда — после подтверждения брони.</li>
            <li>Курение и шумные вечеринки запрещены.</li>
            <li>Командировочным выдаю отчётные документы: чек, договор найма, акт.</li>
          </ul>
        </div>

        <aside class="apt-booking" id="apt-booking">
          <div class="host-mini">
            <div class="host-avatar" aria-hidden="true">М</div>
            <div>
              <b>${SITE.ownerName}, хозяин квартиры</b>
              <span>Отвечаю за ${SITE.responseTime}, ${SITE.workHours}</span>
            </div>
          </div>
          <h2 class="booking-title">Выберите даты</h2>
          <div id="apt-cal"></div>
          <div class="cal-legend">
            <span><i class="dot dot-free"></i>свободно</span>
            <span><i class="dot dot-busy"></i>занято</span>
          </div>
          <div class="booking-guests">
            <span>Гостей:</span>
            <div class="stepper">
              <button data-aguests="-1" aria-label="Меньше гостей">−</button>
              <b id="apt-guests-num">${aptSel(apt.id).guests}</b>
              <button data-aguests="1" aria-label="Больше гостей">+</button>
            </div>
          </div>
          <div id="apt-booking-summary"></div>
          <div class="booking-actions">
            <button class="btn btn-wa book-btn" data-book="wa">Написать в WhatsApp</button>
            <button class="btn btn-tg book-btn" data-book="tg">Написать в Telegram</button>
            <a class="btn btn-call" data-call href="tel:${SITE.phoneHref}">Позвонить: ${SITE.phone}</a>
          </div>
        </aside>
      </div>

      <section class="apt-others">
        <h2 class="h-block">Другие мои квартиры</h2>
        <div class="others-grid">
          ${others.map(o => {
            let note = '';
            if (heroDatesChosen()) {
              note = rangeFree(o, state.heroSel.checkin, state.heroSel.checkout)
                ? '<span class="avail avail-yes">Свободна на ваши даты</span>'
                : '<span class="avail avail-no">Занята на ваши даты</span>';
            }
            return `
            <a class="other-card" href="#/apt/${o.id}">
              <img src="${thumb(o.photos[0])}" alt="${o.title}" loading="lazy" onerror="imgFallback(this)">
              <div>
                <b>${o.title}</b>
                <span>м. ${o.metro.name} · ${priceRangeLabel(o)} / ночь</span>
                ${note}
              </div>
            </a>`;
          }).join('')}
        </div>
      </section>
    </div>

    <div class="apt-sticky">
      <div id="apt-sticky-price"></div>
      <button class="btn btn-accent" data-scrollbook>Выбрать даты</button>
    </div>`;

  /* — обработчики — */
  view.querySelector('[data-back]').addEventListener('click', () => { location.hash = '#/'; });

  // точечное обновление галереи — без перерисовки всей страницы
  const galShow = idx => {
    const n = apt.photos.length;
    const i = ((idx % n) + n) % n;
    state.galleryIdx[apt.id] = i;
    const img = view.querySelector('#gallery-img');
    img.src = apt.photos[i];
    img.alt = `${apt.title} — фото ${i + 1}`;
    view.querySelector('.gallery-count').textContent = `${i + 1} / ${n}`;
    view.querySelectorAll('[data-galto]').forEach((t, k) => {
      t.classList.toggle('is-current', k === i);
      if (k === i) t.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });
  };
  view.querySelectorAll('[data-gal]').forEach(b =>
    b.addEventListener('click', () => galShow((state.galleryIdx[apt.id] || 0) + Number(b.dataset.gal))));
  view.querySelectorAll('[data-galto]').forEach(t =>
    t.addEventListener('click', () => galShow(Number(t.dataset.galto))));
  const mainImg = view.querySelector('#gallery-img');
  let touchX = null;
  mainImg.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  mainImg.addEventListener('touchend', e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) galShow((state.galleryIdx[apt.id] || 0) + (dx < 0 ? 1 : -1));
    touchX = null;
  }, { passive: true });

  const calBox = view.querySelector('#apt-cal');
  const redrawCal = () => renderCalendar(calBox, {
    key: 'apt-' + apt.id,
    months: 1,
    busyOf: iso => isNightBusy(apt, iso),
    sel: aptSel(apt.id),
    onPick(sel) {
      state.aptSel[apt.id] = { ...aptSel(apt.id), ...sel };
      redrawCal();
      renderAptBooking(apt);
    },
  });
  redrawCal();

  view.querySelectorAll('[data-aguests]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = aptSel(apt.id);
      s.guests = Math.min(apt.guests, Math.max(1, s.guests + Number(btn.dataset.aguests)));
      view.querySelector('#apt-guests-num').textContent = s.guests;
      renderAptBooking(apt);
    });
  });

  view.querySelectorAll('[data-book]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sel = aptSel(apt.id);
      if (!sel.checkin || !sel.checkout) {
        toast('Сначала выберите даты заезда и выезда в календаре');
        view.querySelector('#apt-booking').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      btn.dataset.book === 'wa' ? openWhatsApp(apt, sel) : openTelegram(apt, sel);
    });
  });
  view.querySelector('[data-call]').addEventListener('click', () => track('booking_call'));
  view.querySelector('[data-scrollbook]').addEventListener('click', () => {
    view.querySelector('#apt-booking').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  renderAptBooking(apt);
}

/* ---------- Роутер ---------- */
let wasAptRoute = false;
function route() {
  const hash = location.hash || '#/';
  const home = document.querySelector('#home-view');
  const aptView = document.querySelector('#apt-view');
  const m = hash.match(/^#\/apt\/([\w-]+)/);
  const apt = m && APARTMENTS.find(a => a.id === m[1]);
  if (apt) {
    home.hidden = true;
    aptView.hidden = false;
    document.body.classList.add('is-apt-page');
    document.title = `${apt.title} — ${SITE.brand} · ${SITE.tagline}`;
    renderAptView(apt);
    window.scrollTo(0, 0);
    wasAptRoute = true;
  } else {
    const homeWasHidden = home.hidden;
    aptView.hidden = true;
    home.hidden = false;
    document.body.classList.remove('is-apt-page');
    document.title = `${SITE.brand} — ${SITE.tagline}`;
    renderCatalog();
    if (m) {
      // битый id квартиры: заменяем запись истории, чтобы «Назад» не зациклился
      history.replaceState(null, '', location.pathname + location.search + '#/');
    }
    // якорь секции из карточки квартиры: браузер не смог проскроллить
    // к скрытому элементу — докручиваем сами после показа главной
    const anchorEl = /^#[\w-]+$/.test(hash) ? document.getElementById(hash.slice(1)) : null;
    if (anchorEl && homeWasHidden) {
      requestAnimationFrame(() => anchorEl.scrollIntoView({ behavior: 'smooth' }));
    } else if (homeWasHidden && wasAptRoute) {
      window.scrollTo(0, 0);
    }
    wasAptRoute = false;
  }
}

/* ---------- Schema.org (SEO) ---------- */
function injectSchema() {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'LodgingBusiness',
    name: `${SITE.brand} — ${SITE.tagline}`,
    telephone: SITE.phone,
    email: SITE.email,
    address: { '@type': 'PostalAddress', addressLocality: SITE.city, addressCountry: 'RU' },
    checkinTime: SITE.checkIn,
    checkoutTime: SITE.checkOut,
    priceRange: Math.min(...APARTMENTS.map(a => a.priceWeekday)) + '–' +
      Math.max(...APARTMENTS.map(a => a.priceWeekend)) + ' RUB за сутки',
    makesOffer: APARTMENTS.map(a => ({
      '@type': 'Offer',
      name: a.title,
      priceCurrency: 'RUB',
      price: a.priceWeekday,
      itemOffered: {
        '@type': 'Apartment',
        name: a.title,
        floorSize: { '@type': 'QuantitativeValue', value: a.area, unitCode: 'MTK' },
        occupancy: { '@type': 'QuantitativeValue', maxValue: a.guests },
      },
    })),
  };
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify(ld);
  document.head.appendChild(script);
}

/* ---------- Шапка и статика из данных ---------- */
function hydrateStatic() {
  document.querySelectorAll('[data-site]').forEach(el => {
    const key = el.dataset.site;
    if (key in SITE) el.textContent = SITE[key];
  });
  document.querySelectorAll('[data-href-tel]').forEach(el => { el.href = 'tel:' + SITE.phoneHref; });
  document.querySelectorAll('[data-href-wa]').forEach(el => {
    const text = el.dataset.waText || `Здравствуйте, ${SITE.ownerName}! Пишу с сайта — есть вопрос по квартирам и датам.`;
    el.href = 'https://wa.me/' + SITE.whatsapp + '?text=' + encodeURIComponent(text);
  });
  document.querySelectorAll('[data-href-tg]').forEach(el => { el.href = 'https://t.me/' + SITE.telegram; });
  const yearsEl = document.querySelector('#stat-years');
  if (yearsEl) {
    const years = new Date().getFullYear() - SITE.yearsSince;
    yearsEl.textContent = `${years} ${plural(years, 'год', 'года', 'лет')}`;
  }
  const ratingEl = document.querySelector('#stat-rating');
  if (ratingEl && SITE.platformRatings.length) {
    const avg = SITE.platformRatings.reduce((sum, r) =>
      sum + parseFloat(String(r.rating).replace(',', '.')) / parseFloat(r.scale) * 5, 0) / SITE.platformRatings.length;
    ratingEl.textContent = '★ ' + avg.toFixed(1).replace('.', ',');
  }
}

/* ---------- Инициализация ---------- */
document.addEventListener('DOMContentLoaded', () => {
  hydrateStatic();
  initHero();
  renderCatalog();
  renderRatings();
  renderReviews();
  renderFaq();
  injectSchema();
  route();
  window.addEventListener('hashchange', route);

  document.querySelectorAll('[data-track]').forEach(el =>
    el.addEventListener('click', () => track(el.dataset.track)));

  // плавное появление секций при скролле (с фолбэком, если IO недоступен)
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('is-revealed'); io.unobserve(en.target); } });
    }, { threshold: 0.08, rootMargin: '0px 0px -5% 0px' });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  } else {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-revealed'));
  }
});
