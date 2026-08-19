import log from '../util/logger.js';

const logger = log.scope('plugins');

/**
 * Plugins are the extension point that keeps this platform general-purpose.
 * A plugin is an object:
 *
 *   export default {
 *     name: 'my-plugin',
 *     description: 'what it does',
 *     configKey: 'myPlugin',              // optional slice of config.json
 *     async setup(ctx) {},                // called once on load
 *     async onMessage(msg, ctx) {},       // every inbound message
 *     async onConfigChange(cfg, ctx) {},  // settings saved in the UI
 *     async teardown() {},
 *   }
 *
 * `ctx` gives a plugin everything it needs without reaching into internals:
 *   ctx.bot      - send/react/download helpers
 *   ctx.config   - live config object
 *   ctx.queue    - shared serial job queue
 *   ctx.log      - namespaced logger
 *   ctx.store    - small persistent key/value scoped to the plugin
 */
export class PluginManager {
  constructor({ bot, configStore, queue, stateStore }) {
    this.bot = bot;
    this.configStore = configStore;
    this.queue = queue;
    this.stateStore = stateStore;
    this.plugins = new Map();
  }

  async load(name, mod) {
    const plugin = mod?.default ?? mod;
    if (!plugin || typeof plugin !== 'object' || !plugin.name) {
      throw new Error(`plugin "${name}" has no valid default export`);
    }
    if (this.plugins.has(plugin.name)) {
      logger.warn(`plugin ${plugin.name} already loaded, skipping`);
      return;
    }
    const ctx = this._contextFor(plugin);
    try {
      await plugin.setup?.(ctx);
      this.plugins.set(plugin.name, { plugin, ctx });
      logger.info(`loaded plugin: ${plugin.name}`);
    } catch (err) {
      logger.error(`plugin ${plugin.name} failed to load: ${err.message}`);
      throw err;
    }
  }

  async unloadAll() {
    for (const [name, { plugin }] of this.plugins) {
      try {
        await plugin.teardown?.();
        logger.info(`unloaded plugin: ${name}`);
      } catch (err) {
        logger.error(`plugin ${name} teardown failed: ${err.message}`);
      }
    }
    this.plugins.clear();
  }

  _contextFor(plugin) {
    const configStore = this.configStore;
    return {
      bot: this.bot,
      queue: this.queue,
      log: log.scope(plugin.name),
      // Live getter: plugins always read current settings, never a stale copy.
      get config() { return configStore.get(); },
      configStore,
      store: this.stateStore.namespace(plugin.name),
    };
  }

  /** Fan a message out to every plugin; one plugin throwing must not stop the rest. */
  async dispatchMessage(msg) {
    for (const [name, { plugin, ctx }] of this.plugins) {
      if (!plugin.onMessage) continue;
      try {
        await plugin.onMessage(msg, ctx);
      } catch (err) {
        logger.error(`plugin ${name} onMessage error: ${err.message}`, { stack: err.stack });
      }
    }
  }

  async notifyConfigChange(config) {
    for (const [name, { plugin, ctx }] of this.plugins) {
      try {
        await plugin.onConfigChange?.(config, ctx);
      } catch (err) {
        logger.error(`plugin ${name} onConfigChange error: ${err.message}`);
      }
    }
  }

  list() {
    return [...this.plugins.values()].map(({ plugin }) => ({
      name: plugin.name,
      description: plugin.description ?? '',
      configKey: plugin.configKey ?? null,
    }));
  }
}
