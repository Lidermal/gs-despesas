// URL do Google Apps Script (Sua WebApp da planilha)
const API_URL = "https://script.google.com/macros/s/AKfycbyv6rztF_a5ePHzRhzCMJDawDOHhF-le_3MgvoeMY2WUGjVRQBPmt2cSuV6Mp71MGnpUQ/exec";

const TEMPO_SESSAO_MS = 4 * 60 * 60 * 1000;

let userData = null;
let viagensGlobais = [];
let carteiraGlobais = [];
let viagemAtual = null;
let filtroLojaSelecionada = "TODAS";

// Variáveis para OCR + Upload de imagem
let ocrImagemBase64 = '';
let ocrMimeType = 'image/jpeg';
let ocrTextoExtraido = '';

// ==================== UTILITÁRIOS GERAIS ====================

function pad2(n) { return String(n).padStart(2, '0'); }

function escaparAtributoHtml(valor) {
    return String(valor || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatarDataVisao(valor) {
    const s = String(valor || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const partes = s.slice(0, 10).split('-');
        return `${partes[2]}/${partes[1]}/${partes[0]}`;
    }
    return s;
}

function chaveDataOrdenacao(valor) {
    const s = String(valor || '');
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        const p = s.split('/');
        return new Date(`${p[2]}-${p[1]}-${p[0]}`);
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? new Date(0) : d;
}

// ==================== OCR: DATA / HORA ====================

// Data: DD/MM/AAAA, DD/MM/AA, DD-MM-AAAA, aceitando erros de OCR comuns (l, 1, I no lugar de /)
function extrairDataDoTexto(texto) {
    const t = String(texto || '').replace(/\s+/g, ' ');
    // Regex robusta para capturar datas brasileiras com possíveis ruídos de OCR
    const re = /\b(0[1-9]|[12][0-9]|3[01])[\/\-\.\s\,l1I](0[1-9]|1[012])[\/\-\.\s\,l1I](20\d{2}|\d{2})\b/g;
    let m;
    let datas = [];
    while ((m = re.exec(t)) !== null) {
        let d = parseInt(m[1], 10);
        let mo = parseInt(m[2], 10);
        let y = parseInt(m[3], 10);
        if (m[3].length === 2) y = 2000 + y;
        if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) {
            datas.push(`${pad2(d)}/${pad2(mo)}/${y}`);
        }
    }
    if (datas.length > 0) return datas[0]; // Pega a primeira data válida encontrada

    // Fallback ISO AAAA-MM-DD
    const reIso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    if ((m = reIso.exec(t)) !== null) {
        const y = +m[1], mo = +m[2], d = +m[3];
        if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${pad2(d)}/${pad2(mo)}/${y}`;
    }
    return '';
}

// Hora: HH:MM ou HHhMM. Aceita ruídos como HH;MM ou HH.MM
function extrairHoraDoTexto(texto) {
    const t = String(texto || '');
    const re = /\b([01]?\d|2[0-3])[:;hH\.]([0-5]\d)\b/g;
    let horasEncontradas = [];
    let m;
    while ((m = re.exec(t)) !== null) {
        horasEncontradas.push(`${pad2(parseInt(m[1], 10))}:${m[2]}`);
    }
    if (horasEncontradas.length > 0) return horasEncontradas[0];
    return '';
}

// ==================== OCR: VALOR PAGO (Melhorado p/ Cupons e Máquinas) ====================

function extrairValorDoTexto(texto) {
    const t = String(texto || '').toUpperCase().replace(/\n/g, ' ');
    const candidatos = [];

    function add(num, base) {
        if (num === null || isNaN(num) || num <= 0 || num > 50000) return;
        candidatos.push({ num: num, score: base });
    }

    // Processa de forma robusta strings de dinheiro que podem vir com "." ou "," do OCR
    function parseMoedaBR(str) {
        let clean = String(str).replace(/[^\d.,]/g, '');
        const lastComma = clean.lastIndexOf(',');
        const lastDot = clean.lastIndexOf('.');
        const lastSeparator = Math.max(lastComma, lastDot);
        if (lastSeparator === -1) return parseFloat(clean);
        const intPart = clean.substring(0, lastSeparator).replace(/[.,]/g, '');
        const decPart = clean.substring(lastSeparator + 1);
        return parseFloat((intPart || '0') + '.' + decPart);
    }

    // Padrão que pega valores terminados em dois dígitos decimais (ex: 1.234,56 ou 1234.56 ou 12,34)
    const regexMoeda = /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})/;

    // 1. Busca por valores que possuam prefixo monetário antes
    const reMoedaBR = /(?:R\$|RS|S\$|\$)\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})/g;
    let m;
    while ((m = reMoedaBR.exec(t)) !== null) {
        add(parseMoedaBR(m[1]), 60);
    }

    // 2. Busca valores genéricos que estejam próximos de palavras fortes do contexto
    const palavrasChave = [
        { regex: /TOTAL/g, score: 100 },
        { regex: /PAGO/g, score: 90 },
        { regex: /VALOR/g, score: 80 },
        { regex: /D[EÉ]BITO/g, score: 70 },
        { regex: /CR[EÉ]DITO/g, score: 70 },
        { regex: /PIX/g, score: 70 },
        { regex: /DINHEIRO/g, score: 70 },
        { regex: /CART[AÃ]O/g, score: 70 },
        { regex: /VISA/g, score: 60 },
        { regex: /MASTERCARD/g, score: 60 },
        { regex: /MAESTRO/g, score: 60 },
        { regex: /ELO/g, score: 60 },
        { regex: /AMEX/g, score: 60 },
        { regex: /APROVAD[OA]/g, score: 60 },
        { regex: /TOMBAMENTO/g, score: 60 }
    ];

    palavrasChave.forEach(pc => {
        let matchChave;
        const re = new RegExp(pc.regex, 'gi');
        while ((matchChave = re.exec(t)) !== null) {
            // Olha uma janela de 60 caracteres a frente da palavra chave
            const trecho = t.substring(matchChave.index, matchChave.index + 60);
            const matchValor = trecho.match(regexMoeda);
            if (matchValor) {
                 add(parseMoedaBR(matchValor[0]), pc.score);
            }
        }
    });

    // 3. Fallback: Qualquer número solto no formato moeda com 2 decimais
    let reQualquerValor = new RegExp(regexMoeda, 'g');
    while ((m = reQualquerValor.exec(t)) !== null) {
        add(parseMoedaBR(m[0]), 10);
    }

    if (candidatos.length === 0) return '';

    // 4. Agrupa e consolida as pontuações do mesmo valor (Relevância)
    const scoresPorValor = {};
    candidatos.forEach(c => {
        if (!scoresPorValor[c.num]) scoresPorValor[c.num] = 0;
        scoresPorValor[c.num] += c.score;
    });

    // 5. Vence o valor com o maior score consolidado. Empate: o MAIOR valor financeiro vence.
    let bestNum = 0;
    let bestScore = -1;

    for (const numStr in scoresPorValor) {
        const num = parseFloat(numStr);
        const score = scoresPorValor[numStr];
        if (score > bestScore || (score === bestScore && num > bestNum)) {
            bestScore = score;
            bestNum = num;
        }
    }

    return bestNum > 0 ? bestNum.toFixed(2) : '';
}

// ==================== UTILITÁRIOS PARA DRIVE / COMPRUVANTE ====================

function extrairFileIdDrive(url) {
    const s = String(url || '');
    const padraoFileD = s.match(/\/file\/d\/([^\/?&#]+)/);
    if (padraoFileD) return padraoFileD[1];
    const padraoIdParam = s.match(/[?&]id=([^&#]+)/);
    if (padraoIdParam) return padraoIdParam[1];
    const padraoDriveD = s.match(/\/d\/([^\/?&#]+)/);
    if (padraoDriveD) return padraoDriveD[1];
    return '';
}

function montarUrlThumbnailDrive(url) {
    const fileId = extrairFileIdDrive(url);
    if (fileId) return `https://drive.google.com/thumbnail?id=${fileId}&sz=w200`;
    return url;
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
        const img = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = original;
        });

        const maxDimension = 1600;
        const larguraReal = img.width || maxDimension;
        const alturaReal = img.height || maxDimension;
        const maiorLado = Math.max(larguraReal, alturaReal);
        const escala = Math.min(1, maxDimension / maiorLado);
        const novaLargura = Math.max(1, Math.round(larguraReal * escala));
        const novaAltura = Math.max(1, Math.round(alturaReal * escala));

        const canvas = document.createElement('canvas');
        canvas.width = novaLargura;
        canvas.height = novaAltura;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, novaLargura, novaAltura);
        return canvas.toDataURL('image/jpeg', 0.85);
    } catch (erro) {
        return original;
    }
}

function abrirComprovante(url) {
    if (!url) { showToast('Este item não possui comprovante anexado.', 'warning'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
}

function baixarComprovante(url) {
    if (!url) { showToast('Este item não possui comprovante para download.', 'warning'); return; }
    const fileId = extrairFileIdDrive(url);
    if (!fileId) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
    const link = document.createElement('a');
    link.href = `https://drive.google.com/uc?export=download&id=${fileId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

// ==================== INICIALIZAÇÃO E SESSÃO ====================
window.onload = () => {
    const savedUser = localStorage.getItem('usuarioDespesasAtivo');
    const loginTime = localStorage.getItem('loginDespesasTimestamp');

    if (savedUser && loginTime && (Date.now() - parseInt(loginTime) < TEMPO_SESSAO_MS)) {
        userData = JSON.parse(savedUser);
        iniciarSistema();
    } else {
        logout();
    }
};

// LOGOUT: não exibe alerta
function logout() {
    localStorage.removeItem('usuarioDespesasAtivo');
    localStorage.removeItem('loginDespesasTimestamp');
    userData = null;
    viagemAtual = null;
    viagensGlobais = [];
    carteiraGlobais = [];
    document.getElementById('globalHeader').classList.add('hidden');
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('viagemDetalheView').classList.add('hidden');
    document.getElementById('authView').classList.remove('hidden');
}

// ==================== TOAST (ALERTA BONITO) ====================
function showToast(message, type = 'info', title = null, duration = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');

    const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    const titles = { success: 'Sucesso', error: 'Erro', warning: 'Atenção', info: 'Informação' };

    toast.innerHTML = `
        <div class="toast-icon"><i class="fa-solid ${icons[type] || icons.info}"></i></div>
        <div class="toast-content">
            <div class="toast-title">${title || titles[type] || titles.info}</div>
            <div class="toast-message">${String(message || '')}</div>
        </div>
        <button class="toast-close" aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
        <div class="toast-progress" style="animation-duration:${duration}ms"></div>
    `;

    container.appendChild(toast);

    const fechar = () => {
        if (toast.dataset.closing) return;
        toast.dataset.closing = '1';
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    };

    toast.querySelector('.toast-close').addEventListener('click', fechar);
    setTimeout(fechar, duration);
}

function showConfirm(message, options = {}) {
    return new Promise((resolve) => {
        const { title = 'Confirmar Ação', confirmText = 'Confirmar', cancelText = 'Cancelar', type = 'warning', icon = 'fa-question' } = options;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div class="modal-confirm"><div class="modal-header ${type}"><div class="modal-icon"><i class="fa-solid ${icon}"></i></div><h3 class="modal-title">${title}</h3></div><div class="modal-body"><p class="modal-message">${message}</p></div><div class="modal-footer"><button class="modal-btn modal-btn-cancel" id="modalCancel">${cancelText}</button><button class="modal-btn ${type === 'danger' ? 'modal-btn-danger' : 'modal-btn-confirm'}" id="modalConfirm">${confirmText}</button></div></div>`;
        document.body.appendChild(overlay);
        const cleanup = () => { overlay.style.animation = 'fadeIn 0.2s ease-out reverse'; setTimeout(() => overlay.remove(), 200); };
        document.getElementById('modalConfirm').onclick = () => { cleanup(); resolve(true); };
        document.getElementById('modalCancel').onclick = () => { cleanup(); resolve(false); };
    });
}

async function fetchAPI(data, btnId = null, textId = null, originalText = null) {
    const btn = btnId ? document.getElementById(btnId) : null;
    if (btn) { btn.disabled = true; if (textId) document.getElementById(textId).innerHTML = '<span class="loader-small"></span> Aguarde...'; }
    try {
        const response = await fetch(API_URL, { method: 'POST', body: JSON.stringify(data) });
        return await response.json();
    } catch (e) {
        showToast('Erro de Conexão com o Banco.', 'error');
        return { success: false };
    } finally {
        if (btn) { btn.disabled = false; if (textId) document.getElementById(textId).innerHTML = originalText; }
    }
}

// ==================== CONTROLE DE AUTH ====================
function toggleAuthView(v) {
    if (v === 'register') { document.getElementById('loginSection').classList.add('hidden'); document.getElementById('registerSection').classList.remove('hidden'); }
    else { document.getElementById('registerSection').classList.add('hidden'); document.getElementById('loginSection').classList.remove('hidden'); }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    // LOGIN: sem alerta no sucesso
    const r = await fetchAPI({ action: 'login', login: document.getElementById('loginUser').value.trim(), senha: document.getElementById('loginSenha').value }, 'btnLogin', 'loginText', 'Acessar Despesas <i class="fa-solid fa-arrow-right-to-bracket ml-2"></i>');
    if (r && r.success) {
        localStorage.setItem('usuarioDespesasAtivo', JSON.stringify(r.user));
        localStorage.setItem('loginDespesasTimestamp', Date.now().toString());
        userData = r.user;
        iniciarSistema();
    } else {
        showToast(r.message || 'Credenciais incorretas', 'error');
    }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = { action: 'register', nome: document.getElementById('regNome').value, sobrenome: document.getElementById('regSobrenome').value, equipe: document.getElementById('regEquipe').value, nivel: document.getElementById('regNivel').value, senha: document.getElementById('regSenha').value };
    const r = await fetchAPI(data, 'btnRegister', 'regText', '<i class="fa-solid fa-save mr-2"></i> Cadastrar');
    if (r && r.success) { showToast(`Usuário criado: ${r.login}`, 'success'); toggleAuthView('login'); }
    else showToast(r.message, 'error');
});

// ==================== CARREGAMENTO DO PAINEL ====================
function iniciarSistema() {
    document.getElementById('authView').classList.add('hidden');
    document.getElementById('globalHeader').classList.remove('hidden');
    document.getElementById('mainContent').classList.remove('hidden');

    document.getElementById('navUserName').textContent = `${userData.nome} ${userData.sobrenome}`;
    document.getElementById('navUserRole').textContent = `${userData.nivel}`;

    recarregarDashboard();
}

async function recarregarDashboard() {
    document.getElementById('viagemDetalheView').classList.add('hidden');
    document.getElementById('mainContent').classList.remove('hidden');

    const isGestao = (userData.nivel === 'Coordenação GS' || userData.nivel === 'Gerência GS');

    document.getElementById('dashTitle').innerHTML = isGestao ? `<i class="fa-solid fa-user-shield text-emerald-600 mr-2"></i> Painel da Gestão` : `<i class="fa-solid fa-plane-departure text-emerald-600 mr-2"></i> Minhas Viagens`;
    document.getElementById('dashSubtitle').textContent = isGestao ? "Acompanhe e autorize reembolsos organizados por sigla da loja." : "Receba viagens criadas pela coordenação e envie seus comprovantes.";

    const btnArea = document.getElementById('dashActionButtons');
    btnArea.innerHTML = '';

    if (isGestao) {
        document.getElementById('secaoCarteiraSuporte').classList.add('hidden');
        btnArea.innerHTML = `<button onclick="abrirModalCriarViagem()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-4 rounded shadow text-sm transition"><i class="fa-solid fa-plus mr-2"></i> Criar Número da Viagem</button>`;
        carregarUsuariosParaSelect();
    } else {
        document.getElementById('secaoCarteiraSuporte').classList.remove('hidden');
        carregarCarteiraSuporte();
    }

    const r = await fetchAPI({ action: 'getDespesasViagens', login: userData.login, nivel: userData.nivel });
    if (r && r.success) {
        viagensGlobais = r.viagens;
        renderFiltrosSiglas();
        renderViagensGrid();
    }
}

// ==== Filtro de Lojas (Siglas) ====
function renderFiltrosSiglas() {
    const div = document.getElementById('filtroSiglasLojas');
    div.innerHTML = '';
    const siglas = ["TODAS"];
    viagensGlobais.forEach(v => { if (!siglas.includes(v.sigla)) siglas.push(v.sigla); });
    siglas.forEach(s => {
        const active = (filtroLojaSelecionada === s) ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100 border';
        div.innerHTML += `<button onclick="filtrarPorLoja('${s}')" class="${active} px-4 py-1.5 rounded-full font-bold text-xs shadow-sm transition uppercase whitespace-nowrap">${s}</button>`;
    });
}

function filtrarPorLoja(sigla) {
    filtroLojaSelecionada = sigla;
    renderFiltrosSiglas();
    renderViagensGrid();
}

function renderViagensGrid() {
    const grid = document.getElementById('gridViagens');
    grid.innerHTML = '';

    let lista = viagensGlobais;
    if (filtroLojaSelecionada !== "TODAS") {
        lista = lista.filter(v => v.sigla === filtroLojaSelecionada);
    }

    if (lista.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-10 bg-white border border-dashed rounded text-slate-400"><i class="fa-solid fa-folder-open text-3xl mb-2"></i><br>Nenhuma viagem encontrada para este filtro.</div>`;
        return;
    }

    lista.forEach(v => {
        let badge = 'bg-slate-100 text-slate-600';
        if (v.status === 'ABERTO') badge = 'bg-blue-100 text-blue-700 border-blue-200';
        if (v.status === 'PENDENTE') badge = 'bg-amber-100 text-amber-700 border-amber-200';
        if (v.status === 'SOLICITAR CORRECAO') badge = 'bg-red-100 text-red-700 border-red-200';
        if (v.status === 'FECHADA' || v.status === 'ARQUIVADA') badge = 'bg-emerald-100 text-emerald-700 border-emerald-200';
        if (v.status === 'CANCELADO') badge = 'bg-slate-200 text-slate-500 line-through';

        grid.innerHTML += `
            <div onclick="abrirViagemDetalhe('${v.idViagem}')" class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-emerald-400 cursor-pointer transition flex flex-col justify-between">
                <div>
                    <div class="flex justify-between items-start mb-2">
                        <span class="bg-slate-900 text-emerald-400 px-3 py-1 rounded text-xs font-black uppercase tracking-wider">${v.sigla}</span>
                        <span class="${badge} text-[10px] font-bold px-2 py-0.5 rounded border uppercase">${v.status}</span>
                    </div>
                    <h3 class="text-base font-bold text-slate-800 line-clamp-2 mt-2" title="${v.motivo}">${v.motivo}</h3>
                </div>
                <div class="mt-4 pt-3 border-t text-xs text-slate-500 flex justify-between items-end">
                    <div>
                        <p class="text-[11px]">Solicitou: <b>${v.criadoPor}</b></p>
                        <p class="text-[11px]">Técnico: <b>${v.colaborador}</b></p>
                    </div>
                    <span class="text-emerald-600 font-bold text-xs"><i class="fa-solid fa-paperclip"></i> ${v.itens.length} despesa(s)</span>
                </div>
            </div>
        `;
    });
}

// ==================== FLUXO DA COORDENAÇÃO ====================
async function carregarUsuariosParaSelect() {
    const r = await fetchAPI({ action: 'getUsers' });
    if (r.success) {
        const sel = document.getElementById('novaViagemColaborador');
        sel.innerHTML = '<option value="">Selecione o técnico...</option>';
        r.users.forEach(u => { sel.innerHTML += `<option value="${u.login}">${u.nome} (${u.login})</option>`; });
    }
}

function abrirModalCriarViagem() { document.getElementById('modalCriarViagem').classList.remove('hidden'); }

async function confirmarCriarViagem() {
    const sigla = document.getElementById('novaViagemSigla').value.trim().toUpperCase();
    const motivo = document.getElementById('novaViagemMotivo').value.trim();
    const colab = document.getElementById('novaViagemColaborador').value;

    if (!sigla || !motivo || !colab) { showToast('Preencha a sigla, o motivo e o colaborador!', 'warning'); return; }

    const r = await fetchAPI({
        action: 'createDespesaViagem',
        sigla: sigla,
        motivo: motivo,
        colaborador: colab,
        criadoPor: userData.login,
        nivel: userData.nivel
    }, 'btnCriarViagem');

    if (r.success) {
        document.getElementById('modalCriarViagem').classList.add('hidden');
        showToast('Viagem gerada e enviada ao colaborador!', 'success');
        recarregarDashboard();
    } else {
        showToast(r.message || 'Não foi possível criar a viagem.', 'error');
    }
}

// ==================== FLUXO DO SUPORTE (CARTEIRA E OCR) ====================
async function carregarCarteiraSuporte() {
    const r = await fetchAPI({ action: 'getCarteiraComprovantes', login: userData.login });
    const tb = document.getElementById('tbCarteira');
    tb.innerHTML = '';

    if (r && r.success) {
        carteiraGlobais = r.comprovantes;
        if (r.apagadosPorValidade > 0) showToast(`${r.apagadosPorValidade} comprovante(s) foram apagados após 30 dias sem uso.`, 'info');

        if (carteiraGlobais.length === 0) {
            tb.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">Nenhum comprovante guardado na carteira.</td></tr>';
            return;
        }

        carteiraGlobais.forEach(c => {
            const diasVenc = 30 - Math.floor((new Date() - new Date(c.dataUpload)) / (1000 * 60 * 60 * 24));
            const temFoto = !!c.urlComprovante;

            tb.innerHTML += `
                <tr class="hover:bg-slate-50 border-b">
                    <td class="px-4 py-3 text-xs font-mono">${formatarDataVisao(c.dataDespesa)} às ${c.horaDespesa || ''}</td>
                    <td class="px-4 py-3 text-xs font-bold text-slate-700">${c.categoria || ''}</td>
                    <td class="px-4 py-3 text-xs font-bold uppercase text-slate-500">${c.lojaDebito || ''}</td>
                    <td class="px-4 py-3 text-xs font-bold text-emerald-600">R$ ${Number(c.valor || 0).toFixed(2).replace('.', ',')}</td>
                    <td class="px-4 py-3 text-xs text-center">
                        <div class="flex flex-col items-center gap-1">
                            <span class="text-amber-600 font-bold">${diasVenc} dia(s) restante(s)</span>
                            ${temFoto ? '<span class="text-emerald-600 font-bold text-[10px]"><i class="fa-solid fa-image"></i> Foto anexada</span>' : '<span class="text-slate-400 text-[10px]">Sem foto</span>'}
                        </div>
                    </td>
                </tr>
            `;
        });
    }
}

function abrirModalOCR() {
    document.getElementById('modalOCR').classList.remove('hidden');
    document.getElementById('ocrForm').classList.add('hidden');
    document.getElementById('btnSalvarNota').classList.add('hidden');
    document.getElementById('fileOCR').value = "";

    document.getElementById('ocrData').value = '';
    document.getElementById('ocrHora').value = '';
    document.getElementById('ocrValor').value = '';
    document.getElementById('ocrLoja').value = '';
    document.getElementById('ocrCategoria').value = '';

    ocrImagemBase64 = '';
    ocrMimeType = 'image/jpeg';
    ocrTextoExtraido = '';

    const previewContainer = document.getElementById('ocrPreviewContainer');
    const preview = document.getElementById('ocrPreview');
    if (previewContainer) previewContainer.classList.add('hidden');
    if (preview) preview.src = '';
}

async function processarOCR(event) {
    const file = event.target.files[0];
    if (!file) return;

    ocrTextoExtraido = '';

    document.getElementById('ocrData').value = '';
    document.getElementById('ocrHora').value = '';
    document.getElementById('ocrValor').value = '';
    document.getElementById('ocrLoja').value = '';
    document.getElementById('ocrCategoria').value = '';

    document.getElementById('ocrLoader').classList.remove('hidden');
    document.getElementById('ocrForm').classList.add('hidden');
    document.getElementById('btnSalvarNota').classList.add('hidden');

    const previewContainer = document.getElementById('ocrPreviewContainer');
    const preview = document.getElementById('ocrPreview');
    if (previewContainer) previewContainer.classList.add('hidden');
    if (preview) preview.src = '';

    try {
        ocrImagemBase64 = await converterFileParaBase64(file);
        const matchMime = String(ocrImagemBase64).match(/^data:([^;]+);base64,/);
        ocrMimeType = matchMime ? matchMime[1] : (file.type || 'image/jpeg');

        if (preview && previewContainer) {
            preview.src = ocrImagemBase64;
            previewContainer.classList.remove('hidden');
        }

        try {
            const res = await Tesseract.recognize(file, 'por');
            ocrTextoExtraido = res.data.text || '';

            const dataDet = extrairDataDoTexto(ocrTextoExtraido);
            const horaDet = extrairHoraDoTexto(ocrTextoExtraido);
            const valorDet = extrairValorDoTexto(ocrTextoExtraido);

            document.getElementById('ocrData').value = dataDet;     // da foto
            document.getElementById('ocrHora').value = horaDet;      // da foto; vazio = manual
            document.getElementById('ocrValor').value = valorDet;    // valor pago formatado como número float 'XX.XX'
            // Loja e Categoria permanecem VAZIAS (manuais por padrão)

            const faltantes = [];
            if (!dataDet) faltantes.push('data');
            if (!horaDet) faltantes.push('hora');
            if (!valorDet) faltantes.push('valor pago');

            if (faltantes.length > 0) {
                showToast(`Não foi possível ler: ${faltantes.join(', ')}. Preencha manualmente. (Categoria e Loja são sempre manuais.)`, 'warning');
            } else {
                showToast('Data, hora e valor pago lidos da foto. Confira e preencha Categoria e Loja.', 'success');
            }
        } catch (erroOcr) {
            showToast('Falha na leitura automática (OCR). Preencha os dados manualmente.', 'warning');
        }
    } catch (erroArquivo) {
        ocrImagemBase64 = '';
        showToast('Erro ao carregar a imagem para envio.', 'error');
    } finally {
        document.getElementById('ocrLoader').classList.add('hidden');
        document.getElementById('ocrForm').classList.remove('hidden');
        document.getElementById('btnSalvarNota').classList.remove('hidden');
    }
}

async function salvarNotaNaCarteira() {
    const valorRaw = document.getElementById('ocrValor').value;
    const loja = document.getElementById('ocrLoja').value.trim();
    const categoria = document.getElementById('ocrCategoria').value;

    if (!ocrImagemBase64) { showToast('Envie ou tire a foto do comprovante antes de guardar.', 'warning'); return; }
    if (!valorRaw) { showToast('Informe o Valor pago da despesa.', 'warning'); return; }
    if (!loja) { showToast('Informe a Sigla da Loja que será debitada!', 'warning'); return; }
    if (!categoria) { showToast('Selecione a Categoria da despesa.', 'warning'); return; }

    let dataDespesa = document.getElementById('ocrData').value.trim();
    if (!dataDespesa) dataDespesa = new Date().toLocaleDateString('pt-BR');

    const horaDespesa = document.getElementById('ocrHora').value.trim(); // pode ficar vazio (manual)
    const valorNumerico = parseFloat(String(valorRaw).replace(',', '.')) || 0;

    const data = {
        action: 'saveComprovante',
        login: userData.login,
        dataDespesa: dataDespesa,
        horaDespesa: horaDespesa,
        valor: valorNumerico,
        lojaDebito: loja,
        categoria: categoria,
        ocrConteudo: String(ocrTextoExtraido || '').slice(0, 5000),
        imagemBase64: ocrImagemBase64,
        mimeType: ocrMimeType
    };

    const r = await fetchAPI(data, 'btnSalvarNota');

    if (r && r.success) {
        document.getElementById('modalOCR').classList.add('hidden');
        if (r.urlComprovante) showToast('Comprovante e imagem salvos no Google Drive!', 'success');
        else showToast('Comprovante salvo, mas a imagem não foi anexada ao Drive. Verifique permissões/publicação.', 'warning');

        ocrImagemBase64 = '';
        ocrMimeType = 'image/jpeg';
        ocrTextoExtraido = '';
        carregarCarteiraSuporte();
    } else {
        showToast(r.message || 'Falha ao salvar comprovante.', 'error');
    }
}

// ==================== VISUALIZAÇÃO DETALHADA E PRESTAÇÃO DE CONTAS ====================
function abrirViagemDetalhe(id) {
    viagemAtual = viagensGlobais.find(v => v.idViagem === id);
    if (!viagemAtual) return;

    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('viagemDetalheView').classList.remove('hidden');

    document.getElementById('detalheLojaSigla').textContent = `LOJA: ${viagemAtual.sigla}`;
    document.getElementById('detalheMotivo').textContent = viagemAtual.motivo;
    document.getElementById('detalheParticipantes').textContent = `Solicitado por: ${viagemAtual.criadoPor} | Responsável: ${viagemAtual.colaborador}`;

    let badge = 'bg-slate-800 text-white';
    if (viagemAtual.status === 'PENDENTE') badge = 'bg-amber-500 text-white';
    if (viagemAtual.status === 'FECHADA' || viagemAtual.status === 'ARQUIVADA') badge = 'bg-emerald-500 text-white';
    if (viagemAtual.status === 'SOLICITAR CORRECAO') badge = 'bg-red-500 text-white';
    document.getElementById('detalheStatusBadge').innerHTML = `<span class="${badge} font-bold px-4 py-1.5 rounded text-xs uppercase shadow">${viagemAtual.status}</span>`;

    renderAcoesViagem();
    renderItensViagem();
}

function renderAcoesViagem() {
    const area = document.getElementById('painelAcoesViagem');
    area.innerHTML = '';

    const isGestao = (userData.nivel === 'Coordenação GS' || userData.nivel === 'Gerência GS');
    const isColab = (String(viagemAtual.colaborador).toLowerCase() === String(userData.login).toLowerCase());

    if (isColab && (viagemAtual.status === 'ABERTO' || viagemAtual.status === 'SOLICITAR CORRECAO')) {
        area.innerHTML += `
            <button onclick="abrirModalAnexarTickets()" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-paperclip mr-2"></i> Inserir Tickets Guardados</button>
        `;
        if (viagemAtual.itens.length > 0) {
            area.innerHTML += `
                <button onclick="enviarDespesasViagem()" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow ml-auto"><i class="fa-solid fa-paper-plane mr-2"></i> Enviar Despesas da Viagem</button>
            `;
        }
    }

    if (isGestao) {
        if (viagemAtual.status === 'PENDENTE') {
            area.innerHTML += `
                <button onclick="alterarStatusViagem('FECHADA')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-check mr-2"></i> Fechar Viagem</button>
                <button onclick="alterarStatusViagem('SOLICITAR CORRECAO')" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-arrow-rotate-left mr-2"></i> Solicitar Correção</button>
            `;
        }
        if (viagemAtual.status === 'FECHADA') {
            area.innerHTML += `<button onclick="alterarStatusViagem('ARQUIVADA')" class="bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-box-archive mr-2"></i> Arquivar Viagem</button>`;
        }
        area.innerHTML += `<button onclick="excluirViagem()" class="bg-red-600 hover:bg-red-700 text-white text-xs font-bold py-2 px-4 rounded shadow ml-auto"><i class="fa-solid fa-trash mr-2"></i> Excluir Viagem</button>`;
    }
}

function renderItensViagem() {
    const tb = document.getElementById('tbItensViagem');
    tb.innerHTML = '';

    const isColab = (String(viagemAtual.colaborador).toLowerCase() === String(userData.login).toLowerCase());
    const isGestao = (userData.nivel === 'Coordenação GS' || userData.nivel === 'Gerência GS');
    const podeVerComprovante = isGestao || isColab;
    const emEdicao = (viagemAtual.status === 'ABERTO' || viagemAtual.status === 'SOLICITAR CORRECAO');

    let total = 0;

    if (viagemAtual.itens.length === 0) {
        tb.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-slate-400">Nenhum ticket anexado a esta viagem.</td></tr>';
        document.getElementById('detalheTotalValor').textContent = 'R$ 0,00';
        return;
    }

    viagemAtual.itens.sort((a, b) => chaveDataOrdenacao(a.dataDespesa) - chaveDataOrdenacao(b.dataDespesa));

    viagemAtual.itens.forEach(item => {
        total += Number(item.valor || 0);

        let btnAcao = '';
        if (isColab && emEdicao) {
            btnAcao = `<button onclick="removerItemViagem('${item.idComprovante}')" class="text-red-500 hover:text-red-700" title="Remover ticket"><i class="fa-solid fa-trash"></i></button>`;
        }

        let celulaComprovante = '<td class="px-4 py-3 text-xs text-center text-slate-300">—</td>';

        if (podeVerComprovante) {
            if (item.urlComprovante) {
                const thumb = montarUrlThumbnailDrive(item.urlComprovante);
                const urlHtml = escaparAtributoHtml(item.urlComprovante);
                celulaComprovante = `
                    <td class="px-4 py-3 text-xs">
                        <div class="flex items-center gap-3">
                            <img src="${thumb}" alt="Comprovante" loading="lazy" class="h-12 w-12 object-cover rounded border cursor-pointer bg-slate-100" data-url="${urlHtml}" onclick="abrirComprovante(this.dataset.url)" onerror="this.style.display='none'">
                            <div class="flex flex-col gap-1">
                                <button type="button" class="text-[10px] font-bold text-blue-600 hover:text-blue-800" data-url="${urlHtml}" onclick="abrirComprovante(this.dataset.url)"><i class="fa-solid fa-eye mr-1"></i> Ver</button>
                                <button type="button" class="text-[10px] font-bold text-emerald-600 hover:text-emerald-800" data-url="${urlHtml}" onclick="baixarComprovante(this.dataset.url)"><i class="fa-solid fa-download mr-1"></i> Baixar</button>
                            </div>
                        </div>
                    </td>
                `;
            } else {
                celulaComprovante = '<td class="px-4 py-3 text-xs text-center text-amber-600 font-bold">Sem imagem</td>';
            }
        }

        tb.innerHTML += `
            <tr class="hover:bg-slate-50 border-b">
                <td class="px-4 py-3 text-xs">${formatarDataVisao(item.dataDespesa)}</td>
                <td class="px-4 py-3 text-xs font-mono">${item.horaDespesa || ''}</td>
                <td class="px-4 py-3 text-xs font-bold text-slate-700">${item.categoria || ''}</td>
                <td class="px-4 py-3 text-xs uppercase font-bold text-slate-500">${item.lojaDebito || ''}</td>
                <td class="px-4 py-3 text-xs text-right font-bold text-emerald-600">R$ ${Number(item.valor || 0).toFixed(2).replace('.', ',')}</td>
                ${celulaComprovante}
                <td class="px-4 py-3 text-xs text-center">${btnAcao}</td>
            </tr>
        `;
    });

    document.getElementById('detalheTotalValor').textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
}

async function abrirModalAnexarTickets() {
    const r = await fetchAPI({ action: 'getCarteiraComprovantes', login: userData.login });
    const div = document.getElementById('listaTicketsDisponiveis');
    div.innerHTML = '';

    if (r && r.success && r.comprovantes.length > 0) {
        r.comprovantes.forEach(c => {
            const temFoto = !!c.urlComprovante;
            div.innerHTML += `
                <label class="flex items-center gap-3 p-2 bg-white rounded border cursor-pointer hover:border-blue-400">
                    <input type="checkbox" value="${c.idComprovante}" class="chk-ticket h-4 w-4 accent-blue-600">
                    <div class="text-xs">
                        <span class="font-bold text-slate-800">${c.categoria || ''}</span> (${formatarDataVisao(c.dataDespesa)} às ${c.horaDespesa || ''})
                        <span class="block text-[10px] text-slate-500">Debitar: <b>${c.lojaDebito || ''}</b> | R$ ${Number(c.valor || 0).toFixed(2).replace('.', ',')} ${temFoto ? '| <span class="text-emerald-600 font-bold">Foto ok</span>' : '| <span class="text-amber-600 font-bold">Sem foto</span>'}</span>
                    </div>
                </label>
            `;
        });
        document.getElementById('modalAnexarTickets').classList.remove('hidden');
    } else {
        showToast('Sua carteira temporária não possui comprovantes salvos.', 'info');
    }
}

async function confirmarAnexoTickets() {
    const checks = document.querySelectorAll('.chk-ticket:checked');
    const ids = Array.from(checks).map(c => c.value);
    if (ids.length === 0) { showToast('Selecione ao menos um ticket!', 'warning'); return; }

    const r = await fetchAPI({ action: 'linkComprovantesToViagem', idViagem: viagemAtual.idViagem, comprovantesIds: ids, login: userData.login }, 'btnConfirmarAnexos');
    if (r.success) {
        document.getElementById('modalAnexarTickets').classList.add('hidden');
        showToast('Tickets vinculados à viagem!', 'success');
        recarregarDashboard();
    } else {
        showToast(r.message || 'Falha ao vincular tickets.', 'error');
    }
}

async function removerItemViagem(idComp) {
    if (!await showConfirm("Devolver este ticket para sua carteira temporária?")) return;
    const r = await fetchAPI({ action: 'removeComprovanteFromViagem', idComprovante: idComp, login: userData.login });
    if (r.success) { showToast('Ticket removido.', 'info'); recarregarDashboard(); }
    else showToast(r.message || 'Não foi possível remover o ticket.', 'error');
}

async function enviarDespesasViagem() {
    if (!await showConfirm("Enviar todas as despesas para a coordenação aprovar?", { type: 'info' })) return;
    const r = await fetchAPI({ action: 'updateDespesaStatus', idViagem: viagemAtual.idViagem, status: 'PENDENTE', login: userData.login, nivel: userData.nivel });
    if (r.success) { showToast('Prestação enviada com sucesso!', 'success'); recarregarDashboard(); }
    else showToast(r.message || 'Falha ao enviar prestação.', 'error');
}

async function alterarStatusViagem(novoStatus) {
    const r = await fetchAPI({ action: 'updateDespesaStatus', idViagem: viagemAtual.idViagem, status: novoStatus, login: userData.login, nivel: userData.nivel });
    if (r.success) { showToast(`Status alterado para ${novoStatus}!`, 'success'); recarregarDashboard(); }
    else showToast(r.message || 'Falha ao alterar status.', 'error');
}

async function excluirViagem() {
    if (!await showConfirm("Excluir esta viagem permanentemente?", { type: 'danger' })) return;
    const r = await fetchAPI({ action: 'deleteDespesaViagem', idViagem: viagemAtual.idViagem, login: userData.login, nivel: userData.nivel });
    if (r.success) { showToast('Viagem excluída.', 'success'); recarregarDashboard(); }
    else showToast(r.message || 'Falha ao excluir viagem.', 'error');
}

function voltarDashboard() { recarregarDashboard(); }

// ==================== RECUPERAR SENHA ====================
function abrirModalRecuperar() { document.getElementById('modalRecuperar').classList.remove('hidden'); }
let userRecupLogin = null;
async function buscarUsuariosRecup() {
    const q = document.getElementById('recupLoginInput').value;
    if (q.length < 2) return;
    const r = await fetchAPI({ action: 'searchUsers', query: q });
    const div = document.getElementById('recupListaUsers'); div.innerHTML = '';
    if (r.success) {
        r.users.forEach(u => {
            div.innerHTML += `<button onclick="selecionarUserRecup('${u.login}', '${u.nome}')" class="w-full text-left p-2 border-b text-xs hover:bg-emerald-50"><b>${u.nome}</b> (${u.login})</button>`;
        });
    }
}
function selecionarUserRecup(login, nome) {
    userRecupLogin = login;
    document.getElementById('recupUserSelected').textContent = `Usuário: ${nome} (${login})`;
    document.getElementById('recupStep1').classList.add('hidden');
    document.getElementById('recupStep2').classList.remove('hidden');
}
async function confirmarRedefinirSenha() {
    const nova = document.getElementById('recupNovaSenha').value;
    const r = await fetchAPI({ action: 'resetPassword', login: userRecupLogin, novaSenha: nova }, 'btnRedefinir');
    if (r.success) {
        showToast('Senha redefinida com sucesso!', 'success');
        document.getElementById('modalRecuperar').classList.add('hidden');
    } else {
        showToast(r.message || 'Falha ao redefinir senha.', 'error');
    }
}
