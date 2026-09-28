'use strict';

const API = `${document.body.dataset.panelUrl}/api`;

const $ = (id) => document.getElementById(id);

const form = $('cert-form');
const formTitle = $('form-title');
const formError = $('form-error');
const submitBtn = $('submit');
const resetBtn = $('reset');
const gemsBox = $('gems');
const issued = $('issued');
const issuedUrl = $('issued-url');
const rowsBox = $('rows');

const GEM_FIELDS = ['cut', 'qty', 'quality', 'color', 'carat'];
const TEXT_FIELDS = [
  'cert_number', 'issue_date', 'item_number', 'description',
  'size', 'metal', 'fineness', 'weight',
];

let editingId = null;

/* ------------------------------- камни -------------------------------- */

function addGemRow(gem = {}) {
  const row = document.createElement('div');
  row.className = 'gem-row';

  for (const field of GEM_FIELDS) {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.gem = field;
    input.value = gem[field] ?? '';
    input.placeholder = field.toUpperCase();
    row.append(input);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = 'Удалить строку';
  remove.addEventListener('click', () => row.remove());
  row.append(remove);

  gemsBox.append(row);
}

function readGems() {
  return [...gemsBox.querySelectorAll('.gem-row')]
    .map((row) => {
      const gem = {};
      for (const input of row.querySelectorAll('[data-gem]')) {
        gem[input.dataset.gem] = input.value.trim();
      }
      return gem;
    })
    .filter((gem) => GEM_FIELDS.some((f) => gem[f]));
}

$('add-gem').addEventListener('click', () => addGemRow());

/* ------------------------------- форма -------------------------------- */

function showError(message) {
  formError.textContent = message;
  formError.hidden = !message;
  if (message) formError.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function resetForm() {
  editingId = null;
  form.reset();
  gemsBox.replaceChildren();
  $('cert-id').value = '';
  $('cert_number').readOnly = false;
  $('folder').disabled = false;
  formTitle.textContent = 'Выставить сертификат';
  submitBtn.textContent = 'Выставить';
  resetBtn.hidden = true;
  $('doc-current').hidden = true;
  $('doc-remove-wrap').hidden = true;
  $('remove_document').checked = false;
  showError('');
}

function startEdit(cert) {
  editingId = cert.id;
  $('cert-id').value = cert.id;
  for (const field of TEXT_FIELDS) $(field).value = cert[field] ?? '';
  $('folder').value = cert.folder;
  $('extra_doc_name').value = cert.extra_doc_name ?? '';

  gemsBox.replaceChildren();
  for (const gem of cert.gemstones ?? []) addGemRow(gem);

  // Номер и папка входят в напечатанный адрес — после выпуска не меняются.
  $('cert_number').readOnly = true;
  $('folder').disabled = true;

  formTitle.textContent = `Правка сертификата № ${cert.cert_number}`;
  submitBtn.textContent = 'Сохранить';
  resetBtn.hidden = false;
  issued.hidden = true;

  $('doc-current').hidden = !cert.has_extra_doc;
  $('doc-current').textContent = cert.has_extra_doc
    ? `Прикреплён документ: ${cert.extra_doc_name || 'document.pdf'}`
    : '';
  $('doc-remove-wrap').hidden = !cert.has_extra_doc;
  $('remove_document').checked = false;

  showError('');
  form.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

resetBtn.addEventListener('click', resetForm);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  submitBtn.disabled = true;
  submitBtn.textContent = editingId ? 'Сохранение…' : 'Выставление…';

  const payload = new FormData();
  for (const field of TEXT_FIELDS) payload.append(field, $(field).value.trim());
  payload.append('folder', $('folder').value);
  payload.append('gemstones', JSON.stringify(readGems()));
  payload.append('extra_doc_name', $('extra_doc_name').value.trim());
  if ($('photo').files[0]) payload.append('photo', $('photo').files[0]);
  if ($('document').files[0]) payload.append('document', $('document').files[0]);
  if (editingId && $('remove_document').checked) payload.append('remove_document', '1');

  try {
    const res = await fetch(
      editingId ? `${API}/certificates/${editingId}` : `${API}/certificates`,
      { method: 'POST', body: payload },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);

    const wasEditing = Boolean(editingId);
    resetForm();
    if (!wasEditing) {
      issuedUrl.textContent = data.url;
      $('issued-open').href = data.path;
      issued.hidden = false;
      issued.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    await loadRows();
  } catch (err) {
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = editingId ? 'Сохранить' : 'Выставить';
  }
});

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(issuedUrl.textContent);
    $('copy').textContent = 'Скопировано';
    setTimeout(() => ($('copy').textContent = 'Скопировать ссылку'), 1600);
  } catch {
    showError('Не удалось скопировать — выделите адрес вручную');
  }
});

/* ------------------------------- реестр ------------------------------- */

function recordRow(cert) {
  const row = document.createElement('div');
  row.className = 'row';

  const main = document.createElement('div');
  main.className = 'row-main';

  const title = document.createElement('div');
  title.className = 'row-title';
  const number = document.createElement('strong');
  number.textContent = `№ ${cert.cert_number}`;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = cert.folder;
  title.append(number, tag);
  if (cert.has_extra_doc) {
    const doc = document.createElement('span');
    doc.className = 'tag';
    doc.textContent = '+ документ';
    title.append(doc);
  }

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = [cert.description, cert.metal, cert.issue_date]
    .filter(Boolean)
    .join(' · ');

  const link = document.createElement('a');
  link.className = 'row-url';
  link.href = cert.path;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = cert.url.replace(/^https?:\/\//, '');

  main.append(title, meta, link);

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const pdf = document.createElement('a');
  pdf.className = 'btn small ghost';
  pdf.href = `${cert.path}/certificate.pdf`;
  pdf.textContent = 'PDF';

  const edit = document.createElement('button');
  edit.className = 'btn small ghost';
  edit.type = 'button';
  edit.textContent = 'Править';
  edit.addEventListener('click', () => startEdit(cert));

  const remove = document.createElement('button');
  remove.className = 'btn small danger';
  remove.type = 'button';
  remove.textContent = 'Удалить';
  remove.addEventListener('click', () => removeCert(cert, remove));

  actions.append(pdf, edit, remove);
  row.append(main, actions);
  return row;
}

async function removeCert(cert, button) {
  const ok = confirm(
    `Удалить сертификат № ${cert.cert_number}?\n\n` +
      'Папка с файлами будет удалена, адрес перестанет открываться ' +
      'и сможет быть выдан заново.',
  );
  if (!ok) return;

  button.disabled = true;
  try {
    const res = await fetch(`${API}/certificates/${cert.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Ошибка ${res.status}`);
    }
    if (editingId === cert.id) resetForm();
    await loadRows();
  } catch (err) {
    button.disabled = false;
    showError(err.message);
  }
}

async function loadRows() {
  const params = new URLSearchParams({
    search: $('search').value.trim(),
    folder: $('filter-folder').value,
  });

  try {
    const res = await fetch(`${API}/certificates?${params}`);
    if (!res.ok) throw new Error(`Ошибка ${res.status}`);
    const data = await res.json();

    $('stat-total').textContent = data.stats.total ?? 0;
    $('stat-ldb').textContent = data.stats.ldb ?? 0;
    $('stat-edb').textContent = data.stats.edb ?? 0;

    if (!data.items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = params.get('search') || params.get('folder')
        ? 'Ничего не найдено'
        : 'Сертификатов пока нет';
      rowsBox.replaceChildren(empty);
      return;
    }
    rowsBox.replaceChildren(...data.items.map(recordRow));
  } catch (err) {
    const fail = document.createElement('div');
    fail.className = 'empty';
    fail.textContent = `Не удалось загрузить реестр: ${err.message}`;
    rowsBox.replaceChildren(fail);
  }
}

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadRows, 250);
});
$('filter-folder').addEventListener('change', loadRows);

addGemRow();
loadRows();
