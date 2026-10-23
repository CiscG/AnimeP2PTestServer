const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const { startCapture, stopCapture, getPidFromWindowHandle } = require('electron-native-screenshare');
const path = require('path');

let win;

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('listar-janelas', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window'] });
    return sources
        // Correção: Filtrar o nome real da janela e ignorar miniaturas vazias
        .filter(s => s.name !== 'Anime Share P2P' && s.name !== '')
        .map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.handle('iniciar-audio', async (event, sourceId) => {
    const pidMatch = sourceId.match(/window:(\d+):/);
    if (!pidMatch) throw new Error('ID de janela inválido');
    const windowHandle = parseInt(pidMatch[1], 10);
    const pid = getPidFromWindowHandle(windowHandle);

    const sucesso = startCapture(pid, true, (audioData, meta) => {
        win.webContents.send('audio-chunk', audioData, meta);
    });

    return sucesso;
});

ipcMain.handle('parar-audio', () => {
    stopCapture();
});