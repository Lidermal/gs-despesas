const API_URL = "https://script.google.com/macros/s/AKfycbyv6rztF_a5ePHzRhzCMJDawDOHhF-le_3MgvoeMY2WUGjVRQBPmt2cSuV6Mp71MGnpUQ/exec";
const TEMPO_SESSAO_MS = 4 * 60 * 60 * 1000;

let userData = null, viagensGlobais = [], carteiraGlobais = [], viagemAtual = null, filtroLojaSelecionada = "TODAS";
let ocrImagemBase64 = '', ocrMimeType = 'image/jpeg', ocrTextoExtraido = '';
let visualizadorIdAtual = null;
const cacheImagens = {};

function pad2(n) { return String(n).padStart(2, '0'); }
function escaparAtributoHtml(valor) { return String(valor || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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
// Converte para cinza, amplia e aumenta contraste: melhora MUITO a leitura
// de cupom térmico, picote de maquininha e recibo manual.
async function prepararImagemParaOCR(file) {
  const original = await lerFileComoDataUrl(file);
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = original; });
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const maior = Math.max(w0, h0);
  // alvo: lado maior entre 1800 e 2600px
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
  // estica o contraste usando percentis 2% e 98%
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
  // se não achou valor, tenta com a imagem original
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
  return dt <= amanha; // comprovante não pode ser do futuro
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

// Procura o valor PAGO: pontua cada valor monetário pela palavra-chave
// da linha (e da linha anterior) e escolhe o melhor.
function extrairValorDoTexto(texto) {
  if (!texto) return '';
  let t = String(texto).toUpperCase();
  t = t.replace(/R\s?S(?=\s*\d)/g, 'R$');            // "RS 66,00" -> "R$ 66,00"
  t = t.replace(/(\d)\s+([,.])\s*(\d{2})(?!\d)/g, '$1$2$3'); // "66 ,00" -> "66,00"
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
      if (/[\d,.\/:]/.test(antes)) continue;      // pedaço de outro número / data
      if (/[\.\/:]/.test(depois) && /\d/.test(linha[m.index + m[0].length + 1] || '')) continue; // data 12.05.2025
      const valor = parseFloat(m[1].replace(/\./g, '') + '.' + m[2]);
      if (valor >= 0.5 && valor < 50000) candidatos.push({ valor, score });
    }
    // "R$ 6600" (sem separador) => 66,00
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
// palavras que indicam que o trecho NÃO é nome de cidade
const PALAVRAS_NAO_CIDADE = new Set(['RUA', 'AV', 'AVENIDA', 'ROD', 'RODOVIA', 'LOJA', 'CNPJ', 'CPF', 'TOTAL', 'VALOR', 'CUPOM', 'FISCAL', 'NOTA', 'DATA', 'HORA', 'CARTAO', 'CREDITO', 'DEBITO', 'PIX', 'ITEM', 'QTD', 'TROCO', 'ENDERECO', 'END', 'BAIRRO', 'CEP', 'IE', 'IM', 'TEL', 'FONE', 'LTDA', 'EIRELI', 'ME', 'SA', 'CAIXA', 'OPERADOR', 'CODIGO', 'COD', 'NSU', 'AUT', 'AGENCIA', 'CONTA', 'VENDA', 'ESTADO', 'UF', 'CIDADE', 'MUNICIPIO', 'MUN', 'CID', 'PRACA', 'TRAVESSA', 'ALAMEDA', 'QUADRA', 'LOTE', 'SALA', 'CENTRO', 'BR', 'KM', 'NUMERO', 'NRO', 'SN', 'S/N', 'COMPROVANTE', 'VIA', 'CLIENTE', 'ESTABELECIMENTO', 'TERMINAL', 'DOC', 'MERCHANT']);

function semAcentos_(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

function tituloCidade_(s) {
  const pequenas = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
  return String(s).toLowerCase().split(/\s+/).filter(Boolean).map((p, i) => (i > 0 && pequenas.has(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// Limpa o trecho que veio antes da UF, ficando só com o nome provável da cidade
function limparNomeCidade_(bruto) {
  let s = String(bruto || '');
  s = s.split(/[\d,;:|]/).pop();                       // pega o que vem depois do último número/vírgula/dois-pontos
  s = s.replace(/[^A-ZÀ-Ü' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let palavras = s.split(' ').filter(Boolean);
  // remove palavras de endereço/rótulo do começo
  while (palavras.length && (PALAVRAS_NAO_CIDADE.has(semAcentos_(palavras[0])) || palavras[0].length < 2)) palavras.shift();
  if (palavras.length > 4) palavras = palavras.slice(-4);
  // se ainda sobrou palavra proibida no meio, descarta
  if (palavras.some(p => PALAVRAS_NAO_CIDADE.has(semAcentos_(p)) && !['SANTA', 'SANTO'].includes(p))) {
    // mantém só o trecho depois da última palavra proibida
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
    // 1) com rótulo: "CIDADE: SANTA INES - MA" / "MUNICIPIO SANTA INES UF: MA"
    const r1 = new RegExp(`(?:CIDADE|MUNIC[IÍ]PIO|MUN|CID)\\s*[:\\-]?\\s*([A-ZÀ-Ü][A-ZÀ-Ü' ]{2,40}?)\\s*(?:${SEP}|UF\\s*[:\\-]?|\\s)\\s*${UF}`);
    m = r1.exec(linha);
    if (m) { const c = limparNomeCidade_(m[1]); if (c) candidatos.push({ cidade: c, uf: m[2], score: 12, i: idx }); }

    // 2) logo depois do CEP: "65300-000 SANTA INES - MA"
    const r2 = new RegExp(`\\d{5}\\s?-?\\s?\\d{3}\\s*${SEP}?\\s*([A-ZÀ-Ü][A-ZÀ-Ü' ]{2,40}?)\\s*(?:${SEP}|\\s)\\s*${UF}`);
    m = r2.exec(linha);
    if (m) { const c = limparNomeCidade_(m[1]); if (c) candidatos.push({ cidade: c, uf: m[2], score: 10, i: idx }); }

    // 3) "NOME - UF", "NOME/UF", "NOME, UF"
    const r3 = new RegExp(`([A-ZÀ-Ü][A-ZÀ-Ü' .]{2,60}?)\\s*${SEP}\\s*${UF}`, 'g');
    while ((m = r3.exec(linha)) !== null) {
      const c = limparNomeCidade_(m[1]);
      if (c) candidatos.push({ cidade: c, uf: m[2], score: /CNPJ|CEP|END|RUA|AV|LOJA|BAIRRO/.test(linha) ? 7 : 5, i: idx });
    }

    // 4) fim da linha de endereço sem separador: "... CENTRO SANTA INES MA" (só se tiver CEP ou "END" na linha)
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

// Fallback: localização do aparelho (GPS) -> cidade/UF (OpenStreetMap/Nominatim)
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

// Busca a imagem no Drive (via Apps Script) e guarda em cache
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

// Se a miniatura do Drive falhar, carrega pelo Apps Script
function fallbackThumb(img) {
  if (img.dataset.tentou) { img.style.display = 'none'; return; }
  img.dataset.tentou = '1';
  obterImagemComprovante(img.dataset.id).then(x => { if (x) img.src = x.dataUrl; else img.style.display = 'none'; });
}

function htmlMiniatura(c, tamanho = 'h-12 w-12') {
  if (!c.urlComprovante) return '';
  return `<img src="${montarUrlThumbnailDrive(c.urlComprovante)}" data-id="${c.idComprovante}" alt="Comprovante" loading="lazy" referrerpolicy="no-referrer" class="${tamanho} object-cover rounded border cursor-pointer bg-slate-100" onclick="abrirVisualizador('${c.idComprovante}')" onerror="fallbackThumb(this)">`;
}

// ----- Visualizador (ver / baixar / imprimir) -----
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

// Imprime SOMENTE a imagem (iframe oculto, sem popup)
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
//  GARANTE OS CAMPOS/COLUNAS DE LOCAL (mesmo se o index.html for antigo)
// ============================================================
function garantirCamposLocal() {
  const TH = 'px-4 py-3 font-bold text-slate-500 uppercase text-[10px]';
  const LBL = 'block text-[10px] font-bold text-slate-500 mb-1';
  const INP = 'w-full px-3 py-2 text-sm border rounded bg-slate-50';
  // campo na tela de leitura (OCR)
  if (!document.getElementById('ocrLocal')) {
    const ref = document.getElementById('ocrValor'), bloco = ref && ref.closest('.grid');
    if (bloco && bloco.parentNode) {
      const d = document.createElement('div');
      d.innerHTML = `<label class="${LBL}">LOCAL (CIDADE - UF) <span class="text-emerald-600">(auto)</span></label><input type="text" id="ocrLocal" placeholder="Ex: Santa Inês - MA" class="${INP}">`;
      bloco.parentNode.insertBefore(d, bloco);
    }
  }
  // campo na tela de edição
  if (!document.getElementById('editLocal')) {
    const ref = document.getElementById('editValor'), bloco = ref && ref.closest('.grid');
    if (bloco && bloco.parentNode) {
      const d = document.createElement('div');
      d.innerHTML = `<label class="${LBL}">LOCAL (CIDADE - UF)</label><input type="text" id="editLocal" placeholder="Ex: Santa Inês - MA" class="${INP}">`;
      bloco.parentNode.insertBefore(d, bloco);
    }
  }
  // coluna "Local" na carteira
  const tbC = document.getElementById('tbCarteira');
  const trC = tbC && tbC.closest('table') && tbC.closest('table').querySelector('thead tr');
  if (trC && trC.children.length === 6) { const th = document.createElement('th'); th.className = TH; th.textContent = 'Local'; trC.insertBefore(th, trC.children[2]); }
  // coluna "Local" no detalhe da viagem
  const tbV = document.getElementById('tbItensViagem');
  const tabV = tbV && tbV.closest('table');
  const trV = tabV && tabV.querySelector('thead tr');
  if (trV && trV.children.length === 6) {
    const th = document.createElement('th'); th.className = TH; th.textContent = 'Local'; trV.insertBefore(th, trV.children[2]);
    const tdTotal = tabV.querySelector('tfoot td[colspan]'); if (tdTotal) tdTotal.setAttribute('colspan', '4');
  }
}
garantirCamposLocal();

// ==================== SESSÃO ====================
window.onload = () => {
  const savedUser = localStorage.getItem('usuarioDespesasAtivo');
  const loginTime = localStorage.getItem('loginDespesasTimestamp');
  if (savedUser && loginTime && (Date.now() - parseInt(loginTime) < TEMPO_SESSAO_MS)) { userData = JSON.parse(savedUser); iniciarSistema(); } else { logout(); }
};
function logout() {
  localStorage.removeItem('usuarioDespesasAtivo'); localStorage.removeItem('loginDespesasTimestamp');
  userData = null; viagemAtual = null; viagensGlobais = []; carteiraGlobais = [];
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

// ==================== AUTH & PAINEL ====================
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
  recarregarDashboard();
}

async function recarregarDashboard() {
  document.getElementById('viagemDetalheView').classList.add('hidden'); document.getElementById('mainContent').classList.remove('hidden');
  const isGestao = (userData.nivel === 'Coordenação GS' || userData.nivel === 'Gerência GS');
  document.getElementById('dashTitle').innerHTML = isGestao ? `<i class="fa-solid fa-user-shield text-emerald-600 mr-2"></i> Painel da Gestão` : `<i class="fa-solid fa-plane-departure text-emerald-600 mr-2"></i> Minhas Viagens`;
  document.getElementById('dashSubtitle').textContent = isGestao ? "Acompanhe e autorize reembolsos organizados por sigla da loja." : "Receba viagens criadas pela coordenação e envie seus comprovantes.";
  const btnArea = document.getElementById('dashActionButtons'); btnArea.innerHTML = '';
  if (isGestao) {
    document.getElementById('secaoCarteiraSuporte').classList.add('hidden');
    btnArea.innerHTML = `<button onclick="abrirModalCriarViagem()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-4 rounded shadow text-sm transition"><i class="fa-solid fa-plus mr-2"></i> Criar Número da Viagem</button>`;
    carregarUsuariosParaSelect();
  } else {
    document.getElementById('secaoCarteiraSuporte').classList.remove('hidden'); carregarCarteiraSuporte();
  }
  const r = await fetchAPI({ action: 'getDespesasViagens', login: userData.login, nivel: userData.nivel });
  if (r && r.success) { viagensGlobais = r.viagens; renderFiltrosSiglas(); renderViagensGrid(); }
}

function renderFiltrosSiglas() {
  const div = document.getElementById('filtroSiglasLojas'); div.innerHTML = '';
  const siglas = ["TODAS"]; viagensGlobais.forEach(v => { if (!siglas.includes(v.sigla)) siglas.push(v.sigla); });
  siglas.forEach(s => {
    const active = (filtroLojaSelecionada === s) ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100 border';
    div.innerHTML += `<button onclick="filtrarPorLoja('${s}')" class="${active} px-4 py-1.5 rounded-full font-bold text-xs shadow-sm transition uppercase whitespace-nowrap">${s}</button>`;
  });
}
function filtrarPorLoja(sigla) { filtroLojaSelecionada = sigla; renderFiltrosSiglas(); renderViagensGrid(); }

function renderViagensGrid() {
  const grid = document.getElementById('gridViagens'); grid.innerHTML = '';
  let lista = viagensGlobais;
  if (filtroLojaSelecionada !== "TODAS") lista = lista.filter(v => v.sigla === filtroLojaSelecionada);
  if (lista.length === 0) { grid.innerHTML = `<div class="col-span-full text-center py-10 bg-white border border-dashed rounded text-slate-400"><i class="fa-solid fa-folder-open text-3xl mb-2"></i><br>Nenhuma viagem encontrada.</div>`; return; }
  lista.forEach(v => {
    let badge = 'bg-slate-100 text-slate-600';
    if (v.status === 'ABERTO') badge = 'bg-blue-100 text-blue-700 border-blue-200';
    if (v.status === 'PENDENTE') badge = 'bg-amber-100 text-amber-700 border-amber-200';
    if (v.status === 'SOLICITAR CORRECAO') badge = 'bg-red-100 text-red-700 border-red-200';
    if (v.status === 'FECHADA' || v.status === 'ARQUIVADA') badge = 'bg-emerald-100 text-emerald-700 border-emerald-200';
    if (v.status === 'CANCELADO') badge = 'bg-slate-200 text-slate-500 line-through';
    grid.innerHTML += `<div onclick="abrirViagemDetalhe('${v.idViagem}')" class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-emerald-400 cursor-pointer transition flex flex-col justify-between"><div><div class="flex justify-between items-start mb-2"><span class="bg-slate-900 text-emerald-400 px-3 py-1 rounded text-xs font-black uppercase tracking-wider">${v.sigla}</span><span class="${badge} text-[10px] font-bold px-2 py-0.5 rounded border uppercase">${v.status}</span></div><h3 class="text-base font-bold text-slate-800 line-clamp-2 mt-2" title="${v.motivo}">${v.motivo}</h3></div><div class="mt-4 pt-3 border-t text-xs text-slate-500 flex justify-between items-end"><div><p class="text-[11px]">Solicitou: <b>${v.criadoPor}</b></p><p class="text-[11px]">Técnico: <b>${v.colaborador}</b></p></div><span class="text-emerald-600 font-bold text-xs"><i class="fa-solid fa-paperclip"></i> ${v.itens.length} despesa(s)</span></div></div>`;
  });
}

// ==================== COORDENAÇÃO ====================
async function carregarUsuariosParaSelect() {
  const r = await fetchAPI({ action: 'getUsers' });
  if (r.success) {
    const sel = document.getElementById('novaViagemColaborador'); sel.innerHTML = '<option value="">Selecione o técnico...</option>';
    r.users.forEach(u => { sel.innerHTML += `<option value="${u.login}">${u.nome} (${u.login})</option>`; });
  }
}
function abrirModalCriarViagem() { document.getElementById('modalCriarViagem').classList.remove('hidden'); }
async function confirmarCriarViagem() {
  const sigla = document.getElementById('novaViagemSigla').value.trim().toUpperCase();
  const motivo = document.getElementById('novaViagemMotivo').value.trim();
  const colab = document.getElementById('novaViagemColaborador').value;
  if (!sigla || !motivo || !colab) { showToast('Preencha todos os campos!', 'warning'); return; }
  const r = await fetchAPI({ action: 'createDespesaViagem', sigla, motivo, colaborador: colab, criadoPor: userData.login, nivel: userData.nivel }, 'btnCriarViagem');
  if (r.success) { document.getElementById('modalCriarViagem').classList.add('hidden'); showToast('Viagem criada!', 'success'); recarregarDashboard(); }
  else { showToast(r.message || 'Erro ao criar.', 'error'); }
}

// ==================== CARTEIRA DO SUPORTE ====================
async function carregarCarteiraSuporte() {
  const r = await fetchAPI({ action: 'getCarteiraComprovantes', login: userData.login });
  const tb = document.getElementById('tbCarteira'); tb.innerHTML = '';
  if (r && r.success) {
    carteiraGlobais = r.comprovantes;
    if (r.apagadosPorValidade > 0) showToast(`${r.apagadosPorValidade} comprovante(s) expirado(s) removido(s).`, 'info');
    if (carteiraGlobais.length === 0) { tb.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-slate-400">Nenhum comprovante na carteira.</td></tr>'; return; }
    carteiraGlobais.forEach(c => {
      const diasVenc = 30 - Math.floor((new Date() - new Date(c.dataUpload)) / (1000 * 60 * 60 * 24));
      const temFoto = !!c.urlComprovante;
      const horaFormatada = formatarHoraVisao(c.horaDespesa);
      const valorNum = Number(String(c.valor || 0).replace(',', '.')) || 0;
      const localTxt = c.localDespesa ? escaparTextoHtml(c.localDespesa) : '<span class="text-slate-300">—</span>';
      tb.innerHTML += `
        <tr class="hover:bg-slate-50 border-b">
          <td class="px-4 py-3 text-xs font-mono"><div class="flex items-center gap-3">${htmlMiniatura(c)}<span>${formatarDataVisao(c.dataDespesa)}${horaFormatada ? ' às ' + horaFormatada : ''}</span></div></td>
          <td class="px-4 py-3 text-xs font-bold text-slate-700">${c.categoria || ''}</td>
          <td class="px-4 py-3 text-xs font-bold text-slate-600"><i class="fa-solid fa-location-dot text-slate-400 mr-1"></i>${localTxt}</td>
          <td class="px-4 py-3 text-xs font-bold uppercase text-slate-500">${c.lojaDebito || ''}</td>
          <td class="px-4 py-3 text-xs font-bold text-emerald-600">R$ ${valorNum.toFixed(2).replace('.', ',')}</td>
          <td class="px-4 py-3 text-xs text-center"><div class="flex flex-col items-center gap-1"><span class="text-amber-600 font-bold">${diasVenc} dia(s)</span>${temFoto ? '<span class="text-emerald-600 font-bold text-[10px]"><i class="fa-solid fa-image"></i> Foto ok</span>' : '<span class="text-slate-400 text-[10px]">Sem foto</span>'}</div></td>
          <td class="px-4 py-3 text-xs text-center">
            <div class="flex gap-2 justify-center">
              ${temFoto ? `<button onclick="abrirVisualizador('${c.idComprovante}')" class="text-blue-600 hover:text-blue-800" title="Ver foto"><i class="fa-solid fa-eye"></i></button>` : ''}
              <button onclick="editarComprovanteCarteira('${c.idComprovante}')" class="text-amber-600 hover:text-amber-800" title="Editar"><i class="fa-solid fa-pen"></i></button>
              <button onclick="excluirComprovanteCarteira('${c.idComprovante}')" class="text-red-600 hover:text-red-800" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </div>
          </td>
        </tr>`;
    });
  }
}

function editarComprovanteCarteira(idComp) {
  const item = carteiraGlobais.find(c => c.idComprovante === idComp);
  if (!item) return;
  document.getElementById('editIdComprovante').value = idComp;
  document.getElementById('editData').value = formatarDataVisao(item.dataDespesa) || '';
  document.getElementById('editHora').value = formatarHoraVisao(item.horaDespesa) || '';
  // input type=number exige PONTO decimal (com vírgula o campo fica vazio)
  document.getElementById('editValor').value = (Number(String(item.valor || 0).replace(',', '.')) || 0).toFixed(2);
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

  const r = await fetchAPI(data, 'btnSalvarEdicao');
  if (r && r.success) { delete cacheImagens[idComp]; document.getElementById('modalEditarComprovante').classList.add('hidden'); showToast('Comprovante atualizado!', 'success'); carregarCarteiraSuporte(); }
  else { showToast(r.message || 'Erro ao atualizar.', 'error'); }
}

async function excluirComprovanteCarteira(idComp) {
  if (!await showConfirm("Excluir este comprovante permanentemente?", { type: 'danger', icon: 'fa-trash' })) return;
  const r = await fetchAPI({ action: 'deleteComprovante', idComprovante: idComp, login: userData.login });
  if (r && r.success) { delete cacheImagens[idComp]; showToast('Comprovante excluído.', 'success'); carregarCarteiraSuporte(); }
  else { showToast(r.message || 'Erro ao excluir.', 'error'); }
}

// ==================== OCR MODAL ====================
function abrirModalOCR() {
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

      // LOCAL: 1º tenta ler do cupom (cidade - UF); 2º usa a localização do aparelho (GPS)
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

async function salvarNotaNaCarteira() {
  const valorRaw = document.getElementById('ocrValor').value;
  const loja = document.getElementById('ocrLoja').value.trim();
  const categoria = document.getElementById('ocrCategoria').value;
  if (!ocrImagemBase64) { showToast('Envie a foto.', 'warning'); return; }
  if (!valorRaw) { showToast('Informe o valor.', 'warning'); return; }
  if (!loja) { showToast('Informe a loja.', 'warning'); return; }
  if (!categoria) { showToast('Selecione a categoria.', 'warning'); return; }

  let dataDespesa = document.getElementById('ocrData').value.trim();
  if (!dataDespesa) dataDespesa = new Date().toLocaleDateString('pt-BR');

  const data = { action: 'saveComprovante', login: userData.login, dataDespesa, horaDespesa: document.getElementById('ocrHora').value.trim(), valor: parseFloat(String(valorRaw).replace(',', '.')), lojaDebito: loja, categoria, localDespesa: document.getElementById('ocrLocal').value.trim(), ocrConteudo: String(ocrTextoExtraido || '').slice(0, 5000), imagemBase64: ocrImagemBase64, mimeType: ocrMimeType };
  const r = await fetchAPI(data, 'btnSalvarNota');
  if (r && r.success) {
    document.getElementById('modalOCR').classList.add('hidden');
    if (r.urlComprovante) showToast('Comprovante e foto salvos no Drive!', 'success');
    else showToast('Salvo, mas a foto não foi para o Drive. Verifique as permissões do Apps Script.', 'warning');
    ocrImagemBase64 = ''; ocrMimeType = 'image/jpeg'; ocrTextoExtraido = '';
    carregarCarteiraSuporte();
  } else { showToast(r.message || 'Falha ao salvar.', 'error'); }
}

// ==================== DETALHES DA VIAGEM ====================
function abrirViagemDetalhe(id) {
  viagemAtual = viagensGlobais.find(v => v.idViagem === id); if (!viagemAtual) return;
  document.getElementById('mainContent').classList.add('hidden'); document.getElementById('viagemDetalheView').classList.remove('hidden');
  document.getElementById('detalheLojaSigla').textContent = `LOJA: ${viagemAtual.sigla}`;
  document.getElementById('detalheMotivo').textContent = viagemAtual.motivo;
  document.getElementById('detalheParticipantes').textContent = `Solicitado por: ${viagemAtual.criadoPor} | Responsável: ${viagemAtual.colaborador}`;
  let badge = 'bg-slate-800 text-white';
  if (viagemAtual.status === 'PENDENTE') badge = 'bg-amber-500 text-white';
  if (viagemAtual.status === 'FECHADA' || viagemAtual.status === 'ARQUIVADA') badge = 'bg-emerald-500 text-white';
  if (viagemAtual.status === 'SOLICITAR CORRECAO') badge = 'bg-red-500 text-white';
  document.getElementById('detalheStatusBadge').innerHTML = `<span class="${badge} font-bold px-4 py-1.5 rounded text-xs uppercase shadow">${viagemAtual.status}</span>`;
  renderAcoesViagem(); renderItensViagem();
}

function renderAcoesViagem() {
  const area = document.getElementById('painelAcoesViagem'); area.innerHTML = '';
  const isGestao = (userData.nivel === 'Coordenação GS' || userData.nivel === 'Gerência GS');
  const isColab = (String(viagemAtual.colaborador).toLowerCase() === String(userData.login).toLowerCase());
  let direita = '';

  if (isColab && (viagemAtual.status === 'ABERTO' || viagemAtual.status === 'SOLICITAR CORRECAO')) {
    area.innerHTML += `<button onclick="abrirModalAnexarTickets()" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-paperclip mr-2"></i> Inserir Tickets</button>`;
    if (viagemAtual.itens.length > 0) direita += `<button onclick="enviarDespesasViagem()" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-paper-plane mr-2"></i> Enviar Despesas</button>`;
  }
  if (isGestao) {
    if (viagemAtual.status === 'PENDENTE') {
      area.innerHTML += `<button onclick="alterarStatusViagem('FECHADA')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-check mr-2"></i> Fechar</button>`;
      area.innerHTML += `<button onclick="alterarStatusViagem('SOLICITAR CORRECAO')" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-arrow-rotate-left mr-2"></i> Solicitar Correção</button>`;
    }
    if (viagemAtual.status === 'FECHADA') area.innerHTML += `<button onclick="alterarStatusViagem('ARQUIVADA')" class="bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-box-archive mr-2"></i> Arquivar</button>`;
  }

  // Botão EXPORTAR (relatório sem fotos) - visível para gestão e técnico responsável
  if (isGestao || isColab) {
    direita += `<button onclick="exportarRelatorioViagem()" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-file-export mr-2"></i> Exportar</button>`;
  }
  if (isGestao) {
    direita += `<button onclick="excluirViagem()" class="bg-red-600 hover:bg-red-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-trash mr-2"></i> Excluir</button>`;
  }
  if (direita) area.innerHTML += `<div class="flex flex-wrap gap-2 ml-auto">${direita}</div>`;
}

function renderItensViagem() {
  const tb = document.getElementById('tbItensViagem'); tb.innerHTML = '';
  const isColab = (String(viagemAtual.colaborador).toLowerCase() === String(userData.login).toLowerCase());
  const isGestao = (userData.nivel === 'Coordenação GS' || userData.nivel === 'Gerência GS');
  const podeVerComprovante = isGestao || isColab;
  const emEdicao = (viagemAtual.status === 'ABERTO' || viagemAtual.status === 'SOLICITAR CORRECAO');
  let total = 0;
  if (viagemAtual.itens.length === 0) { tb.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-slate-400">Nenhum ticket anexado.</td></tr>'; document.getElementById('detalheTotalValor').textContent = 'R$ 0,00'; return; }
  viagemAtual.itens.sort((a, b) => chaveDataOrdenacao(a.dataDespesa) - chaveDataOrdenacao(b.dataDespesa));
  viagemAtual.itens.forEach(item => {
    const valorNum = Number(String(item.valor || 0).replace(',', '.')) || 0;
    total += valorNum;
    let btnAcao = '';
    if (isColab && emEdicao) btnAcao = `<button onclick="removerItemViagem('${item.idComprovante}')" class="text-red-500 hover:text-red-700" title="Remover"><i class="fa-solid fa-trash"></i></button>`;
    let celulaComprovante = '<td class="px-4 py-3 text-xs text-center text-slate-300">—</td>';
    if (podeVerComprovante) {
      if (item.urlComprovante) {
        celulaComprovante = `<td class="px-4 py-3 text-xs"><div class="flex items-center gap-3">${htmlMiniatura(item)}<div class="flex flex-col gap-1">
          <button type="button" class="text-[10px] font-bold text-blue-600 hover:text-blue-800 text-left" onclick="abrirVisualizador('${item.idComprovante}')"><i class="fa-solid fa-eye mr-1"></i> Ver</button>
          <button type="button" class="text-[10px] font-bold text-emerald-600 hover:text-emerald-800 text-left" onclick="baixarComprovante('${item.idComprovante}')"><i class="fa-solid fa-download mr-1"></i> Baixar</button>
          <button type="button" class="text-[10px] font-bold text-slate-600 hover:text-slate-800 text-left" onclick="imprimirComprovante('${item.idComprovante}')"><i class="fa-solid fa-print mr-1"></i> Imprimir</button>
        </div></div></td>`;
      } else { celulaComprovante = '<td class="px-4 py-3 text-xs text-center text-amber-600 font-bold">Sem imagem</td>'; }
    }
    const localTxt = item.localDespesa ? escaparTextoHtml(item.localDespesa) : '<span class="text-slate-300">—</span>';
    tb.innerHTML += `<tr class="hover:bg-slate-50 border-b"><td class="px-4 py-3 text-xs">${formatarDataVisao(item.dataDespesa)}</td><td class="px-4 py-3 text-xs font-bold text-slate-700">${item.categoria || ''}</td><td class="px-4 py-3 text-xs font-bold text-slate-600"><i class="fa-solid fa-location-dot text-slate-400 mr-1"></i>${localTxt}</td><td class="px-4 py-3 text-xs uppercase font-bold text-slate-500">${item.lojaDebito || ''}</td><td class="px-4 py-3 text-xs text-right font-bold text-emerald-600">R$ ${valorNum.toFixed(2).replace('.', ',')}</td>${celulaComprovante}<td class="px-4 py-3 text-xs text-center">${btnAcao}</td></tr>`;
  });
  document.getElementById('detalheTotalValor').textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
}

// ============================================================
//  RELATÓRIO / EXPORTAR (sem fotos, com logo da TI)
// ============================================================
function escaparTextoHtml(valor) {
  return String(valor == null ? '' : valor).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatarMoedaBR(n) {
  return 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function exportarRelatorioViagem() {
  if (!viagemAtual) return;
  const itens = (viagemAtual.itens || []).slice().sort((a, b) => chaveDataOrdenacao(a.dataDespesa) - chaveDataOrdenacao(b.dataDespesa));
  if (itens.length === 0) { showToast('Não há despesas para exportar.', 'warning'); return; }

  let total = 0;
  const porCategoria = {};
  const linhas = itens.map((item, i) => {
    const valor = Number(String(item.valor || 0).replace(',', '.')) || 0;
    total += valor;
    const cat = item.categoria || 'Sem categoria';
    porCategoria[cat] = (porCategoria[cat] || 0) + valor;
    const hora = formatarHoraVisao(item.horaDespesa);
    return `<tr><td class="c">${i + 1}</td><td>${escaparTextoHtml(formatarDataVisao(item.dataDespesa))}</td><td class="c">${escaparTextoHtml(hora || '—')}</td><td>${escaparTextoHtml(item.localDespesa || '—')}</td><td>${escaparTextoHtml(cat)}</td><td class="c up">${escaparTextoHtml(item.lojaDebito || '')}</td><td class="r">${formatarMoedaBR(valor)}</td></tr>`;
  }).join('');

  const linhasResumo = Object.keys(porCategoria).sort().map(cat => `<tr><td>${escaparTextoHtml(cat)}</td><td class="r">${formatarMoedaBR(porCategoria[cat])}</td></tr>`).join('');

  const agora = new Date();
  const emitidoEm = `${agora.toLocaleDateString('pt-BR')} às ${pad2(agora.getHours())}:${pad2(agora.getMinutes())}`;
  const emitidoPor = `${userData.nome || ''} ${userData.sobrenome || ''}`.trim() || userData.login;
  const logoUrl = new URL('logo.png', window.location.href).href;
  const nomeArquivo = `Relatorio_Despesas_${viagemAtual.sigla}_${agora.toISOString().slice(0, 10)}`;

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
tfoot td{background:#ecfdf5;font-weight:bold;font-size:13px;color:#047857}
.resumo{width:55%}
.assin{display:flex;gap:40px;margin-top:70px;page-break-inside:avoid}
.assin div{flex:1;text-align:center;border-top:1px solid #334155;padding-top:6px;font-size:10px;color:#475569}
.rodape{margin-top:30px;text-align:center;font-size:9px;color:#94a3b8}
</style></head><body>
<div class="topo">
  <div class="marca"><img id="logoRel" src="${escaparTextoHtml(logoUrl)}" alt="TI Claudino"><div><h1>Relatório de Despesas de Viagem</h1><p>TI Claudino S/A</p></div></div>
  <div class="emissao">Emitido em<br><b>${escaparTextoHtml(emitidoEm)}</b><br>por ${escaparTextoHtml(emitidoPor)}</div>
</div>

<h2>Dados da Viagem</h2>
<div class="info">
  <div><span>Loja (Sigla)</span><b>${escaparTextoHtml(viagemAtual.sigla)}</b></div>
  <div><span>Status</span><b>${escaparTextoHtml(viagemAtual.status)}</b></div>
  <div class="full"><span>Motivo</span><b>${escaparTextoHtml(viagemAtual.motivo)}</b></div>
  <div><span>Solicitado por</span><b>${escaparTextoHtml(viagemAtual.criadoPor)}</b></div>
  <div><span>Técnico responsável</span><b>${escaparTextoHtml(viagemAtual.colaborador)}</b></div>
</div>

<h2>Despesas (Ordem Cronológica)</h2>
<table>
  <thead><tr><th class="c" style="width:32px">#</th><th>Data</th><th class="c">Hora</th><th>Local</th><th>Categoria</th><th class="c">Loja Débito</th><th class="r">Valor</th></tr></thead>
  <tbody>${linhas}</tbody>
  <tfoot><tr><td colspan="6" class="r">TOTAL (${itens.length} despesa${itens.length > 1 ? 's' : ''})</td><td class="r">${formatarMoedaBR(total)}</td></tr></tfoot>
</table>

<h2>Resumo por Categoria</h2>
<table class="resumo"><thead><tr><th>Categoria</th><th class="r">Total</th></tr></thead><tbody>${linhasResumo}</tbody></table>

<div class="assin"><div>Técnico responsável</div><div>Coordenação / Gerência</div></div>
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
  // espera a logo carregar antes de abrir a impressão (com limite de 2,5s)
  const logo = doc.getElementById('logoRel');
  if (logo && !logo.complete) { logo.onload = () => setTimeout(imprimir, 150); logo.onerror = () => setTimeout(imprimir, 150); setTimeout(imprimir, 2500); }
  else setTimeout(imprimir, 200);
  showToast('Relatório pronto! Na janela de impressão escolha "Salvar como PDF".', 'info');
}

async function abrirModalAnexarTickets() {
  const r = await fetchAPI({ action: 'getCarteiraComprovantes', login: userData.login });
  const div = document.getElementById('listaTicketsDisponiveis'); div.innerHTML = '';
  if (r && r.success && r.comprovantes.length > 0) {
    r.comprovantes.forEach(c => {
      const temFoto = !!c.urlComprovante;
      const valorNum = Number(String(c.valor || 0).replace(',', '.')) || 0;
      div.innerHTML += `<label class="flex items-center gap-3 p-2 bg-white rounded border cursor-pointer hover:border-blue-400"><input type="checkbox" value="${c.idComprovante}" class="chk-ticket h-4 w-4 accent-blue-600"><div class="text-xs"><span class="font-bold text-slate-800">${c.categoria || ''}</span> (${formatarDataVisao(c.dataDespesa)})${c.localDespesa ? ' - ' + escaparTextoHtml(c.localDespesa) : ''}<span class="block text-[10px] text-slate-500">Debitar: <b>${c.lojaDebito || ''}</b> | R$ ${valorNum.toFixed(2).replace('.', ',')} ${temFoto ? '| <span class="text-emerald-600 font-bold">Foto ok</span>' : '| <span class="text-amber-600 font-bold">Sem foto</span>'}</span></div></label>`;
    });
    document.getElementById('modalAnexarTickets').classList.remove('hidden');
  } else { showToast('Carteira vazia.', 'info'); }
}

async function confirmarAnexoTickets() {
  const checks = document.querySelectorAll('.chk-ticket:checked');
  const ids = Array.from(checks).map(c => c.value);
  if (ids.length === 0) { showToast('Selecione ao menos um.', 'warning'); return; }
  const r = await fetchAPI({ action: 'linkComprovantesToViagem', idViagem: viagemAtual.idViagem, comprovantesIds: ids, login: userData.login }, 'btnConfirmarAnexos');
  if (r.success) { document.getElementById('modalAnexarTickets').classList.add('hidden'); showToast('Tickets vinculados!', 'success'); recarregarDashboard(); }
  else { showToast(r.message || 'Erro.', 'error'); }
}

async function removerItemViagem(idComp) {
  if (!await showConfirm("Devolver este ticket para a carteira?")) return;
  const r = await fetchAPI({ action: 'removeComprovanteFromViagem', idComprovante: idComp, login: userData.login });
  if (r.success) { showToast('Ticket removido.', 'info'); recarregarDashboard(); } else { showToast(r.message || 'Erro.', 'error'); }
}

async function enviarDespesasViagem() {
  if (!await showConfirm("Enviar despesas para aprovação?", { type: 'info' })) return;
  const r = await fetchAPI({ action: 'updateDespesaStatus', idViagem: viagemAtual.idViagem, status: 'PENDENTE', login: userData.login, nivel: userData.nivel });
  if (r.success) { showToast('Enviado!', 'success'); recarregarDashboard(); } else { showToast(r.message || 'Erro.', 'error'); }
}

async function alterarStatusViagem(novoStatus) {
  const r = await fetchAPI({ action: 'updateDespesaStatus', idViagem: viagemAtual.idViagem, status: novoStatus, login: userData.login, nivel: userData.nivel });
  if (r.success) { showToast(`Status: ${novoStatus}!`, 'success'); recarregarDashboard(); } else { showToast(r.message || 'Erro.', 'error'); }
}

async function excluirViagem() {
  if (!await showConfirm("Excluir viagem permanentemente?", { type: 'danger' })) return;
  const r = await fetchAPI({ action: 'deleteDespesaViagem', idViagem: viagemAtual.idViagem, login: userData.login, nivel: userData.nivel });
  if (r.success) { showToast('Viagem excluída.', 'success'); recarregarDashboard(); } else { showToast(r.message || 'Erro.', 'error'); }
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
