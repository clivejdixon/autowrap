import platformClient from 'purecloud-platform-client-v2';
import ClientApp from 'purecloud-client-app-sdk';
import { config } from './config.js';

const apiClient = platformClient.ApiClient.instance;
const usersApi = new platformClient.UsersApi();
const notificationsApi = new platformClient.NotificationsApi();
const params = new URLSearchParams(window.location.search);

const gcHostOrigin = params.get('gcHostOrigin');
const gcTargetEnv = params.get('gcTargetEnv');

// Fallback if not embedded (local dev)
const REGION = gcTargetEnv || 'euw2.pure.cloud';
const BASE_URL = `https://api.${REGION}`;

console.log('Environment:', REGION);
console.log('Host Origin:', gcHostOrigin);
console.log('Base URL:', BASE_URL);
console.log('AUTO-WRAP main.js loaded', {
  href: window.location.href,
  pathname: window.location.pathname,
  search: window.location.search,
  time: new Date().toISOString()
});

let clientApp;
let currentUser;
let notificationChannel;
let socket;
let running = false;
let autoStartAttempted = false;
const recentlyPatched = new Map();

const elements = {
  env: document.getElementById('env'),
  user: document.getElementById('user'),
  channel: document.getElementById('channel'),
  lastAction: document.getElementById('lastAction'),
  log: document.getElementById('log'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn')
};

function serializeError(err) {
  if (!err) return {};
  return {
    message: err.message || String(err),
    stack: err.stack || '',
    name: err.name || 'Error'
  };
}

function log(message, level = 'info', data) {
  const ts = new Date().toISOString();
  const suffix = data !== undefined ? ` ${JSON.stringify(data, null, 2)}` : '';
  const line = `[${ts}] ${message}${suffix}`;
  if (elements.log) {
    elements.log.textContent = `${line}\n${elements.log.textContent}`;
  }
  const fn =
    level === 'error' ? console.error :
    level === 'warn' ? console.warn :
    console.log;
  fn(message, data ?? '');
}

function setStatus(text) {
  if (elements.lastAction) {
    elements.lastAction.textContent = text;
  }
}

function getInterpolatedValue(name, fallback = '') {
  const search = new URLSearchParams(window.location.search);
  return search.get(name) || localStorage.getItem(name) || fallback;
}

function storeInterpolatedValues() {
  ['gcTargetEnv', 'gcHostOrigin', 'gcLangTag'].forEach((key) => {
    const value = new URLSearchParams(window.location.search).get(key);
    if (value) {
      localStorage.setItem(key, value);
    }
  });
}

function getEnvironment() {
  const env = getInterpolatedValue('gcTargetEnv').trim();
  if (!env) {
    throw new Error('Missing gcTargetEnv.');
  }
  return env;
}

function getGcHostOrigin() {
  const raw = getInterpolatedValue('gcHostOrigin').trim();

  if (!raw) {
    throw new Error('Missing gcHostOrigin.');
  }

  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    throw new Error(`Invalid gcHostOrigin provided: ${raw}`);
  }
}

function getTopics(userId) {
  return [
    `v2.users.${userId}.conversations`,
    `v2.users.${userId}.conversationsummary`
  ];
}

function getAccessToken() {
  const token = apiClient.authData?.accessToken || apiClient.accessToken;
  if (!token) {
    throw new Error('No access token');
  }
  return token;
}

async function authenticatedFetch(path, options = {}) {
  const token = getAccessToken();
  const basePath = `https://api.${getEnvironment()}`;
  const url = `${basePath}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText} ${err}`);
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function authenticate() {
  const env = getEnvironment();
  apiClient.setPersistSettings(true, config.persistKey);
  apiClient.setEnvironment(env);
  storeInterpolatedValues();

  if (elements.env) {
    elements.env.textContent = env;
  }

  await apiClient.loginImplicitGrant(config.clientId, config.redirectUri);

  currentUser = await usersApi.getUsersMe();

  if (elements.user) {
    elements.user.textContent = `${currentUser.name}`;
  }

  log('Authenticated', 'info', {
    userId: currentUser.id,
    userName: currentUser.name,
    env
  });
}

async function initClientApp() {
  const env = getEnvironment();
  const hostOrigin = getGcHostOrigin();

  log('initClientApp() starting', 'info', { env, hostOrigin });

  clientApp = new ClientApp({
    gcTargetEnv: env,
    gcHostOrigin: hostOrigin
  });

  setStatus('Client app initialized');
}

async function createNotificationChannel() {
  notificationChannel = await notificationsApi.postNotificationsChannels();

  const topics = getTopics(currentUser.id);

  await notificationsApi.postNotificationsChannelSubscriptions(
    notificationChannel.id,
    topics.map((id) => ({ id }))
  );

  if (elements.channel) {
    elements.channel.textContent = notificationChannel.id;
  }

  log('Notification channel created', 'info', {
    channelId: notificationChannel.id,
    topics
  });
}

function connectWebSocket() {
  if (!notificationChannel?.connectUri) {
    throw new Error('Missing notification channel connectUri');
  }

  socket = new WebSocket(notificationChannel.connectUri);

  socket.addEventListener('open', () => {
    log('WebSocket connected', 'info', { connectUri: notificationChannel.connectUri });
    setStatus('WebSocket connected');
  });

  socket.addEventListener('close', () => {
    log('WebSocket closed', 'warn');
    setStatus('WebSocket closed');
  });

  socket.addEventListener('error', (event) => {
    log('WebSocket error', 'error', serializeError(event?.error || event));
  });

  socket.addEventListener('message', async (event) => {
    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      log('Ignoring non-JSON websocket message', 'warn', {
        raw: String(event.data).slice(0, 500)
      });
      return;
    }

    if (!payload.topicName || !payload.eventBody) return;

    await handleConversationNotification(payload.topicName, payload.eventBody);
  });
}

function isAgentParticipantForCurrentUser(p) {
  return p?.purpose === 'agent' && p?.userId === currentUser.id;
}

async function getConversationCustomAttributes(conversationId) {
  try {
    const attrs = await authenticatedFetch(
      `/api/v2/conversations/${conversationId}/customattributes`
    );
    return attrs?.customAttributes || attrs || {};
  } catch (err) {
    log('Failed to load custom attributes', 'warn', {
      conversationId,
      error: serializeError(err)
    });
    return {};
  }
}

function matchesForcedUnpark(attrs) {
  return String(attrs?.ForcedUnpark).toLowerCase() === 'true';
}

async function patchAgentParticipantWrapup(conversationId, participantId) {
  return authenticatedFetch(
    `/api/v2/conversations/emails/${conversationId}/participants/${participantId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        wrapup: config.wrapupPayload
      })
    }
  );
}

async function verifyParticipant(conversationId, participantId) {
  await new Promise((r) => setTimeout(r, 300));

  const convo = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}`);
  const p = convo?.participants?.find((x) => (x.id || x.participantId) === participantId);

  return {
    wrapupRequired: p?.wrapupRequired,
    wrapup: p?.wrapup,
    state: p?.state
  };
}

async function waitForACWAndWrapup(conversationId, participantId) {
  const key = `${conversationId}:${participantId}`;
  if (recentlyPatched.has(key)) return;

  for (let i = 0; i < 6; i++) {
    const convo = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}`);
    const p = convo?.participants?.find(isAgentParticipantForCurrentUser);

    if (!p) return;

    const state = p.state;
    const active = state === 'wrapup' || state === 'connected';

    log('ACW Check', 'info', { conversationId, participantId, state, wrapupRequired: p.wrapupRequired });

    if (p.wrapupRequired && active) {
      recentlyPatched.set(key, Date.now());

      await patchAgentParticipantWrapup(conversationId, participantId);

      const v = await verifyParticipant(conversationId, participantId);

      log('Wrap-up applied', 'info', v);
      return;
    }

    await new Promise((r) => setTimeout(r, 400));
  }
}

async function handleConversationNotification(topicName, eventBody) {
  if (
    !topicName.includes('conversations') &&
    !topicName.includes('conversationsummary')
  ) {
    return;
  }

  const conversationId = eventBody.conversationId;
  if (!conversationId) return;

  log('🔥 Notification received', 'info', {
    topicName,
    conversationId,
    raw: eventBody
  });

  const participants = eventBody.participants || [];

  const agentParticipant = participants.find((p) =>
    p.userId === currentUser.id && p.purpose === 'agent'
  );

  if (!agentParticipant) {
    log('No agent participant found in event body', 'warn', {
      conversationId,
      currentUserId: currentUser?.id
    });
    return;
  }

  const wrapupRequired = agentParticipant.wrapupRequired;
  const state = agentParticipant.state;

  log('Summary/Event Check', 'info', {
    conversationId,
    participantId: agentParticipant.id,
    wrapupRequired,
    state,
    topicName
  });

  const interactionActive = state === 'wrapup' || state === 'connected';

  if (!wrapupRequired || !interactionActive) return;

  const attrs = await getConversationCustomAttributes(conversationId);
  if (!matchesForcedUnpark(attrs)) {
    log('ForcedUnpark not set, skipping', 'info', { conversationId, attrs });
    return;
  }

  const participantId = agentParticipant.id;
  const key = `${conversationId}:${participantId}`;
  if (recentlyPatched.has(key)) return;

  recentlyPatched.set(key, Date.now());

  try {
    await patchAgentParticipantWrapup(conversationId, participantId);

    const verification = await verifyParticipant(conversationId, participantId);

    log('✅ Wrap-up applied (auto)', 'info', {
      conversationId,
      participantId,
      verification
    });

  } catch (err) {
    log('❌ Wrap-up failed', 'error', serializeError(err));
  }
}

async function stop() {
  running = false;

  try {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  } catch {
    // ignore
  }

  socket = undefined;
  notificationChannel = undefined;

  setStatus('Stopped');
  log('Helper stopped', 'info');
}

async function start() {
  if (running) {
    log('Start ignored; helper already running', 'warn');
    return;
  }

  running = true;
  setStatus('Starting...');
  log('start() clicked', 'info');

  try {
    await initClientApp();
    await authenticate();
    await createNotificationChannel();
    connectWebSocket();
    setStatus('Running');
    log('Helper started successfully', 'info', {
      userId: currentUser?.id,
      env: getEnvironment()
    });
  } catch (err) {
    running = false;
    setStatus('Start failed');
    log('Failed to start helper', 'error', serializeError(err));
    throw err;
  }
}

async function autoStart() {
  if (autoStartAttempted) return;
  autoStartAttempted = true;

  try {
    await start();
  } catch (err) {
    log('Auto-start failed', 'error', serializeError(err));
  }
}

function wireUi() {
  if (elements.startBtn) {
    elements.startBtn.onclick = () => start().catch(() => {});
  }
  if (elements.stopBtn) {
    elements.stopBtn.onclick = () => stop().catch(() => {});
  }
  if (elements.clearBtn) {
    elements.clearBtn.onclick = () => {
      if (elements.log) elements.log.textContent = '';
      setStatus('Waiting');
    };
  }
}

wireUi();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoStart, { once: true });
} else {
  autoStart();
}
