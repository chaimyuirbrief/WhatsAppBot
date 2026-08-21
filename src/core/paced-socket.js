/**
 * A WhatsApp socket that paces itself.
 *
 * Pacing used to be opt-in: every method that talked to WhatsApp had to
 * remember to wait first. That works right up until someone adds a method and
 * doesn't - and the failure is silent, because the code works perfectly. It
 * just works too fast, which is the one thing this bot must never do.
 *
 * So the gate moves under the socket. Every call made through this wrapper
 * waits its turn, chosen by the method being called, and a call nobody has
 * classified gets the conservative default rather than going straight out. The
 * safe behaviour is what you get by doing nothing.
 *
 * The wrapper is a Proxy so it stays transparent: `sock.ev`, `sock.user`,
 * `sock.authState` and everything else pass through untouched, and methods
 * keep their `this`.
 */

/**
 * Which pace each call gets, by Baileys method name. A value may be a function
 * of the call's arguments, for methods that do more than one thing.
 *
 * The keys are pace KINDS, resolved by the caller (see WhatsAppBot) against
 * `whatsapp.pacing` - this module holds no timings of its own.
 */
export const SOCKET_PACE_KINDS = {
  // Group administration - the calls WhatsApp watches most closely.
  groupSettingUpdate: 'groupSetting',
  groupUpdateDescription: 'description',
  groupUpdateSubject: 'description',
  groupParticipantsUpdate: 'participant',
  groupCreate: 'participant',
  groupLeave: 'participant',
  groupRevokeInvite: 'groupSetting',
  groupAcceptInvite: 'participant',
  groupToggleEphemeral: 'groupSetting',

  // Reads. Still activity, still paced, but nobody is fooled into thinking a
  // metadata fetch is as loud as a membership change.
  groupMetadata: 'metadata',
  groupFetchAllParticipating: 'metadata',
  groupInviteCode: 'metadata',
  groupGetInviteInfo: 'metadata',
  onWhatsApp: 'metadata',
  fetchStatus: 'metadata',
  profilePictureUrl: 'metadata',

  // sendMessage is polymorphic: a revoke is a much louder thing than a chat
  // message, and in bulk it is the loudest thing this bot does.
  sendMessage: (jid, content) => (content?.delete ? 'revoke' : 'message'),

  // Ordinary chatter.
  sendPresenceUpdate: 'message',
  readMessages: 'message',
  chatModify: 'message',
  updateProfileStatus: 'message',
  updateProfileName: 'message',
};

/**
 * Calls that must NOT be delayed: connection lifecycle, where a wait either
 * breaks the handshake or leaves someone staring at a blank pairing screen.
 * None of them is an action against another person's group.
 */
export const UNPACED = new Set([
  'requestPairingCode',
  'logout',
  'end',
  'waitForSocketOpen',
  'waitForConnectionUpdate',
  'register',
  'sendNode',
  'sendRawMessage',
  'query',
  'uploadPreKeys',
  'uploadPreKeysToServerIfRequired',
]);

/** The pace kind for a call, or null when it should not be paced at all. */
export function kindFor(method, args = []) {
  if (UNPACED.has(method)) return null;
  const rule = SOCKET_PACE_KINDS[method];
  if (typeof rule === 'function') return rule(...args);
  if (rule) return rule;
  // Unknown call: pace it. Being slow on something that did not need it costs
  // a few seconds; being fast on something that did costs the account.
  return 'default';
}

/**
 * Wrap `sock` so every call through it waits its turn.
 *
 * @param {object} sock       the live Baileys socket
 * @param {(kind: string, method: string, args: any[]) => Promise<void>} hold
 *        called before each paced call; resolves when the call may go out
 * @returns {object} a transparent stand-in for `sock`
 */
export function pacedSocket(sock, hold) {
  if (!sock || typeof hold !== 'function') return sock;

  // Bound wrappers are cached so `sock.sendMessage === sock.sendMessage`, which
  // matters for anything that compares or detaches a handler.
  const cache = new Map();

  return new Proxy(sock, {
    get(target, prop, receiver) {
      // Receiver is the target, not the proxy: Baileys' own getters expect to
      // see the real socket as `this`.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      if (cache.has(prop)) return cache.get(prop);

      const wrapped = async (...args) => {
        const kind = kindFor(prop, args);
        if (kind) await hold(kind, prop, args);
        return value.apply(target, args);
      };
      Object.defineProperty(wrapped, 'name', { value: prop });
      cache.set(prop, wrapped);
      return wrapped;
    },

    // Writes go to the real socket, and any cached wrapper for that name is
    // dropped so the new value is picked up rather than the stale one.
    set(target, prop, value) {
      cache.delete(prop);
      return Reflect.set(target, prop, value, target);
    },
    deleteProperty(target, prop) {
      cache.delete(prop);
      return Reflect.deleteProperty(target, prop);
    },
  });
}
