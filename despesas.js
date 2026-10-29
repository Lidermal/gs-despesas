const API_URL = "https://script.google.com/macros/s/AKfycbyv6rztF_a5ePHzRhzCMJDawDOHhF-le_3MgvoeMY2WUGjVRQBPmt2cSuV6Mp71MGnpUQ/exec";
const VIAGENS_URL = "https://viagens-gs.vercel.app/";
const TEMPO_SESSAO_MS = 4 * 60 * 60 * 1000;
const POLL_MS = 8000; // atualização automática

let userData = null, viagensGlobais = [], grupoAtualKey = null, filtroLojaSelecionada = "TODAS";
let abaAtiva = 'ATIVAS', filtroStatus = 'TODOS';
let ocrImagemBase64 = '', ocrMimeType = 'image/jpeg', ocrTextoExtraido = '', ocrIdViagem = null;
let visualizadorIdAtual = null;
const cacheImagens = {};
let pollTimer = null, polling = false, pollPromise = null, jaCarregou = false, lastSig = '', busy = 0;
let tecnicos = [], tecnicosSel = new Set(), nomesUsuarios = {}, usuariosPromise = null;

const $ = (id) => document.getElementById(id);
const RX_GESTAO = /Coordena|Ger[eê]ncia/i;
function isGestaoUser() { return !!userData && RX_GESTAO.test(userData.nivel || ''); }

function pad2(n) { return String(n).padStart(2, '0'); }
function escaparAtributoHtml(valor) { return String(valor || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

// ===== LOGIN ÚNICO ENTRE SISTEMAS (recebe a sessão vinda do viagens-gs) =====
(function consumirSSO() {
  const m = location.hash.match(/^#sso=(.+)$/);
  if (!m) return;
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    const t = parseInt(o.t, 10);
    if (o && o.u && o.u.login && t && (Date.now() - t < TEMPO_SESSAO_MS)) {
      localStorage.setItem('usuarioDespesasAtivo', JSON.stringify(o.u));
      localStorage.setItem('loginDespesasTimestamp', String(t));
    }
  } catch (e) {}
  history.replaceState(null, '', location.pathname + location.search);
})();

function irParaViagens() {
  if (!userData) return;
  const pacote = { u: userData, t: localStorage.getItem('loginDespesasTimestamp') || Date.now().toString() };
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(pacote))));
  window.location.href = VIAGENS_URL + '#sso=' + payload;
}

function formatarDataVisao(valor) {
  const s = String(valor || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const p = s.slice(0, 10).split('-'); return `${p[2]}/${p[1]}/${p[0]}`; }
  return s;
}

function isDataBaseSheets(valor) {
  if (!valor) return true;
  try { const d = new Date(valor); if (isNaN(d.getTime())) return true; return d.getFullYear() === 1899 || d.getFullYear() === 1900; } catch (e) { return true; }
}

function formatarHoraVisao(valor) {
  if (!valor) return '';
  const s = String(valor).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  if (isDataBaseSheets(valor)) return '';
  const m = s.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function chaveDataOrdenacao(valor) {
  const s = String(valor || '');
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const p = s.split('/'); return new Date(`${p[2]}-${p[1]}-${p[0]}`); }
  const d = new Date(s); return isNaN(d.getTime()) ? new Date(0) : d;
}

// ============================================================
//  OCR: PRÉ-PROCESSAMENTO DA IMAGEM
// ============================================================
async function prepararImagemParaOCR(file) {
  const original = await lerFileComoDataUrl(file);
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = original; });
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const maior = Math.max(w0, h0);
  let escala = 1;
  if (maior < 1800) escala = 1800 / maior;
  else if (maior > 2600) escala = 2600 / maior;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * escala); canvas.height = Math.round(h0 * escala);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g; hist[g]++;
  }
  const total = canvas.width * canvas.height;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const faixa = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let g = (d[i] - lo) * 255 / faixa;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

let tesseractWorker = null;
async function obterWorkerOCR() {
  if (tesseractWorker) return tesseractWorker;
  const worker = await Tesseract.createWorker('por');
  try { await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }); } catch (e) {}
  tesseractWorker = worker;
  return worker;
}

async function lerTextoDaImagem(file) {
  let textoMelhorado = '';
  try {
    const worker = await obterWorkerOCR();
    const canvas = await prepararImagemParaOCR(file);
    const res = await worker.recognize(canvas);
    textoMelhorado = res.data.text || '';
  } catch (e) { console.warn('OCR pré-processado falhou', e); }
  if (!extrairValorDoTexto(textoMelhorado)) {
    try {
      const res2 = await Tesseract.recognize(file, 'por');
      const t2 = res2.data.text || '';
      if (extrairValorDoTexto(t2)) return t2;
      if (!textoMelhorado) return t2;
    } catch (e) {}
  }
  return textoMelhorado;
}

// ============================================================
//  OCR: DATA / HORA / VALOR
// ============================================================
const MESES_PT = { 'JANEIRO': '01', 'FEVEREIRO': '02', 'MARCO': '03', 'MARÇO': '03', 'ABRIL': '04', 'MAIO': '05', 'JUNHO': '06', 'JULHO': '07', 'AGOSTO': '08', 'SETEMBRO': '09', 'OUTUBRO': '10', 'NOVEMBRO': '11', 'DEZEMBRO': '12' };

function dataValida_(dia, mes, ano) {
  dia = parseInt(dia, 10); mes = parseInt(mes, 10); ano = parseInt(ano, 10);
  if (!(dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12 && ano >= 2015 && ano <= 2100)) return false;
  const dt = new Date(ano, mes - 1, dia);
  if (dt.getMonth() !== mes - 1) return false;
  const amanha = new Date(); amanha.setDate(amanha.getDate() + 1);
  return dt <= amanha;
}

function extrairDataDoTexto(texto) {
  if (!texto) return '';
  const linhas = String(texto).toUpperCase().split(/\r?\n/);
  const candidatos = [];
  linhas.forEach((linha, idx) => {
    const l = linha.replace(/O/g, (m, off, s) => /\d/.test(s[off - 1] || '') || /\d/.test(s[off + 1] || '') ? '0' : m);
    const prefer = /DATA|EMISS|VENDA|TRANSA|COMPRA/.test(linha) ? 1 : 0;
    let m;
    const r1 = /(\d{1,2})\s?[\/\-\.]\s?(\d{1,2})\s?[\/\-\.]\s?(\d{4}|\d{2})(?!\d)/g;
    while ((m = r1.exec(l)) !== null) {
      const ano = m[3].length === 2 ? '20' + m[3] : m[3];
      if (dataValida_(m[1], m[2], ano)) candidatos.push({ v: `${pad2(m[1])}/${pad2(m[2])}/${ano}`, p: prefer, i: idx });
    }
    const r2 = /(\d{4})-(\d{2})-(\d{2})/g;
    while ((m = r2.exec(l)) !== null) {
      if (dataValida_(m[3], m[2], m[1])) candidatos.push({ v: `${m[3]}/${m[2]}/${m[1]}`, p: prefer, i: idx });
    }
    const r3 = /(\d{1,2}) DE (JANEIRO|FEVEREIRO|MAR[CÇ]O|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO) DE (\d{4})/g;
    while ((m = r3.exec(l)) !== null) {
      const mes = MESES_PT[m[2]];
      if (mes && dataValida_(m[1], mes, m[3])) candidatos.push({ v: `${pad2(m[1])}/${mes}/${m[3]}`, p: 1, i: idx });
    }
  });
  if (!candidatos.length) return '';
  candidatos.sort((a, b) => (b.p - a.p) || (a.i - b.i));
  return candidatos[0].v;
}

function extrairHoraDoTexto(texto) {
  if (!texto) return '';
  const linhas = String(texto).toUpperCase().split(/\r?\n/);
  const candidatos = [];
  linhas.forEach((linha, idx) => {
    const prefer = /HORA|HR|EMISS|TRANSA|VENDA/.test(linha) ? 1 : 0;
    const re = /(?<!\d)([01]?\d|2[0-3])\s?[:hH]\s?([0-5]\d)(?:\s?[:hH]\s?[0-5]\d)?(?!\d)/g;
    let m;
    while ((m = re.exec(linha)) !== null) candidatos.push({ v: `${pad2(m[1])}:${m[2]}`, p: prefer, i: idx });
  });
  if (!candidatos.length) return '';
  candidatos.sort((a, b) => (b.p - a.p) || (a.i - b.i));
  return candidatos[0].v;
}

function extrairValorDoTexto(texto) {
  if (!texto) return '';
  let t = String(texto).toUpperCase();
  t = t.replace(/R\s?S(?=\s*\d)/g, 'R$');
  t = t.replace(/(\d)\s+([,.])\s*(\d{2})(?!\d)/g, '$1$2$3');
  const linhas = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const fortes = [
    ['VALOR PAGO', 12], ['TOTAL A PAGAR', 12], ['VALOR TOTAL', 11], ['TOTAL PAGO', 11], ['VALOR DA COMPRA', 10], ['VALOR COBRADO', 10],
    ['TOTAL R$', 10], ['TOTAL', 8], ['A PAGAR', 8], ['PAGO', 7], ['VALOR', 6], ['CREDITO', 5], ['DEBITO', 5], ['CARTAO', 4], ['PIX', 5], ['DINHEIRO', 4], ['APROVAD', 4], ['VISTA', 3]
  ];
  const negativas = /TROCO|DESCONTO|IMPOSTO|TRIBUT|ICMS|ALIQ|CNPJ|CPF|FONE|TEL\b|PIS|COFINS|UNIT|QTD|ACRESC|GORJETA|TAXA DE SERV|NSU|AUT\b|CODIGO|COD\b|PROTOCOLO|CHAVE/;

  function pontuarLinha(l) {
    if (negativas.test(l)) return -20;
    let melhor = 0;
    const semSub = l.replace(/SUBTOTAL|SUB-TOTAL|SUB TOTAL/g, 'SUBT');
    for (const [k, p] of fortes) if (semSub.indexOf(k) !== -1) melhor = Math.max(melhor, p);
    if (/SUBT/.test(l)) melhor = Math.max(melhor, 2);
    if (/R\$/.test(l)) melhor += 2;
    return melhor;
  }

  const candidatos = [];
  linhas.forEach((linha, idx) => {
    const anterior = idx > 0 ? linhas[idx - 1] : '';
    const pLinha = pontuarLinha(linha);
    const pAnt = anterior && !/\d[,.]\d{2}/.test(anterior) ? Math.max(0, pontuarLinha(anterior) - 3) : 0;
    const score = pLinha < 0 ? pLinha : Math.max(pLinha, pAnt);

    const re = /(\d{1,3}(?:\.\d{3})+|\d+)[,.](\d{2})(?!\d)/g;
    let m;
    while ((m = re.exec(linha)) !== null) {
      const antes = linha[m.index - 1] || '', depois = linha[m.index + m[0].length] || '';
      if (/[\d,.\/:]/.test(antes)) continue;
      if (/[\.\/:]/.test(depois) && /\d/.test(linha[m.index + m[0].length + 1] || '')) continue;
      const valor = parseFloat(m[1].replace(/\./g, '') + '.' + m[2]);
      if (valor >= 0.5 && valor < 50000) candidatos.push({ valor, score });
    }
    const reSem = /R\$\s*(\d{3,6})(?![\d,.])/g;
    while ((m = reSem.exec(linha)) !== null) {
      const valor = parseFloat(m[1].slice(0, -2) + '.' + m[1].slice(-2));
      if (valor >= 0.5 && valor < 50000) candidatos.push({ valor, score: Math.max(score, 1) });
    }
  });

  if (!candidatos.length) return '';
  const positivos = candidatos.filter(c => c.score > 0);
  const base = positivos.length ? positivos : candidatos.filter(c => c.score >= 0);
  const lista = base.length ? base : candidatos;
  lista.sort((a, b) => (b.score - a.score) || (b.valor - a.valor));
  return lista[0].valor.toFixed(2);
}

// ============================================================
//  OCR: LOCAL (CIDADE - UF)  ex.: "Santa Inês - MA"
// ============================================================
const UFS_BR = 'AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO';
const ESTADOS_UF = {
  'ACRE': 'AC', 'ALAGOAS': 'AL', 'AMAPA': 'AP', 'AMAZONAS': 'AM', 'BAHIA': 'BA', 'CEARA': 'CE', 'DISTRITO FEDERAL': 'DF',
  'ESPIRITO SANTO': 'ES', 'GOIAS': 'GO', 'MARANHAO': 'MA', 'MATO GROSSO': 'MT', 'MATO GROSSO DO SUL': 'MS', 'MINAS GERAIS': 'MG',
  'PARA': 'PA', 'PARAIBA': 'PB', 'PARANA': 'PR', 'PERNAMBUCO': 'PE', 'PIAUI': 'PI', 'RIO DE JANEIRO': 'RJ', 'RIO GRANDE DO NORTE': 'RN',
  'RIO GRANDE DO SUL': 'RS', 'RONDONIA': 'RO', 'RORAIMA': 'RR', 'SANTA CATARINA': 'SC', 'SAO PAULO': 'SP', 'SERGIPE': 'SE', 'TOCANTINS': 'TO'
};
const PALAVRAS_NAO_CIDADE = new Set(['RUA', 'AV', 'AVENIDA', 'ROD', 'RODOVIA', 'LOJA', 'CNPJ', 'CPF', 'TOTAL', 'VALOR', 'CUPOM', 'FISCAL', 'NOTA', 'DATA', 'HORA', 'CARTAO', 'CREDITO', 'DEBITO', 'PIX', 'ITEM', 'QTD', 'TROCO', 'ENDERECO', 'END', 'BAIRRO', 'CEP', 'IE', 'IM', 'TEL', 'FONE', 'LTDA', 'EIRELI', 'ME', 'SA', 'CAIXA', 'OPERADOR', 'CODIGO', 'COD', 'NSU', 'AUT', 'AGENCIA', 'CONTA', 'VENDA', 'ESTADO', 'UF', 'CIDADE', 'MUNICIPIO', 'MUN', 'CID', 'PRACA', 'TRAVESSA', 'ALAMEDA', 'QUADRA', 'LOTE', 'SALA', 'CENTRO', 'BR', 'KM', 'NUMERO', 'NRO', 'SN', 'S/N', 'COMPROVANTE', 'VIA', 'CLIENTE', 'ESTABELECIMENTO', 'TERMINAL', 'DOC', 'MERCHANT']);

function semAcentos_(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

function tituloCidade_(s) {
  const pequenas = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
  return String(s).toLowerCase().split(/\s+/).filter(Boolean).map((p, i) => (i > 0 && pequenas.has(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function limparNomeCidade_(bruto) {
  let s = String(bruto || '');
  s = s.split(/[\d,;:|]/).pop();
  s = s.replace(/[^A-ZÀ-Ü' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let palavras = s.split(' ').filter(Boolean);
  while (palavras.length && (PALAVRAS_NAO_CIDADE.has(semAcentos_(palavras[0])) || palavras[0].length < 2)) palavras.shift();
  if (palavras.length > 4) palavras = palavras.slice(-4);
  if (palavras.some(p => PALAVRAS_NAO_CIDADE.has(semAcentos_(p)) && !['SANTA', 'SANTO'].includes(p))) {
    let idxUlt = -1;
    palavras.forEach((p, i) => { if (PALAVRAS_NAO_CIDADE.has(semAcentos_(p))) idxUlt = i; });
    palavras = palavras.slice(idxUlt + 1);
  }
  const nome = palavras.join(' ').trim();
  if (nome.length < 3 || nome.length > 40) return '';
  return nome;
}

function extrairLocalDoTexto(texto) {
  if (!texto) return '';
  const linhas = String(texto).toUpperCase().split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const candidatos = [];
  const SEP = '[-\\u2013\\u2014\\/,]';
  const UF = `(${UFS_BR})(?![A-Z0-9])`;

  linhas.forEach((linha, idx) => {
    let m;
    const r1 = new RegExp(`(?:CIDADE|MUNIC[IÍ]PIO|MUN|CID)\\s*[:\\-]?\\s*([A-ZÀ-Ü][A-ZÀ-Ü' ]{2,40}?)\\s*(?:${SEP}|UF\\s*[:\\-]?|\\s)\\s*${UF}`);
    m = r1.exec(linha);
    if (m) { const c = limparNomeCidade_(m[1]); if (c) candidatos.push({ cidade: c, uf: m[2], score: 12, i: idx }); }

    const r2 = new RegExp(`\\d{5}\\s?-?\\s?\\d{3}\\s*${SEP}?\\s*([A-ZÀ-Ü][A-ZÀ-Ü' ]{2,40}?)\\s*(?:${SEP}|\\s)\\s*${UF}`);
    m = r2.exec(linha);
    if (m) { const c = limparNomeCidade_(m[1]); if (c) candidatos.push({ cidade: c, uf: m[2], score: 10, i: idx }); }

    const r3 = new RegExp(`([A-ZÀ-Ü][A-ZÀ-Ü' .]{2,60}?)\\s*${SEP}\\s*${UF}`, 'g');
    while ((m = r3.exec(linha)) !== null) {
      const c = limparNomeCidade_(m[1]);
      if (c) candidatos.push({ cidade: c, uf: m[2], score: /CNPJ|CEP|END|RUA|AV|LOJA|BAIRRO/.test(linha) ? 7 : 5, i: idx });
    }

    if (/CEP|END|RUA|AV |AVENIDA|RODOVIA/.test(linha)) {
      const r4 = new RegExp(`([A-ZÀ-Ü][A-ZÀ-Ü' ]{2,40}?)\\s+${UF}\\s*$`);
      m = r4.exec(linha);
      if (m) { const c = limparNomeCidade_(m[1]); if (c) candidatos.push({ cidade: c, uf: m[2], score: 3, i: idx }); }
    }
  });

  if (!candidatos.length) return '';
  candidatos.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  const melhor = candidatos[0];
  return `${tituloCidade_(melhor.cidade)} - ${melhor.uf}`;
}

function obterLocalPorGPS() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(''); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&zoom=10&addressdetails=1&accept-language=pt-BR`;
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const j = await resp.json();
        const a = (j && j.address) || {};
        const cidade = a.city || a.town || a.village || a.municipality || a.city_district || '';
        let uf = '';
        const iso = a['ISO3166-2-lvl4'] || '';
        if (/^BR-[A-Z]{2}$/.test(iso)) uf = iso.slice(3);
        else uf = ESTADOS_UF[semAcentos_(a.state || '').toUpperCase()] || '';
        resolve(cidade && uf ? `${cidade} - ${uf}` : '');
      } catch (e) { resolve(''); }
    }, () => resolve(''), { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  });
}

// ============================================================
//  DRIVE / IMAGEM DO COMPROVANTE
// ============================================================
function extrairFileIdDrive(url) {
  const s = String(url || '');
  const p1 = s.match(/\/file\/d\/([^\/?&#]+)/); if (p1) return p1[1];
  const p2 = s.match(/[?&]id=([^&#]+)/); if (p2) return p2[1];
  const p3 = s.match(/\/d\/([^\/?&#]+)/); if (p3) return p3[1];
  return '';
}
function montarUrlThumbnailDrive(url) {
  const fileId = extrairFileIdDrive(url);
  return fileId ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w400` : url;
}
function lerFileComoDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function converterFileParaBase64(file) {
  const original = await lerFileComoDataUrl(file);
  if (!file.type || !file.type.startsWith('image/')) return original;
  try {
    const img = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = original; });
    const maxDim = 1600, w = img.width || maxDim, h = img.height || maxDim;
    const escala = Math.min(1, maxDim / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * escala));
    canvas.height = Math.max(1, Math.round(h * escala));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) { return original; }
}

async function obterImagemComprovante(idComp) {
  if (cacheImagens[idComp]) return cacheImagens[idComp];
  const r = await fetchAPI({ action: 'getComprovanteImagem', idComprovante: idComp, login: userData.login, nivel: userData.nivel });
  if (r && r.success) {
    cacheImagens[idComp] = { dataUrl: `data:${r.mimeType};base64,${r.base64}`, nome: r.nome || (idComp + '.jpg') };
    return cacheImagens[idComp];
  }
  showToast((r && r.message) || 'Não foi possível carregar a imagem.', 'error');
  return null;
}

function fallbackThumb(img) {
  if (img.dataset.tentou) { img.style.display = 'none'; return; }
  img.dataset.tentou = '1';
  obterImagemComprovante(img.dataset.id).then(x => { if (x) img.src = x.dataUrl; else img.style.display = 'none'; });
}

function htmlMiniatura(c, tamanho = 'h-12 w-12') {
  if (!c.urlComprovante) return '';
  return `<img src="${montarUrlThumbnailDrive(c.urlComprovante)}" data-id="${c.idComprovante}" alt="Comprovante" loading="lazy" referrerpolicy="no-referrer" class="${tamanho} object-cover rounded border cursor-pointer bg-slate-100" onclick="abrirVisualizador('${c.idComprovante}')" onerror="fallbackThumb(this)">`;
}

async function abrirVisualizador(idComp) {
  visualizadorIdAtual = idComp;
  const modal = document.getElementById('modalVisualizador');
  const img = document.getElementById('visualizadorImg');
  const loader = document.getElementById('visualizadorLoader');
  modal.classList.remove('hidden'); img.classList.add('hidden'); img.src = ''; loader.classList.remove('hidden');
  const x = await obterImagemComprovante(idComp);
  loader.classList.add('hidden');
  if (!x) { modal.classList.add('hidden'); return; }
  img.src = x.dataUrl; img.classList.remove('hidden');
}
function fecharVisualizador() { document.getElementById('modalVisualizador').classList.add('hidden'); document.getElementById('visualizadorImg').src = ''; visualizadorIdAtual = null; }

async function baixarComprovante(idComp) {
  const id = idComp || visualizadorIdAtual;
  const x = await obterImagemComprovante(id);
  if (!x) return;
  const a = document.createElement('a');
  a.href = x.dataUrl; a.download = x.nome;
  document.body.appendChild(a); a.click(); a.remove();
}

async function imprimirComprovante(idComp) {
  const id = idComp || visualizadorIdAtual;
  const x = await obterImagemComprovante(id);
  if (!x) return;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><title>Comprovante</title><style>@page{margin:10mm}html,body{margin:0;padding:0}img{display:block;max-width:100%;max-height:270mm;margin:0 auto}</style></head><body><img id="im" src="${x.dataUrl}"></body></html>`);
  doc.close();
  const imprimir = () => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { showToast('Não foi possível imprimir.', 'error'); } setTimeout(() => iframe.remove(), 2000); };
  const im = doc.getElementById('im');
  if (im.complete) setTimeout(imprimir, 150); else im.onload = () => setTimeout(imprimir, 150);
}

// ============================================================
//  GARANTE OS CAMPOS DE LOCAL (mesmo se o index.html for antigo)
// ============================================================
function garantirCamposLocal() {
  const LBL = 'block text-[10px] font-bold text-slate-500 mb-1';
  const INP = 'w-full px-3 py-2 text-sm border rounded bg-slate-50';
  if (!document.getElementById('ocrLocal')) {
    const ref = document.getElementById('ocrValor'), bloco = ref && ref.closest('.grid');
    if (bloco && bloco.parentNode) {
      const d = document.createElement('div');
      d.innerHTML = `<label class="${LBL}">LOCAL (CIDADE - UF) <span class="text-emerald-600">(auto)</span></label><input type="text" id="ocrLocal" placeholder="Ex: Santa Inês - MA" class="${INP}">`;
      bloco.parentNode.insertBefore(d, bloco);
    }
  }
  if (!document.getElementById('editLocal')) {
    const ref = document.getElementById('editValor'), bloco = ref && ref.closest('.grid');
    if (bloco && bloco.parentNode) {
      const d = document.createElement('div');
      d.innerHTML = `<label class="${LBL}">LOCAL (CIDADE - UF)</label><input type="text" id="editLocal" placeholder="Ex: Santa Inês - MA" class="${INP}">`;
      bloco.parentNode.insertBefore(d, bloco);
    }
  }
}
garantirCamposLocal();

// ============================================================
//  AGRUPAMENTO: UMA VIAGEM = VÁRIOS TÉCNICOS
// ============================================================
const ST_ARQ = ['FECHADA', 'ARQUIVADA', 'CANCELADO'];
const ST_ATIVOS_ORDEM = ['PENDENTE', 'SOLICITAR CORRECAO', 'ABERTO'];
const STATUS_UI = {
  'PENDENTE': { label: 'Aguardando aprovação', curto: 'Pendente', badge: 'bg-amber-100 text-amber-700 border-amber-200', bar: 'border-l-amber-500', dot: 'bg-amber-500', icon: 'fa-hourglass-half', txt: 'text-amber-600' },
  'SOLICITAR CORRECAO': { label: 'Correção solicitada', curto: 'Correção', badge: 'bg-red-100 text-red-700 border-red-200', bar: 'border-l-red-500', dot: 'bg-red-500', icon: 'fa-rotate-left', txt: 'text-red-600' },
  'ABERTO': { label: 'Em andamento (abertas)', curto: 'Aberto', badge: 'bg-blue-100 text-blue-700 border-blue-200', bar: 'border-l-blue-500', dot: 'bg-blue-500', icon: 'fa-folder-open', txt: 'text-blue-600' },
  'FECHADA': { label: 'Fechada', curto: 'Fechada', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', bar: 'border-l-emerald-500', dot: 'bg-emerald-500', icon: 'fa-circle-check', txt: 'text-emerald-600' },
  'ARQUIVADA': { label: 'Arquivada', curto: 'Arquivada', badge: 'bg-slate-200 text-slate-600 border-slate-300', bar: 'border-l-slate-400', dot: 'bg-slate-400', icon: 'fa-box-archive', txt: 'text-slate-500' },
  'CANCELADO': { label: 'Cancelada', curto: 'Cancelada', badge: 'bg-slate-200 text-slate-500 border-slate-300 line-through', bar: 'border-l-slate-300', dot: 'bg-slate-300', icon: 'fa-ban', txt: 'text-slate-400' }
};
function uiStatus(s) { return STATUS_UI[s] || STATUS_UI.ABERTO; }

function normChave(s) { return semAcentos_(String(s || '')).toLowerCase().replace(/\s+/g, ' ').trim(); }
function chaveGrupo(v) {
  if (v.idGrupo) return 'g:' + v.idGrupo;
  return 'k:' + String(v.sigla || '').toUpperCase() + '|' + normChave(v.motivo) + '|' + lower(v.criadoPor);
}
function kAttr(k) { return encodeURIComponent(k).replace(/'/g, '%27'); }
function nomeTecnico(login) { return nomesUsuarios[lower(login)] || login || '—'; }
function valorNum(v) { return Number(String(v || 0).replace(',', '.')) || 0; }
function somaItens(itens) { return (itens || []).reduce((a, i) => a + valorNum(i.valor), 0); }
function formatarMoedaBR(n) { return 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function statusAgregado(ms) {
  const st = ms.map(m => m.status);
  if (st.includes('PENDENTE')) return 'PENDENTE';
  if (st.includes('SOLICITAR CORRECAO')) return 'SOLICITAR CORRECAO';
  if (st.includes('ABERTO')) return 'ABERTO';
  if (st.every(s => s === 'ARQUIVADA')) return 'ARQUIVADA';
  if (st.every(s => s === 'CANCELADO')) return 'CANCELADO';
  return 'FECHADA';
}

function gruposDe(lista) {
  const mapa = new Map();
  (lista || []).forEach(v => {
    const k = chaveGrupo(v);
    if (!mapa.has(k)) mapa.set(k, { key: k, sigla: v.sigla, motivo: v.motivo, criadoPor: v.criadoPor, membros: [] });
    mapa.get(k).membros.push(v);
  });
  return Array.from(mapa.values()).map(g => {
    g.membros.sort((a, b) => nomeTecnico(a.colaborador).localeCompare(nomeTecnico(b.colaborador)));
    g.statusAgg = statusAgregado(g.membros);
    g.arquivado = g.membros.every(m => ST_ARQ.includes(m.status));
    g.nItens = g.membros.reduce((a, m) => a + (m.itens || []).length, 0);
    g.total = g.membros.reduce((a, m) => a + somaItens(m.itens), 0);
    return g;
  });
}
function grupoAtual() { return gruposDe(viagensGlobais).find(g => g.key === grupoAtualKey) || null; }
function viagemPorId(id) { return viagensGlobais.find(v => v.idViagem === id) || null; }
function acharItem(idComp) {
  for (const v of viagensGlobais) { const it = (v.itens || []).find(c => c.idComprovante === idComp); if (it) return { item: it, membro: v }; }
  return null;
}

// ==================== SESSÃO ====================
window.onload = () => {
  const savedUser = localStorage.getItem('usuarioDespesasAtivo');
  const loginTime = localStorage.getItem('loginDespesasTimestamp');
  if (savedUser && loginTime && (Date.now() - parseInt(loginTime) < TEMPO_SESSAO_MS)) { userData = JSON.parse(savedUser); iniciarSistema(); } else { logout(); }
};
function logout() {
  pararPolling();
  localStorage.removeItem('usuarioDespesasAtivo'); localStorage.removeItem('loginDespesasTimestamp');
  userData = null; grupoAtualKey = null; viagensGlobais = []; jaCarregou = false; lastSig = ''; tecnicos = []; usuariosPromise = null;
  document.getElementById('globalHeader').classList.add('hidden'); document.getElementById('mainContent').classList.add('hidden');
  document.getElementById('viagemDetalheView').classList.add('hidden'); document.getElementById('authView').classList.remove('hidden');
}

// ==================== TOAST ====================
function showToast(message, type = 'info', title = null, duration = 4000) {
  const container = document.getElementById('toastContainer'); if (!container) return;
  const toast = document.createElement('div'); toast.className = `toast toast-${type}`; toast.setAttribute('role', 'alert');
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
  const titles = { success: 'Sucesso', error: 'Erro', warning: 'Atenção', info: 'Informação' };
  toast.innerHTML = `<div class="toast-icon"><i class="fa-solid ${icons[type] || icons.info}"></i></div><div class="toast-content"><div class="toast-title">${title || titles[type] || titles.info}</div><div class="toast-message">${String(message || '')}</div></div><button class="toast-close" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button><div class="toast-progress" style="animation-duration:${duration}ms"></div>`;
  container.appendChild(toast);
  const fechar = () => { if (toast.dataset.closing) return; toast.dataset.closing = '1'; toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); };
  toast.querySelector('.toast-close').addEventListener('click', fechar);
  setTimeout(fechar, duration);
}

// ==================== MODAL CONFIRMAÇÃO ====================
function showConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const existing = document.querySelector('.modal-overlay'); if (existing) existing.remove();
    const { title = 'Confirmar Ação', confirmText = 'Confirmar', cancelText = 'Cancelar', type = 'warning', icon = 'fa-question' } = options;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;animation:fadeIn 0.2s ease-out;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;box-shadow:0 20px 25px -5px rgba(0,0,0,0.1);max-width:400px;width:90%;overflow:hidden;animation:slideUp 0.3s ease-out;';
    const corHeader = type === 'danger' ? '#ef4444' : type === 'info' ? '#3b82f6' : type === 'success' ? '#10b981' : '#f59e0b';
    modal.innerHTML = `<div style="background:${corHeader};color:white;padding:1rem;display:flex;align-items:center;gap:0.75rem;"><div style="font-size:1.5rem;"><i class="fa-solid ${icon}"></i></div><h3 style="font-weight:700;font-size:1.125rem;margin:0;">${title}</h3></div><div style="padding:1.5rem;"><p style="color:#475569;line-height:1.5;margin:0;">${message}</p></div><div style="padding:1rem 1.5rem;background:#f8fafc;display:flex;gap:0.75rem;justify-content:flex-end;"><button id="modalCancel" style="padding:0.5rem 1rem;border-radius:0.375rem;font-weight:600;font-size:0.875rem;background:#e2e8f0;color:#475569;border:none;cursor:pointer;">${cancelText}</button><button id="modalConfirm" style="padding:0.5rem 1rem;border-radius:0.375rem;font-weight:600;font-size:0.875rem;background:${corHeader};color:white;border:none;cursor:pointer;">${confirmText}</button></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const cleanup = () => { overlay.style.animation = 'fadeOut 0.2s ease-out'; setTimeout(() => overlay.remove(), 200); };
    document.getElementById('modalConfirm').onclick = () => { cleanup(); resolve(true); };
    document.getElementById('modalCancel').onclick = () => { cleanup(); resolve(false); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(false); } });
  });
}

async function fetchAPI(data, btnId = null, textId = null, originalText = null) {
  const btn = btnId ? document.getElementById(btnId) : null;
  if (btn) { btn.disabled = true; if (textId) document.getElementById(textId).innerHTML = '<span class="loader-small"></span> Aguarde...'; }
  try { const response = await fetch(API_URL, { method: 'POST', body: JSON.stringify(data) }); return await response.json(); }
  catch (e) { showToast('Erro de Conexão com o Banco.', 'error'); return { success: false }; }
  finally { if (btn) { btn.disabled = false; if (textId) document.getElementById(textId).innerHTML = originalText; } }
}

async function postAPI(data) {
  try { const r = await fetch(API_URL, { method: 'POST', body: JSON.stringify(data) }); return await r.json(); }
  catch (e) { return null; }
}

// ==================== AUTH ====================
function toggleAuthView(v) {
  if (v === 'register') { document.getElementById('loginSection').classList.add('hidden'); document.getElementById('registerSection').classList.remove('hidden'); }
  else { document.getElementById('registerSection').classList.add('hidden'); document.getElementById('loginSection').classList.remove('hidden'); }
}
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetchAPI({ action: 'login', login: document.getElementById('loginUser').value.trim(), senha: document.getElementById('loginSenha').value }, 'btnLogin', 'loginText', 'Acessar Despesas <i class="fa-solid fa-arrow-right-to-bracket ml-2"></i>');
  if (r && r.success) { localStorage.setItem('usuarioDespesasAtivo', JSON.stringify(r.user)); localStorage.setItem('loginDespesasTimestamp', Date.now().toString()); userData = r.user; iniciarSistema(); }
  else { showToast(r.message || 'Credenciais incorretas', 'error'); }
});
document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = { action: 'register', nome: document.getElementById('regNome').value, sobrenome: document.getElementById('regSobrenome').value, equipe: document.getElementById('regEquipe').value, nivel: document.getElementById('regNivel').value, senha: document.getElementById('regSenha').value };
  const r = await fetchAPI(data, 'btnRegister', 'regText', '<i class="fa-solid fa-save mr-2"></i> Cadastrar');
  if (r && r.success) { showToast(`Usuário criado: ${r.login}`, 'success'); toggleAuthView('login'); } else { showToast(r.message, 'error'); }
});

function iniciarSistema() {
  document.getElementById('authView').classList.add('hidden'); document.getElementById('globalHeader').classList.remove('hidden'); document.getElementById('mainContent').classList.remove('hidden');
  document.getElementById('navUserName').textContent = `${userData.nome} ${userData.sobrenome}`; document.getElementById('navUserRole').textContent = `${userData.nivel}`;
  jaCarregou = false; lastSig = ''; viagensGlobais = []; abaAtiva = 'ATIVAS'; filtroStatus = 'TODOS'; filtroLojaSelecionada = 'TODAS';
  carregarUsuarios();
  recarregarDashboard();
  iniciarPolling();
}

// ==================== USUÁRIOS (nomes + lista de técnicos) ====================
function carregarUsuarios() {
  if (!usuariosPromise) {
    usuariosPromise = postAPI({ action: 'getUsers' }).then(r => {
      if (r && r.success) {
        (r.users || []).forEach(u => { nomesUsuarios[lower(u.login)] = u.nome; });
        tecnicos = (r.users || []).filter(u => !RX_GESTAO.test(u.nivel || ''));
        if (userData) renderTudo();
      } else usuariosPromise = null;
      return tecnicos;
    });
  }
  return usuariosPromise;
}

// ==================== SINCRONIZAÇÃO AUTOMÁTICA ====================
function iniciarPolling() {
  pararPolling();
  pollTimer = setInterval(() => {
    if (!userData) return;
    const t = parseInt(localStorage.getItem('loginDespesasTimestamp') || '0', 10);
    if (t && Date.now() - t >= TEMPO_SESSAO_MS) { showToast('Sua sessão expirou por segurança.', 'warning', 'Tempo Esgotado'); logout(); return; }
    if (!document.hidden && !polling && busy === 0) atualizarViagens();
  }, POLL_MS);
}
function pararPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && userData) atualizarViagens(); });
window.addEventListener('online', () => { if (userData) atualizarViagens(); });

async function atualizarViagens() {
  if (!userData) return;
  while (polling) await pollPromise;
  if (!userData) return;
  polling = true;
  pollPromise = (async () => {
    const r = await postAPI({ action: 'getDespesasViagens', login: userData.login, nivel: userData.nivel });
    if (!userData) return;
    if (r && r.success) aplicarViagens(r.viagens || []);
    else if (!jaCarregou && viagensGlobais.length === 0) document.getElementById('gridViagens').innerHTML = '<div class="col-span-full text-center py-10 text-amber-600"><i class="fa-solid fa-wifi mr-1"></i> Não foi possível carregar. Tentando novamente...</div>';
  })();
  try { await pollPromise; } finally { polling = false; }
}

function detectarMudancas(antigas, novas) {
  const mapa = {}; antigas.forEach(v => { mapa[v.idViagem] = v; });
  const avisados = new Set();
  novas.forEach(v => {
    const o = mapa[v.idViagem];
    if (!o) {
      const k = chaveGrupo(v);
      if (!avisados.has(k) && lower(v.criadoPor) !== lower(userData.login)) { avisados.add(k); showToast(`${v.sigla} - ${v.motivo}`, 'info', 'Nova viagem'); }
    }
    else if (o.status !== v.status) showToast(`${v.sigla} (${nomeTecnico(v.colaborador)}): ${o.status} → ${v.status}`, 'info', 'Status atualizado');
    else if (isGestaoUser() && (v.itens || []).length > (o.itens || []).length) showToast(`${v.sigla} (${nomeTecnico(v.colaborador)}): nova despesa lançada.`, 'info', 'Ao vivo');
  });
}

function aplicarViagens(novas) {
  if (busy > 0) return;
  const sig = JSON.stringify(novas);
  if (sig === lastSig && jaCarregou) return;
  lastSig = sig;
  if (jaCarregou) detectarMudancas(viagensGlobais, novas);
  viagensGlobais = novas; jaCarregou = true;
  if (grupoAtualKey && !grupoAtual()) { showToast('Esta viagem foi removida.', 'warning'); mostrarLista(); }
  renderTudo();
}

function renderTudo() {
  renderPainel();
  if (grupoAtualKey && grupoAtual()) renderDetalhe();
}

function mostrarLista() {
  grupoAtualKey = null;
  document.getElementById('viagemDetalheView').classList.add('hidden');
  document.getElementById('mainContent').classList.remove('hidden');
}

function montarCabecalhoPainel() {
  const isGestao = isGestaoUser();
  document.getElementById('dashTitle').innerHTML = isGestao ? `<i class="fa-solid fa-user-shield text-emerald-600 mr-2"></i> Painel da Gestão` : `<i class="fa-solid fa-plane-departure text-emerald-600 mr-2"></i> Minhas Viagens`;
  document.getElementById('dashSubtitle').textContent = isGestao ? "Acompanhe e autorize reembolsos. Cada viagem reúne todos os técnicos escolhidos." : "Receba viagens criadas pela coordenação e envie seus comprovantes.";
  const btnArea = document.getElementById('dashActionButtons'); btnArea.innerHTML = '';
  if (isGestao) {
    btnArea.innerHTML = `<button onclick="abrirModalCriarViagem()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-4 rounded shadow text-sm transition"><i class="fa-solid fa-plus mr-2"></i> Criar Número da Viagem</button>`;
    carregarUsuarios();
  }
}

async function recarregarDashboard() {
  mostrarLista();
  montarCabecalhoPainel();
  if (viagensGlobais.length) renderPainel();
  else document.getElementById('gridViagens').innerHTML = '<div class="text-center py-10 text-slate-500"><i class="fa-solid fa-spinner fa-spin text-2xl"></i><br>Carregando viagens...</div>';
  await atualizarViagens();
}

// ==================== PAINEL PRINCIPAL (abas, resumo, seções) ====================
function garantirPainel() {
  if ($('abasViagens')) return;
  const ref = $('filtroSiglasLojas');
  const abas = document.createElement('div'); abas.id = 'abasViagens'; abas.className = 'mb-4 flex gap-2 border-b border-slate-300';
  const resumo = document.createElement('div'); resumo.id = 'painelResumo'; resumo.className = 'mb-5 grid grid-cols-2 md:grid-cols-4 gap-3';
  ref.parentNode.insertBefore(abas, ref);
  ref.parentNode.insertBefore(resumo, ref);
  $('gridViagens').className = 'space-y-8 fade-in';
}

function setAba(a) { abaAtiva = a; filtroLojaSelecionada = 'TODAS'; filtroStatus = 'TODOS'; renderPainel(); }
function setFiltroStatus(s) { filtroStatus = (filtroStatus === s) ? 'TODOS' : s; renderPainel(); }
function filtrarPorLoja(sigla) { filtroLojaSelecionada = sigla; renderPainel(); }

function renderPainel() {
  garantirPainel();
  const grupos = gruposDe(viagensGlobais);
  const ativas = grupos.filter(g => !g.arquivado);
  const arq = grupos.filter(g => g.arquivado);

  // abas
  const aba = (id, icon, txt, n) => {
    const on = abaAtiva === id;
    return `<button onclick="setAba('${id}')" class="px-4 py-2.5 text-sm font-bold -mb-px border-b-2 transition ${on ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-800'}"><i class="fa-solid ${icon} mr-2"></i>${txt} <span class="ml-1 text-[10px] px-2 py-0.5 rounded-full ${on ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}">${n}</span></button>`;
  };
  $('abasViagens').innerHTML = aba('ATIVAS', 'fa-layer-group', 'Ativas', ativas.length) + aba('ARQUIVADAS', 'fa-box-archive', 'Arquivadas', arq.length);

  // resumo (filtros por status) - só nas ativas
  const boxResumo = $('painelResumo');
  if (abaAtiva === 'ATIVAS') {
    boxResumo.classList.remove('hidden');
    const tile = (st) => {
      const u = uiStatus(st), n = ativas.filter(g => g.statusAgg === st).length;
      const on = filtroStatus === st;
      return `<button onclick="setFiltroStatus('${st}')" class="text-left bg-white rounded-xl border-l-4 ${u.bar} border border-slate-200 p-4 shadow-sm hover:shadow-md transition ${on ? 'ring-2 ring-slate-800' : ''}"><div class="flex items-center justify-between"><span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">${u.label}</span><i class="fa-solid ${u.icon} ${u.txt}"></i></div><div class="text-3xl font-black text-slate-800 mt-1">${n}</div></button>`;
    };
    const totalAtivas = ativas.reduce((a, g) => a + g.total, 0);
    boxResumo.innerHTML = tile('PENDENTE') + tile('SOLICITAR CORRECAO') + tile('ABERTO') +
      `<div class="bg-slate-900 rounded-xl p-4 shadow-sm"><div class="flex items-center justify-between"><span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total nas ativas</span><i class="fa-solid fa-wallet text-emerald-400"></i></div><div class="text-xl font-black text-emerald-400 mt-2">${formatarMoedaBR(totalAtivas)}</div></div>`;
  } else { boxResumo.classList.add('hidden'); boxResumo.innerHTML = ''; }

  // filtro por sigla (da aba atual)
  const base = abaAtiva === 'ATIVAS' ? ativas : arq;
  const siglas = ['TODAS']; base.forEach(g => { if (!siglas.includes(g.sigla)) siglas.push(g.sigla); });
  if (!siglas.includes(filtroLojaSelecionada)) filtroLojaSelecionada = 'TODAS';
  $('filtroSiglasLojas').innerHTML = siglas.map(s => {
    const active = (filtroLojaSelecionada === s) ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100 border';
    return `<button onclick="filtrarPorLoja('${s}')" class="${active} px-4 py-1.5 rounded-full font-bold text-xs shadow-sm transition uppercase whitespace-nowrap">${escaparTextoHtml(s)}</button>`;
  }).join('');

  let lista = base.filter(g => filtroLojaSelecionada === 'TODAS' || g.sigla === filtroLojaSelecionada);
  const grid = $('gridViagens');

  if (abaAtiva === 'ATIVAS') {
    if (filtroStatus !== 'TODOS') lista = lista.filter(g => g.statusAgg === filtroStatus);
    if (!lista.length) { grid.innerHTML = `<div class="text-center py-10 bg-white border border-dashed rounded text-slate-400"><i class="fa-solid fa-folder-open text-3xl mb-2"></i><br>Nenhuma viagem ativa${filtroStatus !== 'TODOS' ? ' neste status' : ''}.</div>`; return; }
    let html = '';
    ST_ATIVOS_ORDEM.forEach(st => {
      const sec = lista.filter(g => g.statusAgg === st);
      if (!sec.length) return;
      const u = uiStatus(st);
      html += `<section><div class="flex items-center gap-2 mb-3"><i class="fa-solid ${u.icon} ${u.txt}"></i><h3 class="text-sm font-black uppercase tracking-wider text-slate-700">${u.label}</h3><span class="text-[10px] font-bold bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">${sec.length}</span><div class="flex-1 border-t border-slate-200 ml-2"></div></div><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">${sec.map(cardGrupo).join('')}</div></section>`;
    });
    grid.innerHTML = html;
  } else {
    if (!lista.length) { grid.innerHTML = `<div class="text-center py-10 bg-white border border-dashed rounded text-slate-400"><i class="fa-solid fa-box-archive text-3xl mb-2"></i><br>Nenhuma viagem arquivada.</div>`; return; }
    lista.sort((a, b) => String(a.sigla).localeCompare(String(b.sigla)));
    grid.innerHTML = `<section><div class="flex items-center gap-2 mb-3"><i class="fa-solid fa-box-archive text-slate-500"></i><h3 class="text-sm font-black uppercase tracking-wider text-slate-700">Viagens fechadas e arquivadas</h3><div class="flex-1 border-t border-slate-200 ml-2"></div></div><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">${lista.map(cardGrupo).join('')}</div></section>`;
  }
}

function cardGrupo(g) {
  const u = uiStatus(g.statusAgg);
  const chips = g.membros.map(m => `<span class="inline-flex items-center gap-1.5 bg-slate-50 border rounded-full pl-2 pr-2.5 py-0.5 text-[11px] font-semibold text-slate-600" title="${escaparAtributoHtml(uiStatus(m.status).label)}"><span class="w-2 h-2 rounded-full ${uiStatus(m.status).dot}"></span>${escaparTextoHtml(nomeTecnico(m.colaborador))}</span>`).join('');
  const multi = g.membros.length > 1 ? `<span class="text-[10px] font-bold text-slate-500"><i class="fa-solid fa-users mr-1"></i>${g.membros.length} técnicos</span>` : '';
  return `<div onclick="abrirGrupo('${kAttr(g.key)}')" class="bg-white p-5 rounded-xl border border-slate-200 border-l-4 ${u.bar} shadow-sm hover:shadow-md cursor-pointer transition flex flex-col justify-between"><div><div class="flex justify-between items-start mb-2"><span class="bg-slate-900 text-emerald-400 px-3 py-1 rounded text-xs font-black uppercase tracking-wider">${escaparTextoHtml(g.sigla)}</span><span class="${u.badge} text-[10px] font-bold px-2 py-0.5 rounded border uppercase">${u.curto}</span></div><h3 class="text-base font-bold text-slate-800 line-clamp-2 mt-2" title="${escaparAtributoHtml(g.motivo)}">${escaparTextoHtml(g.motivo)}</h3><div class="flex flex-wrap gap-1.5 mt-3">${chips}</div></div><div class="mt-4 pt-3 border-t text-xs text-slate-500 flex justify-between items-end"><div><p class="text-[11px]">Solicitou: <b>${escaparTextoHtml(g.criadoPor)}</b></p>${multi}</div><div class="text-right"><p class="text-emerald-600 font-black text-sm">${formatarMoedaBR(g.total)}</p><p class="text-[10px] text-slate-400"><i class="fa-solid fa-paperclip"></i> ${g.nItens} despesa(s)</p></div></div></div>`;
}

// ==================== COORDENAÇÃO: CRIAR VIAGEM (um ticket, vários técnicos) ====================
function checkOutrosViagem() { const v = $('novaViagemTipo').value; if (v === 'Outros') $('novaViagemOutros').classList.remove('hidden'); else { $('novaViagemOutros').classList.add('hidden'); $('novaViagemOutros').value = ''; } }

async function abrirModalCriarViagem() {
  $('novaViagemSigla').value = ''; $('novaViagemMotivo').value = ''; $('novaViagemOutros').value = ''; $('buscaTecnico').value = '';
  $('novaViagemTipo').value = 'Inauguração'; checkOutrosViagem();
  tecnicosSel = new Set();
  $('modalCriarViagem').classList.remove('hidden');
  $('listaTecnicos').innerHTML = '<p class="text-xs text-slate-400 text-center py-3"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Carregando técnicos...</p>';
  await carregarUsuarios();
  renderListaTecnicos();
}
function fecharModalCriarViagem() { $('modalCriarViagem').classList.add('hidden'); }

function atualizarContTecnicos() { $('contTecnicos').textContent = `(${tecnicosSel.size} selecionado${tecnicosSel.size === 1 ? '' : 's'})`; }

function listaTecnicosVisiveis() {
  const q = ($('buscaTecnico').value || '').trim().toLowerCase();
  return tecnicos.filter(u => (String(u.nome || '') + ' ' + String(u.login || '')).toLowerCase().includes(q));
}

function renderListaTecnicos() {
  const box = $('listaTecnicos'); box.innerHTML = '';
  const lista = listaTecnicosVisiveis();
  if (!lista.length) { box.innerHTML = '<p class="text-xs text-slate-400 text-center py-3">Nenhum técnico encontrado.</p>'; atualizarContTecnicos(); return; }
  lista.forEach(u => {
    const lb = document.createElement('label');
    lb.className = 'flex items-center gap-2 px-3 py-2 border-b text-sm cursor-pointer hover:bg-slate-50';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'h-4 w-4 accent-emerald-600'; cb.checked = tecnicosSel.has(u.login);
    cb.onchange = () => { if (cb.checked) tecnicosSel.add(u.login); else tecnicosSel.delete(u.login); atualizarContTecnicos(); };
    const sp = document.createElement('span'); sp.innerHTML = `<b>${escaparTextoHtml(u.nome)}</b> <span class="text-[11px] text-slate-400 font-mono">${escaparTextoHtml(u.login)}</span>`;
    lb.appendChild(cb); lb.appendChild(sp); box.appendChild(lb);
  });
  atualizarContTecnicos();
}

function selecionarTodosTecnicos() {
  const vis = listaTecnicosVisiveis();
  const todos = vis.length && vis.every(u => tecnicosSel.has(u.login));
  vis.forEach(u => { if (todos) tecnicosSel.delete(u.login); else tecnicosSel.add(u.login); });
  renderListaTecnicos();
}

async function confirmarCriarViagem() {
  const sigla = $('novaViagemSigla').value.trim().toUpperCase();
  let tipo = $('novaViagemTipo').value;
  if (tipo === 'Outros') tipo = $('novaViagemOutros').value.trim();
  const motivo = $('novaViagemMotivo').value.trim() || tipo;
  let logins = Array.from(tecnicosSel);
  if (!sigla || !tipo) { showToast('Informe a sigla e a categoria.', 'warning'); return; }
  if (!logins.length) { showToast('Selecione ao menos um técnico.', 'warning'); return; }

  // evita duplicar quem já está numa viagem ativa igual (mesma loja + mesmo motivo)
  const jaExistem = viagensGlobais.filter(v => String(v.sigla).toUpperCase() === sigla && normChave(v.motivo) === normChave(motivo) && !ST_ARQ.includes(v.status)).map(v => lower(v.colaborador));
  const duplicados = logins.filter(l => jaExistem.includes(lower(l)));
  if (duplicados.length) {
    showToast(`Já estão nesta viagem: ${duplicados.map(l => escaparTextoHtml(nomeTecnico(l))).join(', ')}.`, 'warning', 'Ignorados', 6000);
    logins = logins.filter(l => !duplicados.includes(l));
    if (!logins.length) return;
  }

  const idGrupo = 'G' + Date.now();
  const btn = $('btnCriarViagem'); const original = btn.innerHTML; btn.disabled = true;
  busy++;
  const falhas = [];
  try {
    // Sequencial de propósito: evita gravações simultâneas na planilha (ids duplicados)
    for (let i = 0; i < logins.length; i++) {
      btn.innerHTML = `<span class="loader-small"></span> ${i + 1}/${logins.length}`;
      const login = logins[i];
      const a = await postAPI({ action: 'initProject', login, sigla, tipoProjeto: tipo });
      const b = await postAPI({ action: 'createDespesaViagem', sigla, motivo, colaborador: login, criadoPor: userData.login, nivel: userData.nivel, idGrupo });
      if (!(a && a.success) || !(b && b.success)) falhas.push(login);
    }
  } finally { busy--; btn.disabled = false; btn.innerHTML = original; }
  fecharModalCriarViagem();
  if (falhas.length) showToast(`Falha ao criar para: ${falhas.map(l => escaparTextoHtml(nomeTecnico(l))).join(', ')}`, 'error', 'Atenção', 7000);
  const ok = logins.length - falhas.length;
  if (ok > 0) showToast(`Viagem ${sigla} criada com ${ok} técnico(s): despesas e projeto de horas abertos.`, 'success', 'Viagem Criada');
  atualizarViagens();
}

// ==================== DETALHE DA VIAGEM (grupo) ====================
function abrirGrupo(keyEnc) {
  grupoAtualKey = decodeURIComponent(keyEnc);
  if (!grupoAtual()) { grupoAtualKey = null; return; }
  document.getElementById('mainContent').classList.add('hidden'); document.getElementById('viagemDetalheView').classList.remove('hidden');
  renderDetalhe();
}

function garantirDetalhe() {
  if ($('grupoConteudo')) return;
  const tb = $('tbItensViagem');
  const wrapper = tb && tb.closest('.overflow-auto');
  if (!wrapper) return;
  const h3 = wrapper.previousElementSibling;
  if (h3 && h3.tagName === 'H3') h3.classList.add('hidden');
  wrapper.classList.add('hidden');
  const box = document.createElement('div'); box.id = 'grupoConteudo'; box.className = 'space-y-6';
  wrapper.parentNode.insertBefore(box, wrapper);
}

function renderDetalhe() {
  const g = grupoAtual(); if (!g) return;
  garantirDetalhe();
  const u = uiStatus(g.statusAgg);
  document.getElementById('detalheLojaSigla').textContent = `LOJA: ${g.sigla}`;
  document.getElementById('detalheMotivo').textContent = g.motivo;
  document.getElementById('detalheParticipantes').textContent = `Solicitado por: ${g.criadoPor} | ${g.membros.length > 1 ? 'Técnicos' : 'Responsável'}: ${g.membros.map(m => nomeTecnico(m.colaborador)).join(', ')}`;
  const bg = { PENDENTE: 'bg-amber-500', 'SOLICITAR CORRECAO': 'bg-red-500', ABERTO: 'bg-blue-600', FECHADA: 'bg-emerald-500', ARQUIVADA: 'bg-slate-500', CANCELADO: 'bg-slate-500' }[g.statusAgg] || 'bg-slate-800';
  document.getElementById('detalheStatusBadge').innerHTML = `<span class="${bg} text-white font-bold px-4 py-1.5 rounded text-xs uppercase shadow"><i class="fa-solid ${u.icon} mr-1"></i> ${u.label}</span>`;
  renderAcoesGrupo(g);
  renderMembros(g);
}

function renderAcoesGrupo(g) {
  const area = document.getElementById('painelAcoesViagem');
  const gestao = isGestaoUser();
  let esq = '', dir = '';
  if (gestao) {
    const nPend = g.membros.filter(m => m.status === 'PENDENTE').length;
    const nFech = g.membros.filter(m => m.status === 'FECHADA').length;
    if (nPend > 0) esq += `<button onclick="alterarStatusGrupo('PENDENTE','FECHADA')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-check-double mr-2"></i> Fechar ${nPend > 1 ? 'todos os pendentes (' + nPend + ')' : 'pendente'}</button>`;
    if (nFech > 0) esq += `<button onclick="alterarStatusGrupo('FECHADA','ARQUIVADA')" class="bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-box-archive mr-2"></i> Arquivar ${nFech > 1 ? 'fechadas (' + nFech + ')' : 'fechada'}</button>`;
    dir += `<button onclick="excluirViagem()" class="bg-red-600 hover:bg-red-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-trash mr-2"></i> Excluir viagem</button>`;
  }
  const podeExportar = gestao || g.membros.some(m => lower(m.colaborador) === lower(userData.login));
  if (podeExportar) dir = `<button onclick="exportarRelatorioViagem()" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-file-export mr-2"></i> Exportar relatório</button>` + dir;
  area.innerHTML = `<div class="flex flex-wrap gap-2">${esq}</div><div class="flex flex-wrap gap-2 ml-auto">${dir}</div>`;
}

function linhaItemHtml(item, isColab, emEdicao, podeVer) {
  const vn = valorNum(item.valor);
  let btnAcao = '';
  if (isColab && emEdicao) btnAcao = `<div class="flex gap-3 justify-center"><button onclick="editarComprovanteViagem('${item.idComprovante}')" class="text-amber-600 hover:text-amber-800" title="Editar"><i class="fa-solid fa-pen"></i></button><button onclick="excluirDespesaViagem('${item.idComprovante}')" class="text-red-500 hover:text-red-700" title="Excluir"><i class="fa-solid fa-trash"></i></button></div>`;
  let cel = '<td class="px-4 py-3 text-xs text-center text-slate-300">—</td>';
  if (podeVer) {
    if (item.urlComprovante) {
      cel = `<td class="px-4 py-3 text-xs"><div class="flex items-center gap-3">${htmlMiniatura(item)}<div class="flex flex-col gap-1">
        <button type="button" class="text-[10px] font-bold text-blue-600 hover:text-blue-800 text-left" onclick="abrirVisualizador('${item.idComprovante}')"><i class="fa-solid fa-eye mr-1"></i> Ver</button>
        <button type="button" class="text-[10px] font-bold text-emerald-600 hover:text-emerald-800 text-left" onclick="baixarComprovante('${item.idComprovante}')"><i class="fa-solid fa-download mr-1"></i> Baixar</button>
        <button type="button" class="text-[10px] font-bold text-slate-600 hover:text-slate-800 text-left" onclick="imprimirComprovante('${item.idComprovante}')"><i class="fa-solid fa-print mr-1"></i> Imprimir</button>
      </div></div></td>`;
    } else cel = '<td class="px-4 py-3 text-xs text-center text-amber-600 font-bold">Sem imagem</td>';
  }
  const localTxt = item.localDespesa ? escaparTextoHtml(item.localDespesa) : '<span class="text-slate-300">—</span>';
  return `<tr class="hover:bg-slate-50 border-b"><td class="px-4 py-3 text-xs">${formatarDataVisao(item.dataDespesa)}</td><td class="px-4 py-3 text-xs font-bold text-slate-700">${escaparTextoHtml(item.categoria || '')}</td><td class="px-4 py-3 text-xs font-bold text-slate-600"><i class="fa-solid fa-location-dot text-slate-400 mr-1"></i>${localTxt}</td><td class="px-4 py-3 text-xs uppercase font-bold text-slate-500">${escaparTextoHtml(item.lojaDebito || '')}</td><td class="px-4 py-3 text-xs text-right font-bold text-emerald-600">${formatarMoedaBR(vn)}</td>${cel}<td class="px-4 py-3 text-xs text-center">${btnAcao}</td></tr>`;
}

function htmlMembro(m) {
  const gestao = isGestaoUser();
  const isColab = lower(m.colaborador) === lower(userData.login);
  const emEdicao = (m.status === 'ABERTO' || m.status === 'SOLICITAR CORRECAO');
  const podeVer = gestao || isColab;
  const u = uiStatus(m.status);
  const itens = (m.itens || []).slice().sort((a, b) => chaveDataOrdenacao(a.dataDespesa) - chaveDataOrdenacao(b.dataDespesa));
  const total = somaItens(itens);
  const nome = nomeTecnico(m.colaborador);

  let btns = '';
  if (isColab && emEdicao) {
    btns += `<button onclick="abrirModalOCR('${m.idViagem}')" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-camera mr-2"></i> Tirar Foto / Enviar Nota</button>`;
    if (itens.length > 0) btns += `<button onclick="enviarDespesasViagem('${m.idViagem}')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-paper-plane mr-2"></i> Enviar Despesas</button>`;
  }
  if (gestao) {
    if (m.status === 'PENDENTE') {
      btns += `<button onclick="alterarStatusViagem('${m.idViagem}','FECHADA')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-1.5 px-3 rounded shadow"><i class="fa-solid fa-check mr-1"></i> Fechar</button>`;
      btns += `<button onclick="alterarStatusViagem('${m.idViagem}','SOLICITAR CORRECAO')" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold py-1.5 px-3 rounded shadow"><i class="fa-solid fa-arrow-rotate-left mr-1"></i> Solicitar Correção</button>`;
    }
    if (m.status === 'FECHADA') btns += `<button onclick="alterarStatusViagem('${m.idViagem}','ARQUIVADA')" class="bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold py-1.5 px-3 rounded shadow"><i class="fa-solid fa-box-archive mr-1"></i> Arquivar</button>`;
  }

  const corpo = itens.length
    ? itens.map(i => linhaItemHtml(i, isColab, emEdicao, podeVer)).join('')
    : '<tr><td colspan="7" class="p-6 text-center text-slate-400 text-sm">Nenhuma despesa lançada por este técnico ainda.</td></tr>';

  return `<div class="border border-slate-200 border-l-4 ${u.bar} rounded-xl overflow-hidden shadow-sm">
    <div class="bg-slate-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3 border-b">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-full bg-slate-800 text-emerald-400 flex items-center justify-center font-black text-sm">${escaparTextoHtml(String(nome).charAt(0).toUpperCase())}</div>
        <div><p class="text-sm font-bold text-slate-800 leading-tight">${escaparTextoHtml(nome)}${isColab ? ' <span class="text-[10px] text-emerald-600 font-bold">(você)</span>' : ''}</p><p class="text-[11px] text-slate-400 font-mono">${escaparTextoHtml(m.colaborador)}</p></div>
        <span class="${u.badge} text-[10px] font-bold px-2 py-0.5 rounded border uppercase">${u.curto}</span>
      </div>
      <div class="flex flex-wrap items-center gap-2">${btns}<div class="text-right pl-2"><p class="text-[10px] uppercase font-bold text-slate-400">Subtotal</p><p class="text-base font-black text-emerald-600 leading-none">${formatarMoedaBR(total)}</p></div></div>
    </div>
    <div class="overflow-auto custom-scrollbar"><table class="min-w-full text-sm text-left">
      <thead class="bg-white border-b"><tr>
        <th class="px-4 py-2 font-bold text-slate-500 uppercase text-[10px]">Data</th><th class="px-4 py-2 font-bold text-slate-500 uppercase text-[10px]">Categoria</th><th class="px-4 py-2 font-bold text-slate-500 uppercase text-[10px]">Local</th><th class="px-4 py-2 font-bold text-slate-500 uppercase text-[10px]">Loja</th><th class="px-4 py-2 font-bold text-slate-500 uppercase text-[10px] text-right">Valor</th><th class="px-4 py-2 font-bold text-slate-500 uppercase text-[10px] text-center">Comprovante</th><th class="px-4 py-2 font-bold text-slate-500 uppercase text-[10px] text-center">Ação</th>
      </tr></thead><tbody class="divide-y divide-slate-100">${corpo}</tbody></table></div>
  </div>`;
}

function renderMembros(g) {
  const box = $('grupoConteudo'); if (!box) return;
  const total = g.total;
  const resumo = g.membros.length > 1
    ? `<div class="flex flex-wrap gap-4 mt-1">${g.membros.map(m => `<span class="text-[11px] text-slate-300">${escaparTextoHtml(nomeTecnico(m.colaborador))}: <b class="text-white">${formatarMoedaBR(somaItens(m.itens))}</b></span>`).join('')}</div>` : '';
  box.innerHTML = g.membros.map(htmlMembro).join('') +
    `<div class="bg-slate-900 rounded-xl px-6 py-4 flex flex-wrap justify-between items-center gap-3"><div><span class="text-xs font-bold uppercase tracking-wider text-slate-400">Total da viagem (${g.nItens} despesa${g.nItens === 1 ? '' : 's'})</span>${resumo}</div><span class="text-2xl font-black text-emerald-400">${formatarMoedaBR(total)}</span></div>`;
}

// ==================== EDITAR / EXCLUIR DESPESA ====================
function editarComprovanteViagem(idComp) {
  const f = acharItem(idComp); if (!f) return;
  const item = f.item;
  document.getElementById('editIdComprovante').value = idComp;
  document.getElementById('editData').value = formatarDataVisao(item.dataDespesa) || '';
  document.getElementById('editHora').value = formatarHoraVisao(item.horaDespesa) || '';
  document.getElementById('editValor').value = valorNum(item.valor).toFixed(2);
  document.getElementById('editLoja').value = item.lojaDebito || '';
  document.getElementById('editLocal').value = item.localDespesa || '';
  document.getElementById('editCategoria').value = item.categoria || '';
  const img = document.getElementById('editPreviewImg');
  img.dataset.tentou = ''; img.dataset.id = idComp; img.style.display = '';
  img.referrerPolicy = 'no-referrer'; img.onerror = () => fallbackThumb(img);
  img.src = item.urlComprovante ? montarUrlThumbnailDrive(item.urlComprovante) : '';
  document.getElementById('editPreviewContainer').classList.toggle('hidden', !item.urlComprovante);
  document.getElementById('editFileOCR').value = '';
  document.getElementById('modalEditarComprovante').classList.remove('hidden');
}

async function salvarEdicaoComprovante() {
  const idComp = document.getElementById('editIdComprovante').value;
  const valorRaw = document.getElementById('editValor').value;
  const loja = document.getElementById('editLoja').value.trim();
  const categoria = document.getElementById('editCategoria').value;
  if (!valorRaw || !loja || !categoria) { showToast('Preencha valor, loja e categoria.', 'warning'); return; }

  const fileInput = document.getElementById('editFileOCR');
  let novaImagem = null, novoMime = null;
  if (fileInput.files && fileInput.files[0]) {
    novaImagem = await converterFileParaBase64(fileInput.files[0]);
    const matchMime = String(novaImagem).match(/^data:([^;]+);base64,/);
    novoMime = matchMime ? matchMime[1] : (fileInput.files[0].type || 'image/jpeg');
  }

  const data = { action: 'updateComprovante', idComprovante: idComp, login: userData.login, dataDespesa: document.getElementById('editData').value.trim(), horaDespesa: document.getElementById('editHora').value.trim(), valor: parseFloat(String(valorRaw).replace(',', '.')), lojaDebito: loja, categoria, localDespesa: document.getElementById('editLocal').value.trim() };
  if (novaImagem) { data.imagemBase64 = novaImagem; data.mimeType = novoMime; }

  busy++;
  let r;
  try { r = await fetchAPI(data, 'btnSalvarEdicao'); } finally { busy--; }
  if (r && r.success) {
    delete cacheImagens[idComp]; document.getElementById('modalEditarComprovante').classList.add('hidden'); showToast('Despesa atualizada!', 'success');
    const f = acharItem(idComp);
    if (f) { Object.assign(f.item, { dataDespesa: data.dataDespesa, horaDespesa: data.horaDespesa, valor: data.valor, lojaDebito: data.lojaDebito, categoria: data.categoria, localDespesa: data.localDespesa }); renderTudo(); }
    atualizarViagens();
  }
  else { showToast(r.message || 'Erro ao atualizar.', 'error'); }
}

async function excluirDespesaViagem(idComp) {
  if (!await showConfirm("Excluir esta despesa e a foto permanentemente?", { type: 'danger', icon: 'fa-trash' })) return;
  const f = acharItem(idComp); if (!f) return;
  const membro = f.membro, backup = membro.itens.slice();
  membro.itens = membro.itens.filter(c => c.idComprovante !== idComp);
  renderTudo();
  busy++;
  let r;
  try { r = await fetchAPI({ action: 'deleteComprovante', idComprovante: idComp, login: userData.login }); } finally { busy--; }
  if (r && r.success) { delete cacheImagens[idComp]; showToast('Despesa excluída.', 'success'); atualizarViagens(); }
  else { membro.itens = backup; renderTudo(); showToast((r && r.message) || 'Erro ao excluir.', 'error'); }
}

// ==================== OCR MODAL ====================
function abrirModalOCR(idViagem) {
  if (!idViagem || !viagemPorId(idViagem)) { showToast('Abra uma viagem para enviar notas.', 'warning'); return; }
  ocrIdViagem = idViagem;
  document.getElementById('modalOCR').classList.remove('hidden'); document.getElementById('ocrForm').classList.add('hidden'); document.getElementById('btnSalvarNota').classList.add('hidden'); document.getElementById('fileOCR').value = "";
  document.getElementById('ocrData').value = ''; document.getElementById('ocrHora').value = ''; document.getElementById('ocrValor').value = ''; document.getElementById('ocrLoja').value = ''; document.getElementById('ocrCategoria').value = ''; document.getElementById('ocrLocal').value = '';
  ocrImagemBase64 = ''; ocrMimeType = 'image/jpeg'; ocrTextoExtraido = '';
  const previewContainer = document.getElementById('ocrPreviewContainer'), preview = document.getElementById('ocrPreview');
  if (previewContainer) previewContainer.classList.add('hidden'); if (preview) preview.src = '';
}

async function processarOCR(event) {
  const file = event.target.files[0]; if (!file) return;
  ocrTextoExtraido = '';
  document.getElementById('ocrData').value = ''; document.getElementById('ocrHora').value = ''; document.getElementById('ocrValor').value = ''; document.getElementById('ocrLoja').value = ''; document.getElementById('ocrCategoria').value = ''; document.getElementById('ocrLocal').value = '';
  document.getElementById('ocrLoader').classList.remove('hidden'); document.getElementById('ocrForm').classList.add('hidden'); document.getElementById('btnSalvarNota').classList.add('hidden');
  const previewContainer = document.getElementById('ocrPreviewContainer'), preview = document.getElementById('ocrPreview');
  if (previewContainer) previewContainer.classList.add('hidden'); if (preview) preview.src = '';

  try {
    ocrImagemBase64 = await converterFileParaBase64(file);
    const matchMime = String(ocrImagemBase64).match(/^data:([^;]+);base64,/);
    ocrMimeType = matchMime ? matchMime[1] : (file.type || 'image/jpeg');
    if (preview && previewContainer) { preview.src = ocrImagemBase64; previewContainer.classList.remove('hidden'); }
    try {
      ocrTextoExtraido = await lerTextoDaImagem(file);
      document.getElementById('ocrData').value = extrairDataDoTexto(ocrTextoExtraido);
      document.getElementById('ocrHora').value = extrairHoraDoTexto(ocrTextoExtraido);
      document.getElementById('ocrValor').value = extrairValorDoTexto(ocrTextoExtraido);

      let local = extrairLocalDoTexto(ocrTextoExtraido), origemLocal = 'cupom';
      if (!local) {
        const loaderEl = document.getElementById('ocrLoader');
        if (loaderEl) loaderEl.innerHTML = '<i class="fa-solid fa-location-crosshairs fa-beat text-2xl block mb-2"></i> Obtendo localização...';
        local = await obterLocalPorGPS(); origemLocal = 'GPS';
      }
      document.getElementById('ocrLocal').value = local || '';

      const faltantes = [];
      if (!document.getElementById('ocrData').value) faltantes.push('data');
      if (!document.getElementById('ocrHora').value) faltantes.push('hora');
      if (!document.getElementById('ocrValor').value) faltantes.push('valor');
      if (!local) faltantes.push('local');
      if (faltantes.length > 0) showToast(`Não consegui ler: ${faltantes.join(', ')}. Preencha manualmente.`, 'warning');
      else showToast(`Dados lidos! Local obtido pelo ${origemLocal}. Confira e preencha Categoria e Loja.`, 'success');
    } catch (e) { showToast('Falha no OCR. Preencha manualmente.', 'warning'); }
  } catch (e) { ocrImagemBase64 = ''; showToast('Erro ao carregar imagem.', 'error'); }
  finally {
    const loaderEl = document.getElementById('ocrLoader');
    if (loaderEl) { loaderEl.classList.add('hidden'); loaderEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-2xl block mb-2"></i> Lendo...'; }
    document.getElementById('ocrForm').classList.remove('hidden'); document.getElementById('btnSalvarNota').classList.remove('hidden');
  }
}

async function salvarNotaNaViagem() {
  if (!ocrIdViagem || !viagemPorId(ocrIdViagem)) { showToast('Abra uma viagem para enviar a nota.', 'warning'); return; }
  const valorRaw = document.getElementById('ocrValor').value;
  const loja = document.getElementById('ocrLoja').value.trim();
  const categoria = document.getElementById('ocrCategoria').value;
  if (!ocrImagemBase64) { showToast('Envie a foto.', 'warning'); return; }
  if (!valorRaw) { showToast('Informe o valor.', 'warning'); return; }
  if (!loja) { showToast('Informe a loja.', 'warning'); return; }
  if (!categoria) { showToast('Selecione a categoria.', 'warning'); return; }

  let dataDespesa = document.getElementById('ocrData').value.trim();
  if (!dataDespesa) dataDespesa = new Date().toLocaleDateString('pt-BR');

  const idViagem = ocrIdViagem;
  const data = { action: 'saveComprovante', login: userData.login, idViagem, dataDespesa, horaDespesa: document.getElementById('ocrHora').value.trim(), valor: parseFloat(String(valorRaw).replace(',', '.')), lojaDebito: loja, categoria, localDespesa: document.getElementById('ocrLocal').value.trim(), ocrConteudo: String(ocrTextoExtraido || '').slice(0, 5000), imagemBase64: ocrImagemBase64, mimeType: ocrMimeType };
  busy++;
  let r, vinculou = false;
  try {
    r = await fetchAPI(data, 'btnSalvarNota');
    if (!(r && r.success)) { showToast((r && r.message) || 'Falha ao salvar.', 'error'); return; }
    vinculou = await vincularNotaNaViagem(idViagem, r);
  } finally { busy--; }
  document.getElementById('modalOCR').classList.add('hidden');
  if (!vinculou) showToast('Nota salva, mas não consegui vinculá-la à viagem. Verifique o Apps Script.', 'warning');
  else if (r.urlComprovante) showToast('Despesa e foto salvas na viagem!', 'success');
  else showToast('Despesa salva, mas a foto não foi para o Drive. Verifique as permissões do Apps Script.', 'warning');
  ocrImagemBase64 = ''; ocrMimeType = 'image/jpeg'; ocrTextoExtraido = ''; ocrIdViagem = null;
  atualizarViagens();
}

async function vincularNotaNaViagem(idViagem, respostaSalvar) {
  if (respostaSalvar && (respostaSalvar.vinculado === true || respostaSalvar.idViagem === idViagem)) return true;
  let idComp = respostaSalvar && (respostaSalvar.idComprovante || respostaSalvar.id);
  if (!idComp) {
    const lista = await fetchAPI({ action: 'getCarteiraComprovantes', login: userData.login });
    if (lista && lista.success && lista.comprovantes && lista.comprovantes.length) {
      const ord = lista.comprovantes.slice().sort((a, b) => new Date(b.dataUpload) - new Date(a.dataUpload));
      idComp = ord[0].idComprovante;
    }
  }
  if (!idComp) return false;
  const v = await fetchAPI({ action: 'linkComprovantesToViagem', idViagem, comprovantesIds: [idComp], login: userData.login });
  return !!(v && v.success);
}

// ============================================================
//  RELATÓRIO / EXPORTAR (sem fotos, com logo da TI) - todos os técnicos da viagem
// ============================================================
function escaparTextoHtml(valor) {
  return String(valor == null ? '' : valor).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function exportarRelatorioViagem() {
  const g = grupoAtual(); if (!g) return;
  const gestao = isGestaoUser();
  const membros = g.membros.filter(m => gestao || lower(m.colaborador) === lower(userData.login));
  const totalItens = membros.reduce((a, m) => a + (m.itens || []).length, 0);
  if (totalItens === 0) { showToast('Não há despesas para exportar.', 'warning'); return; }

  let totalGeral = 0;
  const porCategoria = {};
  const blocos = membros.map(m => {
    const itens = (m.itens || []).slice().sort((a, b) => chaveDataOrdenacao(a.dataDespesa) - chaveDataOrdenacao(b.dataDespesa));
    let sub = 0;
    const linhas = itens.map((item, i) => {
      const valor = valorNum(item.valor); sub += valor; totalGeral += valor;
      const cat = item.categoria || 'Sem categoria';
      porCategoria[cat] = (porCategoria[cat] || 0) + valor;
      const hora = formatarHoraVisao(item.horaDespesa);
      return `<tr><td class="c">${i + 1}</td><td>${escaparTextoHtml(formatarDataVisao(item.dataDespesa))}</td><td class="c">${escaparTextoHtml(hora || '—')}</td><td>${escaparTextoHtml(item.localDespesa || '—')}</td><td>${escaparTextoHtml(cat)}</td><td class="c up">${escaparTextoHtml(item.lojaDebito || '')}</td><td class="r">${formatarMoedaBR(valor)}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="c">Sem despesas lançadas.</td></tr>';
    return `<div class="tec"><div class="tec-h"><b>${escaparTextoHtml(nomeTecnico(m.colaborador))}</b> <span>${escaparTextoHtml(m.colaborador)} • ${escaparTextoHtml(uiStatus(m.status).label)}</span></div>
<table><thead><tr><th class="c" style="width:32px">#</th><th>Data</th><th class="c">Hora</th><th>Local</th><th>Categoria</th><th class="c">Loja Débito</th><th class="r">Valor</th></tr></thead><tbody>${linhas}</tbody>
<tfoot><tr><td colspan="6" class="r">SUBTOTAL (${itens.length} despesa${itens.length === 1 ? '' : 's'})</td><td class="r">${formatarMoedaBR(sub)}</td></tr></tfoot></table></div>`;
  }).join('');

  const linhasResumo = Object.keys(porCategoria).sort().map(cat => `<tr><td>${escaparTextoHtml(cat)}</td><td class="r">${formatarMoedaBR(porCategoria[cat])}</td></tr>`).join('');
  const agora = new Date();
  const emitidoEm = `${agora.toLocaleDateString('pt-BR')} às ${pad2(agora.getHours())}:${pad2(agora.getMinutes())}`;
  const emitidoPor = `${userData.nome || ''} ${userData.sobrenome || ''}`.trim() || userData.login;
  const logoUrl = new URL('logo.png', window.location.href).href;
  const nomeArquivo = `Relatorio_Despesas_${g.sigla}_${agora.toISOString().slice(0, 10)}`;
  const assinaturas = membros.map(m => `<div>${escaparTextoHtml(nomeTecnico(m.colaborador))}<br>Técnico responsável</div>`).join('') + '<div>Coordenação / Gerência</div>';

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${escaparTextoHtml(nomeArquivo)}</title>
<style>
@page{size:A4;margin:12mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;font-size:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.topo{display:flex;align-items:center;justify-content:space-between;background:#0f172a;color:#fff;padding:14px 18px;border-radius:8px;border-bottom:4px solid #059669}
.topo .marca{display:flex;align-items:center;gap:14px}
.topo img{height:52px;background:#fff;border-radius:6px;padding:4px}
.topo h1{margin:0;font-size:18px;letter-spacing:.5px}
.topo p{margin:2px 0 0;font-size:11px;color:#34d399;font-weight:bold}
.topo .emissao{text-align:right;font-size:10px;color:#cbd5e1;line-height:1.5}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#334155;margin:20px 0 8px;padding-bottom:4px;border-bottom:2px solid #e2e8f0}
.info{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;background:#f8fafc}
.info div span{display:block;font-size:9px;font-weight:bold;color:#64748b;text-transform:uppercase;letter-spacing:.6px}
.info div b{font-size:13px}
.info .full{grid-column:1 / -1}
table{width:100%;border-collapse:collapse}
th{background:#f1f5f9;color:#475569;font-size:9px;text-transform:uppercase;letter-spacing:.6px;text-align:left;padding:8px;border:1px solid #e2e8f0}
td{padding:8px;border:1px solid #e2e8f0;font-size:11.5px}
tr{page-break-inside:avoid}
.c{text-align:center}.r{text-align:right}.up{text-transform:uppercase;font-weight:bold}
tfoot td{background:#ecfdf5;font-weight:bold;font-size:12px;color:#047857}
.tec{margin-bottom:18px;page-break-inside:auto}
.tec-h{background:#1e293b;color:#fff;padding:8px 12px;border-radius:6px 6px 0 0;font-size:13px}
.tec-h span{color:#94a3b8;font-size:10px;margin-left:8px}
.resumo{width:55%}
.geral{margin-top:14px;background:#0f172a;color:#34d399;padding:12px 16px;border-radius:8px;display:flex;justify-content:space-between;font-size:15px;font-weight:bold}
.geral span:first-child{color:#cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:.6px;align-self:center}
.assin{display:flex;flex-wrap:wrap;gap:40px;margin-top:70px;page-break-inside:avoid}
.assin div{flex:1;min-width:150px;text-align:center;border-top:1px solid #334155;padding-top:6px;font-size:10px;color:#475569}
.rodape{margin-top:30px;text-align:center;font-size:9px;color:#94a3b8}
</style></head><body>
<div class="topo">
  <div class="marca"><img id="logoRel" src="${escaparTextoHtml(logoUrl)}" alt="TI Claudino"><div><h1>Relatório de Despesas de Viagem</h1><p>TI Claudino S/A</p></div></div>
  <div class="emissao">Emitido em<br><b>${escaparTextoHtml(emitidoEm)}</b><br>por ${escaparTextoHtml(emitidoPor)}</div>
</div>
<h2>Dados da Viagem</h2>
<div class="info">
  <div><span>Loja (Sigla)</span><b>${escaparTextoHtml(g.sigla)}</b></div>
  <div><span>Situação</span><b>${escaparTextoHtml(uiStatus(g.statusAgg).label)}</b></div>
  <div class="full"><span>Motivo</span><b>${escaparTextoHtml(g.motivo)}</b></div>
  <div><span>Solicitado por</span><b>${escaparTextoHtml(g.criadoPor)}</b></div>
  <div><span>Técnico(s)</span><b>${escaparTextoHtml(membros.map(m => nomeTecnico(m.colaborador)).join(', '))}</b></div>
</div>
<h2>Despesas por Técnico (Ordem Cronológica)</h2>
${blocos}
<div class="geral"><span>Total geral (${totalItens} despesa${totalItens === 1 ? '' : 's'})</span><span>${formatarMoedaBR(totalGeral)}</span></div>
<h2>Resumo por Categoria</h2>
<table class="resumo"><thead><tr><th>Categoria</th><th class="r">Total</th></tr></thead><tbody>${linhasResumo}</tbody></table>
<div class="assin">${assinaturas}</div>
<div class="rodape">Relatório gerado pelo Sistema de Despesas de Viagens | TI Claudino S/A</div>
</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();

  let impresso = false;
  const imprimir = () => {
    if (impresso) return; impresso = true;
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
    catch (e) { showToast('Não foi possível gerar o relatório.', 'error'); }
    setTimeout(() => iframe.remove(), 3000);
  };
  const logo = doc.getElementById('logoRel');
  if (logo && !logo.complete) { logo.onload = () => setTimeout(imprimir, 150); logo.onerror = () => setTimeout(imprimir, 150); setTimeout(imprimir, 2500); }
  else setTimeout(imprimir, 200);
  showToast('Relatório pronto! Na janela de impressão escolha "Salvar como PDF".', 'info');
}

// ==================== STATUS / EXCLUSÃO (com atualização imediata) ====================
async function aplicarStatus(ids, novoStatus) {
  const anteriores = {};
  ids.forEach(id => { const v = viagemPorId(id); if (v) { anteriores[id] = v.status; v.status = novoStatus; } });
  renderTudo();
  busy++;
  const falhas = [];
  try {
    for (const id of ids) {
      const r = await postAPI({ action: 'updateDespesaStatus', idViagem: id, status: novoStatus, login: userData.login, nivel: userData.nivel });
      if (!(r && r.success)) falhas.push(id);
    }
  } finally { busy--; }
  falhas.forEach(id => { const v = viagemPorId(id); if (v) v.status = anteriores[id]; });
  renderTudo();
  return falhas.length;
}

async function alterarStatusViagem(idViagem, novoStatus) {
  const falhas = await aplicarStatus([idViagem], novoStatus);
  if (falhas) showToast('Não foi possível alterar o status.', 'error');
  else { showToast(`Status: ${novoStatus}!`, 'success'); atualizarViagens(); }
}

async function alterarStatusGrupo(de, para) {
  const g = grupoAtual(); if (!g) return;
  const ids = g.membros.filter(m => m.status === de).map(m => m.idViagem);
  if (!ids.length) return;
  const msg = para === 'FECHADA' ? `Fechar ${ids.length} despesa(s) de técnicos desta viagem?` : `Arquivar ${ids.length} despesa(s) desta viagem?`;
  if (!await showConfirm(msg, { type: 'info' })) return;
  const falhas = await aplicarStatus(ids, para);
  if (falhas) showToast(`${falhas} item(ns) não puderam ser atualizados.`, 'error');
  else { showToast(`Status: ${para}!`, 'success'); atualizarViagens(); }
}

async function enviarDespesasViagem(idViagem) {
  if (!await showConfirm("Enviar despesas para aprovação?", { type: 'info' })) return;
  const falhas = await aplicarStatus([idViagem], 'PENDENTE');
  if (falhas) showToast('Não foi possível enviar.', 'error');
  else { showToast('Enviado!', 'success'); atualizarViagens(); }
}

async function excluirViagem() {
  const g = grupoAtual(); if (!g) return;
  const qtd = g.membros.length;
  if (!await showConfirm(qtd > 1 ? `Excluir esta viagem permanentemente, incluindo as despesas de ${qtd} técnicos?` : "Excluir viagem permanentemente?", { type: 'danger' })) return;
  const ids = g.membros.map(m => m.idViagem);
  const backup = viagensGlobais;
  viagensGlobais = viagensGlobais.filter(v => !ids.includes(v.idViagem));
  mostrarLista(); renderPainel();
  busy++;
  const falhas = [];
  try {
    for (const id of ids) {
      const r = await postAPI({ action: 'deleteDespesaViagem', idViagem: id, login: userData.login, nivel: userData.nivel });
      if (!(r && r.success)) falhas.push(id);
    }
  } finally { busy--; }
  if (falhas.length) { viagensGlobais = backup; renderPainel(); showToast('Alguns itens não puderam ser excluídos.', 'error'); }
  else showToast('Viagem excluída.', 'success');
  atualizarViagens();
}

function voltarDashboard() { recarregarDashboard(); }

// ==================== RECUPERAR SENHA ====================
function abrirModalRecuperar() { document.getElementById('modalRecuperar').classList.remove('hidden'); }
let userRecupLogin = null;
async function buscarUsuariosRecup() {
  const q = document.getElementById('recupLoginInput').value; if (q.length < 2) return;
  const r = await fetchAPI({ action: 'searchUsers', query: q });
  const div = document.getElementById('recupListaUsers'); div.innerHTML = '';
  if (r.success) r.users.forEach(u => { div.innerHTML += `<button onclick="selecionarUserRecup('${u.login}', '${u.nome}')" class="w-full text-left p-2 border-b text-xs hover:bg-emerald-50"><b>${u.nome}</b> (${u.login})</button>`; });
}
function selecionarUserRecup(login, nome) {
  userRecupLogin = login; document.getElementById('recupUserSelected').textContent = `Usuário: ${nome} (${login})`;
  document.getElementById('recupStep1').classList.add('hidden'); document.getElementById('recupStep2').classList.remove('hidden');
}
async function confirmarRedefinirSenha() {
  const nova = document.getElementById('recupNovaSenha').value;
  const r = await fetchAPI({ action: 'resetPassword', login: userRecupLogin, novaSenha: nova }, 'btnRedefinir');
  if (r.success) { showToast('Senha redefinida!', 'success'); document.getElementById('modalRecuperar').classList.add('hidden'); }
  else { showToast(r.message || 'Erro.', 'error'); }
}
