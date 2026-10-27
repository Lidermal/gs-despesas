const API_URL = "https://script.google.com/macros/s/AKfycbyv6rztF_a5ePHzRhzCMJDawDOHhF-le_3MgvoeMY2WUGjVRQBPmt2cSuV6Mp71MGnpUQ/exec";
const TEMPO_SESSAO_MS = 4 * 60 * 60 * 1000;

let userData = null, viagensGlobais = [], carteiraGlobais = [], viagemAtual = null, filtroLojaSelecionada = "TODAS";
let ocrImagemBase64 = '', ocrMimeType = 'image/jpeg', ocrTextoExtraido = '';

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
  if (!valor || isDataBaseSheets(valor)) return '';
  const s = String(valor).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  const m = s.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function chaveDataOrdenacao(valor) {
  const s = String(valor || '');
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const p = s.split('/'); return new Date(`${p[2]}-${p[1]}-${p[0]}`); }
  const d = new Date(s); return isNaN(d.getTime()) ? new Date(0) : d;
}

// ==================== OCR: DATA / HORA / VALOR (MELHORADO) ====================
function extrairDataDoTexto(texto) {
  if (!texto) return '';
  let t = String(texto).toUpperCase();
  const padroesData = [
    /(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/g,
    /(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{2})/g,
    /DATA[:\s]+(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{2,4})/gi,
    /(\d{2}) DE (JANEIRO|FEVEREIRO|MARÇO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO) DE (\d{4})/gi
  ];
  const meses = { 'JANEIRO': '01', 'FEVEREIRO': '02', 'MARÇO': '03', 'ABRIL': '04', 'MAIO': '05', 'JUNHO': '06', 'JULHO': '07', 'AGOSTO': '08', 'SETEMBRO': '09', 'OUTUBRO': '10', 'NOVEMBRO': '11', 'DEZEMBRO': '12' };
  for (let padrao of padroesData) {
    padrao.lastIndex = 0;
    let match;
    while ((match = padrao.exec(t)) !== null) {
      let dia, mes, ano;
      if (match[0].includes(' DE ')) { dia = pad2(parseInt(match[1])); mes = meses[match[2].toUpperCase()]; ano = match[3]; }
      else { dia = match[1]; mes = match[2]; ano = match[3].length === 2 ? '20' + match[3] : match[3]; }
      if (parseInt(dia) >= 1 && parseInt(dia) <= 31 && parseInt(mes) >= 1 && parseInt(mes) <= 12 && parseInt(ano) >= 2000 && parseInt(ano) <= 2100) return `${dia}/${mes}/${ano}`;
    }
  }
  return '';
}

function extrairHoraDoTexto(texto) {
  if (!texto) return '';
  let t = String(texto);
  const padroesHora = [/(\d{2})[:hH](\d{2})/, /HORA[:\s]+(\d{2}[:hH]\d{2})/gi, /(\d{1,2})[:hH](\d{2})[:hH](\d{2})/];
  for (let padrao of padroesHora) {
    padrao.lastIndex = 0;
    let match = padrao.exec(t);
    if (match) {
      let hora = pad2(parseInt(match[1]));
      let min = match[2];
      if (parseInt(hora) >= 0 && parseInt(hora) <= 23 && parseInt(min) >= 0 && parseInt(min) <= 59) return `${hora}:${min}`;
    }
  }
  return '';
}

function extrairValorDoTexto(texto) {
  if (!texto) return '';
  let t = String(texto).toUpperCase();
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/(R\$|RS|\$)\s*(\d+)[\)\]\}]+/g, '$1 $2');

  // Estratégia 1: busca por palavras-chave fortes
  const padroesValor = [
    /VALOR\s*PAGO[:\s]*R?\$?\s*([\d.]+,\d{2})/gi,
    /TOTAL\s*(?:DA\s*COMPRA|A\s*PAGAR|PAGO)?[:\s]*R?\$?\s*([\d.]+,\d{2})/gi,
    /PAGO[:\s]*R?\$?\s*([\d.]+,\d{2})/gi,
    /CREDITO\s*(?:A\s*VISTA|A\s*PRAZO)?[:\s]*[\w\s]*?R?\$?\s*([\d.]+,\d{2})/gi,
    /DEBITO\s*(?:A\s*VISTA)?[:\s]*[\w\s]*?R?\$?\s*([\d.]+,\d{2})/gi,
    /R\$\s*([\d.]+,\d{2})/g,
    /([\d.]+,\d{2})\s*REAL/gi,
  ];
  for (let padrao of padroesValor) {
    padrao.lastIndex = 0;
    let match = padrao.exec(t);
    if (match) {
      let valorStr = match[1].replace(/\./g, '').replace(',', '.');
      let valor = parseFloat(valorStr);
      if (valor > 0.50 && valor < 50000) return valor.toFixed(2);
    }
  }

  // Estratégia 2: busca R$ seguido de número SEM vírgula (ex: R$6600 → 66,00)
  const reRealSemVirgula = /R\$\s*(\d{3,})/g;
  let matchReal;
  while ((matchReal = reRealSemVirgula.exec(t)) !== null) {
    const numStr = matchReal[1];
    if (numStr.length >= 3) {
      const intPart = numStr.slice(0, -2);
      const decPart = numStr.slice(-2);
      const valor = parseFloat(intPart + '.' + decPart);
      if (valor > 0.50 && valor < 50000) return valor.toFixed(2);
    }
  }

  // Estratégia 3: busca palavras-chave próximas a qualquer número
  const palavrasChave = ['TOTAL', 'PAGO', 'VALOR', 'CREDITO', 'DEBITO', 'PIX', 'DINHEIRO', 'TOMBAMENTO'];
  for (let palavra of palavrasChave) {
    let index = t.indexOf(palavra);
    if (index !== -1) {
      let trecho = t.substring(index, index + 80);
      let matchValor = /R?\$?\s*([\d.]+,\d{2})/.exec(trecho);
      if (matchValor) {
        let valorStr = matchValor[1].replace(/\./g, '').replace(',', '.');
        let valor = parseFloat(valorStr);
        if (valor > 0.50 && valor < 50000) return valor.toFixed(2);
      }
    }
  }

  // Estratégia 4: maior valor com centavos no texto
  let todosValores = t.match(/[\d.]+,\d{2}/g) || [];
  let maiorValor = 0;
  for (let valorStr of todosValores) {
    let valorLimpo = valorStr.replace(/\./g, '').replace(',', '.');
    let valor = parseFloat(valorLimpo);
    if (valor > maiorValor && valor < 50000) maiorValor = valor;
  }
  if (maiorValor > 0) return maiorValor.toFixed(2);

  return '';
}

// ==================== DRIVE / COMPRUVANTE ====================
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
function abrirComprovante(url) { if (!url) { showToast('Sem comprovante anexado.', 'warning'); return; } window.open(url, '_blank', 'noopener,noreferrer'); }
function baixarComprovante(url) {
  if (!url) { showToast('Sem comprovante para download.', 'warning'); return; }
  const fileId = extrairFileIdDrive(url);
  if (!fileId) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
  const link = document.createElement('a'); link.href = `https://drive.google.com/uc?export=download&id=${fileId}`;
  link.target = '_blank'; link.rel = 'noopener noreferrer'; document.body.appendChild(link); link.click(); link.remove();
}

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

// ==================== MODAL CONFIRMAÇÃO (COM ESTILOS INLINE) ====================
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
    if (carteiraGlobais.length === 0) { tb.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-400">Nenhum comprovante na carteira.</td></tr>'; return; }
    carteiraGlobais.forEach(c => {
      const diasVenc = 30 - Math.floor((new Date() - new Date(c.dataUpload)) / (1000 * 60 * 60 * 24));
      const temFoto = !!c.urlComprovante;
      const horaFormatada = formatarHoraVisao(c.horaDespesa);
      tb.innerHTML += `
        <tr class="hover:bg-slate-50 border-b">
          <td class="px-4 py-3 text-xs font-mono">${formatarDataVisao(c.dataDespesa)}${horaFormatada ? ' às ' + horaFormatada : ''}</td>
          <td class="px-4 py-3 text-xs font-bold text-slate-700">${c.categoria || ''}</td>
          <td class="px-4 py-3 text-xs font-bold uppercase text-slate-500">${c.lojaDebito || ''}</td>
          <td class="px-4 py-3 text-xs font-bold text-emerald-600">R$ ${Number(c.valor || 0).toFixed(2).replace('.', ',')}</td>
          <td class="px-4 py-3 text-xs text-center"><div class="flex flex-col items-center gap-1"><span class="text-amber-600 font-bold">${diasVenc} dia(s)</span>${temFoto ? '<span class="text-emerald-600 font-bold text-[10px]"><i class="fa-solid fa-image"></i> Foto ok</span>' : '<span class="text-slate-400 text-[10px]">Sem foto</span>'}</div></td>
          <td class="px-4 py-3 text-xs text-center">
            <div class="flex gap-1 justify-center">
              ${temFoto ? `<button onclick="visualizarImagemCarteira('${c.idComprovante}')" class="text-blue-600 hover:text-blue-800" title="Ver foto"><i class="fa-solid fa-eye"></i></button>` : ''}
              <button onclick="editarComprovanteCarteira('${c.idComprovante}')" class="text-amber-600 hover:text-amber-800" title="Editar"><i class="fa-solid fa-pen"></i></button>
              <button onclick="excluirComprovanteCarteira('${c.idComprovante}')" class="text-red-600 hover:text-red-800" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </div>
          </td>
        </tr>`;
    });
  }
}

function visualizarImagemCarteira(idComp) {
  const item = carteiraGlobais.find(c => c.idComprovante === idComp);
  if (!item || !item.urlComprovante) { showToast('Sem imagem.', 'warning'); return; }
  abrirComprovante(item.urlComprovante);
}

function editarComprovanteCarteira(idComp) {
  const item = carteiraGlobais.find(c => c.idComprovante === idComp);
  if (!item) return;
  document.getElementById('editIdComprovante').value = idComp;
  document.getElementById('editData').value = item.dataDespesa || '';
  document.getElementById('editHora').value = formatarHoraVisao(item.horaDespesa) || '';
  document.getElementById('editValor').value = Number(item.valor || 0).toFixed(2).replace('.', ',');
  document.getElementById('editLoja').value = item.lojaDebito || '';
  document.getElementById('editCategoria').value = item.categoria || '';
  document.getElementById('editPreviewImg').src = item.urlComprovante ? montarUrlThumbnailDrive(item.urlComprovante) : '';
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

  const data = { action: 'updateComprovante', idComprovante: idComp, login: userData.login, dataDespesa: document.getElementById('editData').value.trim(), horaDespesa: document.getElementById('editHora').value.trim(), valor: parseFloat(String(valorRaw).replace(',', '.')), lojaDebito: loja, categoria };
  if (novaImagem) { data.imagemBase64 = novaImagem; data.mimeType = novoMime; }

  const r = await fetchAPI(data, 'btnSalvarEdicao');
  if (r && r.success) { document.getElementById('modalEditarComprovante').classList.add('hidden'); showToast('Comprovante atualizado!', 'success'); carregarCarteiraSuporte(); }
  else { showToast(r.message || 'Erro ao atualizar.', 'error'); }
}

async function excluirComprovanteCarteira(idComp) {
  if (!await showConfirm("Excluir este comprovante permanentemente?", { type: 'danger', icon: 'fa-trash' })) return;
  const r = await fetchAPI({ action: 'deleteComprovante', idComprovante: idComp, login: userData.login });
  if (r && r.success) { showToast('Comprovante excluído.', 'success'); carregarCarteiraSuporte(); }
  else { showToast(r.message || 'Erro ao excluir.', 'error'); }
}

// ==================== OCR MODAL ====================
function abrirModalOCR() {
  document.getElementById('modalOCR').classList.remove('hidden'); document.getElementById('ocrForm').classList.add('hidden'); document.getElementById('btnSalvarNota').classList.add('hidden'); document.getElementById('fileOCR').value = "";
  document.getElementById('ocrData').value = ''; document.getElementById('ocrHora').value = ''; document.getElementById('ocrValor').value = ''; document.getElementById('ocrLoja').value = ''; document.getElementById('ocrCategoria').value = '';
  ocrImagemBase64 = ''; ocrMimeType = 'image/jpeg'; ocrTextoExtraido = '';
  const previewContainer = document.getElementById('ocrPreviewContainer'), preview = document.getElementById('ocrPreview');
  if (previewContainer) previewContainer.classList.add('hidden'); if (preview) preview.src = '';
}

async function processarOCR(event) {
  const file = event.target.files[0]; if (!file) return;
  ocrTextoExtraido = '';
  document.getElementById('ocrData').value = ''; document.getElementById('ocrHora').value = ''; document.getElementById('ocrValor').value = ''; document.getElementById('ocrLoja').value = ''; document.getElementById('ocrCategoria').value = '';
  document.getElementById('ocrLoader').classList.remove('hidden'); document.getElementById('ocrForm').classList.add('hidden'); document.getElementById('btnSalvarNota').classList.add('hidden');
  const previewContainer = document.getElementById('ocrPreviewContainer'), preview = document.getElementById('ocrPreview');
  if (previewContainer) previewContainer.classList.add('hidden'); if (preview) preview.src = '';

  try {
    ocrImagemBase64 = await converterFileParaBase64(file);
    const matchMime = String(ocrImagemBase64).match(/^data:([^;]+);base64,/);
    ocrMimeType = matchMime ? matchMime[1] : (file.type || 'image/jpeg');
    if (preview && previewContainer) { preview.src = ocrImagemBase64; previewContainer.classList.remove('hidden'); }
    try {
      const res = await Tesseract.recognize(file, 'por');
      ocrTextoExtraido = res.data.text || '';
      document.getElementById('ocrData').value = extrairDataDoTexto(ocrTextoExtraido);
      document.getElementById('ocrHora').value = extrairHoraDoTexto(ocrTextoExtraido);
      document.getElementById('ocrValor').value = extrairValorDoTexto(ocrTextoExtraido);
      const faltantes = [];
      if (!document.getElementById('ocrData').value) faltantes.push('data');
      if (!document.getElementById('ocrHora').value) faltantes.push('hora');
      if (!document.getElementById('ocrValor').value) faltantes.push('valor');
      if (faltantes.length > 0) showToast(`Verifique: ${faltantes.join(', ')}.`, 'warning');
      else showToast('Dados lidos! Preencha Categoria e Loja.', 'success');
    } catch (e) { showToast('Falha no OCR. Preencha manualmente.', 'warning'); }
  } catch (e) { ocrImagemBase64 = ''; showToast('Erro ao carregar imagem.', 'error'); }
  finally { document.getElementById('ocrLoader').classList.add('hidden'); document.getElementById('ocrForm').classList.remove('hidden'); document.getElementById('btnSalvarNota').classList.remove('hidden'); }
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
  
  const data = { action: 'saveComprovante', login: userData.login, dataDespesa, horaDespesa: document.getElementById('ocrHora').value.trim(), valor: parseFloat(String(valorRaw).replace(',', '.')), lojaDebito: loja, categoria, ocrConteudo: String(ocrTextoExtraido || '').slice(0, 5000), imagemBase64: ocrImagemBase64, mimeType: ocrMimeType };
  const r = await fetchAPI(data, 'btnSalvarNota');
  if (r && r.success) {
    document.getElementById('modalOCR').classList.add('hidden');
    if (r.urlComprovante) showToast('✅ Comprovante e FOTO salvos!', 'success');
    else showToast('Salvo, mas sem anexo no Drive.', 'warning');
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
  if (isColab && (viagemAtual.status === 'ABERTO' || viagemAtual.status === 'SOLICITAR CORRECAO')) {
    area.innerHTML += `<button onclick="abrirModalAnexarTickets()" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-paperclip mr-2"></i> Inserir Tickets</button>`;
    if (viagemAtual.itens.length > 0) area.innerHTML += `<button onclick="enviarDespesasViagem()" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow ml-auto"><i class="fa-solid fa-paper-plane mr-2"></i> Enviar Despesas</button>`;
  }
  if (isGestao) {
    if (viagemAtual.status === 'PENDENTE') {
      area.innerHTML += `<button onclick="alterarStatusViagem('FECHADA')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-check mr-2"></i> Fechar</button>`;
      area.innerHTML += `<button onclick="alterarStatusViagem('SOLICITAR CORRECAO')" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-arrow-rotate-left mr-2"></i> Solicitar Correção</button>`;
    }
    if (viagemAtual.status === 'FECHADA') area.innerHTML += `<button onclick="alterarStatusViagem('ARQUIVADA')" class="bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-box-archive mr-2"></i> Arquivar</button>`;
    area.innerHTML += `<button onclick="excluirViagem()" class="bg-red-600 hover:bg-red-700 text-white text-xs font-bold py-2 px-4 rounded shadow ml-auto"><i class="fa-solid fa-trash mr-2"></i> Excluir</button>`;
  }
}

function renderItensViagem() {
  const tb = document.getElementById('tbItensViagem'); tb.innerHTML = '';
  const isColab = (String(viagemAtual.colaborador).toLowerCase() === String(userData.login).toLowerCase());
  const isGestao = (userData.nivel === 'Coordenação GS' || userData.nivel === 'Gerência GS');
  const podeVerComprovante = isGestao || isColab;
  const emEdicao = (viagemAtual.status === 'ABERTO' || viagemAtual.status === 'SOLICITAR CORRECAO');
  let total = 0;
  if (viagemAtual.itens.length === 0) { tb.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-slate-400">Nenhum ticket anexado.</td></tr>'; document.getElementById('detalheTotalValor').textContent = 'R$ 0,00'; return; }
  viagemAtual.itens.sort((a, b) => chaveDataOrdenacao(a.dataDespesa) - chaveDataOrdenacao(b.dataDespesa));
  viagemAtual.itens.forEach(item => {
    total += Number(item.valor || 0);
    let btnAcao = '';
    if (isColab && emEdicao) btnAcao = `<button onclick="removerItemViagem('${item.idComprovante}')" class="text-red-500 hover:text-red-700" title="Remover"><i class="fa-solid fa-trash"></i></button>`;
    let celulaComprovante = '<td class="px-4 py-3 text-xs text-center text-slate-300">—</td>';
    if (podeVerComprovante) {
      if (item.urlComprovante) {
        const thumb = montarUrlThumbnailDrive(item.urlComprovante);
        const urlHtml = escaparAtributoHtml(item.urlComprovante);
        celulaComprovante = `<td class="px-4 py-3 text-xs"><div class="flex items-center gap-3"><img src="${thumb}" alt="Comprovante" loading="lazy" class="h-12 w-12 object-cover rounded border cursor-pointer bg-slate-100" data-url="${urlHtml}" onclick="abrirComprovante(this.dataset.url)" onerror="this.style.display='none'"><div class="flex flex-col gap-1"><button type="button" class="text-[10px] font-bold text-blue-600 hover:text-blue-800" data-url="${urlHtml}" onclick="abrirComprovante(this.dataset.url)"><i class="fa-solid fa-eye mr-1"></i> Ver</button><button type="button" class="text-[10px] font-bold text-emerald-600 hover:text-emerald-800" data-url="${urlHtml}" onclick="baixarComprovante(this.dataset.url)"><i class="fa-solid fa-download mr-1"></i> Baixar</button></div></div></td>`;
      } else { celulaComprovante = '<td class="px-4 py-3 text-xs text-center text-amber-600 font-bold">Sem imagem</td>'; }
    }
    tb.innerHTML += `<tr class="hover:bg-slate-50 border-b"><td class="px-4 py-3 text-xs">${formatarDataVisao(item.dataDespesa)}</td><td class="px-4 py-3 text-xs font-bold text-slate-700">${item.categoria || ''}</td><td class="px-4 py-3 text-xs uppercase font-bold text-slate-500">${item.lojaDebito || ''}</td><td class="px-4 py-3 text-xs text-right font-bold text-emerald-600">R$ ${Number(item.valor || 0).toFixed(2).replace('.', ',')}</td>${celulaComprovante}<td class="px-4 py-3 text-xs text-center">${btnAcao}</td></tr>`;
  });
  document.getElementById('detalheTotalValor').textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
}

async function abrirModalAnexarTickets() {
  const r = await fetchAPI({ action: 'getCarteiraComprovantes', login: userData.login });
  const div = document.getElementById('listaTicketsDisponiveis'); div.innerHTML = '';
  if (r && r.success && r.comprovantes.length > 0) {
    r.comprovantes.forEach(c => {
      const temFoto = !!c.urlComprovante;
      div.innerHTML += `<label class="flex items-center gap-3 p-2 bg-white rounded border cursor-pointer hover:border-blue-400"><input type="checkbox" value="${c.idComprovante}" class="chk-ticket h-4 w-4 accent-blue-600"><div class="text-xs"><span class="font-bold text-slate-800">${c.categoria || ''}</span> (${formatarDataVisao(c.dataDespesa)})<span class="block text-[10px] text-slate-500">Debitar: <b>${c.lojaDebito || ''}</b> | R$ ${Number(c.valor || 0).toFixed(2).replace('.', ',')} ${temFoto ? '| <span class="text-emerald-600 font-bold">Foto ok</span>' : '| <span class="text-amber-600 font-bold">Sem foto</span>'}</span></div></label>`;
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
