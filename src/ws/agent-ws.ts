import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { agentRegistry } from '../agents/registry.js';
import type { AgentCommand } from '../agents/types.js';

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

    // Replay all existing messages as a single batch
    const messages = agent.getMessages();
    if (messages.length > 0) {
      ws.send(JSON.stringify({ type: 'history_batch', messages }));
    }

    // Send running dispatches for atoo-any (survives reconnect/project switch)
    if ('getRunningDispatches' in agent) {
      const running = (agent as any).getRunningDispatches();
      if (running.length > 0) {
        ws.send(JSON.stringify({ type: 'running_dispatches', dispatches: running }));
      }
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
      agent.sendMessage(cmd.text, cmd.attachments, {
        ...(cmd.agents ? { agents: cmd.agents } : {}),
        ...(cmd.agentSelectorConfig ? { agentSelectorConfig: cmd.agentSelectorConfig } : {}),
      });
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
    // Branch operations (atoo-any)
    case 'remove_messages':
      if ('removeMessages' in agent) (agent as any).removeMessages(cmd.eventUuids);
      break;
    case 'restore_message':
      if ('restoreMessage' in agent) (agent as any).restoreMessage(cmd.eventUuid);
      break;
    case 'compact_messages':
      if ('compactMessages' in agent) (agent as any).compactMessages(cmd.eventUuids, cmd.compactedBy);
      break;
    case 'fork_conversation':
      if ('forkConversation' in agent) (agent as any).forkConversation(cmd.afterIndex);
      break;
    case 'extract_range':
      if ('extractRange' in agent) (agent as any).extractRange(cmd.startIndex, cmd.endIndex, cmd.label);
      break;
    case 'kill_agent':
      if ('killAgent' in agent) (agent as any).killAgent(cmd.agentFamily);
      break;
    case 'kill_all_agents':
      if ('killAllAgents' in agent) (agent as any).killAllAgents();
      break;
    default: {
      // Legacy focus/blur commands — primarily handled via status WS now
      const action = (cmd as any).action;
      if (action === 'session_viewed' || action === 'session_focus') {
        agentRegistry.setSessionFocused(sessionId);
      } else if (action === 'session_blur') {
        agentRegistry.setSessionBlurred(sessionId);
      } else {
        console.warn(`[agent-ws] Unknown command action for ${sessionId}:`, action);
      }
    }
  }
}
