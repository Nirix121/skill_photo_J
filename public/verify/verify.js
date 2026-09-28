// Лист сертификата свёрстан в фиксированных 1123x794 px — увеличиваем на широких экранах и вписываем в узкие.
const SHEET_WIDTH = 1123;
const SHEET_HEIGHT = 794;

const inner = document.getElementById('stage');
const frame = inner?.parentElement;

function fit() {
  if (!inner || !frame) return;
  // Пиксель запаса: при дробном масштабе округление иногда выносит правый край
  // листа за контейнер, и QR-код срезается.
  const scale = Math.min(1.3, (frame.clientWidth - 1) / SHEET_WIDTH);
  inner.style.transform = `scale(${scale})`;
  frame.style.height = `${Math.ceil(SHEET_HEIGHT * scale)}px`;
}

fit();

/*
 * Пересчитываем при любом изменении ширины контейнера, а не только окна:
 * полоса прокрутки, изменение боковой панели и зум окно не «ресайзят»,
 * но лист после них перестаёт помещаться.
 */
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(fit).observe(frame);
} else {
  addEventListener('resize', fit);
}

// Шрифты меняют высоту страницы, из-за чего может появиться полоса прокрутки.
document.fonts?.ready.then(fit);

document.getElementById('print')?.addEventListener('click', () => window.print());
