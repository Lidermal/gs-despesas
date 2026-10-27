// URL do Google Apps Script (Sua WebApp da planilha)
const API_URL = "https://script.google.com/macros/s/AKfycbyv6rztF_a5ePHzRhzCMJDawDOHhF-le_3MgvoeMY2WUGjVRQBPmt2cSuV6Mp71MGnpUQ/exec";

const TEMPO_SESSAO_MS = 4 * 60 * 60 * 1000;

let userData = null;
let viagensGlobais = [];
let carteiraGlobais = [];
let viagemAtual = null;
let filtroLojaSelecionada = "TODAS";

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

function logout() {
    localStorage.removeItem('usuarioDespesasAtivo');
    localStorage.removeItem('loginDespesasTimestamp');
    userData = null;
    document.getElementById('globalHeader').classList.add('hidden');
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('viagemDetalheView').classList.add('hidden');
    document.getElementById('authView').classList.remove('hidden');
}

function showToast(message, type = 'info', title = null, duration = 4000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    const titles = { success: 'Sucesso', error: 'Erro', warning: 'Atenção', info: 'Informação' };
    toast.innerHTML = `<div class="toast-icon"><i class="fa-solid ${icons[type]}"></i></div><div class="toast-content"><div class="toast-title">${title || titles[type]}</div><div class="toast-message">${message}</div></div><button class="toast-close" onclick="this.parentElement.remove()"><i class="fa-solid fa-xmark"></i></button>`;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); }, duration);
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
    if(btn) { btn.disabled = true; if(textId) document.getElementById(textId).innerHTML = '<span class="loader-small"></span> Aguarde...'; }
    try {
        const response = await fetch(API_URL, { method: 'POST', body: JSON.stringify(data) });
        return await response.json();
    } catch (e) {
        showToast('Erro de Conexão com o Banco.', 'error');
        return { success: false };
    } finally {
        if(btn) { btn.disabled = false; if(textId) document.getElementById(textId).innerHTML = originalText; }
    }
}

// ==================== CONTROLE DE AUTH ====================
function toggleAuthView(v) {
    if(v==='register') { document.getElementById('loginSection').classList.add('hidden'); document.getElementById('registerSection').classList.remove('hidden'); }
    else { document.getElementById('registerSection').classList.add('hidden'); document.getElementById('loginSection').classList.remove('hidden'); }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await fetchAPI({ action: 'login', login: document.getElementById('loginUser').value.trim(), senha: document.getElementById('loginSenha').value }, 'btnLogin', 'loginText', 'Acessar Despesas <i class="fa-solid fa-arrow-right-to-bracket ml-2"></i>');
    if(r && r.success) {
        localStorage.setItem('usuarioDespesasAtivo', JSON.stringify(r.user));
        localStorage.setItem('loginDespesasTimestamp', Date.now().toString());
        userData = r.user;
        iniciarSistema();
    } else { showToast(r.message || 'Credenciais incorretas', 'error'); }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = { action: 'register', nome: document.getElementById('regNome').value, sobrenome: document.getElementById('regSobrenome').value, equipe: document.getElementById('regEquipe').value, nivel: document.getElementById('regNivel').value, senha: document.getElementById('regSenha').value };
    const r = await fetchAPI(data, 'btnRegister', 'regText', '<i class="fa-solid fa-save mr-2"></i> Cadastrar');
    if(r && r.success) { showToast(`Usuário criado: ${r.login}`, 'success'); toggleAuthView('login'); }
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
        btnArea.innerHTML = `<button onclick="abrirModalCriarViagem()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-4 rounded shadow text-sm transition"><i class="fa-solid fa-plus mr-2"></i> Criar Número da Viagem</button>`;
        carregarUsuariosParaSelect();
    } else {
        document.getElementById('secaoCarteiraSuporte').classList.remove('hidden');
        carregarCarteiraSuporte();
    }

    // Busca viagens no banco
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
    viagensGlobais.forEach(v => { if(!siglas.includes(v.sigla)) siglas.push(v.sigla); });

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
    if(filtroLojaSelecionada !== "TODAS") {
        lista = lista.filter(v => v.sigla === filtroLojaSelecionada);
    }

    if(lista.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-10 bg-white border border-dashed rounded text-slate-400"><i class="fa-solid fa-folder-open text-3xl mb-2"></i><br>Nenhuma viagem encontrada para este filtro.</div>`;
        return;
    }

    lista.forEach(v => {
        let badge = 'bg-slate-100 text-slate-600';
        if(v.status === 'ABERTO') badge = 'bg-blue-100 text-blue-700 border-blue-200';
        if(v.status === 'PENDENTE') badge = 'bg-amber-100 text-amber-700 border-amber-200';
        if(v.status === 'SOLICITAR CORRECAO') badge = 'bg-red-100 text-red-700 border-red-200';
        if(v.status === 'FECHADA' || v.status === 'ARQUIVADA') badge = 'bg-emerald-100 text-emerald-700 border-emerald-200';
        if(v.status === 'CANCELADO') badge = 'bg-slate-200 text-slate-500 line-through';

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
    if(r.success) {
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

    if(!sigla || !motivo || !colab) { showToast('Preencha a sigla, o motivo e o colaborador!', 'warning'); return; }

    const r = await fetchAPI({ action: 'createDespesaViagem', sigla: sigla, motivo: motivo, colaborador: colab, criadoPor: userData.login }, 'btnCriarViagem');
    if(r.success) {
        document.getElementById('modalCriarViagem').classList.add('hidden');
        showToast('Viagem gerada e enviada ao colaborador!', 'success');
        recarregarDashboard();
    }
}


// ==================== FLUXO DO SUPORTE (CARTEIRA E OCR) ====================
async function carregarCarteiraSuporte() {
    const r = await fetchAPI({ action: 'getCarteiraComprovantes', login: userData.login });
    const tb = document.getElementById('tbCarteira');
    tb.innerHTML = '';

    if(r && r.success) {
        carteiraGlobais = r.comprovantes;
        if(r.apagadosPorValidade > 0) showToast(`${r.apagadosPorValidade} comprovante(s) foram apagados após 30 dias sem uso.`, 'info');

        if(carteiraGlobais.length === 0) {
            tb.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">Nenhum comprovante guardado na carteira.</td></tr>';
            return;
        }

        carteiraGlobais.forEach(c => {
            const diasVenc = 30 - Math.floor((new Date() - new Date(c.dataUpload)) / (1000 * 60 * 60 * 24));
            tb.innerHTML += `
                <tr class="hover:bg-slate-50 border-b">
                    <td class="px-4 py-3 text-xs font-mono">${c.dataDespesa} às ${c.horaDespesa}</td>
                    <td class="px-4 py-3 text-xs font-bold text-slate-700">${c.categoria}</td>
                    <td class="px-4 py-3 text-xs font-bold uppercase text-slate-500">${c.lojaDebito}</td>
                    <td class="px-4 py-3 text-xs font-bold text-emerald-600">R$ ${Number(c.valor).toFixed(2).replace('.',',')}</td>
                    <td class="px-4 py-3 text-xs text-center text-amber-600 font-bold">${diasVenc} dia(s) restante(s)</td>
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
}

async function processarOCR(event) {
    const file = event.target.files[0];
    if(!file) return;

    document.getElementById('ocrLoader').classList.remove('hidden');
    document.getElementById('ocrForm').classList.add('hidden');

    try {
        const res = await Tesseract.recognize(file, 'por');
        const text = res.data.text;

        // Tenta extrair hora, data e valores por Regex
        const horaMatch = text.match(/\b([0-1]?[0-9]|2[0-3]):[0-5][0-9]\b/);
        const dataMatch = text.match(/\b\d{2}\/\d{2}\/\d{2,4}\b/);
        const valorMatch = text.match(/(?:R\$|VALOR|TOTAL)?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i);

        document.getElementById('ocrHora').value = horaMatch ? horaMatch[0] : '';
        document.getElementById('ocrData').value = dataMatch ? dataMatch[0] : new Date().toLocaleDateString('pt-BR');
        document.getElementById('ocrValor').value = valorMatch ? valorMatch[1].replace('.','').replace(',','.') : '';
        document.getElementById('ocrLoja').value = '';

        atualizarCategoriaPorHorario();

        document.getElementById('ocrLoader').classList.add('hidden');
        document.getElementById('ocrForm').classList.remove('hidden');
        document.getElementById('btnSalvarNota').classList.remove('hidden');
        showToast('Foto lida com sucesso! Confira e ajuste os dados.', 'success');
    } catch(e) {
        document.getElementById('ocrLoader').classList.add('hidden');
        showToast('Não foi possível ler os dados automaticamente. Preencha manualmente.', 'warning');
        document.getElementById('ocrForm').classList.remove('hidden');
        document.getElementById('btnSalvarNota').classList.remove('hidden');
    }
}

function atualizarCategoriaPorHorario() {
    const h = document.getElementById('ocrHora').value;
    if(!h) return;
    const [hrs, mins] = h.split(':').map(Number);
    const mTotal = hrs * 60 + (mins || 0);

    let cat = 'Outros';
    if(mTotal >= 300 && mTotal <= 599) cat = 'Café da Manhã';       // 05:00 - 09:59
    else if(mTotal >= 600 && mTotal <= 689) cat = 'Lanche da Manhã';  // 10:00 - 11:29
    else if(mTotal >= 690 && mTotal <= 870) cat = 'Almoço';           // 11:30 - 14:30
    else if(mTotal >= 871 && mTotal <= 1079) cat = 'Lanche da Tarde'; // 14:31 - 17:59
    else if(mTotal >= 1080 && mTotal <= 1260) cat = 'Janta';          // 18:00 - 21:00
    else if(mTotal >= 1261 || mTotal <= 299) cat = 'Lanche da Noite'; // 21:01 - 04:59

    document.getElementById('ocrCategoria').value = cat;
}

async function salvarNotaNaCarteira() {
    const data = {
        action: 'saveComprovante',
        login: userData.login,
        dataDespesa: document.getElementById('ocrData').value,
        horaDespesa: document.getElementById('ocrHora').value,
        valor: document.getElementById('ocrValor').value,
        lojaDebito: document.getElementById('ocrLoja').value,
        categoria: document.getElementById('ocrCategoria').value,
        ocrConteudo: 'Lido via OCR'
    };

    if(!data.valor || !data.lojaDebito) { showToast('Informe o Valor e a Sigla da Loja que será debitada!', 'warning'); return; }

    const r = await fetchAPI(data, 'btnSalvarNota');
    if(r.success) {
        document.getElementById('modalOCR').classList.add('hidden');
        showToast('Comprovante guardado na sua carteira!', 'success');
        carregarCarteiraSuporte();
    }
}


// ==================== VISUALIZAÇÃO DETALHADA E PRESTAÇÃO DE CONTAS ====================
function abrirViagemDetalhe(id) {
    viagemAtual = viagensGlobais.find(v => v.idViagem === id);
    if(!viagemAtual) return;

    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('viagemDetalheView').classList.remove('hidden');

    document.getElementById('detalheLojaSigla').textContent = `LOJA: ${viagemAtual.sigla}`;
    document.getElementById('detalheMotivo').textContent = viagemAtual.motivo;
    document.getElementById('detalheParticipantes').textContent = `Solicitado por: ${viagemAtual.criadoPor} | Responsável: ${viagemAtual.colaborador}`;

    // Badge Status
    let badge = 'bg-slate-800 text-white';
    if(viagemAtual.status === 'PENDENTE') badge = 'bg-amber-500 text-white';
    if(viagemAtual.status === 'FECHADA' || viagemAtual.status === 'ARQUIVADA') badge = 'bg-emerald-500 text-white';
    if(viagemAtual.status === 'SOLICITAR CORRECAO') badge = 'bg-red-500 text-white';
    document.getElementById('detalheStatusBadge').innerHTML = `<span class="${badge} font-bold px-4 py-1.5 rounded text-xs uppercase shadow">${viagemAtual.status}</span>`;

    renderAcoesViagem();
    renderItensViagem();
}

function renderAcoesViagem() {
    const area = document.getElementById('painelAcoesViagem');
    area.innerHTML = '';

    const isGestao = (userData.nivel === 'Coordenação GS' || userData.nivel === 'Gerência GS');
    const isColab = (String(viagemAtual.colaborador).toLowerCase() === String(userData.login).toLowerCase());

    // AÇÕES DO TÉCNICO (SUPORTE)
    if (isColab && (viagemAtual.status === 'ABERTO' || viagemAtual.status === 'SOLICITAR CORRECAO')) {
        area.innerHTML += `
            <button onclick="abrirModalAnexarTickets()" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-2 px-4 rounded shadow"><i class="fa-solid fa-paperclip mr-2"></i> Inserir Tickets Guardados</button>
        `;
        if(viagemAtual.itens.length > 0) {
            area.innerHTML += `
                <button onclick="enviarDespesasViagem()" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 px-4 rounded shadow ml-auto"><i class="fa-solid fa-paper-plane mr-2"></i> Enviar Despesas da Viagem</button>
            `;
        }
    }

    // AÇÕES DA COORDENAÇÃO E GERÊNCIA
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
    const emEdicao = (viagemAtual.status === 'ABERTO' || viagemAtual.status === 'SOLICITAR CORRECAO');

    let total = 0;

    if(viagemAtual.itens.length === 0) {
        tb.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-slate-400">Nenhum ticket anexado a esta viagem.</td></tr>';
        document.getElementById('detalheTotalValor').textContent = 'R$ 0,00';
        return;
    }

    // ORDENAR POR DATA CRESCENTE (conforme solicitado)
    viagemAtual.itens.sort((a,b) => {
        const da = a.dataDespesa.split('/').reverse().join('-');
        const db = b.dataDespesa.split('/').reverse().join('-');
        return new Date(da) - new Date(db);
    });

    viagemAtual.itens.forEach(item => {
        total += Number(item.valor);
        let btnAcao = '';
        if (isColab && emEdicao) {
            btnAcao = `<button onclick="removerItemViagem('${item.idComprovante}')" class="text-red-500 hover:text-red-700" title="Remover ticket"><i class="fa-solid fa-trash"></i></button>`;
        }

        tb.innerHTML += `
            <tr class="hover:bg-slate-50 border-b">
                <td class="px-4 py-3 text-xs">${item.dataDespesa}</td>
                <td class="px-4 py-3 text-xs font-mono">${item.horaDespesa}</td>
                <td class="px-4 py-3 text-xs font-bold text-slate-700">${item.categoria}</td>
                <td class="px-4 py-3 text-xs uppercase font-bold text-slate-500">${item.lojaDebito}</td>
                <td class="px-4 py-3 text-xs text-right font-bold text-emerald-600">R$ ${Number(item.valor).toFixed(2).replace('.',',')}</td>
                <td class="px-4 py-3 text-xs text-center">${btnAcao}</td>
            </tr>
        `;
    });

    document.getElementById('detalheTotalValor').textContent = `R$ ${total.toFixed(2).replace('.',',')}`;
}

async function abrirModalAnexarTickets() {
    const r = await fetchAPI({ action: 'getCarteiraComprovantes', login: userData.login });
    const div = document.getElementById('listaTicketsDisponiveis');
    div.innerHTML = '';

    if(r && r.success && r.comprovantes.length > 0) {
        r.comprovantes.forEach(c => {
            div.innerHTML += `
                <label class="flex items-center gap-3 p-2 bg-white rounded border cursor-pointer hover:border-blue-400">
                    <input type="checkbox" value="${c.idComprovante}" class="chk-ticket h-4 w-4 accent-blue-600">
                    <div class="text-xs">
                        <span class="font-bold text-slate-800">${c.categoria}</span> (${c.dataDespesa} às ${c.horaDespesa})
                        <span class="block text-[10px] text-slate-500">Debitar: <b>${c.lojaDebito}</b> | R$ ${Number(c.valor).toFixed(2)}</span>
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

    if(ids.length === 0) { showToast('Selecione ao menos um ticket!', 'warning'); return; }

    const r = await fetchAPI({ action: 'linkComprovantesToViagem', idViagem: viagemAtual.idViagem, comprovantesIds: ids }, 'btnConfirmarAnexos');
    if(r.success) {
        document.getElementById('modalAnexarTickets').classList.add('hidden');
        showToast('Tickets vinculados à viagem!', 'success');
        recarregarDashboard();
    }
}

async function removerItemViagem(idComp) {
    if(!await showConfirm("Devolver este ticket para sua carteira temporária?")) return;
    const r = await fetchAPI({ action: 'removeComprovanteFromViagem', idComprovante: idComp });
    if(r.success) { showToast('Ticket removido.', 'info'); recarregarDashboard(); }
}

async function enviarDespesasViagem() {
    if(!await showConfirm("Enviar todas as despesas para a coordenação aprovar?", { type: 'info' })) return;
    const r = await fetchAPI({ action: 'updateDespesaStatus', idViagem: viagemAtual.idViagem, status: 'PENDENTE' });
    if(r.success) { showToast('Prestação enviada com sucesso!', 'success'); recarregarDashboard(); }
}

async function alterarStatusViagem(novoStatus) {
    const r = await fetchAPI({ action: 'updateDespesaStatus', idViagem: viagemAtual.idViagem, status: novoStatus });
    if(r.success) { showToast(`Status alterado para ${novoStatus}!`, 'success'); recarregarDashboard(); }
}

async function excluirViagem() {
    if(!await showConfirm("Excluir esta viagem permanentemente?", { type: 'danger' })) return;
    const r = await fetchAPI({ action: 'deleteDespesaViagem', idViagem: viagemAtual.idViagem });
    if(r.success) { showToast('Viagem excluída.', 'success'); recarregarDashboard(); }
}

function voltarDashboard() { recarregarDashboard(); }

// ==================== RECUPERAR SENHA ====================
function abrirModalRecuperar() { document.getElementById('modalRecuperar').classList.remove('hidden'); }
let userRecupLogin = null;
async function buscarUsuariosRecup() {
    const q = document.getElementById('recupLoginInput').value;
    if(q.length < 2) return;
    const r = await fetchAPI({ action: 'searchUsers', query: q });
    const div = document.getElementById('recupListaUsers'); div.innerHTML = '';
    if(r.success) {
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
    if(r.success) {
        showToast('Senha redefinida com sucesso!', 'success');
        document.getElementById('modalRecuperar').classList.add('hidden');
    }
}
