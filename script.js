// ============================================================
// Anime Share P2P — com reconexão automática
// ============================================================

// ---------- Áudio ----------

let audioContext = null;
let audioWorkletNode = null;
let mediaStreamDestino = null;

async function configurarPipelineDeAudio() {
    audioContext = new AudioContext({ sampleRate: 48000 });
    mediaStreamDestino = audioContext.createMediaStreamDestination();

    await audioContext.audioWorklet.addModule('pcm-processor.js');
    audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
    audioWorkletNode.connect(mediaStreamDestino);

    window.electronAPI.onAudioChunk((buffer, meta) => {
        // Correção: Conversão segura do Buffer do IPC para Float32Array
        const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
        audioWorkletNode.port.postMessage({ samples: float32 });
    });
}

// ---------- Configuração ----------
const PREFIXO = 'animeshare-';
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TAMANHO_CODIGO = 5;
const MAX_BITRATE = 4_000_000;
const TIMEOUT_CONEXAO_MS = 10_000;

// Reconexão
const HEARTBEAT_MS = 3_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;
const RECONECTAR_BASE_MS = 1_000;
const RECONECTAR_MAX_MS = 15_000;
const MAX_TENTATIVAS = 10;

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

// ---------- Elementos ----------
const $ = id => document.getElementById(id);
const el = {
    myId: $('my-id'), btnCopy: $('btn-copy'), btnShare: $('btn-share'),
    btnConnect: $('btn-connect'), btnSound: $('btn-sound'), hostId: $('host-id'),
    video: $('video-player'), status: $('status'), viewers: $('viewers')
};

// ---------- Estado ----------
let peer = null, peerPronto = false, meuCodigo = '', papel = null;
let meuStream = null;
const chamadasAtivas = new Set();
const conexoesDados = new Set();

// Viewer
let hostConn = null, viewerCall = null, streamVazia = null;
let audioCtx = null, timeoutConexao = null;
let hostPeerIdAtual = null;

// Reconexão
let tentativasReconexao = 0;
let reconectando = false;
let heartbeatTimer = null;
let ultimoPong = 0;
let watchdogTimer = null;

// ---------- UI ----------
function setStatus(texto, tipo = '') {
    el.status.textContent = texto;
    el.status.className = tipo;
}

function atualizarUI() {
    const souHost = papel === 'host';
    const souViewer = papel === 'viewer';

    el.btnCopy.disabled = !peerPronto;
    el.btnShare.disabled = !peerPronto || souViewer;
    el.btnShare.textContent = souHost ? 'Parar transmissão' : '1. Compartilhar Tela (Host)';

    el.btnConnect.disabled = !peerPronto || souHost;
    el.btnConnect.textContent = souViewer ? 'Desconectar' : '2. Assistir (Viewer)';
    el.hostId.disabled = papel !== null;

    el.viewers.textContent = souHost ? `Espectadores conectados: ${chamadasAtivas.size}` : '';
    el.btnSound.hidden = !(souViewer && el.video.srcObject);
    el.btnSound.textContent = el.video.muted ? '🔊 Ativar som' : '🔇 Silenciar';
}

// ---------- Peer ----------
function gerarCodigo() {
    let c = '';
    const b = crypto.getRandomValues(new Uint8Array(TAMANHO_CODIGO));
    for (const x of b) c += ALFABETO[x % ALFABETO.length];
    return c;
}

function iniciarPeer(tentativa = 0) {
    const codigo = gerarCodigo();
    peer = new Peer(PREFIXO + codigo, { config: { iceServers: ICE_SERVERS } });

    peer.on('open', () => {
        meuCodigo = codigo;
        peerPronto = true;
        el.myId.textContent = codigo;
        setStatus('Pronto! Compartilhe sua tela ou cole o código de um host.', 'ok');
        atualizarUI();
    });

    peer.on('disconnected', () => {
        if (!peer.destroyed) peer.reconnect();
    });

    peer.on('error', err => {
        if (err.type === 'unavailable-id' && tentativa < 5) {
            peer.destroy();
            iniciarPeer(tentativa + 1);
            return;
        }
        tratarErroPeer(err);
    });

    peer.on('connection', conn => {
        if (papel === 'viewer') return conn.close();

        conn.on('open', () => {
            conexoesDados.add(conn);
            conn.send({ tipo: meuStream ? 'iniciada' : 'aguardando' });
        });
        conn.on('data', msg => {
            if (msg?.tipo === 'ping') conn.send({ tipo: 'pong', t: msg.t });
        });
        conn.on('close', () => conexoesDados.delete(conn));
        conn.on('error', () => conexoesDados.delete(conn));
    });

    peer.on('call', call => {
        if (!meuStream) { call.close(); return; }

        call.answer(meuStream);
        chamadasAtivas.add(call);
        atualizarUI();

        const remover = () => { chamadasAtivas.delete(call); atualizarUI(); };
        call.on('close', remover);
        call.on('error', remover);
        setTimeout(() => limitarBitrate(call), 1000);
    });
}

function tratarErroPeer(err) {
    console.error('Erro do Peer:', err);
    const mensagens = {
        'peer-unavailable': 'Host não encontrado. Confira o código.',
        'network': 'Falha de rede.',
        'server-error': 'Servidor de sinalização não respondeu.',
        'socket-error': 'Conexão com o signaling perdida.',
        'socket-closed': 'Conexão com o signaling encerrada.',
        'browser-incompatible': 'Seu navegador não suporta WebRTC.',
        'invalid-id': 'Código inválido.'
    };
    const msg = mensagens[err.type] || `Erro: ${err.type || err.message}`;
    if (papel === 'viewer') sairDoViewer(msg, 'erro');
    else setStatus(msg, 'erro');
}

// ---------- Host ----------
function transmitir(msg) {
    conexoesDados.forEach(c => { if (c.open) c.send(msg); });
}

function limitarBitrate(call) {
    const pc = call.peerConnection;
    if (!pc) return;
    pc.getSenders().forEach(async sender => {
        if (sender.track?.kind !== 'video') return;
        try {
            const p = sender.getParameters();
            if (!p.encodings || !p.encodings.length) p.encodings = [{}];
            p.encodings[0].maxBitrate = MAX_BITRATE;
            await sender.setParameters(p);
        } catch (e) { console.warn(e); }
    });
}

async function iniciarTransmissao() {
    try {
        meuStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 30 }, width: { ideal: 1920 } },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            systemAudio: 'include'
        });
    } catch (err) {
        setStatus('Você precisa permitir o compartilhamento de tela.', 'erro');
        meuStream = null;
        return;
    }

    papel = 'host';
    el.video.srcObject = meuStream;
    el.video.muted = true;
    meuStream.getVideoTracks()[0].addEventListener('ended', pararTransmissao);

    const temAudio = meuStream.getAudioTracks().length > 0;
    setStatus(temAudio
        ? `Transmitindo! Envie o código ${meuCodigo}.`
        : `Transmitindo SEM áudio. Código: ${meuCodigo}`, temAudio ? 'ok' : '');

    transmitir({ tipo: 'iniciada' });
    atualizarUI();
}

// Correção: Função limpa, sem código duplicado
function pararTransmissao() {
    if (!meuStream) return;

    meuStream.getTracks().forEach(t => t.stop());
    meuStream = null;

    // Para a captura no Electron
    if (window.electronAPI) {
        window.electronAPI.pararAudio().catch(() => {});
    }

    chamadasAtivas.forEach(c => { try { c.close(); } catch {} });
    chamadasAtivas.clear();
    transmitir({ tipo: 'encerrada' });
    
    el.video.srcObject = null;
    papel = null;
    setStatus('Transmissão encerrada.');
    atualizarUI();
}

// ---------- Viewer ----------
function criarStreamVazia() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const v = canvas.captureStream(1).getVideoTracks()[0];
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const a = audioCtx.createMediaStreamDestination().stream.getAudioTracks()[0];
    return new MediaStream([v, a]);
}

function resolverIdDoHost(entrada) {
    const limpo = entrada.trim();
    if (limpo.toLowerCase().startsWith(PREFIXO)) return limpo.toLowerCase();
    return PREFIXO + limpo.toUpperCase();
}

function conectarAoHost() {
    const entrada = el.hostId.value.trim();
    if (!entrada) { setStatus('Digite o código do Host.', 'erro'); return; }

    hostPeerIdAtual = resolverIdDoHost(entrada);
    papel = 'viewer';
    streamVazia = criarStreamVazia();
    tentativasReconexao = 0;
    abrirCanalComHost();
    atualizarUI();
}

function abrirCanalComHost() {
    setStatus(reconectando ? 'Reconectando ao host...' : 'Conectando ao host...');
    atualizarUI();

    hostConn = peer.connect(hostPeerIdAtual, { reliable: true });

    clearTimeout(timeoutConexao);
    timeoutConexao = setTimeout(() => {
        if (papel === 'viewer' && !hostConn?.open) {
            agendarReconexao('Tempo esgotado ao conectar.');
        }
    }, TIMEOUT_CONEXAO_MS);

    hostConn.on('open', () => {
        clearTimeout(timeoutConexao);
        tentativasReconexao = 0;
        reconectando = false;
        ultimoPong = Date.now();
        setStatus('Conectado ao host. Aguardando a transmissão...', 'ok');
        iniciarHeartbeat();
    });

    hostConn.on('data', msg => {
        if (papel !== 'viewer' || !msg) return;

        if (msg.tipo === 'pong') {
            ultimoPong = Date.now();
            return;
        }
        if (msg.tipo === 'ping') {
            hostConn.send({ tipo: 'pong', t: msg.t });
            return;
        }

        if (msg.tipo === 'iniciada') {
            ligarParaHost(hostPeerIdAtual);
        } else if (msg.tipo === 'aguardando') {
            setStatus('Conectado. O host ainda não começou a transmitir...');
        } else if (msg.tipo === 'encerrada') {
            fecharChamadaDoViewer();
            el.video.srcObject = null;
            setStatus('O host encerrou a transmissão. Aguardando ele iniciar de novo...');
            atualizarUI();
        }
    });

    hostConn.on('close', () => {
        if (papel === 'viewer') agendarReconexao('A conexão com o host caiu.');
    });

    hostConn.on('error', err => {
        console.error('Erro no canal de dados:', err);
        if (papel === 'viewer') agendarReconexao('Erro no canal de dados.');
    });
}

function iniciarHeartbeat() {
    pararHeartbeat();

    heartbeatTimer = setInterval(() => {
        if (!hostConn?.open) return;
        try {
            hostConn.send({ tipo: 'ping', t: Date.now() });
        } catch (e) { /* será detectado pelo watchdog */ }
    }, HEARTBEAT_MS);

    watchdogTimer = setInterval(() => {
        if (papel !== 'viewer' || reconectando) return;
        const silencio = Date.now() - ultimoPong;
        if (silencio > HEARTBEAT_TIMEOUT_MS) {
            agendarReconexao('Host parou de responder (possível oscilação de rede).');
        }
    }, 1000);
}

function pararHeartbeat() {
    clearInterval(heartbeatTimer);
    clearInterval(watchdogTimer);
    heartbeatTimer = watchdogTimer = null;
}

function agendarReconexao(motivo) {
    if (papel !== 'viewer' || reconectando) return;
    reconectando = true;
    pararHeartbeat();

    fecharChamadaDoViewer();
    if (hostConn) { try { hostConn.close(); } catch {} hostConn = null; }

    tentativasReconexao++;
    if (tentativasReconexao > MAX_TENTATIVAS) {
        reconectando = false;
        sairDoViewer(`Não foi possível reconectar após ${MAX_TENTATIVAS} tentativas. ${motivo}`, 'erro');
        return;
    }

    const espera = Math.min(RECONECTAR_BASE_MS * 2 ** (tentativasReconexao - 1), RECONECTAR_MAX_MS);
    setStatus(
        `⚠️ ${motivo} Reconectando em ${(espera / 1000).toFixed(0)}s ` +
        `(tentativa ${tentativasReconexao}/${MAX_TENTATIVAS})...`,
        'erro'
    );

    setTimeout(() => {
        if (papel !== 'viewer') return;
        abrirCanalComHost();
    }, espera);
}

function ligarParaHost(hostPeerId) {
    fecharChamadaDoViewer();
    setStatus(reconectando ? 'Restaurando vídeo...' : 'Recebendo transmissão...');

    const call = peer.call(hostPeerId, streamVazia);
    viewerCall = call;

    const pc = call.peerConnection;
    if (pc) {
        pc.addEventListener('iceconnectionstatechange', () => {
            const st = pc.iceConnectionState;
            if (viewerCall !== call) return;

            if (st === 'failed') {
                try {
                    call.peerConnection.restartIce();
                } catch {
                    agendarReconexao('Conexão de vídeo falhou.');
                }
            } else if (st === 'disconnected') {
                setTimeout(() => {
                    if (viewerCall === call && pc.iceConnectionState === 'disconnected') {
                        try { pc.restartIce(); } catch {}
                    }
                }, 5000);
            }
        });
    }

    call.on('stream', remoteStream => {
        if (viewerCall !== call || el.video.srcObject === remoteStream) return;
        el.video.srcObject = remoteStream;
        el.video.muted = true;
        el.video.play().catch(e => console.warn('Autoplay bloqueado:', e));
        reconectando = false;
        tentativasReconexao = 0;
        setStatus('Assistindo! Clique em "Ativar som" para ouvir.', 'ok');
        atualizarUI();
    });

    call.on('close', () => {
        if (viewerCall !== call) return;
        viewerCall = null;
        el.video.srcObject = null;
        if (papel === 'viewer') agendarReconexao('A transmissão foi encerrada.');
        atualizarUI();
    });

    call.on('error', err => {
        console.error('Erro na chamada:', err);
        if (viewerCall === call) agendarReconexao('Erro na chamada de vídeo.');
    });
}

function fecharChamadaDoViewer() {
    if (!viewerCall) return;
    const call = viewerCall;
    viewerCall = null;
    try { call.close(); } catch {}
}

function sairDoViewer(mensagem, tipo = '') {
    clearTimeout(timeoutConexao);
    pararHeartbeat();
    reconectando = false;
    tentativasReconexao = 0;
    fecharChamadaDoViewer();

    if (hostConn) { const c = hostConn; hostConn = null; try { c.close(); } catch {} }
    if (streamVazia) { streamVazia.getTracks().forEach(t => t.stop()); streamVazia = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }

    el.video.srcObject = null;
    papel = null;
    hostPeerIdAtual = null;
    setStatus(mensagem || 'Desconectado.', tipo);
    atualizarUI();
}

// ---------- Eventos ----------
el.btnShare.addEventListener('click', async () => {
    if (papel === 'host') {
        pararTransmissao();
        return;
    }

    if (window.electronAPI) {
        const janelas = await window.electronAPI.listarJanelas();
        const container = document.getElementById('lista-janelas');
        container.innerHTML = '';

        janelas.forEach(j => {
            const btn = document.createElement('button');
            btn.className = 'secondary';
            btn.style.display = 'block';
            btn.style.width = '100%';
            btn.style.marginBottom = '5px';
            btn.innerHTML = `<img src="${j.thumbnail}" style="height:30px; vertical-align:middle; margin-right:10px;"> ${j.name}`;
            btn.onclick = () => iniciarTransmissaoElectron(j.id);
            container.appendChild(btn);
        });

        document.getElementById('modal-janelas').classList.remove('hidden');
    } else {
        iniciarTransmissao();
    }
});

// Correção: Evento para fechar o modal
document.getElementById('btn-cancelar-janela').addEventListener('click', () => {
    document.getElementById('modal-janelas').classList.add('hidden');
});

async function iniciarTransmissaoElectron(sourceId) {
    try {
        document.getElementById('modal-janelas').classList.add('hidden');
        setStatus('Preparando captura...');

        const videoStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    maxWidth: 1920,
                    maxHeight: 1080,
                    maxFrameRate: 30
                }
            }
        });

        await configurarPipelineDeAudio();
        await window.electronAPI.iniciarAudio(sourceId);

        const audioTrack = mediaStreamDestino.stream.getAudioTracks()[0];
        const videoTrack = videoStream.getVideoTracks()[0];
        meuStream = new MediaStream([videoTrack, audioTrack]);

        papel = 'host';
        el.video.srcObject = meuStream;
        el.video.muted = true;
        videoTrack.addEventListener('ended', pararTransmissao);

        setStatus(`Transmitindo janela com áudio! Código: ${meuCodigo}`, 'ok');
        transmitir({ tipo: 'iniciada' });
        atualizarUI();
    } catch (err) {
        console.error('Erro na captura Electron:', err);
        setStatus('Erro ao capturar a janela.', 'erro');
        if (window.electronAPI) await window.electronAPI.pararAudio();
    }
}

el.btnConnect.addEventListener('click', () => {
    if (papel === 'viewer') sairDoViewer('Desconectado.');
    else conectarAoHost();
});

el.hostId.addEventListener('keydown', e => {
    if (e.key === 'Enter' && papel === null) conectarAoHost();
});

el.btnSound.addEventListener('click', () => {
    el.video.muted = !el.video.muted;
    if (!el.video.muted && el.video.paused) el.video.play().catch(() => {});
    atualizarUI();
});

el.video.addEventListener('volumechange', atualizarUI);

el.btnCopy.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(meuCodigo);
        setStatus(`Código ${meuCodigo} copiado!`, 'ok');
    } catch { window.prompt('Copie o código:', meuCodigo); }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || papel !== 'viewer') return;
    if (reconectando) return;

    if (viewerCall?.peerConnection) {
        const st = viewerCall.peerConnection.iceConnectionState;
        if (st === 'disconnected' || st === 'failed' || st === 'closed') {
            agendarReconexao('Conexão degradada após voltar do background.');
        } else {
            const silencio = Date.now() - ultimoPong;
            if (silencio > HEARTBEAT_TIMEOUT_MS) {
                agendarReconexao('Sem resposta do host.');
            }
        }
    }
});

window.addEventListener('online', () => {
    if (papel === 'viewer' && !reconectando) {
        const silencio = Date.now() - ultimoPong;
        if (silencio > HEARTBEAT_TIMEOUT_MS) agendarReconexao('Rede voltou após ficar offline.');
    }
});

window.addEventListener('offline', () => {
    if (papel === 'viewer') setStatus('📴 Você está offline. Aguardando rede...', 'erro');
});

window.addEventListener('beforeunload', () => {
    if (peer && !peer.destroyed) peer.destroy();
});

// ---------- Início ----------
if (!navigator.mediaDevices?.getDisplayMedia && !window.electronAPI) {
    el.btnShare.title = 'Seu navegador não suporta captura de tela.';
}
atualizarUI();
iniciarPeer();