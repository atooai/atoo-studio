import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { agentRegistry } from '../agents/registry.js';
import type { AgentCommand } from '../agents/types.js';
import { getEnvIdForSession, markSessionFocused, markSessionBlurred } from '../spawner.js';

const AGENT_WS_PATH_RE = /^\/ws\/agent\/([^/?]+)/;

export function isAgentWsUpgrade(url: string): boolean {
  return AGENT_WS_PATH_RE.test(url);
}

export function handleAgentWsUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const match = req.url?.match(AGENT_WS_PATH_RE);
  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const agent = agentRegistry.getAgent(sessionId);
  if (!agent) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log(`[agent-ws] Browser connected for agent session ${sessionId}`);

    // Register as browser client
    agentRegistry.addBrowserClient(sessionId, ws);

    // Send agent info
    const info = agent.getInfo();
    ws.send(JSON.stringify({ type: 'agent_info', ...info }));

    // Replay all existing messages
    const messages = agent.getMessages();
    for (const msg of messages) {
      ws.send(JSON.stringify(msg));
    }

    // Handle incoming commands
    ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString()) as AgentCommand;
        handleCommand(sessionId, cmd);
      } catch (err) {
        console.error(`[agent-ws] Failed to parse command for ${sessionId}`);
      }
    });

    ws.on('close', () => {
      console.log(`[agent-ws] Browser disconnected for agent session ${sessionId}`);
      agentRegistry.removeBrowserClient(sessionId, ws);
    });

    ws.on('error', (err) => {
      console.error(`[agent-ws] Error for ${sessionId}:`, err.message);
    });
  });
}

function handleCommand(sessionId: string, cmd: AgentCommand): void {
  const agent = agentRegistry.getAgent(sessionId);
  if (!agent) return;

  switch (cmd.action) {
    case 'send_message':
      agent.sendMessage(cmd.text, cmd.attachments);
      break;
    case 'approve':
      agent.approve(cmd.requestId, cmd.updatedInput);
      break;
    case 'deny':
      agent.deny(cmd.requestId);
      break;
    case 'answer_question':
      agent.answerQuestion(cmd.requestId, cmd.answers);
      break;
    case 'set_mode':
      agent.setMode(cmd.mode);
      break;
    case 'set_model':
      agent.setModel(cmd.model);
      break;
    case 'refresh_context':
      agent.refreshContext();
      break;
    case 'send_key':
      agent.sendKey(cmd.key);
      break;
    case 'session_viewed': {
      // Legacy: treat as focus (backwards compat if old frontend connects)
      agent.markViewed();
      const envId = getEnvIdForSession(sessionId);
      if (envId) markSessionFocused(envId);
      break;
    }
    case 'session_focus': {
      agent.markViewed();
      const envId2 = getEnvIdForSession(sessionId);
      if (envId2) markSessionFocused(envId2);
      break;
    }
    case 'session_blur': {
      const envId3 = getEnvIdForSession(sessionId);
      if (envId3) markSessionBlurred(envId3);
      break;
    }
    default:
      console.warn(`[agent-ws] Unknown command action for ${sessionId}:`, (cmd as any).action);
  }
}
