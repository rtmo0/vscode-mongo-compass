/**
 * Entry point of `dist/oidc-plugin.js`, a bundle of its own so that only
 * OIDC connections pay for loading the plugin and its HTTP stack.
 */
export { createMongoDBOIDCPlugin } from '@mongodb-js/oidc-plugin';
