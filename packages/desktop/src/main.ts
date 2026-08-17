import { app, BrowserWindow, Menu, dialog, clipboard, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newBoard } from '@flamingo/engine';
import { Doc, startServer } from '@flamingo/server';
import type { StartedServer } from '@flamingo/server';

// GUI apps launched from Finder get a bare launchd PATH; freerouting needs `java`
// (homebrew) to be findable.
process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/opt/homebrew/opt/openjdk/bin', '/usr/local/bin'].join(':');

const DEFAULT_PORT = 4242;
const here = dirname(fileURLToPath(import.meta.url));

let started: StartedServer | null = null;
let win: BrowserWindow | null = null;
let currentBoardPath: string | null = null;
let pendingOpenPath: string | null = null; // set by open-file before ready
let quitting = false;

function uiDistDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'ui') : join(here, '..', '..', 'ui', 'dist');
}

function statePath(): string {
  return join(app.getPath('userData'), 'state.json');
}

function loadLastBoard(): string | null {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8')) as { lastBoard?: string };
    return s.lastBoard && existsSync(s.lastBoard) ? s.lastBoard : null;
  } catch {
    return null;
  }
}

function saveLastBoard(p: string): void {
  try {
    writeFileSync(statePath(), JSON.stringify({ lastBoard: p }));
  } catch {
    /* best effort */
  }
}

function defaultBoardPath(): string {
  const dir = join(app.getPath('documents'), 'Flamingo');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'board.flamingo');
}

async function openBoard(filePath: string): Promise<void> {
  if (started) {
    const prev = started;
    started = null;
    await prev.close(); // flushes the previous doc to disk
  }

  let doc: Doc;
  if (existsSync(filePath)) {
    doc = await Doc.load(filePath);
  } else {
    const stem = basename(filePath, extname(filePath)) || 'board';
    doc = new Doc(newBoard(stem, 2), filePath);
    await doc.save();
  }

  const port = process.env.FLAMINGO_PORT ? Number(process.env.FLAMINGO_PORT) : DEFAULT_PORT;
  try {
    started = await startServer(doc, port, { projectDir: dirname(filePath), uiDistDir: uiDistDir() });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw err;
    // Another Flamingo (e.g. the CLI) owns the port; fall back to an ephemeral one.
    started = await startServer(doc, 0, { projectDir: dirname(filePath), uiDistDir: uiDistDir() });
  }

  currentBoardPath = filePath;
  saveLastBoard(filePath);
  app.addRecentDocument(filePath);

  if (!win) createWindow();
  win!.setTitle(`Flamingo — ${basename(filePath)}`);
  win!.setRepresentedFilename(filePath);
  await win!.loadURL(`http://localhost:${started.port}`);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    title: 'Flamingo',
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true },
  });
  win.on('closed', () => {
    win = null;
  });
}

async function chooseAndOpen(): Promise<void> {
  const res = await dialog.showOpenDialog({
    filters: [{ name: 'Flamingo Board', extensions: ['flamingo'] }],
    properties: ['openFile'],
  });
  if (!res.canceled && res.filePaths[0]) await openBoard(res.filePaths[0]);
}

async function chooseAndCreate(): Promise<void> {
  const res = await dialog.showSaveDialog({
    title: 'New Board',
    defaultPath: join(app.getPath('documents'), 'Flamingo', 'untitled.flamingo'),
    filters: [{ name: 'Flamingo Board', extensions: ['flamingo'] }],
  });
  if (!res.canceled && res.filePath) {
    const p = extname(res.filePath) === '.flamingo' ? res.filePath : `${res.filePath}.flamingo`;
    await openBoard(p);
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Board…', accelerator: 'CmdOrCtrl+N', click: () => void chooseAndCreate() },
        { label: 'Open Board…', accelerator: 'CmdOrCtrl+O', click: () => void chooseAndOpen() },
        { type: 'separator' },
        {
          label: 'Show Board File in Finder',
          click: () => {
            if (currentBoardPath) shell.showItemInFolder(currentBoardPath);
          },
        },
        {
          label: 'Copy MCP URL',
          click: () => {
            if (started) clipboard.writeText(`http://localhost:${started.port}/mcp`);
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('open-file', (event, path) => {
    event.preventDefault();
    if (app.isReady()) void openBoard(path);
    else pendingOpenPath = path;
  });

  app.whenReady().then(async () => {
    buildMenu();
    createWindow();
    const boardPath = pendingOpenPath ?? loadLastBoard() ?? defaultBoardPath();
    try {
      await openBoard(boardPath);
    } catch (err) {
      dialog.showErrorBox('Flamingo failed to start', err instanceof Error ? (err.stack ?? err.message) : String(err));
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!win) {
      createWindow();
      if (started) void win!.loadURL(`http://localhost:${started.port}`);
    }
  });

  // Keep running with the window closed (server + MCP stay live), like a menu-less doc app.
  app.on('window-all-closed', () => {
    /* stay alive on macOS */
  });

  app.on('before-quit', (event) => {
    if (quitting || !started) return;
    event.preventDefault();
    quitting = true;
    const s = started;
    started = null;
    s.close()
      .catch(() => {})
      .finally(() => app.quit());
  });
}
