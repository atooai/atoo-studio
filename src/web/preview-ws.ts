import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { Duplex } from 'stream';
import { previewManager } from '../services/preview-manager.js';

// Grace period before destroying instances with no clients
const GRACE_PERIOD = 30_000; // 30 seconds
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function isPreviewWsUpgrade(url: string): boolean {
  return url.startsWith('/ws/preview/');
}

export function handlePreviewWsUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  const url = req.url || '';
  const match = url.match(/^\/ws\/preview\/([^/?]+)\/([^/?]+)/);
  if (!match) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const projectId = decodeURIComponent(match[1]);
  const tabId = decodeURIComponent(match[2]);
  const params = new URLSearchParams(url.split('?')[1] || '');

  const targetPort = parseInt(params.get('target_port') || '', 10);
  if (!targetPort || isNaN(targetPort)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const headerHost = params.get('host') || undefined;
  const protocol = (params.get('protocol') || 'http') as 'http' | 'https';
  const quality = parseInt(params.get('quality') || '80', 10);
  const width = parseInt(params.get('width') || '1920', 10);
  const height = parseInt(params.get('height') || '1080', 10);
  const dpr = parseFloat(params.get('dpr') || '1');
  const isMobile = params.get('isMobile') === 'true';
  const hasTouch = params.get('hasTouch') === 'true';

  wss.handleUpgrade(req, socket, head, async (ws) => {
    const key = `${projectId}/${tabId}`;

    // Cancel any pending grace period destruction
    const graceTimer = graceTimers.get(key);
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimers.delete(key);
    }

    try {
      // Get or create instance
      let instance = previewManager.get(projectId, tabId);
      if (!instance) {
        instance = await previewManager.create(projectId, tabId, {
          targetPort,
          headerHost,
          protocol,
          width,
          height,
          dpr,
          isMobile,
          hasTouch,
          quality,
        });
      }

      // Register WS client
      instance.wsClients.add(ws);
      instance.lastActivity = Date.now();

      // Send connected message
      ws.send(JSON.stringify({
        type: 'connected',
        viewport: {
          width: instance.viewport.width,
          height: instance.viewport.height,
          deviceScaleFactor: instance.viewport.deviceScaleFactor,
          isMobile: instance.viewport.isMobile,
          hasTouch: instance.viewport.hasTouch,
        },
      }));

      // Handle messages from client
      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          instance!.lastActivity = Date.now();
          await handleClientMessage(projectId, tabId, msg, ws);
        } catch (err: any) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      });

      // Handle disconnect
      ws.on('close', () => {
        const inst = previewManager.get(projectId, tabId);
        if (inst) {
          inst.wsClients.delete(ws);
          // Start grace period if no clients left
          if (inst.wsClients.size === 0) {
            const timer = setTimeout(() => {
              graceTimers.delete(key);
              const check = previewManager.get(projectId, tabId);
              if (check && check.wsClients.size === 0) {
                previewManager.destroy(projectId, tabId);
              }
            }, GRACE_PERIOD);
            graceTimers.set(key, timer);
          }
        }
      });
    } catch (err: any) {
      console.error(`[preview-ws] Failed to setup preview for ${key}:`, err.message);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close(1011, 'Failed to create preview instance');
    }
  });
}

async function handleClientMessage(
  projectId: string,
  tabId: string,
  msg: any,
  ws: WebSocket,
) {
  switch (msg.type) {
    case 'mouse':
      await previewManager.dispatchMouseEvent(projectId, tabId, {
        type: msg.event,
        x: msg.x,
        y: msg.y,
        button: msg.button || 'none',
        buttons: msg.buttons ?? 0,
        clickCount: msg.clickCount || 0,
        deltaX: msg.deltaX || 0,
        deltaY: msg.deltaY || 0,
        modifiers: msg.modifiers || 0,
      });
      break;

    case 'scroll':
      await previewManager.dispatchScrollEvent(projectId, tabId, {
        x: msg.x,
        y: msg.y,
        deltaX: msg.deltaX || 0,
        deltaY: msg.deltaY || 0,
      });
      break;

    case 'key':
      await previewManager.dispatchKeyEvent(projectId, tabId, {
        type: msg.event,
        key: msg.key,
        code: msg.code,
        text: msg.text,
        modifiers: msg.modifiers || 0,
        windowsVirtualKeyCode: msg.windowsVirtualKeyCode,
        nativeVirtualKeyCode: msg.nativeVirtualKeyCode,
      });
      break;

    case 'text':
      await previewManager.insertText(projectId, tabId, msg.text);
      break;

    case 'screenshot': {
      const data = await previewManager.screenshot(projectId, tabId, msg.fullPage);
      ws.send(JSON.stringify({ type: 'screenshot', data }));
      break;
    }

    case 'scrollshot': {
      const data = await previewManager.screenshot(projectId, tabId, true);
      ws.send(JSON.stringify({ type: 'scrollshot', data }));
      break;
    }

    case 'record_start':
      previewManager.startRecording(projectId, tabId);
      break;

    case 'record_stop': {
      const data = await previewManager.stopRecording(projectId, tabId);
      ws.send(JSON.stringify({ type: 'recording', data }));
      break;
    }

    case 'navigate':
      await previewManager.navigate(projectId, tabId, msg.url);
      break;

    case 'reload':
      await previewManager.reload(projectId, tabId);
      break;

    case 'viewport':
      await previewManager.setViewport(projectId, tabId, {
        width: msg.width,
        height: msg.height,
        dpr: msg.dpr,
        isMobile: msg.isMobile,
        hasTouch: msg.hasTouch,
      });
      break;

    case 'quality':
      await previewManager.setQuality(projectId, tabId, msg.quality);
      break;

    case 'dialog_response':
      previewManager.handleDialogResponse(projectId, tabId, msg.dialogId, msg.accept, msg.promptText);
      break;

    case 'file_chooser_response':
      await previewManager.handleFileChooserResponse(projectId, tabId, msg.backendNodeId, msg.files || []);
      break;

    // Shadow overlay responses
    case 'select_response':
      await previewManager.handleSelectResponse(projectId, tabId, msg.selectorPath, msg.value);
      break;

    case 'picker_response':
      await previewManager.handlePickerResponse(projectId, tabId, msg.selectorPath, msg.value, msg.inputType);
      break;

    case 'auth_response':
      previewManager.handleAuthResponse(projectId, tabId, msg.requestId, msg.username, msg.password);
      break;

    case 'auth_cancel':
      previewManager.handleAuthCancel(projectId, tabId, msg.requestId);
      break;

    case 'context_menu_action':
      await previewManager.handleContextMenuAction(projectId, tabId, msg.action, msg);
      break;
  }
}
