import platformClient from 'purecloud-platform-client-v2';
import ClientApp from 'purecloud-client-app-sdk';
import { config } from './config.js';

const APP_NAME = 'AUTO-WRAP';

const apiClient = platformClient.ApiClient.instance;
const usersApi = new platformClient.UsersApi();
const notificationsApi = new platformClient.NotificationsApi();
const params = new URLSearchParams(window.location.search);

const gcHostOriginRaw = (params.get('gcHostOrigin') || localStorage.getItem('gcHostOrigin') || '').trim();
const gcTargetEnvRaw = (params.get('gcTargetEnv') || localStorage.getItem('gcTargetEnv') || 'euw2.pure.cloud').trim();

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
  'usw2.pure.cloud': 'usw2.pure.cloud',
  'mypurecloud.ie': 'mypurecloud.ie',
  'mypurecloud.de': 'mypurecloud.de',
  'mypurecloud.jp': 'mypurecloud.jp'
};

function normalizeEnvironment(env) {
  if (!env) return '';
  return ENVIRONMENT_MAP[env] || env;
}

function getEnvironment() {
  const env = normalizeEnvironment(gcTargetEnvRaw);
  if (!env) {
    throw new Error('Missing gcTargetEnv.');
  }
  return env;
}

function getSdkTargetEnv() {
  // For the Genesys client-app SDK, use the actual cloud environment label.
  // This avoids turning euw2 into a login.prod-euw2 style hostname.
  return getEnvironment();
}

function getHostOrigin() {
  if (gcHostOriginRaw) return gcHostOriginRaw;

  const env = getEnvironment();
  if (env === 'mypurecloud.com') return 'https://apps.mypurecloud.com';
  if (env.endsWith('.pure.cloud')) return `https://apps.${env}`;
  return `https://apps.${env}`;
}

function getBaseUrl() {
  return `https://api.${getEnvironment()}`;
}

console.log('🚀 AUTO-WRAP main.js loaded', {
  href: window.location.href,
  pathname: window.location.pathname,
  search: window.location.search,
  time: new Date().toISOString()
});
console.log('Environment:', getEnvironment());
console.log('Host Origin:', getHostOrigin());
console.log('Base URL:', getBaseUrl());

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

function getAccessToken() {
  const token = apiClient.authData?.accessToken || apiClient.accessToken;
  if (!token) {
    throw new Error('No access token');
  }
  return token;
}

async function authenticatedFetch(path, options = {}) {
  const token = getAccessToken();
  const url = `${getBaseUrl()}${path}`;

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
  const sdkTargetEnv = getSdkTargetEnv();

  log('initClientApp() starting', 'info', {
    env,
    sdkTargetEnv,
    hostOrigin
  });

  clientApp = new ClientApp({
    gcTargetEnv: sdkTargetEnv,
    gcHostOrigin: hostOrigin
  });
}

async function createNotificationChannel() {
  notificationChannel = await notificationsApi.postNotificationsChannels();

  await notificationsApi.postNotificationsChannelSubscriptions(
    notificationChannel.id,
    [{ id: `v2.users.${currentUser.id}.conversationsummary` }]
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
  return p?.purpose === 'agent' && p?.userId === currentUser?.id;
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

function getConversationIdFromEventBody(eventBody) {
  return (
    eventBody?.conversationId ||
    eventBody?.conversation?.id ||
    eventBody?.conversation?.conversationId ||
    eventBody?.id ||
    ''
  );
}

async function handleConversationNotification(topicName, eventBody) {
  if (!topicName.includes('conversations') && !topicName.includes('conversationsummary')) return;

  const conversationId = getConversationIdFromEventBody(eventBody);
  if (!conversationId) return;

  const participants = eventBody.participants || [];

  const agentParticipant = participants.find(
    (p) => p.userId === currentUser.id && p.purpose === 'agent'
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

  const participantId = agentParticipant.id || agentParticipant.participantId;
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
    log('❌ Wrap-up failed', 'error', {
      message: err?.message || String(err)
    });
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

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
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

  start();

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
