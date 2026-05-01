export const config = {
  clientId: '584c1e79-568e-4d71-91ff-3e00bf01d04b',
  redirectUri: 'https://clivejdixon.github.io/autowrap/index.html',
  persistKey: 'genesys-auto-wrapup-helper',
  authFlow: 'implicit',
  notificationTopicTemplate: 'v2.users.{userId}.conversations',
  wrapupPayload: {
    code: 'ca8f495d-e32d-4c6d-b721-2b061ca80213',
    name: 'CD_AutoUnparked',
    notes: 'Unparked due to time limit'
  },
  requiredCustomAttribute: {
    key: 'ForcedUnpark',
    value: true
  },
  pollVerificationMs: 1500,
  dedupeWindowMs: 30000,
  enableClientAppToast: true
};
