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
const PORT_SCAN_RANGE = 50;
const here = dirname(fileURLToPath(import.meta.url));

/**
 * One open board = one BoardSession: its own Doc, its own HTTP/MCP server on
 * its own port, and its own BrowserWindow (merged into the native macOS tab
 * bar). Separate Claude Code instances can drive separate boards concurrently
 * — each project's .mcp.json points at its board's port.
 */
interface BoardSession {
  doc: Doc;
  started: StartedServer;
  win: BrowserWindow;
  /** Path the board was opened from. doc.filePath is the live truth (MCP tools can retarget it). */
  filePath: string;
}

const sessions = new Map<number, BoardSession>(); // key: BrowserWindow id
let portByProject: Record<string, number> = {}; // projectDir -> last port used, kept stable across relaunches
let pendingOpenPaths: string[] = []; // set by open-file before ready
let quitting = false;

function uiDistDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'ui') : join(here, '..', '..', 'ui', 'dist');
}

function statePath(): string {
  return join(app.getPath('userData'), 'state.json');
}

interface AppState {
  openBoards?: string[];
  ports?: Record<string, number>;
  /** Legacy single-board field from before tabs. */
  lastBoard?: string;
}

function loadState(): AppState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as AppState;
  } catch {
    return {};
  }
}

function saveState(): void {
  const openBoards = [...sessions.values()].map((s) => s.doc.filePath ?? s.filePath);
  try {
    // On a fresh install the userData dir may not exist yet; writeFileSync won't create it.
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ openBoards, ports: portByProject }, null, 2));
  } catch {
    /* best effort */
  }
}

function defaultBoardPath(): string {
  const dir = join(app.getPath('documents'), 'Flamingo');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'board.flamingo');
}

function focusedSession(): BoardSession | null {
  const win = BrowserWindow.getFocusedWindow();
  return (win && sessions.get(win.id)) ?? null;
}

/**
 * Point the project's .mcp.json at this board's MCP endpoint so a Claude Code
 * session started in that folder connects to the right board automatically.
 * Merges into any existing config (other servers untouched); no-op when the
 * flamingo entry already matches, so git checkouts aren't dirtied for nothing.
 */
function writeMcpConfig(projectDir: string, port: number): void {
  const p = join(projectDir, '.mcp.json');
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  try {
    cfg = JSON.parse(readFileSync(p, 'utf8')) as typeof cfg;
  } catch {
    /* absent or unparseable: start fresh */
  }
  const url = `http://localhost:${port}/mcp`;
  const existing = (cfg.mcpServers?.flamingo as { url?: string } | undefined)?.url;
  if (existing === url) return;
  cfg.mcpServers = { ...cfg.mcpServers, flamingo: { type: 'http', url } };
  try {
    writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  } catch {
    /* best effort */
  }
}

/**
 * Start the board's server, preferring the port this project used last time
 * (so .mcp.json stays valid across relaunches), then scanning up from the
 * base port past ports our other tabs hold, then anything the OS gives us.
 */
async function startOnFreePort(doc: Doc, projectDir: string): Promise<StartedServer> {
  const basePort = process.env.FLAMINGO_PORT ? Number(process.env.FLAMINGO_PORT) : DEFAULT_PORT;
  const inUse = new Set([...sessions.values()].map((s) => s.started.port));
  const candidates: number[] = [];
  const remembered = portByProject[projectDir];
  if (remembered && !inUse.has(remembered)) candidates.push(remembered);
  for (let p = basePort; p < basePort + PORT_SCAN_RANGE; p++) {
    if (!inUse.has(p) && !candidates.includes(p)) candidates.push(p);
  }
  const opts = { projectDir, uiDistDir: uiDistDir() };
  for (const port of candidates) {
    try {
      return await startServer(doc, port, opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  return startServer(doc, 0, opts); // whole range taken (CLI instances?): ephemeral
}

function createWindow(): BrowserWindow {
  // Grab the tab anchor before the new window steals focus.
  const anchor = BrowserWindow.getFocusedWindow() ?? [...sessions.values()].at(-1)?.win ?? null;
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    title: 'Flamingo',
    backgroundColor: '#1e1e1e',
    tabbingIdentifier: 'flamingo-board',
    webPreferences: { contextIsolation: true },
  });
  if (anchor && !anchor.isDestroyed()) anchor.addTabbedWindow(win);
  // Keep the board-file title; the served UI's document.title must not win.
  win.on('page-title-updated', (event) => event.preventDefault());
  // Native tab bar's "+" button.
  win.on('new-window-for-tab', () => void chooseAndCreate());
  return win;
}

async function openBoard(filePath: string): Promise<void> {
  const already = [...sessions.values()].find((s) => (s.doc.filePath ?? s.filePath) === filePath);
  if (already) {
    already.win.show();
    already.win.focus();
    return;
  }

  let doc: Doc;
  if (existsSync(filePath)) {
    doc = await Doc.load(filePath);
  } else {
    const stem = basename(filePath, extname(filePath)) || 'board';
    doc = new Doc(newBoard(stem, 2), filePath);
    await doc.save();
  }

  const projectDir = dirname(filePath);
  const started = await startOnFreePort(doc, projectDir);
  portByProject[projectDir] = started.port;
  writeMcpConfig(projectDir, started.port);

  const win = createWindow();
  const session: BoardSession = { doc, started, win, filePath };
  sessions.set(win.id, session);
  saveState();
  app.addRecentDocument(filePath);

  win.setTitle(`Flamingo — ${basename(filePath)}`);
  win.setRepresentedFilename(filePath);
  win.on('closed', () => {
    sessions.delete(win.id);
    if (quitting) return; // before-quit closes every server itself
    saveState();
    void session.started.close().catch((err: unknown) => {
      console.error(`[flamingo] failed to close board server for ${session.filePath}:`, err);
    });
  });

  await win.loadURL(`http://localhost:${started.port}`);
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

async function saveBoardAs(): Promise<void> {
  const session = focusedSession();
  if (!session) return;
  const { doc, win } = session;
  const res = await dialog.showSaveDialog(win, {
    title: 'Save Board As',
    defaultPath: doc.filePath ?? join(app.getPath('documents'), 'Flamingo', 'untitled.flamingo'),
    filters: [{ name: 'Flamingo Board', extensions: ['flamingo'] }],
  });
  if (res.canceled || !res.filePath) return;
  const p = extname(res.filePath) === '.flamingo' ? res.filePath : `${res.filePath}.flamingo`;
  try {
    await doc.saveAs(p);
  } catch (err) {
    dialog.showErrorBox('Save As failed', err instanceof Error ? err.message : String(err));
    return;
  }
  session.filePath = p;
  saveState();
  app.addRecentDocument(p);
  win.setTitle(`Flamingo — ${basename(p)}`);
  win.setRepresentedFilename(p);
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
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () =>
            void focusedSession()
              ?.doc.save()
              .catch((err: unknown) => {
                dialog.showErrorBox('Save failed', err instanceof Error ? err.message : String(err));
              }),
        },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: () => void saveBoardAs() },
        { type: 'separator' },
        {
          label: 'Show Board File in Finder',
          click: () => {
            const s = focusedSession();
            const p = s?.doc.filePath ?? s?.filePath;
            if (p) shell.showItemInFolder(p);
          },
        },
        {
          label: 'Copy MCP URL',
          click: () => {
            const s = focusedSession();
            if (s) clipboard.writeText(`http://localhost:${s.started.port}/mcp`);
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }, // macOS adds the Show Tab Bar / Show All Tabs items here
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Boards to (re)open at launch/activate: last session's tab set, else the legacy/default board. */
function boardsToRestore(state: AppState): string[] {
  const remembered = (state.openBoards ?? []).filter((p) => existsSync(p));
  if (remembered.length) return remembered;
  if (state.lastBoard && existsSync(state.lastBoard)) return [state.lastBoard];
  return [defaultBoardPath()];
}

async function openAll(paths: string[]): Promise<void> {
  const errors: string[] = [];
  for (const p of paths) {
    try {
      await openBoard(p);
    } catch (err) {
      errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length) dialog.showErrorBox('Some boards failed to open', errors.join('\n'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = [...sessions.values()].at(-1)?.win;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('open-file', (event, path) => {
    event.preventDefault();
    if (app.isReady()) void openBoard(path);
    else pendingOpenPaths.push(path);
  });

  app.whenReady().then(async () => {
    buildMenu();
    const state = loadState();
    portByProject = state.ports ?? {};
    const paths = pendingOpenPaths.length ? pendingOpenPaths : boardsToRestore(state);
    pendingOpenPaths = [];
    await openAll(paths);
    if (sessions.size === 0) app.quit(); // nothing could open; error box already shown
  });

  app.on('activate', () => {
    if (sessions.size === 0) void openAll(boardsToRestore(loadState()));
  });

  // Closing a tab closes that board's server (its MCP endpoint dies with it).
  // With every tab closed the app itself stays alive, macOS-style; clicking
  // the dock icon restores the last set of boards via 'activate'.
  app.on('window-all-closed', () => {
    /* stay alive on macOS */
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    saveState(); // capture the full tab set before the windows start closing
    const closes = [...sessions.values()].map((s) => s.started.close().catch(() => {}));
    void Promise.all(closes).finally(() => app.quit());
  });
}
