import platformClient from 'purecloud-platform-client-v2';
import ClientApp from 'purecloud-client-app-sdk';
import { config } from './config.js';

const APP_NAME = 'AUTO-WRAP';

const apiClient = platformClient.ApiClient.instance;
const usersApi = new platformClient.UsersApi();
const notificationsApi = new platformClient.NotificationsApi();
const params = new URLSearchParams(window.location.search);

const gcHostOriginRaw = params.get('gcHostOrigin');
const gcTargetEnvRaw = params.get('gcTargetEnv');

const ENVIRONMENT_MAP = {
  'prod-euw2': 'euw2.pure.cloud',
  'euw2': 'euw2.pure.cloud',
  'prod-use1': 'use1.pure.cloud',
  'use1': 'use1.pure.cloud',
  'prod-usw2': 'usw2.pure.cloud',
  'usw2': 'usw2.pure.cloud',
  'prod-mypurecloud': 'mypurecloud.com',
  'mypurecloud': 'mypurecloud.com',
  'mypurecloud.com': 'mypurecloud.com',
  'euw2.pure.cloud': 'euw2.pure.cloud',
  'use1.pure.cloud': 'use1.pure.cloud',
  'usw2.pure.cloud': 'usw2.pure.cloud'
};

const CLIENT_TARGET_ENV_MAP = {
  'euw2.pure.cloud': 'prod-euw2',
  'use1.pure.cloud': 'prod-use1',
  'usw2.pure.cloud': 'prod-usw2',
  'mypurecloud.com': 'mypurecloud',
  'mypurecloud.ie': 'mypurecloud.ie',
  'mypurecloud.de': 'mypurecloud.de',
  'mypurecloud.jp': 'mypurecloud.jp'
};

function normalizeEnvironment(env) {
  if (!env) return '';
  return ENVIRONMENT_MAP[env] || env;
}

function resolveClientTargetEnv(rawTargetEnv, apiEnv) {
  const trimmed = (rawTargetEnv || '').trim();
  if (trimmed && !trimmed.includes('.pure.cloud')) {
    return trimmed;
  }

  if (trimmed && CLIENT_TARGET_ENV_MAP[trimmed]) {
    return CLIENT_TARGET_ENV_MAP[trimmed];
  }

  return CLIENT_TARGET_ENV_MAP[apiEnv] || trimmed || apiEnv || 'prod-euw2';
}

// Fallback if not embedded (local dev)
const RAW_REGION = gcTargetEnvRaw || 'prod-euw2';
const API_REGION = normalizeEnvironment(RAW_REGION);
const CLIENT_TARGET_ENV = resolveClientTargetEnv(gcTargetEnvRaw, API_REGION);
const HOST_ORIGIN = (gcHostOriginRaw || '').trim();
const BASE_URL = `https://api.${API_REGION}`;

console.log('🚀 AUTO-WRAP main.js loaded', {
  href: window.location.href,
  pathname: window.location.pathname,
  search: window.location.search,
  time: new Date().toISOString()
});
console.log('Environment:', API_REGION);
console.log('Client Target Env:', CLIENT_TARGET_ENV);
console.log('Host Origin:', HOST_ORIGIN);
console.log('Base URL:', BASE_URL);

let clientApp;
let currentUser;
let notificationChannel;
let socket;
let running = false;
let autoStartAttempted = false;
let autoStartRetryTimer = null;
let heartbeatTimer = null;
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

function log(message, level = 'info', data) {
  const ts = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data, null, 2)}` : '';
  const line = `[${ts}] ${message}${suffix}`;
  if (elements.log) {
    elements.log.textContent = `${line}\n${elements.log.textContent}`;
  }
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[fn](message, data || '');
}

function setStatus(text) {
  if (elements.lastAction) {
    elements.lastAction.textContent = text;
  }
}

function clearLog() {
  if (elements.log) {
    elements.log.textContent = '';
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
  const env = normalizeEnvironment(getInterpolatedValue('gcTargetEnv', RAW_REGION));
  if (!env) {
    throw new Error('Missing gcTargetEnv.');
  }
  return env;
}

function getClientTargetEnv() {
  const raw = getInterpolatedValue('gcTargetEnv', CLIENT_TARGET_ENV);
  return resolveClientTargetEnv(raw, getEnvironment());
}

function getHostOrigin() {
  const origin = getInterpolatedValue('gcHostOrigin', HOST_ORIGIN);
  if (!origin) {
    throw new Error('Missing gcHostOrigin.');
  }
  return origin;
}

function getTopic(userId) {
  return `v2.users.${userId}.conversationsummary`;
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

  log('authenticate() starting', 'info', { env });

  await apiClient.loginImplicitGrant(config.clientId, config.redirectUri);

  currentUser = await usersApi.getUsersMe();
  if (elements.user) {
    elements.user.textContent = `${currentUser.name}`;
  }

  log('Authenticated user loaded', 'info', {
    userId: currentUser.id,
    name: currentUser.name
  });
}

async function initClientApp() {
  const env = getEnvironment();
  const hostOrigin = getHostOrigin();
  const targetEnv = getClientTargetEnv();

  log('initClientApp() starting', 'info', {
    env,
    targetEnv,
    hostOrigin
  });

  // Keep platform client on the API environment.
  apiClient.setEnvironment(env);

  // ClientApp needs the Genesys target env form, not the API host name form.
  clientApp = new ClientApp({
    gcTargetEnv: targetEnv,
    gcHostOrigin: hostOrigin
  });
}

async function createNotificationChannel() {
  notificationChannel = await notificationsApi.postNotificationsChannels();

  await notificationsApi.postNotificationsChannelSubscriptions(
    notificationChannel.id,
    [{ id: getTopic(currentUser.id) }]
  );

  if (elements.channel) {
    elements.channel.textContent = notificationChannel.id || '';
  }

  log('Notification channel created', 'info', {
    channelId: notificationChannel.id,
    connectUri: notificationChannel.connectUri
  });
}

function connectWebSocket() {
  if (!notificationChannel?.connectUri) {
    throw new Error('Notification channel connectUri is missing');
  }

  socket = new WebSocket(notificationChannel.connectUri);

  socket.addEventListener('open', () => {
    log('WebSocket connected', 'info');
    setStatus('Connected');
  });

  socket.addEventListener('close', () => {
    log('WebSocket closed', 'warn');
    setStatus('Disconnected');
  });

  socket.addEventListener('error', (event) => {
    log('WebSocket error', 'error', event);
  });

  socket.addEventListener('message', async (event) => {
    try {
      const payload = JSON.parse(event.data);

      if (!payload.topicName || !payload.eventBody) return;

      log('Notification received', 'info', {
        topicName: payload.topicName,
        raw: payload.eventBody
      });

      await handleConversationNotification(payload.topicName, payload.eventBody);
    } catch (err) {
      log('Failed to process socket message', 'error', {
        message: err?.message || String(err),
        raw: event.data
      });
    }
  });
}

function isAgentParticipantForCurrentUser(p) {
  return p?.purpose === 'agent' && p?.userId === currentUser.id;
}

async function getConversationCustomAttributes(conversationId) {
  try {
    const attrs = await authenticatedFetch(`/api/v2/conversations/${conversationId}/customattributes`);
    return attrs?.customAttributes || attrs || {};
  } catch {
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
  const p = convo.participants.find((x) => (x.id || x.participantId) === participantId);

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
    const p = convo.participants.find(isAgentParticipantForCurrentUser);

    if (!p) return;

    const state = p.state;
    const active = state === 'wrapup' || state === 'connected';

    log('ACW Check', 'info', { state, wrapupRequired: p.wrapupRequired });

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
  if (!topicName.includes('conversations') && !topicName.includes('conversationsummary')) return;

  const conversationId = eventBody.conversationId;
  if (!conversationId) return;

  const participants = eventBody.participants || [];

  const agentParticipant = participants.find((p) =>
    p.userId === currentUser.id && p.purpose === 'agent'
  );

  if (!agentParticipant) return;

  const wrapupRequired = agentParticipant.wrapupRequired;
  const state = agentParticipant.state;

  log('Summary Event Check', 'info', {
    conversationId,
    wrapupRequired,
    state
  });

  const interactionActive = state === 'wrapup' || state === 'connected';

  if (!wrapupRequired || !interactionActive) return;

  const attrs = await getConversationCustomAttributes(conversationId);
  if (!matchesForcedUnpark(attrs)) return;

  const participantId = agentParticipant.id;
  const key = `${conversationId}:${participantId}`;
  if (recentlyPatched.has(key)) return;

  recentlyPatched.set(key, Date.now());

  try {
    await patchAgentParticipantWrapup(conversationId, participantId);

    const verification = await verifyParticipant(conversationId, participantId);

    log('✅ Wrap-up applied (summary event)', 'info', {
      conversationId,
      verification
    });
  } catch (err) {
    log('❌ Wrap-up failed', 'error', err.message);
  }
}

async function start() {
  if (running) {
    log('start() ignored because helper is already running', 'warn');
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
      channelId: notificationChannel?.id
    });

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        log('Heartbeat', 'info', {
          running,
          userId: currentUser?.id,
          channelId: notificationChannel?.id,
          env: getEnvironment(),
          clientTargetEnv: getClientTargetEnv(),
          hostOrigin: getHostOrigin()
        });
      }, 60000);
    }
  } catch (err) {
    running = false;
    setStatus('Waiting');
    log('Failed to start helper', 'error', {
      message: err?.message || String(err),
      stack: err?.stack
    });
  }
}

function stop() {
  log('stop() clicked', 'info');
  try {
    if (socket) {
      socket.close();
      socket = null;
    }
  } catch (err) {
    log('Error while closing socket', 'warn', {
      message: err?.message || String(err)
    });
  }

  if (autoStartRetryTimer) {
    clearInterval(autoStartRetryTimer);
    autoStartRetryTimer = null;
  }

  running = false;
  setStatus('Stopped');
}

function bindUI() {
  if (elements.startBtn) {
    elements.startBtn.onclick = start;
  }

  if (elements.stopBtn) {
    elements.stopBtn.onclick = stop;
  }

  if (elements.clearBtn) {
    elements.clearBtn.onclick = clearLog;
  }
}

function autoStart() {
  if (autoStartAttempted) return;
  autoStartAttempted = true;

  // Auto-start immediately.
  start();

  // Retry a few times in case the host runtime or auth is still warming up.
  let attempts = 0;
  const maxAttempts = 20;
  const retryDelayMs = 1000;

  if (autoStartRetryTimer) clearInterval(autoStartRetryTimer);
  autoStartRetryTimer = setInterval(() => {
    attempts += 1;

    if (running) {
      clearInterval(autoStartRetryTimer);
      autoStartRetryTimer = null;
      return;
    }

    log(`Auto-start retry ${attempts}/${maxAttempts}`, 'warn');
    start();

    if (attempts >= maxAttempts) {
      clearInterval(autoStartRetryTimer);
      autoStartRetryTimer = null;
      log('Auto-start retry loop stopped after max attempts', 'warn');
    }
  }, retryDelayMs);
}

bindUI();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoStart);
} else {
  autoStart();
}
